//! REDmod 部署：调用游戏自带的 `tools/redmod/bin/redMod.exe deploy` 重新生成
//! `r6/cache/modded`。
//!
//! # 为什么必须有这一步
//!
//! REDmod 格式的 mod 被放进 `mods/<名称>/` 之后，游戏并不直接读它——游戏读的是
//! `r6/cache/modded` 里由 redMod 生成的编译产物。不调用 redMod，这类 mod 装了
//! 也不生效。本启动器此前只传 `-modded` 启动参数、从不调用 redMod，等于「假支持」。
//!
//! # 对齐来源
//!
//! 逐条对齐 Nexus-Mods/game-cyberpunk2077（GPL-3.0）：
//! - `src/redmod.deploy.ts`：exe 路径、参数数组、cwd、windowsHide、失败原因提取、
//!   `0xC000013A` 中断码、`redmodDeployedFilesNeedRebuilding` 判定；
//! - `src/load_order.ts::deployREDmodLoadOrder`：modlist.txt 的写入格式与时机；
//! - `src/redmodding.metadata.ts`：全部相对路径常量。
//!
//! # 关键格式（照抄，勿「优化」）
//!
//! - modlist.txt 每行一个 REDmod **文件夹名（basename）**，不是相对路径；
//! - 行分隔符必须是 **CRLF**（redMod 只认 Windows 换行）；
//! - **无尾随换行**（`Array.join` 语义），无 BOM，UTF-8；
//! - 只写 `enabled` 的 mod；禁用的 mod 仍留在加载顺序里但不进 modlist；
//! - 空列表写 **0 字节文件**，仍要执行一次部署（让 redMod 回落到默认规则）。

use crate::schema::{AppResult, AppStateData, CommandError, InstallLayout, ModEntry};
use crate::store::Store;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 部署器本体（REDmod DLC 自带）。
pub const REDMOD_EXE: &str = "tools/redmod/bin/redMod.exe";
/// 启动器本体。Vortex 用它判断「REDmod 是否已安装」，缺了它 redMod 也跑不起来。
///
/// 目前只作为文档留存：本启动器的启动链路不依赖它，缺件时 redMod 自己会报错，
/// 我们不必抢在它前面拒绝。
#[allow(dead_code)]
pub const REDPRELAUNCHER_EXE: &str = "REDprelauncher.exe";
/// redMod 编译所需的 RTTI scheme 元数据。
pub const RTTI_METADATA: &str = "tools/redmod/metadata.json";
/// redMod 读取的 mod 列表（相对游戏根）。
pub const MODLIST_RELATIVE: &str = "V2077/modlist.txt";
/// REDmod 加载顺序存档目录（相对游戏根）。
///
/// 预留给「导入 Vortex 已有的加载顺序」：Vortex 会在这里落
/// `V2077-load-order-<id>.json`，直接读它比让用户重排一遍省事。
#[allow(dead_code)]
pub const LOAD_ORDER_DIR: &str = "V2077/Load Order";
/// redMod 生成的编译产物目录。
pub const MODDED_CACHE: &str = "r6/cache/modded";
/// REDmod 的安装根。
pub const MODS_DIR: &str = "mods";

/// redMod 报告失败的固定那一行。
const FAILED_LINE: &str = "Commandlet deploy has failed.";
/// redMod 的阶段进度行前缀，用它判断「上一行不是真原因」。
const STAGE_PREFIX: &str = "[DEPLOY]";
/// `STATUS_CONTROL_C_EXIT`：控制台被关闭 / 进程被强行结束。
/// 以 u32 表示是 0xC000013A，`ExitStatus::code()` 给出的是它的 i32 补码。
const INTERRUPTED_CODE: i32 = -1073741638;

