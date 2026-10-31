//! AI 补丁生成（T6）：在**独立文件**里生成 Redscript 补丁，不改原 Mod 脚本。
//!
//! 边界（与 `docs/PROJECT_HISTORY.md#design-ai-patch` 一致，代码里逐条守住）：
//!
//! 1. 原 `.reds` 只读：只把被选中模组的脚本片段发给 AI，产物永远写新文件。
//! 2. 结构校验（G1）：模块名、注解、括号配平、危险 API 白名单之外的东西一律拒绝。
//! 3. 编译校验（G2）：本机没有 redscript 编译器时如实标记 `compiled=false`，
//!    并在报告里明确「未做编译校验」，不把它说成验证通过。
//! 4. 用户确认（G3）：未经确认不落盘；部署目标已存在时拒绝覆盖。
//! 5. 一键撤销：按 `deployed_files` 语义撤除，只删自己放进去的那个文件。

use std::fs;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::installer::file_stamp;
use crate::schema::{
    AiFixProposal, AiFixReport, AiFixState, AppResult, CommandError, DeployedFile, LinkType,
    ModEntry,
};
use crate::store::{is_within, now_iso, safe_join, Store};

/// 发给 AI 的脚本上下文上限（字符）。整包脚本可能有几万行，
/// 全发既不礼貌也会把关键方法挤出窗口。
const MAX_CONTEXT_CHARS: usize = 12_000;
const MAX_SCRIPT_FILES: usize = 8;
/// 补丁文件行数上限：超过基本说明模型在重写整个方法体，不是补丁。
const MAX_PATCH_LINES: usize = 400;

/// 危险 API：补丁里出现这些调用一律拒绝。游戏脚本正常运行不需要碰文件和网络，
/// 出现就说明模型跑偏（或被注入）。
const FORBIDDEN_SNIPPETS: &[&str] = &[
    "FileSystem",
    "HttpRequest",
    "HttpClient",
    "Network.",
    "Process.",
    "Exec(",
    "Runtime.",
    "import(",
];

/// 把 id 净化成可安全拼进文件名的片段。
///
/// id 由启动器生成（adopt-… / mod-…），但状态文件是用户可编辑的 JSON：
/// 一旦有人把 id 改成 "..\\..\\x" 之类，直接拼路径就会写到目录外。
fn safe_id(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "mod".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn find_entry(store: &Store, mod_id: &str) -> AppResult<ModEntry> {
    let data = store.data.lock().expect("state mutex poisoned");
    data.mods
        .iter()
        .find(|entry| entry.id == mod_id)
        .cloned()
        .ok_or_else(|| CommandError::new("MOD_NOT_FOUND", "找不到这个模组。"))
}

/// G1 结构校验。返回 `(是否通过, 问题列表)`。
///
/// 这些检查都很便宜，但能挡掉绝大多数「模型返回了半截代码 / 写了整个 mod 框架」的情况。
pub fn validate_structure(code: &str) -> (bool, Vec<String>) {
    let mut issues = Vec::new();
    let trimmed = code.trim();
    if trimmed.is_empty() {
        issues.push("补丁内容为空。".to_string());
        return (false, issues);
    }
    if trimmed.lines().count() > MAX_PATCH_LINES {
        issues.push(format!("补丁超过 {MAX_PATCH_LINES} 行，拒绝当作增量补丁。"));
    }
    if !trimmed.starts_with("module ") {
        issues.push("补丁必须以 `module ` 声明开头（独立模块，避免污染原模块）。".to_string());
    }
    if !trimmed.contains("@wrapMethod(") && !trimmed.contains("@replaceMethod(") {
        issues.push("补丁没有使用 @wrapMethod / @replaceMethod，无法作为覆盖层生效。".to_string());
    }
    for snippet in FORBIDDEN_SNIPPETS {
        if trimmed.contains(snippet) {
            issues.push(format!("补丁包含不允许的调用：{snippet}"));
        }
    }
    // 括号配平：不要完美解析器，只要能挡住「截断的返回值」。
    let mut braces = 0i32;
    let mut parens = 0i32;
    let mut in_string = false;
    let mut quote = ' ';
    let mut escaped = false;
    for ch in trimmed.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                in_string = true;
                quote = ch;
            }
            '{' => braces += 1,
            '}' => braces -= 1,
            '(' => parens += 1,
            ')' => parens -= 1,
            _ => {}
        }
        if braces < 0 || parens < 0 {
            break;
        }
    }
    if in_string {
        issues.push("字符串引号没有闭合，补丁大概率被截断。".to_string());
    }
    if braces != 0 {
        issues.push(format!("花括号不配平（差值 {braces}）。"));
    }
    if parens != 0 {
        issues.push(format!("圆括号不配平（差值 {parens}）。"));
    }
    (issues.is_empty(), issues)
}

