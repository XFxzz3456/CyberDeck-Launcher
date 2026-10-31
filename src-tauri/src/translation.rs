//! 附属汉化包（translation child pack）识别与安全规则。
//!
//! Nexus 上大量中文 Mod 是「原版 + 额外汉化包」两个条目。传统管理器会把汉化包
//! 当成「重复 Mod / 文件冲突」亮红灯，玩家要么不敢装，要么装了以后被自己的
//! 冲突检测劝退。这里做三件小事：
//!
//! 1. **识别**：按名字/文件名里的关键词初判「疑似汉化包」，只做标记，不替用户
//!    决定——识别错了用户可以在界面里改绑。
//! 2. **合法性边界**：汉化包覆盖原版同名文件是**合法覆盖**，不是冲突；
//!    但如果它带了模型/贴图/实体资源，那就不是纯汉化了，必须黄灯提示。
//! 3. **级联**：父级禁用/卸载时子级要跟随，否则会留下一个失去宿主、
//!    仍在往游戏目录写文件的孤儿。
//!
//! 这里不碰任何状态文件：字段读写由 `schema.rs` 的 `ModEntry` 承担。

use std::collections::HashSet;

/// 汉化包关键词。
///
/// 分两类处理（与 `ai::is_framework_name` 同一套思路）：
/// - **长词**（> 3 字符）用「包含」匹配：`简体中文`、`translation`、`汉化` 这类
///   词不会出现在别的语义里，包含即可。
/// - **短词**（<= 3 字符：`cn` / `chs` / `cht`）只在**词边界**上匹配，否则
///   `Contact Names`、`CnC` 这类正常名字会被误判。
///
/// 为什么不用「中文两个字 + translation」以外的判断：作者怎么命名完全无法约束，
/// 这套词表只负责"提一句"，最终的父子关系由用户在绑定弹窗里确认。
const LONG_KEYWORDS: &[&str] = &[
    "translation",
    "translate",
    "localization",
    "localisation",
    "chinese",
    "汉化",
    "汉化包",
    "中文补丁",
    "简体中文",
    "中文本地化",
    "繁体中文",
];

const SHORT_KEYWORDS: &[&str] = &["cn", "chs", "cht", "zhcn", "zhtw"];

/// 判断某个 Mod 名 / 压缩包文件名是否像汉化包。
///
/// `haystacks` 通常传两个：Mod 名、原始 ZIP 文件名。两者都要看——有人把 ZIP
/// 改名为中文，也有人只在 ZIP 名里写 `_CHS`。
pub fn looks_like_translation<I, S>(haystacks: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut tokens_union: HashSet<String> = HashSet::new();
    let mut joined = String::new();
    for haystack in haystacks {
        let lowered = haystack.as_ref().to_lowercase();
        if lowered.trim().is_empty() {
            continue;
        }
        joined.push(' ');
        joined.push_str(&lowered);
        for token in lowered.split(|ch: char| !ch.is_ascii_alphanumeric()) {
            if !token.is_empty() {
                tokens_union.insert(token.to_string());
            }
        }
    }
    if joined.trim().is_empty() {
        return false;
    }

    if LONG_KEYWORDS.iter().any(|word| joined.contains(word)) {
        return true;
    }
    // 短词：整词相等，或 `chs`/`cn` 直接抵在中文边界上（`CHS汉化`）。
    SHORT_KEYWORDS.iter().any(|word| {
        tokens_union.contains(*word) || joined.contains(&format!("{word}汉"))
    })
}

/// 非文本资源后缀：这些文件一出现，就说明「汉化包」改的不只是文本。
///
/// 只列**确定属于美术/实体资源**的后缀。`.archive` 与 `.xl` 故意不算——
/// 汉化最常见的落后做法就是直接覆盖一个 `.archive`，把它们算成非文本会让
/// 几乎每个汉化包都亮黄灯，警告随即失去意义。
const NON_TEXT_EXTENSIONS: &[&str] = &[
    ".mesh",
    ".w2mesh",
    ".xbm",
    ".dds",
    ".mi",
    ".rig",
    ".anims",
    ".ent",
    ".w2ent",
    ".app",
    ".bnk",
    ".wem",
    ".opus",
];

/// 返回前若干个「不像文本」的文件路径，用于部署前的黄灯提示。
/// 只取前 `limit` 个，避免一个美术整合包刷出几百行。
pub fn non_text_files<'a, I>(paths: I, limit: usize) -> Vec<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut out = Vec::new();
    for path in paths {
        let lowered = path.replace('\\', "/").to_lowercase();
        if NON_TEXT_EXTENSIONS
            .iter()
            .any(|extension| lowered.ends_with(extension))
        {
            out.push(path.to_string());
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// 部署前给汉化包的警告文案。返回 None 表示没有需要提醒的东西。
pub fn translation_warning(paths: &[String]) -> Option<String> {
    let hits = non_text_files(paths.iter().map(String::as_str), 3);
    if hits.is_empty() {
        return None;
    }
    Some(format!(
        "这个汉化包包含非文本资源（{}），可能覆盖原版的模型或贴图，而不只是改语言。部署前请确认它确实只是汉化。",
        hits.join("、")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_chinese_keywords() {
        assert!(looks_like_translation(["Cyberpunk 2077 汉化包"]));
        assert!(looks_like_translation(["Cool Outfit CHS"]));
        assert!(looks_like_translation(["Cool Outfit - Chinese Translation"]));
        assert!(looks_like_translation(["mod_zh-cn"]));
        assert!(looks_like_translation(["CET汉化"]));
    }

    /// 短词必须按词边界判定，否则 `Contact Names` / `CnC` 会被误判成汉化包。
    #[test]
    fn short_tokens_need_word_boundary() {
        assert!(!looks_like_translation(["Contact Names"]));
        assert!(!looks_like_translation(["CnC Redux"]));
        assert!(!looks_like_translation(["Cool Outfit"]));
        assert!(looks_like_translation(["Cool Outfit (CN)"]));
    }

    /// ZIP 名里有 `_CHS` 同样要认出来——很多人只会改压缩包名。
    #[test]
    fn checks_zip_name_too() {
        assert!(looks_like_translation(["Cool Outfit", "cool_outfit_CHS.zip"]));
        assert!(!looks_like_translation(["Cool Outfit", "cool_outfit.zip"]));
    }

    #[test]
    fn empty_input_is_not_translation() {
        assert!(!looks_like_translation([""]));
        assert!(!looks_like_translation(Vec::<String>::new()));
    }

    #[test]
    fn non_text_assets_are_flagged() {
        let paths = vec![
            "archive/pc/mod/cool.xl".to_string(),
            "archive/pc/mod/cool.archive".to_string(),
            "archive/pc/mod/cool_mesh.mesh".to_string(),
        ];
        let hits = non_text_files(paths.iter().map(String::as_str), 5);
        assert_eq!(hits, vec!["archive/pc/mod/cool_mesh.mesh".to_string()]);
        let warning = translation_warning(&paths).expect("应该给出警告");
        assert!(warning.contains("非文本资源"));
    }

    /// `.archive` / `.xl` 不算非文本：否则每个汉化包都会黄灯。
    #[test]
    fn archive_and_xl_are_text_allowed() {
        let paths = vec![
            "archive/pc/mod/zh.archive".to_string(),
            "archive/pc/mod/zh.xl".to_string(),
        ];
        assert!(non_text_files(paths.iter().map(String::as_str), 5).is_empty());
        assert!(translation_warning(&paths).is_none());
    }
}