/// 串行化部署：Vortex 同样用队列保证同一时刻只有一个 deploy 在跑，
/// 因为多个部署会争抢同一个 modlist.txt 和 `r6/cache/modded`。
static DEPLOY_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 「REDmod 集合可能有变化，需要重跑一次 redMod」。
///
/// 用脏标记而不是在 `deploy_mod` 里直接跑进程，是因为批量启用/安装时会连续
/// 部署几十个 mod：每次起一个 redMod（还要加载 6 MB 的 metadata.json）会让
/// 一次批量操作从几秒变成几分钟。标记只置位，命令层在锁外统一 flush 一次。
static DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn mark_dirty() {
    DIRTY.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub fn is_dirty() -> bool {
    DIRTY.load(std::sync::atomic::Ordering::SeqCst)
}

/// 有待同步的改动就跑一次 redMod；没有就直接返回，零开销。
///
/// 失败时**不清标记**，下一次操作会重试——REDmod 部署失败不该被静默吞掉，
/// 但也不该让「装一个 archive」跟着一起报错。唯一例外是工具链缺失：那不是
/// 暂时性问题，反复重试只会每次多弹一条同样的提示。
pub fn flush(store: &Store, game_root: &Path) -> AppResult<Option<SyncReport>> {
    if !is_dirty() {
        return Ok(None);
    }
    let result = sync_from_store(store, game_root);
    match &result {
        Ok(_) => DIRTY.store(false, std::sync::atomic::Ordering::SeqCst),
        Err(err) if err.code == "REDMOD_TOOLCHAIN_MISSING" => {
            DIRTY.store(false, std::sync::atomic::Ordering::SeqCst)
        }
        Err(_) => {}
    }
    result
}

/// redMod 工具链是否可用。
#[derive(Debug)]
pub struct Toolchain {
    pub exe: PathBuf,
}

/// 检查 REDmod 工具链。缺件时返回面向用户的说明，调用方据此降级为警告。
pub fn probe_toolchain(game_root: &Path) -> Result<Toolchain, String> {
    let exe = game_root.join(REDMOD_EXE);
    let metadata = game_root.join(RTTI_METADATA);

    let mut missing: Vec<&str> = Vec::new();
    if !exe.is_file() {
        missing.push(REDMOD_EXE);
    }
    if !metadata.is_file() {
        missing.push(RTTI_METADATA);
    }
    if !missing.is_empty() {
        return Err(format!(
            "未找到 REDmod 工具链（缺 {}）。请在游戏商店安装免费的 REDmod DLC 后再启用 REDmod 类模组；\
             其余模组不受影响。",
            missing.join("、")
        ));
    }
    Ok(Toolchain { exe })
}

/// redMod 的完整参数数组。
///
/// 注意 `-root` 是**独立参数**，其余 flag 用 `=` 连接——这是 redMod 自己的约定，
/// 写成 `-root=xxx` 它认不出来。
pub fn deploy_args(game_root: &Path) -> Vec<String> {
    vec![
        "deploy".to_string(),
        "-reportProgress".to_string(),
        "-root".to_string(),
        game_root.to_string_lossy().to_string(),
        format!(
            "-rttiSchemaPath={}",
            game_root.join(RTTI_METADATA).to_string_lossy()
        ),
        format!(
            "-modlist={}",
            game_root.join(MODLIST_RELATIVE).to_string_lossy()
        ),
    ]
}

/// 从 ModEntry 推出它在 `mods/` 下的文件夹名。
///
/// 优先用导入时记下的 `mod_folder`；没有就从未卸载清单里反推（老记录可能没填）。
fn folder_of(entry: &ModEntry) -> Option<String> {
    if let Some(folder) = entry.mod_folder.as_deref() {
        let trimmed = folder.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let prefix = format!("{MODS_DIR}/");
    for file in &entry.deployed_files {
        let relative = file.relative_path.replace('\\', "/");
        if let Some(rest) = relative.strip_prefix(&prefix) {
            if let Some(index) = rest.find('/') {
                return Some(rest[..index].to_string());
            }
        }
    }
    None
}

/// 部署只需要状态里的两样东西：加载顺序，以及 REDmod 类模组本身。
///
/// 单独开这个结构而不是直接用 `AppStateData`：`sync_from_store` 要在**锁外**
/// 跑外部进程，复制整个库（几百条记录 + 部署清单）纯属浪费。
pub struct RedmodView {
    pub order: Vec<String>,
    pub mods: Vec<ModEntry>,
}

impl RedmodView {
    pub fn from_state(state: &AppStateData) -> Self {
        RedmodView {
            order: state.redmod_order.clone(),
            mods: state
                .mods
                .iter()
                .filter(|entry| entry.layout == InstallLayout::Redmod)
                .cloned()
                .collect(),
        }
    }
}

/// 当前应写进 modlist.txt 的 REDmod 文件夹名，**按用户设定的加载顺序**。
///
/// 顺序来源：`state.redmod_order`（存 mod id）。没登记过的按文件夹名字母序补在后面，
/// 保证「刚装上、还没排过序」的 mod 也能被部署，而不是悄悄丢失。
pub fn enabled_folders(view: &RedmodView) -> Vec<String> {
    let mut pending: HashMap<String, String> = HashMap::new();
    for entry in view.mods.iter().filter(|item| item.enabled) {
        if let Some(folder) = folder_of(entry) {
            pending.insert(entry.id.clone(), folder);
        }
    }

    let mut ordered: Vec<String> = Vec::with_capacity(pending.len());
    for id in &view.order {
        if let Some(folder) = pending.remove(id) {
            ordered.push(folder);
        }
    }
    let mut rest: Vec<(String, String)> = pending.into_iter().collect();
    // 只用小写名当排序键会留下并列：`SameMod` 和 `samemod` 在 Windows 上是同一个
    // mod，小写后完全相同。而 `pending` 是 HashMap，迭代顺序每个进程都不同——
    // 并列时谁排前面是随机的，去重后保留下来的大小写也就随机，等于每次写出的
    // modlist.txt 可能不一样。用原字符串兜底，让结果可复现。
    rest.sort_by(|left, right| {
        left.1
            .to_ascii_lowercase()
            .cmp(&right.1.to_ascii_lowercase())
            .then_with(|| left.1.cmp(&right.1))
    });
    ordered.extend(rest.into_iter().map(|(_, folder)| folder));

    // modlist.txt 只认文件夹名，同名的两个 mod 会让 redMod 覆盖掉一个。
    let mut seen: HashSet<String> = HashSet::new();
    ordered.retain(|folder| seen.insert(folder.to_ascii_lowercase()));
    ordered
}

/// 读盘上的 modlist.txt。
///
/// 返回 `None` 表示「文件在，但读不出来」——已部署顺序不可知，按 Vortex 的做法
/// 必须无条件重建缓存，否则 redMod 可能沿用错误的旧产物。
pub fn read_modlist(path: &Path) -> Option<Vec<String>> {
    match fs::read_to_string(path) {
        Ok(raw) => Some(
            raw.split("\r\n")
                .flat_map(|line| line.split('\n'))
                .map(|line| line.trim_end_matches('\r').trim())
                .filter(|line| !line.is_empty())
                .map(|line| line.to_string())
                .collect(),
        ),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
        Err(_) => None,
    }
}

/// mod 集合相同、但顺序变了 → 需要先删缓存再重建。
///
/// redMod 自己会重建「有变化」的 mod，但它察觉不到纯重排：同样的输入文件、
/// 不同的优先级，它认为无事可做，于是加载顺序改了却不生效。
///
/// 全程按小写比较：Windows 下 mod 文件夹名不区分大小写，`Foo` 和 `foo` 是同一个
/// mod，只改大小写不算重排，不该触发整份缓存重建（那要几十秒）。
pub fn needs_rebuild(previous: &[String], next: &[String]) -> bool {
    if previous.len() != next.len() {
        return false;
    }
    let a: Vec<String> = previous.iter().map(|s| s.to_ascii_lowercase()).collect();
    let b: Vec<String> = next.iter().map(|s| s.to_ascii_lowercase()).collect();
    if a == b {
        return false;
    }
    // 集合不同 → redMod 自己能察觉新增/删除，不需要我们先清空缓存。
    let mut sorted_a = a.clone();
    let mut sorted_b = b.clone();
    sorted_a.sort();
    sorted_b.sort();
    sorted_a == sorted_b
}

/// 原子写 modlist.txt（同目录 `.tmp` + rename）。
///
/// 空列表写成 0 字节文件，而不是删掉文件：删文件会让 redMod 以为「从来没部署过」，
/// 而我们正是要靠一次「空列表部署」把缓存清干净。
pub fn write_modlist(game_root: &Path, folders: &[String]) -> AppResult<PathBuf> {
    let path = game_root.join(MODLIST_RELATIVE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            CommandError::new(
                "REDMOD_MKDIR",
                format!("无法创建 {}：{err}", parent.display()),
            )
        })?;
    }
    let content = folders.join("\r\n");
    let temp = path.with_extension("txt.cyberdeck-tmp");
    fs::write(&temp, content.as_bytes()).map_err(|err| {
        CommandError::new(
            "REDMOD_MODLIST_WRITE",
            format!("写入 V2077/modlist.txt 失败：{err}"),
        )
    })?;
    fs::rename(&temp, &path).map_err(|err| {
        CommandError::new(
            "REDMOD_MODLIST_WRITE",
            format!("保存 V2077/modlist.txt 失败（旧文件未被改动）：{err}"),
        )
    })?;
    Ok(path)
}