/// 收集可当上下文的脚本文件（相对暂存根，稳定排序）。
fn collect_scripts(staging: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut budget = MAX_CONTEXT_CHARS;
    let mut files: Vec<PathBuf> = WalkDir::new(staging)
        .max_depth(8)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|item| item.file_type().is_file())
        .filter(|item| {
            item.path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("reds"))
                .unwrap_or(false)
        })
        .map(|item| item.path().to_path_buf())
        .collect();
    files.sort();
    for file in files {
        if out.len() >= MAX_SCRIPT_FILES || budget == 0 {
            break;
        }
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        let label = file
            .strip_prefix(staging)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let slice: String = text.chars().take(budget).collect();
        budget = budget.saturating_sub(slice.chars().count());
        out.push((label, slice));
    }
    out
}

fn total_chars(scripts: &[(String, String)]) -> usize {
    scripts
        .iter()
        .map(|(label, text)| label.chars().count() + text.chars().count())
        .sum()
}

fn build_brief(entry: &ModEntry, intent: &str, scripts: &[(String, String)]) -> String {
    let mut brief = String::new();
    brief.push_str(&format!("模组：{}\n", entry.name));
    if let Some(version) = entry.version.as_deref() {
        brief.push_str(&format!("版本：{version}\n"));
    }
    brief.push_str(&format!("需求：{intent}\n\n脚本片段：\n"));
    for (label, text) in scripts {
        brief.push_str(&format!("===== {label} =====\n{text}\n\n"));
    }
    brief
}

/// 生成提案：把选中模组的脚本片段发给 AI，拿到补丁文本后做结构校验。
pub fn propose(store: &Store, mod_id: &str, intent: &str) -> AppResult<AiFixProposal> {
    let intent = intent.trim();
    if intent.is_empty() {
        return Err(CommandError::new(
            "AI_FIX_INTENT_REQUIRED",
            "请先写清楚要修什么（例如「与 XX 模组的同名方法冲突」）。",
        ));
    }
    let entry = find_entry(store, mod_id)?;
    let staging = PathBuf::from(&entry.staging_path);
    if !staging.is_dir() {
        return Err(CommandError::new(
            "STAGING_MISSING",
            "这个模组的暂存文件不见了，无法读取脚本上下文。",
        ));
    }
    let scripts = collect_scripts(&staging);
    if scripts.is_empty() {
        return Err(CommandError::new(
            "AI_FIX_NO_SCRIPTS",
            "这个模组里没有 .reds 脚本；AI 补丁只针对 Redscript 冲突，其它类型请用冲突中心排查。",
        ));
    }
    let context_labels: Vec<String> = scripts.iter().map(|(label, _)| label.clone()).collect();
    let context_chars = total_chars(&scripts);
    let brief = build_brief(&entry, intent, &scripts);

    let (code, model, warnings) = crate::ai::propose_redscript_patch(store, &brief)?;
    let (structure_ok, structure_issues) = validate_structure(&code);
    let compiler = crate::installer::which("scc.exe")
        .ok()
        .map(|path| path.to_string_lossy().to_string());

    Ok(AiFixProposal {
        mod_id: mod_id.to_string(),
        mod_name: entry.name.clone(),
        intent: intent.to_string(),
        context_chars,
        context_files: context_labels,
        code,
        structure_ok,
        structure_issues,
        compiler,
        warnings: {
            let mut all = warnings;
            all.push(format!("提案由 {model} 生成，未经你确认前不会写入游戏目录。"));
            all
        },
    })
}

