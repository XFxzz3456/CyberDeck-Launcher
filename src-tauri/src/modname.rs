//! Mod 展示名清洗。
//!
//! 导入时如果拿不到 REDmod `info.json` 或 Nexus 元数据，`name` 只能取压缩包 /
//! 文件夹名。真实模组文件名普遍带装饰前缀和分隔符：
//! `!!!!_mime.archive`、`#_scorpion_zenitex_core_dependency`，直接上列表非常难读。
//!
//! 这里只清洗**展示名**。内部 id、暂存路径、部署清单、modlist 写入全部不受影响
//! （modlist.txt 用的是 archive 相对路径里的文件名，不读 `name`）。原始文件名另存
//! `ModEntry::raw_name`，详情页留给要对照真实文件排错的高级玩家。

/// 需要剥掉的文件后缀。`.archive` 是 Cyberpunk 的模组实体后缀，`.zip/.7z/.rar`
/// 是玩家手动改过名的压缩包；`mod` 从长到短匹配，避免 `.archive.zip` 只剥一层。
const STRIPPED_EXTS: [&str; 6] = [".archive", ".zip", ".7z", ".rar", ".pak", ".redmod"];

/// 开头的装饰符。玩家习惯用 `!!!` / `#` 把模组顶到资源管理器列表最前面，
/// 这些东西没有任何语义，展示时一律剥掉。
const LEADING_NOISE: &[char] = &[
    '!', '#', '$', '%', '&', '*', '+', '~', '^', '@', '=', '_', '-', '.', ' ', '\u{3000}', '[',
    ']', '(', ')', '{', '}',
];

/// 把「文件名形态」的原始名清洗成给人看的展示名。
///
/// 清洗后如果是空串（例如原名就是一串 `!!!!`），回退返回原字符串 —— 宁可难看，
/// 也不能让界面出现空标题。
pub fn polish(raw: &str) -> String {
    let original = raw.trim();
    if original.is_empty() {
        return String::new();
    }

    let stem = strip_extensions(original);
    let body = stem.trim_start_matches(LEADING_NOISE);
    if body.is_empty() {
        return original.to_string();
    }

    // 下划线是文件名里最常见的分隔符，换成空格；顺手压掉连续空白，
    // 否则 `#_scorpion__core` 会展示成「Scorpion  Core」。
    let mut spaced = String::with_capacity(body.len());
    let mut prev_space = false;
    for ch in body.chars() {
        let ch = if ch == '_' { ' ' } else { ch };
        if ch.is_whitespace() {
            if !prev_space {
                spaced.push(' ');
                prev_space = true;
            }
        } else {
            spaced.push(ch);
            prev_space = false;
        }
    }

    let spaced = spaced.trim();
    if spaced.is_empty() {
        return original.to_string();
    }

    let polished = spaced
        .split(' ')
        .map(title_case_word)
        .collect::<Vec<_>>()
        .join(" ");
    let polished = polished.trim();
    if polished.is_empty() {
        original.to_string()
    } else {
        polished.to_string()
    }
}

fn strip_extensions(raw: &str) -> &str {
    let mut current = raw;
    loop {
        let lower = current.to_ascii_lowercase();
        let mut hit = false;
        for ext in STRIPPED_EXTS {
            if lower.ends_with(ext) && lower.len() > ext.len() {
                current = &current[..current.len() - ext.len()];
                hit = true;
                break;
            }
        }
        if !hit {
            return current;
        }
    }
}

/// 单个词的格式美化。
///
/// 只在「词里一个字母都没大写」时才补首字母大写：
/// - `mime` → `Mime`、`natural` → `Natural`
/// - `CyberDeck` / `ReShade` / `CET` → 原样，作者已经定过写法，改成 `Cyberdeck`
///   反而像 bug
/// - `0sp0` / `4k` / `2.0` → 原样，数字开头补大写没有意义
fn title_case_word(word: &str) -> String {
    if word.chars().any(|ch| ch.is_ascii_uppercase()) || !word.is_ascii() {
        return word.to_string();
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {
            let mut out = String::with_capacity(word.len());
            out.push(first.to_ascii_uppercase());
            out.push_str(chars.as_str());
            out
        }
        _ => word.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::polish;

    #[test]
    fn strips_decorative_prefix_and_extension() {
        // 需求文档「三、UI 表现预期」的三个例子，逐条对死。
        assert_eq!(polish("!!!!_mime.archive"), "Mime");
        assert_eq!(
            polish("#_scorpion_zenitex_core_dependency"),
            "Scorpion Zenitex Core Dependency"
        );
        assert_eq!(polish("_0sp0_natural_breast"), "0sp0 Natural Breast");
    }

    #[test]
    fn keeps_author_casing_and_acronyms() {
        assert_eq!(polish("CyberDeck_Tools_v1.2"), "CyberDeck Tools V1.2");
        assert_eq!(polish("CET_keybinds"), "CET Keybinds");
        assert_eq!(polish("archivexl-patch.7z"), "Archivexl-patch");
    }

    #[test]
    fn falls_back_to_original_when_nothing_is_left() {
        // 剥完只剩空串：必须原样返回，不能给界面一个空标题。
        assert_eq!(polish("!!!!"), "!!!!");
        assert_eq!(polish("....archive"), "....archive");
        assert_eq!(polish("   "), "");
    }

    #[test]
    fn plain_names_pass_through_unchanged() {
        // 已经是正常英文标题的名字不应被二次加工（幂等）。
        for name in [
            "Scorpion Zenitex Core Dependency",
            "Cyberpunk 2077",
            "mime",
            "0sp0 Natural Breast",
        ] {
            let once = polish(name);
            assert_eq!(polish(&once), once, "{name} 清洗不幂等");
        }
        assert_eq!(polish("mime"), "Mime");
    }
}