/// 删掉并重建 `r6/cache/modded`。目录不存在时只创建。
pub fn clear_cache(game_root: &Path) -> AppResult<()> {
    let dir = game_root.join(MODDED_CACHE);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|err| {
            CommandError::new(
                "REDMOD_CACHE_CLEAR",
                format!(
                    "无法清空 {}（游戏可能正在运行）：{err}",
                    dir.display()
                ),
            )
        })?;
    }
    fs::create_dir_all(&dir).map_err(|err| {
        CommandError::new(
            "REDMOD_CACHE_CLEAR",
            format!("无法创建 {}：{err}", dir.display()),
        )
    })?;
    Ok(())
}

pub struct DeployOutcome {
    pub exit_code: Option<i32>,
    pub output: String,
}

/// 从 redMod 的输出里挑出真正的失败原因。
///
/// redMod 最后一行永远是 `Commandlet deploy has failed.`，原因在它**上一行**；
/// 上一行如果只是 `[DEPLOY] xxx` 这种阶段进度，说明它没给出有用信息，退回退出码。
pub fn failure_reason(exit_code: Option<i32>, output: &str) -> String {
    if exit_code == Some(INTERRUPTED_CODE) {
        return "REDmod 部署被中断（控制台被关闭或进程被强行结束）。".to_string();
    }
    let lines: Vec<&str> = output.lines().map(|line| line.trim()).collect();
    let reason = match lines.iter().position(|line| *line == FAILED_LINE) {
        Some(index) => lines[..index]
            .iter()
            .rev()
            .find(|line| !line.is_empty())
            .copied(),
        None => None,
    };
    match reason {
        Some(line) if !line.starts_with(STAGE_PREFIX) => line.to_string(),
        _ => format!("REDmod 退出码 {}", exit_code.unwrap_or(-1)),
    }
}

