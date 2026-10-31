//! Mod 版本号比较（P5-5A）。
//!
//! 为什么不用 `compat::parse_version`：那个是**游戏 CL 版本**专用的按字符位解析
//! （`2.21` → `[2, 2, 1]`，因为 CDPR 的 2.21 表示 2.2.1）。Mod 版本是常规语义化
//! 版本（`2.21` 就是二点二一，比 `2.5` 新），两套规则混用必然误判。
//!
//! 规则：
//! - 先剥掉前导 `v` / `V`；
//! - 按 `.` `_` `-` `+` 空格切段；
//! - 两段都是纯数字 → 按数值比（`10` > `9`，不是字符串比）；
//! - 数字段带字母尾巴（`3b` / `1a2`）→ 先比数字部分，数字相同再比尾巴（无尾 < 有尾）；
//! - 其它情况按小写字符串比；
//! - 短的一方缺段视为 `0`：`1.0` == `1.0.0`（避免「版本格式多写个 .0」被误报成有更新）。

use std::cmp::Ordering;

/// 把版本号切成可比片段：数字段与字母段分开，方便逐段比较。
fn segments(raw: &str) -> Vec<Segment> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let mut out: Vec<Segment> = Vec::new();
    let mut token = String::new();
    let push_token = |token: &mut String, out: &mut Vec<Segment>| {
        if token.is_empty() {
            return;
        }
        let piece = token.clone();
        token.clear();
        // 数字开头：拆成「数字 + 可选字母尾巴」，让 3b 与 3 只差在尾巴上。
        let digit_end = piece
            .char_indices()
            .find(|(_, ch)| !ch.is_ascii_digit())
            .map(|(idx, _)| idx)
            .unwrap_or(piece.len());
        if digit_end > 0 {
            if let Ok(number) = piece[..digit_end].parse::<u64>() {
                out.push(Segment::Number(number));
            }
            let tail = piece[digit_end..].trim();
            if !tail.is_empty() {
                out.push(Segment::Text(tail.to_ascii_lowercase()));
            }
        } else {
            out.push(Segment::Text(piece.to_ascii_lowercase()));
        }
    };

    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            token.push(ch);
        } else {
            push_token(&mut token, &mut out);
        }
    }
    push_token(&mut token, &mut out);
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Number(u64),
    Text(String),
}

impl Segment {
    fn is_zero(&self) -> bool {
        matches!(self, Segment::Number(0)) || matches!(self, Segment::Text(text) if text.is_empty())
    }

    fn compare(&self, other: &Segment) -> Ordering {
        match (self, other) {
            (Segment::Number(left), Segment::Number(right)) => left.cmp(right),
            // 数字 vs 字母：数字更大（`1.0` > `1.0-beta` 的尾巴段场景）。
            (Segment::Number(_), Segment::Text(_)) => Ordering::Greater,
            (Segment::Text(_), Segment::Number(_)) => Ordering::Less,
            (Segment::Text(left), Segment::Text(right)) => left.cmp(right),
        }
    }
}

/// 预发布标记：`1.0-beta` 应当比正式版 `1.0` **旧**。
/// 而 `1.2.3b` 这类「热修尾字母」是**更新**的构建 —— 两者规则相反，
/// 只能靠关键词区分（字母尾巴不带这些词就不是预发布）。
fn is_prerelease(text: &str) -> bool {
    ["alpha", "beta", "rc", "pre", "preview", "dev", "snapshot"]
        .iter()
        .any(|word| text.starts_with(word))
}

/// 比较两个 Mod 版本号。`a` 比 `b` 新则返回 `Greater`。
pub fn compare(a: &str, b: &str) -> Ordering {
    let left = segments(a);
    let right = segments(b);
    let len = left.len().max(right.len());
    for index in 0..len {
        let l = left.get(index);
        let r = right.get(index);
        let ordering = match (l, r) {
            (Some(l), Some(r)) => l.compare(r),
            // 一侧已结束：另一侧剩下的段如果全是 0，视为等价（1.0 == 1.0.0）；
            // 剩下的段是预发布关键词则更旧（1.0-beta < 1.0），否则更新（1.0.1 > 1.0）。
            (Some(l), None) => match l {
                _ if l.is_zero() => Ordering::Equal,
                Segment::Text(text) if is_prerelease(text) => Ordering::Less,
                _ => Ordering::Greater,
            },
            (None, Some(r)) => match r {
                _ if r.is_zero() => Ordering::Equal,
                Segment::Text(text) if is_prerelease(text) => Ordering::Greater,
                _ => Ordering::Less,
            },
            (None, None) => Ordering::Equal,
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

/// 候选版本是否比当前版本新。任一为空一律返回 false——宁可漏报，
/// 也不要把「没存版本」当成「有新版本」。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    if candidate.trim().is_empty() || current.trim().is_empty() {
        return false;
    }
    compare(candidate, current) == Ordering::Greater
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_trailing_zero_is_equal() {
        assert_eq!(compare("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare("2.1", "2.1.0.0"), Ordering::Equal);
        assert!(!is_newer("1.0.0", "1.0"));
        assert!(!is_newer("1.0", "1.0.0"));
    }

    #[test]
    fn compares_numerically_not_lexically() {
        assert_eq!(compare("1.10", "1.9"), Ordering::Greater);
        assert_eq!(compare("2.21", "2.5"), Ordering::Greater);
        assert_eq!(compare("0.9", "0.10"), Ordering::Less);
    }

    #[test]
    fn handles_prefix_and_separators() {
        assert_eq!(compare("v1.2", "1.2"), Ordering::Equal);
        assert_eq!(compare("1_2_3", "1.2.3"), Ordering::Equal);
        assert_eq!(compare("1.2-4", "1.2.4"), Ordering::Equal);
    }

    #[test]
    fn letter_suffix_is_newer_than_bare_number() {
        assert_eq!(compare("1.2.3b", "1.2.3"), Ordering::Greater);
        assert_eq!(compare("1.2.3b", "1.2.3a"), Ordering::Greater);
        assert_eq!(compare("1.0-beta", "1.0"), Ordering::Less);
        assert_eq!(compare("1.0.1", "1.0"), Ordering::Greater);
        assert_eq!(compare("2.0-rc1", "2.0"), Ordering::Less);
    }

    #[test]
    fn empty_versions_never_claim_update() {
        assert!(!is_newer("", "1.0"));
        assert!(!is_newer("1.0", ""));
        assert_eq!(compare("", "0"), Ordering::Equal);
    }
}