/// 应用补丁：再次结构校验 → 写入独立文件 → 登记。
pub fn apply(
    store: &Store,
    mod_id: &str,
    game_root: &Path,
    code: &str,
    intent: &str,
    acknowledged: bool,
) -> AppResult<AiFixReport> {
    if !acknowledged {
        return Err(CommandError::new(
            "AI_FIX_CONSENT_REQUIRED",
            "需要先确认「已知晓该补丁由 AI 生成、可能影响游戏稳定性」。",
        ));
    }
    let (ok, issues) = validate_structure(code);
    if !ok {
        return Err(CommandError::new(
            "AI_FIX_STRUCTURE_INVALID",
            format!("补丁未通过结构校验：{}", issues.join("；")),
        ));
    }
    let entry = find_entry(store, mod_id)?;
    let id = safe_id(mod_id);
    let relative = format!("r6/scripts/cyberdeck-ai-fix/{id}-AIFix.reds");
    let target = safe_join(game_root, &relative)?;
    if !is_within(game_root, &target) {
        return Err(CommandError::new("PATH_ESCAPE", "补丁目标路径越界。"));
    }
    if target.exists() {
        return Err(CommandError::new(
            "AI_FIX_TARGET_EXISTS",
            format!("目标文件已存在，未覆盖：{relative}（可先撤销旧补丁）"),
        ));
    }
    let script_dir = store.staging_dir().join("ai-fix").join(safe_id(&entry.id));
    fs::create_dir_all(&script_dir)?;
    let staged = script_dir.join(format!("{id}-AIFix.reds"));
    fs::write(&staged, code)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&staged, &target).map_err(|err| {
        CommandError::new("AI_FIX_DEPLOY_COPY", format!("写入游戏目录失败：{err}"))
    })?;
    let (size, modified_time) = file_stamp(&target);
    let deployed = DeployedFile {
        source: staged.to_string_lossy().to_string(),
        target: target.to_string_lossy().to_string(),
        relative_path: relative.clone(),
        link_type: LinkType::Copy,
        size,
        modified_time,
    };

    let settings_model = {
        let data = store.snapshot_data();
        data.settings.ai_model.clone()
    };
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        if let Some(slot) = data.mods.iter_mut().find(|item| item.id == mod_id) {
            slot.ai_fix.push(AiFixState {
                file: deployed.clone(),
                intent: intent.to_string(),
                model: settings_model.clone(),
                created_at: now_iso(),
            });
            slot.updated_at = Some(now_iso());
        }
        if let Err(err) = store.save(&data) {
            let _ = fs::remove_file(&target);
            return Err(err);
        }
    }

    Ok(AiFixReport {
        mod_id: mod_id.to_string(),
        target: relative,
        bytes: code.len(),
        // 本机没有接入 redscript 编译器时如实报 false；不要把「结构合法」说成「能编译」。
        compiled: false,
        model: settings_model,
        warnings: vec![
            "补丁已写入独立文件，原模组脚本未被修改。".to_string(),
            "未做编译校验：进游戏前请先在 REDscript 日志里确认没有编译错误。".to_string(),
        ],
    })
}

/// 撤销补丁：按登记的相对路径删除，只删自己放进去的文件。
pub fn revert(store: &Store, mod_id: &str, relative_path: &str) -> AppResult<AiFixReport> {
    let entry = find_entry(store, mod_id)?;
    let Some(index) = entry
        .ai_fix
        .iter()
        .position(|item| item.file.relative_path == relative_path)
    else {
        return Err(CommandError::new(
            "AI_FIX_NOT_FOUND",
            "找不到这个补丁的登记记录。",
        ));
    };
    let record = entry.ai_fix[index].clone();
    let target = PathBuf::from(&record.file.target);
    let mut warnings = Vec::new();
    if target.exists() {
        let (size, _) = file_stamp(&target);
        if record.file.size.is_some() && record.file.size != size {
            return Err(CommandError::new(
                "AI_FIX_CHANGED",
                format!("补丁文件在部署后被改动过，已停止删除：{relative_path}"),
            ));
        }
        fs::remove_file(&target)
            .map_err(|err| CommandError::new("AI_FIX_REVERT_FAILED", format!("删除失败：{err}")))?;
    } else {
        warnings.push("补丁文件已不在游戏目录，只清理登记记录。".to_string());
    }
    let staged = PathBuf::from(&record.file.source);
    if is_within(&store.staging_dir(), &staged) {
        let _ = fs::remove_file(&staged);
    }
    {
        let mut data = store.data.lock().expect("state mutex poisoned");
        if let Some(slot) = data.mods.iter_mut().find(|item| item.id == mod_id) {
            slot.ai_fix.retain(|item| item.file.relative_path != relative_path);
            slot.updated_at = Some(now_iso());
        }
        store.save(&data)?;
    }
    Ok(AiFixReport {
        mod_id: mod_id.to_string(),
        target: relative_path.to_string(),
        bytes: 0,
        compiled: false,
        model: record.model,
        warnings,
    })
}