/// 调用 redMod 部署。返回的 `exit_code != Some(0)` 由调用方决定怎么呈现。
pub fn run_deploy(game_root: &Path) -> AppResult<DeployOutcome> {
    let tool = probe_toolchain(game_root)
        .map_err(|reason| CommandError::new("REDMOD_TOOLCHAIN_MISSING", reason))?;
    let args = deploy_args(game_root);
    let mut command = Command::new(&tool.exe);
    command
        .args(&args)
        // Vortex 同样把 cwd 设在 exe 所在目录：redMod 会去那里找自己的一堆 DLL。
        .current_dir(tool.exe.parent().unwrap_or(game_root));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：不给用户弹一个黑框，也不让它抢焦点。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().map_err(|err| {
        CommandError::new(
            "REDMOD_SPAWN",
            format!("无法启动 redMod.exe：{err}。请确认游戏目录没有被杀软拦写。"),
        )
    })?;

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    Ok(DeployOutcome {
        exit_code: output.status.code(),
        output: text.trim().to_string(),
    })
}

/// 一次完整的 REDmod 同步结果，供命令层拼装提示文案。
pub struct SyncReport {
    /// 本次写了几个 mod 进 modlist。
    pub mod_count: usize,
    /// 是否因为「纯重排」清空了缓存再重建。
    pub rebuilt: bool,
}

