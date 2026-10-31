//! 模组分类推断。
//!
//! ## 为什么单独成文件
//!
//! 0.9.0 的分类引擎出过一次很难看的故障：195 个模组里有 168 个被归到「工具」。
//! 真因不是关键词太少，而是**分类把 `description` 也拼进了关键词海**——
//! 「收编」出来的模组 description 全是同一句模板：
//!
//! > 由外部工具（如 Vortex）部署、经「收编」纳入启动器管理。
//!
//! 这句里带「工具」二字，于是 168 个模组被一键打成工具。分类器看见的
//! 应该是**模组自己长什么样**（叫什么、装了哪些文件），而不是我们写的那句说明。
//!
//! 所以这里的输入只有三样：`name` / `folder` / 真实文件路径。description 一律不参与。
//!
//! ## 判定顺序（加权投票，权重高的层压过低层）
//!
//! 1. **内容证据**（权重 6）：`.archive` 落在 `character/`、`body/`、`clothing` 下 ⇒ 服装；
//!    含 `weapon` / `guns/` ⇒ 武器；`.reds` / `.tweak` / `r6/scripts` ⇒ 玩法；
//!    `bin/x64/plugins`（框架本体，不是 CET 的 mods 目录）⇒ 框架。
//! 2. **名称 / 目录关键词**（权重 3）：模组名与顶层文件夹名。staging 目录常常是
//!    解压壳名（`archive-xxxx`、`adopt-<hash>`），本身没有信息量。
//! 3. **布局**（权重 1）：只做兜底。
//!
//! 所以「名为 MIME、装了一堆 character 下的 .archive」会判成服装，
//! 而不是被名字里的某个巧合词带跑。

use std::collections::BTreeMap;

use crate::schema::InstallLayout;

/// 并列时的决胜顺序：越靠前优先级越高。顺序固定 ⇒ 结果可复现。
const CATEGORY_ORDER: [&str; 10] = [
    "框架", "玩法", "武器", "服装", "车辆", "视觉", "音频", "任务", "工具", "其他",
];

pub const UNCATEGORIZED: &str = "其他";

/// 一次分类需要的全部信息。刻意不含 description —— 见文件头。
pub struct Signals<'a> {
    pub name: &'a str,
    pub folder: &'a str,
    pub layout: &'a InstallLayout,
    pub paths: &'a [String],
}

