//! 游戏内部版本号 → 社区版本叫法。
//!
//! 为什么需要这一层：`Cyberpunk2077.exe` 的文件版本是 CDPR 的内部四段号
//! （实测 `3.0.88.46235`），而玩家、Mod 作者、Nexus 页面上说的都是「2.5」
//! 「2.4」这类市场版本号。界面直接显示 `3.0.88.46235` 等于给用户一串看不懂
//! 的数字，排查兼容性问题时也没法跟作者对话；只截前三段又会得到 `3.0`，
//! 比原文更误导（看着像"3.0 版本的游戏"）。
//!
//! 维护方式：**这是一张数据表，不是逻辑**。CDPR 发新版本时按实测的四段号
//! 往 [`INTERNAL_FLOORS`] 里补一行（从高到低排列，取第一个 `patch >= floor`
//! 的桶），无需改判定代码。
//!
//! ⚠️ 阈值只按「3.0 线的第三段」分桶：`3.0.80.x` 起是 2.5；`3.0.7x` 是 2.4；
//! 依次往下降到 `3.0.3x` 的 2.0；再老的一律「旧版 (2.0 及以下)」。
//! 实测 3.0.88 落在 2.5 桶里，符合「2.5 的热修版本」这一事实。

use serde::{Deserialize, Serialize};

/// 内部版本第三段 → 社区版本。`patch` 为下界（含），必须从高到低排列。
const INTERNAL_FLOORS: &[(u32, &str)] = &[
    (80, "2.5"),
    (70, "2.4"),
    (60, "2.3"),
    (50, "2.2"),
    (40, "2.1"),
    (30, "2.0"),
];

/// 低于所有桶时的兜底标签。
pub const LEGACY_LABEL: &str = "旧版 (2.0 及以下)";
/// 完全认不出来时的标签。
pub const UNKNOWN_LABEL: &str = "未知版本";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersionInfo {
    /// 原始版本串（`3.0.88.46235`）。界面上放进 title 供排查时对照。
    pub raw: String,
    /// 社区叫法（`2.5` / `旧版 (2.0 及以下)` / `未知版本`）。
    pub label: String,
    /// 是否命中已知映射。false = label 是兜底值，界面应避免据此下结论。
    pub matched: bool,
    /// 是否是 CDPR 内部四段号（true 表示 label 来自映射表而不是原样透传）。
    pub internal: bool,
}

/// 把版本串拆成数字段：`3.0.88.46235` → `[3, 0, 88, 46235]`。
fn segments(raw: &str) -> Vec<u32> {
    raw.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '_', ' ', '(', ')'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u32>().unwrap_or(0)
        })
        .collect()
}

/// 主入口：任意版本串 → [`GameVersionInfo`]。
pub fn describe(raw: &str) -> GameVersionInfo {
    let value = raw.trim().to_string();
    let parts = segments(&value);

    // 空串 / 解析不出任何数字：明确说"未知"，不猜。
    if parts.is_empty() || value.is_empty() {
        return GameVersionInfo {
            raw: value,
            label: UNKNOWN_LABEL.to_string(),
            matched: false,
            internal: false,
        };
    }

    // 1) CDPR 内部号：3.0.x.y —— 按第三段查表。
    if parts[0] == 3 && parts.get(1).copied().unwrap_or(0) == 0 {
        let patch = parts.get(2).copied().unwrap_or(0);
        for (floor, label) in INTERNAL_FLOORS {
            if patch >= *floor {
                return GameVersionInfo {
                    raw: value,
                    label: (*label).to_string(),
                    matched: true,
                    internal: true,
                };
            }
        }
        return GameVersionInfo {
            raw: value,
            label: LEGACY_LABEL.to_string(),
            matched: true,
            internal: true,
        };
    }

    // 2) 少数安装包/存档直接写市场号（2.21 / 2.5）：原样透传前两段。
    if parts[0] == 2 {
        let label = match parts.get(1) {
            Some(minor) => format!("{}.{minor}", parts[0]),
            None => parts[0].to_string(),
        };
        return GameVersionInfo {
            raw: value,
            label,
            matched: true,
            internal: false,
        };
    }

    // 3) 其它（未来的 4.x 内部号、乱码）：不猜，交给界面显示"未知版本"。
    GameVersionInfo {
        raw: value,
        label: UNKNOWN_LABEL.to_string(),
        matched: false,
        internal: false,
    }
}

/// 只要标签的便捷封装（当前仅测试与断言脚本使用）。
#[cfg(test)]
pub fn label(raw: &str) -> String {
    describe(raw).label
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测值：玩家机器上 Cyberpunk2077.exe 的文件版本。
    #[test]
    fn real_internal_version_maps_to_25() {
        let info = describe("3.0.88.46235");
        assert_eq!(info.label, "2.5");
        assert!(info.matched && info.internal);
        assert_eq!(info.raw, "3.0.88.46235", "原始号要留住，界面放进 title");
    }

    #[test]
    fn internal_buckets_cover_every_generation() {
        assert_eq!(label("3.0.80.51928"), "2.5");
        assert_eq!(label("3.0.79.1"), "2.4");
        assert_eq!(label("3.0.74.1"), "2.4");
        assert_eq!(label("3.0.65.1"), "2.3");
        assert_eq!(label("3.0.55.1"), "2.2");
        assert_eq!(label("3.0.45.1"), "2.1");
        assert_eq!(label("3.0.31.1"), "2.0");
    }

    /// 比所有桶都老：给一个明确的"旧版"结论，而不是把 3.0.x 直接怼给用户。
    #[test]
    fn ancient_internal_build_is_legacy_not_30() {
        let info = describe("3.0.12.1");
        assert_eq!(info.label, LEGACY_LABEL);
        assert!(info.matched);
        assert_ne!(info.label, "3.0", "绝不能退化成前三段截取");
    }

    /// 市场号原样透传：`2.21` 必须还是 `2.21`，不能被当成内部号重算。
    #[test]
    fn market_numbers_pass_through() {
        assert_eq!(label("2.21"), "2.21");
        assert_eq!(label("2.5"), "2.5");
        assert_eq!(label("v2.5.0"), "2.5");
    }

    /// 认不出来时明确 unknown，且 matched=false，界面不会拿它下结论。
    #[test]
    fn unrecognized_versions_are_flagged_not_guessed() {
        for raw in ["", "   ", "abc", "4.1.2.3"] {
            let info = describe(raw);
            assert_eq!(info.label, UNKNOWN_LABEL, "{raw:?} 应显示未知版本");
            assert!(!info.matched, "{raw:?} 不该被标成已识别");
        }
    }
}