/// 是否值得跑一次 redMod。
///
/// 没有已启用的 REDmod、盘上也没有非空 modlist 时直接跳过：白白调用一次
/// redMod 会把 `r6/cache/modded` 重建成空目录，反而破坏用户手工部署的成果。
pub fn should_run(view: &RedmodView, game_root: &Path) -> bool {
    if !enabled_folders(view).is_empty() {
        return true;
    }
    let previous = read_modlist(&game_root.join(MODLIST_RELATIVE));
    !matches!(previous, Some(ref list) if list.is_empty())
}

/// 按当前状态同步 modlist.txt 并执行 redMod 部署。
///
/// 调用约定：**不要在持有 store 锁时调用**（redMod 可能跑几十秒）。
pub fn sync(view: &RedmodView, game_root: &Path) -> AppResult<SyncReport> {
    let _gate = DEPLOY_GATE.lock().unwrap_or_else(|err| err.into_inner());

    let folders = enabled_folders(view);
    let modlist_path = game_root.join(MODLIST_RELATIVE);
    // 先留一份原文：清缓存失败时要把 modlist 回滚，否则下次判定的基准就变成
    // 「刚写进去的新内容」，与新集合必然相等 → `needs_rebuild` 永远 false，
    // 于是 r6/cache/modded 里的旧产物一直留着（2026-11-06 审计 P1-2）。
    let previous_bytes = fs::read(&modlist_path).ok();
    let previous = read_modlist(&modlist_path);
    write_modlist(game_root, &folders)?;

    // 「文件读不出来」时必须重建：已部署顺序不可知，redMod 可能沿用错误产物。
    let rebuilt = match &previous {
        None => true,
        Some(list) => needs_rebuild(list, &folders),
    };
    if rebuilt {
        if let Err(err) = clear_cache(game_root) {
            match &previous_bytes {
                Some(bytes) => {
                    let _ = fs::write(&modlist_path, bytes);
                }
                None => {
                    let _ = fs::remove_file(&modlist_path);
                }
            }
            return Err(err);
        }
    }

    let outcome = run_deploy(game_root)?;
    if outcome.exit_code != Some(0) {
        return Err(CommandError::new(
            "REDMOD_DEPLOY_FAILED",
            format!(
                "模组文件已就位，但 REDmod 部署失败：{}",
                failure_reason(outcome.exit_code, &outcome.output)
            ),
        ));
    }

    Ok(SyncReport {
        mod_count: folders.len(),
        rebuilt,
    })
}