/// ASCII 短词必须整词匹配，否则 "cet" 会命中 "cetocide"、"car" 会命中
/// "cargo"、"core" 会命中 "score"。
fn whole_word_hit(haystack: &str, word: &str) -> bool {
    if !word.is_ascii() {
        return haystack.contains(word);
    }
    let mut start = 0;
    while let Some(offset) = haystack[start..].find(word) {
        let abs = start + offset;
        let end = abs + word.len();
        let before_ok = abs == 0
            || !haystack[..abs]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        let after_ok = end == haystack.len()
            || !haystack[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

fn any_word(haystack: &str, words: &[&str]) -> bool {
    words.iter().any(|word| word_hit(haystack, word))
}

/// 名称 / 目录名的命中规则：**短词整词，长词允许词中词**。
///
/// 分层的理由来自真实库的观测，不是偏好：
///
/// - 短词（`< 5`，如 `cet` / `gun` / `hud` / `car`）一旦放开子串，就会命中
///   `cetocide`、`cargo`、`score` 这类无关词，必须整词。
/// - 长词（`>= 5`，如 `weapon` / `vehicle` / `texture`）恰好相反：玩家从
///   Vortex 收编过来的模组名大多是**连写句柄**——`compactweaponmodslots`、
///   `alwaysfirstequip`、`weaponsimproved`、`npc-silverhand`。这些名字里没有
///   空格也没有下划线，整词匹配一律落空。实测 195 个真实模组：整词匹配有
///   169 个判不出来，放开长词子串后降到 143，且命中项逐条核对全部正确。
///
/// 中文词走子串（中文没有词边界）。
pub(crate) fn word_hit(haystack: &str, word: &str) -> bool {
    if !word.is_ascii() {
        return haystack.contains(word);
    }
    if word.len() >= 5 {
        return haystack.contains(word);
    }
    whole_word_hit(haystack, word)
}

/// 路径片段匹配用纯子串。
///
/// 不能用 `whole_word_hit`：像 "character/" 这种以 `/` 结尾的片段，
/// 后面紧跟的一定是下一个目录名（字母数字），整词判定必然失败。
/// 路径本身是结构化的（分隔符明确），子串匹配在这里既准确又简单。
fn has_fragment(haystack: &str, words: &[&str]) -> bool {
    words.iter().any(|word| haystack.contains(word))
}

/// 名称清洗（文档「一、字符串清洗逻辑」）。
///
/// 真实库里的名字长这样：`!arkhe_10_ust_base_4k`、`!!!_vbr_2.0_skin`、
/// `#01 - Some Mod`。开头的 `!` / `#` / `_` / `-` / `.` 是排序前缀或抓眼符号，
/// 不是语义；`_` 在同一条名字里既当分隔符又被当空格读。统一成「空格分隔的
/// 小写串」之后，关键词匹配才数得准。
///
/// 只做机械归一，不猜测含义：
/// - 去掉开头连续的空白与装饰符（`! # _ - . [ ]`）；
/// - `_` 与 `-` 视为分隔符（换成空格），保留 `.`（`2.0` 不能被拆成 `2 0`）；
/// - 连续空白压成一个；去尾部空白；转小写。
fn clean_name(raw: &str) -> String {
    let trimmed = raw.trim_start_matches(|c: char| {
        c.is_whitespace() || matches!(c, '!' | '#' | '_' | '-' | '.' | '[' | ']')
    });
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_space = false;
    for ch in trimmed.chars() {
        let ch = if ch == '_' || ch == '-' { ' ' } else { ch };
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim_end().to_lowercase()
}

/// 名称关键词表。只放**有区分度**的词：像 "core" / "menu" 这种到处出现的
/// 泛词要么不放，要么接受它带来的误判（它们权重只有 3，会被内容证据压过）。
const NAME_RULES: [(&str, &[&str]); 10] = [
    (
        "框架",
        &[
            "framework", "red4ext", "archivexl", "tweakxl", "codeware", "redscript",
            "cyber engine tweaks", "cet", "corelib", "nativelib", "equipment-ex", "equipmentex",
            "mod settings", "modsettings", "native interactions", "core",
            "框架", "前置", "库",
        ],
    ),
    (
        "武器",
        &[
            "weapon", "gun", "firearm", "blade", "katana", "sword", "pistol", "rifle",
            "shotgun", "sniper", "melee", "ammo", "cyberarm",
            "武器", "枪", "刀", "弹药",
        ],
    ),
    (
        "服装",
        &[
            // 文档「服装/外观」组：skin/body/face/hair 从「视觉」移到这里——
            // 它们是「人外表长什么样」，不是「画面怎么渲染」。
            "clothing", "cloth", "outfit", "wardrobe", "garment", "armor", "armour",
            "jacket", "coat", "pants", "shoes", "shoe", "boots", "dress", "shirt",
            "heels", "apparel", "lingerie", "wear",
            "skin", "body", "face", "hair", "hairstyle", "eyes",
            "vbr", "sp0", "tattoo", "makeup",
            "服装", "衣服", "护甲", "穿搭", "上衣", "裤", "鞋", "外观",
        ],
    ),
    (
        "车辆",
        &[
            "vehicle", "car", "bike", "motor", "wheel", "motorcycle", "garage",
            "车辆", "汽车", "摩托",
        ],
    ),
    (
        "视觉",
        &[
            // 文档「视觉/画质」组：画质与渲染相关词（4k/2k/8k 等是玩家最常用的
            // 画质标签，此前漏收导致大量高清材质包落进「其他」）。
            "4k", "2k", "8k", "retexture", "texture", "reshade", "lut", "lighting",
            "weather", "env", "color", "fx", "path tracing", "vfx",
            "visual", "graphic", "lod", "photmode", "photomode",
            "画质", "视觉", "光影",
        ],
    ),
    (
        "音频",
        &[
            "audio", "sound", "music", "radio", "voice", "sfx", "soundtrack",
            "音效", "音乐", "电台",
        ],
    ),
    (
        "任务",
        &[
            "quest", "mission", "story", "romance", "npc", "dialogue", "journal",
            "剧情", "任务", "委托", "恋爱", "对话",
        ],
    ),
    (
        "玩法",
        &[
            "gameplay", "mechanic", "balance", "difficulty", "perk", "skill", "leveling",
            "level", "economy", "loot", "crafting", "hud", "minimap", "interface",
            "timescale", "stealth", "spawn", "police", "traffic", "rebalance",
            "equip", "loadout", "inventory", "cyberware", "chipware", "progression",
            "system", "combat", "physics", "tweak", "ai",
            "玩法", "平衡", "难度", "界面", "刷怪", "警察",
        ],
    ),
    (
        "工具",
        &["tool", "utility", "manager", "trainer", "cheat", "console", "工具", "管理器"],
    ),
    ("其他", &[]),
];

/// 内容证据：先看文件长什么样，再看它叫什么。
fn by_content(paths: &[String]) -> Option<&'static str> {
    if paths.is_empty() {
        return None;
    }
    let lower: Vec<String> = paths
        .iter()
        .map(|path| path.replace('\\', "/").to_ascii_lowercase())
        .collect();

    // 框架：RED4ext 插件目录，或 bin/x64/plugins 下的框架本体。
    // CET 的**模组**装在 cyber_engine_tweaks/mods 下，那是玩法不是框架，要排除。
    let is_framework = lower.iter().any(|path| {
        path.contains("red4ext/plugins")
            || path.ends_with(".red4ext")
            || (path.contains("bin/x64/plugins") && !path.contains("cyber_engine_tweaks/mods"))
    });
    if is_framework {
        return Some("框架");
    }

    let archives: Vec<&String> = lower
        .iter()
        .filter(|path| path.contains(".archive"))
        .collect();

    // 武器要排在服装前面：枪械模型也躺在 character/ 下面。
    if archives.iter().any(|path| {
        has_fragment(
            path,
            &["weapon", "guns/", "/gun", "firearm", "katana", "rifle", "pistol", "shotgun"],
        )
    }) {
        return Some("武器");
    }

    if archives.iter().any(|path| {
        has_fragment(
            path,
            &[
                "character/", "body/", "/torso", "/legs", "/feet", "/head",
                "clothing", "garment", "apparel", "hair",
            ],
        )
    }) {
        return Some("服装");
    }

    if archives.iter().any(|path| {
        has_fragment(path, &["vehicles/", "/vehicle", "/bike", "motorcycle", "cars/"])
    }) {
        return Some("车辆");
    }

    if lower.iter().any(|path| {
        path.ends_with(".wav")
            || path.ends_with(".bnk")
            || path.ends_with(".ogg")
            || path.ends_with(".opus")
    }) {
        return Some("音频");
    }

    if lower
        .iter()
        .any(|path| has_fragment(path, &["reshade", "weather", "/lut", "visualstate"]))
    {
        return Some("视觉");
    }

    // 脚本 / 调整档 = 玩法。CET 的 lua 也归这里（框架已在上面拦掉了）。
    if lower.iter().any(|path| {
        path.ends_with(".reds")
            || path.ends_with(".tweak")
            || path.ends_with(".lua")
            || path.contains("r6/scripts")
            || path.contains("r6/tweaks")
    }) {
        return Some("玩法");
    }

    None
}

/// 主入口：加权投票，取最高分。
pub fn infer(signals: &Signals<'_>) -> String {
    let mut score: BTreeMap<&'static str, i32> = BTreeMap::new();

    // ① 内容证据
    if let Some(category) = by_content(signals.paths) {
        *score.entry(category).or_insert(0) += 6;
    }

    // ② 名称与目录名（先清洗：去开头装饰符、下划线/连字符转空格、压空格、转小写）
    let name = clean_name(signals.name);
    let folder = clean_name(&signals.folder.replace('\\', "/"));
    for (category, words) in NAME_RULES {
        if words.is_empty() {
            continue;
        }
        if any_word(&name, words) || any_word(&folder, words) {
            *score.entry(category).or_insert(0) += 3;
        }
    }

    // ③ 布局兜底
    match signals.layout {
        InstallLayout::Cet | InstallLayout::Redscript | InstallLayout::Redmod => {
            *score.entry("玩法").or_insert(0) += 1;
        }
        _ => {}
    }

    // ④ 后缀兜底（文档 三.1）：内容与名称都没认出任何类别时，ArchiveXL 的 `.xl`
    //    调整档归视觉。权重给 1，只在「什么都没命中」时兜底，不抢真正的证据。
    if score.is_empty()
        && signals
            .paths
            .iter()
            .any(|path| path.to_ascii_lowercase().ends_with(".xl"))
    {
        *score.entry("视觉").or_insert(0) += 1;
    }

    // 取最高分；并列时按 CATEGORY_ORDER 固定顺序决胜（靠前者胜）。
    //
    // 注意：不能用 `max_by_key`。它在并列时返回**最后一个**最大值，
    // 而这里的语义是「顺序靠前者优先」。真实库上抓到过反例：
    // `Disappearing NPC and Vehicle Fix (Crowd LOD spawn distance)`
    // 同时命中玩法(spawn)/车辆(vehicle)/视觉(lod)/任务(npc)，各 3 分，
    // 用 `max_by_key` 会被判成「任务」，靠前者胜才判成「玩法」。
    let mut best: Option<(&'static str, i32)> = None;
    for category in CATEGORY_ORDER {
        if let Some(value) = score.get(category) {
            let better = match best {
                None => true,
                Some((_, best_value)) => *value > best_value,
            };
            if better {
                best = Some((category, *value));
            }
        }
    }
    best.map(|(category, _)| category.to_string())
        .unwrap_or_else(|| UNCATEGORIZED.to_string())
}

/// 扫一遍暂存目录，拿到「像什么样」的证据。
///
/// 只在条目没有 `planned_files` 缓存时才会被调用（老状态文件、收编进来的模组）。
/// 上限 4000 个文件 / 6 层深 —— 分类不需要看全，看到足够多的路径就够判断了，
/// 卡上限是为了让「重算全部」不至于在几百个模组上扫到天亮。
pub fn scan_staging(staging_path: &str) -> Vec<String> {
    const MAX_FILES: usize = 4000;
    const MAX_DEPTH: usize = 6;
    let root = std::path::Path::new(staging_path);
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(relative) = entry.path().strip_prefix(root) {
            out.push(relative.to_string_lossy().replace('\\', "/"));
        }
        if out.len() >= MAX_FILES {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn layout() -> InstallLayout {
        InstallLayout::Archive
    }

    #[test]
    fn adoption_boilerplate_no_longer_makes_everything_a_tool() {
        // 回归用例：收编模组的 description 里含「工具」，旧实现因此把 168 个模组
        // 全判成工具。新实现根本拿不到 description，只能靠名字与文件。
        let empty: Vec<String> = Vec::new();
        let result = infer(&Signals {
            name: "MIME - Mouse Interactive Model Enhancement",
            folder: "adopt-89fcc4c321f90ae2",
            layout: &layout(),
            paths: &empty,
        });
        assert_ne!(result, "工具", "未命中的模组应落到其他，而不是工具");
        assert_eq!(result, UNCATEGORIZED);
    }

    #[test]
    fn archive_under_character_is_clothing() {
        let result = infer(&Signals {
            name: "some archive",
            folder: "adopt-1",
            layout: &layout(),
            paths: &paths(&["archive/pc/mod/character/body/feet/heels_a.archive"]),
        });
        assert_eq!(result, "服装");
    }

    #[test]
    fn weapon_beats_clothing_when_both_match_character_path() {
        let result = infer(&Signals {
            name: "some gun mod",
            folder: "mod",
            layout: &layout(),
            paths: &paths(&[
                "archive/pc/mod/character/body/gloves.archive",
                "archive/pc/mod/character/weapons/katana.archive",
            ]),
        });
        // 内容层「武器」和「服装」都会命中，武器排在前，直接返回。
        assert_eq!(result, "武器");
    }

    #[test]
    fn reds_and_tweak_mean_gameplay() {
        let tw = infer(&Signals {
            name: "Always First Equip",
            folder: "alwaysfirstequip",
            layout: &InstallLayout::Redscript,
            paths: &paths(&["r6/scripts/always_first_equip.reds"]),
        });
        assert_eq!(tw, "玩法");

        let tweak = infer(&Signals {
            name: "no intro",
            folder: "nointro",
            layout: &layout(),
            paths: &paths(&["r6/tweaks/no_intro.yaml.tweak"]),
        });
        assert_eq!(tweak, "玩法");
    }

    #[test]
    fn plugins_directory_is_framework() {
        let result = infer(&Signals {
            name: "RED4ext",
            folder: "red4ext",
            layout: &InstallLayout::GameRoot,
            paths: &paths(&["red4ext/plugins/ArchiveXL/ArchiveXL.dll"]),
        });
        assert_eq!(result, "框架");
    }

    #[test]
    fn cet_mod_under_mods_directory_is_gameplay_not_framework() {
        let result = infer(&Signals {
            name: "Respector",
            folder: "respector",
            layout: &InstallLayout::Cet,
            paths: &paths(&["bin/x64/plugins/cyber_engine_tweaks/mods/respector/init.lua"]),
        });
        assert_eq!(result, "玩法", "CET 的 mods 目录是玩法，不是框架本体");
    }

    #[test]
    fn name_keywords_still_work_without_file_evidence() {
        let empty: Vec<String> = Vec::new();
        assert_eq!(
            infer(&Signals {
                name: "Panam romance hangouts",
                folder: "x",
                layout: &layout(),
                paths: &empty,
            }),
            "任务"
        );
        assert_eq!(
            infer(&Signals {
                name: "车辆大修 Vehicle Overhaul",
                folder: "x",
                layout: &layout(),
                paths: &empty,
            }),
            "车辆"
        );
    }

    #[test]
    fn short_ascii_words_do_not_fire_inside_longer_words() {
        // "car" 不该命中 "cargo"，"cet" 不该命中 "cetocide"
        let empty: Vec<String> = Vec::new();
        let result = infer(&Signals {
            name: "Cargo Terminal Redesign",
            folder: "cargo-terminal",
            layout: &layout(),
            paths: &empty,
        });
        assert_ne!(result, "车辆");
    }

    #[test]
    fn content_evidence_outweighs_a_misleading_name() {
        let result = infer(&Signals {
            name: "Vehicle Toolkit",
            folder: "x",
            layout: &layout(),
            paths: &paths(&["archive/pc/mod/character/body/jacket_m.archive"]),
        });
        // 名字投了「车辆」(3)，内容投「服装」(6)。
        assert_eq!(result, "服装");
    }

    #[test]
    fn ties_resolve_to_the_earlier_category() {
        // 这条名字命中四类各 3 分：玩法(spawn) / 车辆(vehicle) / 视觉(lod) / 任务(npc)。
        // 顺序里「玩法」最靠前 ⇒ 玩法。`max_by_key` 会给出「任务」，是错的。
        let empty: Vec<String> = Vec::new();
        assert_eq!(
            infer(&Signals {
                name: "Disappearing NPC and Vehicle Fix (Crowd LOD spawn distance)",
                folder: "",
                layout: &layout(),
                paths: &empty,
            }),
            "玩法"
        );
    }

    #[test]
    fn concatenated_handles_are_recognised() {
        // 收编进来的模组名是连写句柄，既没空格也没下划线 —— 长词必须允许词中词。
        // 这几条全部来自真实库（195 个模组里的实际名字）。
        let empty: Vec<String> = Vec::new();
        for (name, expected) in [
            ("compactweaponmodslots", "武器"),
            ("weaponsimproved_grenades", "武器"),
            ("alwaysfirstequip", "玩法"),
            ("badlandsgarage-cht.archive", "车辆"),
        ] {
            assert_eq!(
                infer(&Signals {
                    name,
                    folder: "",
                    layout: &layout(),
                    paths: &empty,
                }),
                expected,
                "{name} 应判为 {expected}"
            );
        }
    }

    #[test]
    fn short_words_still_need_whole_word_boundaries() {
        // 放开长词子串不能连带放开短词：cet / car / gun / hud 必须整词。
        let empty: Vec<String> = Vec::new();
        for name in ["cetocide", "cargoterminal", "gunpowder", "hudson"] {
            assert_eq!(
                infer(&Signals {
                    name,
                    folder: "",
                    layout: &layout(),
                    paths: &empty,
                }),
                "其他",
                "{name} 不该被短词命中"
            );
        }
    }

    #[test]
    fn clean_name_strips_leading_noise_and_separators() {
        // 文档「一」点名的清洗：去开头装饰符、下划线转空格、压空格、转小写。
        assert_eq!(clean_name("!!!_vbr_2.0_skin"), "vbr 2.0 skin");
        assert_eq!(clean_name("!arkhe_10_ust_base_4k"), "arkhe 10 ust base 4k");
        assert_eq!(clean_name("  #01 - Some Mod  "), "01 some mod");
    }

    #[test]
    fn quality_tags_land_in_visual() {
        // 文档点名：`!arkhe_10_ust_base_4k`（4k 画质标签）必须判视觉。
        // 此前「4k/2k/8k/retexture/env/color/fx/vfx」都不在词库，导致大量
        // 高清材质包落进「其他」。
        let empty: Vec<String> = Vec::new();
        for name in [
            "!arkhe_10_ust_base_4k",
            "8k_hd_retexture",
            "some_vfx_pack",
            "night_city_path_tracing",
            "weather_and_lighting_overhaul",
        ] {
            assert_eq!(
                infer(&Signals {
                    name,
                    folder: "",
                    layout: &layout(),
                    paths: &empty,
                }),
                "视觉",
                "{name} 应判为视觉"
            );
        }
    }

    #[test]
    fn vbr_and_skin_land_in_clothing() {
        // 文档点名：`vbr_2.0_skin` 必须判服装；带前导装饰符也一样。
        let empty: Vec<String> = Vec::new();
        for name in ["vbr_2.0_skin", "!!!_vbr_2.0_skin", "sp0_body_replacer"] {
            assert_eq!(
                infer(&Signals {
                    name,
                    folder: "",
                    layout: &layout(),
                    paths: &empty,
                }),
                "服装",
                "{name} 应判为服装"
            );
        }
    }

    #[test]
    fn xl_only_mods_fall_back_to_visual() {
        // 名称无信息、只有 ArchiveXL 的 `.xl` 调整档 → 视觉（低权重兜底）。
        let result = infer(&Signals {
            name: "zzzz",
            folder: "",
            layout: &layout(),
            paths: &paths(&["archive/pc/mod/mystery.archive.xl"]),
        });
        assert_eq!(result, "视觉");
    }

    /// 真实库诊断：只打印「模组名 → 分类」，不改任何文件。
    ///
    /// `CDL_DIAG_STATE=<launcher-state.json> cargo test --lib diagnose_real_library -- --ignored --nocapture`
    ///
    /// 存在的意义：单元测试只能证明规则自洽，证明不了**玩家那一库**会被判成什么样。
    /// 这个入口让「真实数据上的分布」可复现、可核对，而不必靠截图肉眼数。
    #[test]
    #[ignore]
    fn diagnose_real_library() {
        let Ok(path) = std::env::var("CDL_DIAG_STATE") else {
            return;
        };
        let raw = std::fs::read_to_string(&path).expect("读取状态文件失败");
        let data: serde_json::Value = serde_json::from_str(&raw).expect("状态文件不是合法 JSON");
        let mods = data["mods"].as_array().expect("状态文件缺少 mods");
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for item in mods {
            let name = item["name"].as_str().unwrap_or_default();
            let folder = item["modFolder"].as_str().unwrap_or_default();
            let collected: Vec<String> = item["plannedFiles"]
                .as_array()
                .map(|files| {
                    files
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let layout = InstallLayout::Archive;
            let category = infer(&Signals {
                name,
                folder,
                layout: &layout,
                paths: &collected,
            });
            println!("{name}\t{category}");
            *counts.entry(category).or_insert(0) += 1;
        }
        println!("--- 分布 ---");
        for category in CATEGORY_ORDER {
            if let Some(count) = counts.get(category) {
                println!("{category}\t{count}");
            }
        }
    }
}