/// 启动游戏前的强制同步：REDmod 顺序 / 集合变了就必须先重建缓存。
///
/// 与 `flush_into` 的分工很明确：那个是「命令收尾」，失败只记 warning，因为
/// 模组文件已经就位、REDmod 编译失败不该连带把「装了个 archive」报成错误；
/// 这个在**启动前**跑，`r6/cache/modded` 落后于 `V2077/modlist.txt` 时游戏会按
/// 上一套加载，而且它自己不报错——玩家只会觉得"我明明启用了却不生效"。所以
/// 这里失败必须上抛，由调用方拦下启动。
///
/// 返回值 = 是否真的重建了缓存（供界面拼一条说明）。
pub fn sync_before_launch(store: &Store, game_root: &Path) -> AppResult<bool> {
    match flush(store, game_root)? {
        Some(report) => Ok(report.rebuilt),
        None => Ok(false),
    }
}

/// 命令收尾：把待同步的 REDmod 变化真正落到 `r6/cache/modded`，结果并入 warnings。
///
/// 调用时机固定在**拿完快照、释放 store 锁之后**——redMod 是个外部进程，
/// 可能跑几十秒，持锁调用会把整个界面卡死。
///
/// 失败只往 warnings 里推一条，不阻断主操作：模组文件已经就位，REDmod 编译
/// 失败是另一件事，不该让「装了一个 archive」跟着一起报错。
pub fn flush_into(store: &Store, game_dir: Option<&str>, warnings: &mut Vec<String>) {
    if !is_dirty() {
        return;
    }
    let Some(root) = game_dir else {
        return;
    };
    match flush(store, Path::new(root)) {
        Ok(Some(report)) => {
            if report.rebuilt {
                warnings.push(format!(
                    "REDmod 加载顺序有变化，已重建缓存（共 {} 个 REDmod）。",
                    report.mod_count
                ));
            }
        }
        Ok(None) => {}
        Err(err) => warnings.push(err.message),
    }
}

/// 从 store 取一份状态快照后同步（自己管锁，锁外执行外部进程）。
pub fn sync_from_store(store: &Store, game_root: &Path) -> AppResult<Option<SyncReport>> {
    let view = {
        let data = store.data.lock().expect("state mutex poisoned");
        let view = RedmodView::from_state(&data);
        if !should_run(&view, game_root) {
            return Ok(None);
        }
        view
    };
    sync(&view, game_root).map(Some)
}

/// 归一化 REDmod 加载顺序：去重、剔除不存在的 id、补上未登记的条目。
///
/// 前端拖完顺序后调用，保证存下来的是一份自洽的列表，而不是「拖到一半」的脏数据。
pub fn normalize_order(state: &AppStateData, requested: &[String]) -> Vec<String> {
    let known: HashSet<&str> = state
        .mods
        .iter()
        .filter(|entry| entry.layout == InstallLayout::Redmod)
        .map(|entry| entry.id.as_str())
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut ordered: Vec<String> = Vec::new();
    for id in requested {
        if known.contains(id.as_str()) && seen.insert(id.clone()) {
            ordered.push(id.clone());
        }
    }
    let mut rest: Vec<&ModEntry> = state
        .mods
        .iter()
        .filter(|entry| {
            entry.layout == InstallLayout::Redmod && !seen.contains(entry.id.as_str())
        })
        .collect();
    rest.sort_by_key(|entry| {
        folder_of(entry)
            .unwrap_or_else(|| entry.name.clone())
            .to_ascii_lowercase()
    });
    ordered.extend(rest.into_iter().map(|entry| entry.id.clone()));
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_args_put_root_as_separate_flag() {
        let args = deploy_args(Path::new("D:\\game"));
        assert_eq!(args[0], "deploy");
        assert_eq!(args[1], "-reportProgress");
        assert_eq!(args[2], "-root");
        assert_eq!(args[3], "D:\\game");
        assert!(args[4].starts_with("-rttiSchemaPath="));
        assert!(args[5].starts_with("-modlist="));
        // redMod 不认 `-root=xxx`。
        assert!(!args.iter().any(|arg| arg.starts_with("-root=")));
    }

    #[test]
    fn modlist_is_crlf_without_trailing_newline() {
        let dir = std::env::temp_dir().join(format!(
            "cdl-redmod-list-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let folders = vec!["Alpha".to_string(), "Beta".to_string()];
        let path = write_modlist(&dir, &folders).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "Alpha\r\nBeta");
        assert!(!raw.ends_with('\n'));
        assert!(!raw.starts_with('\u{feff}'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_modlist_is_zero_byte_file() {
        let dir = std::env::temp_dir().join(format!(
            "cdl-redmod-empty-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = write_modlist(&dir, &[]).unwrap();
        assert_eq!(fs::read(&path).unwrap().len(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebuild_only_when_set_unchanged_but_order_flipped() {
        let a = vec!["A".to_string(), "B".to_string()];
        let b = vec!["B".to_string(), "A".to_string()];
        assert!(needs_rebuild(&a, &b));
        // 完全相同 → 不用重建
        assert!(!needs_rebuild(&a, &a));
        // 集合变了 → redMod 自己会察觉，不用清缓存
        assert!(!needs_rebuild(&a, &vec!["A".to_string()]));
        // 大小写不同不算重排（Windows 路径不区分大小写）
        assert!(!needs_rebuild(&a, &vec!["a".to_string(), "b".to_string()]));
        // 大小写不同 + 顺序翻转 → 仍然要重建
        assert!(needs_rebuild(&a, &vec!["b".to_string(), "a".to_string()]));
    }

    #[test]
    fn interrupted_exit_code_is_reported_as_interruption() {
        let reason = failure_reason(Some(INTERRUPTED_CODE), "");
        assert!(reason.contains("中断"), "{reason}");
    }

    #[test]
    fn failure_reason_takes_line_before_failed_marker() {
        let output = "[DEPLOY] building mods\nSomething went wrong here\nCommandlet deploy has failed.";
        assert_eq!(
            failure_reason(Some(1), output),
            "Something went wrong here"
        );
    }

    #[test]
    fn failure_reason_falls_back_to_exit_code() {
        let output = "[DEPLOY] still working\nCommandlet deploy has failed.";
        let reason = failure_reason(Some(2), output);
        assert!(reason.contains('2'), "{reason}");
    }

    #[test]
    fn missing_toolchain_is_reported_with_both_paths() {
        let dir = std::env::temp_dir().join(format!(
            "cdl-redmod-probe-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let err = probe_toolchain(&dir).unwrap_err();
        assert!(err.contains("redMod.exe"), "{err}");
        assert!(err.contains("metadata.json"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_modlist_missing_file_is_empty_not_unknown() {
        let dir = std::env::temp_dir().join(format!(
            "cdl-redmod-read-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_modlist(&dir.join("nope.txt")), Some(Vec::new()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_modlist_tolerates_lf_and_crlf() {
        let dir = std::env::temp_dir().join(format!(
            "cdl-redmod-mixed-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("modlist.txt");
        fs::write(&path, "A\r\nB\nC").unwrap();
        assert_eq!(
            read_modlist(&path),
            Some(vec!["A".to_string(), "B".to_string(), "C".to_string()])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 最小 REDmod 记录：只填顺序推导用得到的字段。
    fn redmod_entry(id: &str, folder: &str, enabled: bool) -> ModEntry {
        ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: folder.to_string(),
            version: None,
            author: None,
            category: "其他".to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: None,
            staging_path: format!("staging/{id}"),
            cover_path: None,
            enabled,
            installed_at: crate::store::now_iso(),
            updated_at: None,
            size_bytes: 0,
            file_count: 0,
            layout: InstallLayout::Redmod,
            mod_folder: Some(folder.to_string()),
            metadata_source: "test".to_string(),
            planned_files: Vec::new(),
            warnings: Vec::new(),
            deployed_files: Vec::new(),
            has_archive: false,
            has_redmod: true,
            has_cet: false,
            translated_name: None,
            translated_at: None,
            translated_by: None,
            managed: true,
            origin: "cyberdeck".to_string(),
            modpack_id: None,
            nexus_cover_url: None,
            is_translation: false,
            parent_mod_id: None,
            ai_loc: None,
            ai_fix: Vec::new(),
        }
    }

    #[test]
    fn enabled_folders_follow_stored_order_and_skip_disabled() {
        let view = RedmodView {
            order: vec!["b".to_string(), "a".to_string()],
            mods: vec![
                redmod_entry("a", "Alpha", true),
                redmod_entry("b", "Beta", true),
                redmod_entry("c", "Gamma", false),
            ],
        };
        // 顺序来自 redmod_order；禁用的不进 modlist。
        assert_eq!(
            enabled_folders(&view),
            vec!["Beta".to_string(), "Alpha".to_string()]
        );
    }

    #[test]
    fn enabled_folders_appends_unlisted_mods_alphabetically() {
        let view = RedmodView {
            order: vec!["b".to_string()],
            mods: vec![
                redmod_entry("a", "zeta", true),
                redmod_entry("b", "Beta", true),
                redmod_entry("c", "alpha", true),
            ],
        };
        // 未登记的按文件夹名排序补在后面，不能悄悄丢。
        assert_eq!(
            enabled_folders(&view),
            vec![
                "Beta".to_string(),
                "alpha".to_string(),
                "zeta".to_string()
            ]
        );
    }

    #[test]
    fn enabled_folders_dedupe_case_insensitive_names() {
        let view = RedmodView {
            order: Vec::new(),
            mods: vec![
                redmod_entry("a", "SameMod", true),
                redmod_entry("b", "samemod", true),
            ],
        };
        // 同名两份会让 redMod 互相覆盖，只保留第一个。
        assert_eq!(enabled_folders(&view), vec!["SameMod".to_string()]);
    }

    #[test]
    fn enabled_folders_is_stable_across_calls() {
        // 回归防线：`pending` 是 HashMap，每次新建都换随机种子，迭代顺序会变。
        // 排序键只用小写名时 `SameMod` / `samemod` 并列，谁排前面取决于 HashMap
        // 的迭代顺序，于是保留下来的大小写（乃至 modlist.txt 的全文）每次都可能不同。
        // 单次断言抓不稳这种问题，这里连跑多轮比对。
        let view = RedmodView {
            order: Vec::new(),
            mods: vec![
                redmod_entry("a", "SameMod", true),
                redmod_entry("b", "samemod", true),
                redmod_entry("c", "Beta", true),
                redmod_entry("d", "alpha", true),
            ],
        };
        let first = enabled_folders(&view);
        for round in 0..32 {
            assert_eq!(
                enabled_folders(&view),
                first,
                "第 {round} 轮结果与首轮不一致：同一份状态必须每次写出同一份 modlist.txt"
            );
        }
    }

    #[test]
    fn normalize_order_drops_unknown_and_appends_rest() {
        let mut state = AppStateData::new("staging".to_string());
        state.mods = vec![
            redmod_entry("a", "Alpha", true),
            redmod_entry("b", "Beta", true),
            redmod_entry("c", "Gamma", true),
        ];
        // 前端给了：未知 id、重复 id、缺失项。
        let requested = vec![
            "c".to_string(),
            "ghost".to_string(),
            "c".to_string(),
            "a".to_string(),
        ];
        assert_eq!(
            normalize_order(&state, &requested),
            vec!["c".to_string(), "a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn normalize_order_ignores_non_redmod_layouts() {
        let mut state = AppStateData::new("staging".to_string());
        let mut archive = redmod_entry("x", "ArchiveMod", true);
        archive.layout = InstallLayout::Archive;
        state.mods = vec![redmod_entry("a", "Alpha", true), archive];
        assert_eq!(
            normalize_order(&state, &["x".to_string()]),
            vec!["a".to_string()]
        );
    }
}
