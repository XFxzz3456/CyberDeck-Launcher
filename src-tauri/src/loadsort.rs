//! 加载顺序自动整理：确定性规则 + AI 约束校验 + 可解释输出。
//!
//! ## 为什么单独成模块
//!
//! `loadorder.rs` 管的是「顺序怎么落盘 / modlist.txt 怎么写」，有副作用（写盘、
//! 同步 Vortex）；这里管的是「顺序该是什么」——必须是纯函数，才好在单测里把
//! 真实库的畸形状态（同 mod 多 archive 被打散、冲突来自未启用模组、AI 输出乱写）
//! 摆出来验证。
//!
//! ## 语义前提（决定了这个引擎能做和不能做什么）
//!
//! CP2077 的 archive 是**全部挂载**，`modlist.txt` 的行序只决定「同名文件谁覆盖谁」。
//! 所以不存在「最优全序」：两个 archive 没有同名文件时，谁前谁后游戏结果一样。
//!
//! 因此本模块只做三件事：
//! 1. 框架/核心置顶（它们的文件被覆盖会直接失效）；
//! 2. 给**有冲突的** MOD 对排出确定的相对顺序（策略可选，方向本质上不可知）；
//! 3. 其余项沿用用户当前相对顺序（不制造无谓 diff），缺顺序时才按 ASCII 兜底。
//!
//! 「整理后冲突数变多/变少」不是本模块的目标——脚本类冲突（`.reds` / `.lua`）
//! 由部署覆盖决定，与这里无关。

use std::collections::{HashMap, HashSet};

use crate::installer;
use crate::loadorder;
use crate::schema::{
    AppStateData, LoadOrderItem, LoadOrderSuggestion, ModEntry, OrderMove, OrderReason,
};

/// AI 输出一条规则的上限。模型偶尔会把整张表复述一遍，这里兜一下。
const MAX_AI_RULES: usize = 200;

/// AI 给的相对约束：`before` 要排在 `after` 之前（`before` 先加载、`after` 覆盖它）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderConstraint {
    pub before: String,
    pub after: String,
    pub reason: String,
}

/// 一个不可拆的「组」：同一 MOD 的全部 archive。
///
/// 为什么按 MOD 而不是按文件排：同一 MOD 的多个 archive 是同一批内容，拆开穿插
/// 只会让「谁覆盖谁」更难解释；而用户想钉住时想的也是「这个 MOD 待在原地」。
struct Group {
    name: String,
    archives: Vec<String>,
    /// 组内第一个 archive 在当前顺序里的位置，用作稳定排序的第二关键字。
    base: usize,
    framework: bool,
    pinned: bool,
}

/// 一次整理建议。`ai_used` / `ai_note` 由调用方提供：本模块不碰网络。
pub fn build_suggestion(
    state: &AppStateData,
    constraints: &[OrderConstraint],
    ai_used: bool,
    mut ai_note: Option<String>,
) -> LoadOrderSuggestion {
    let view = loadorder::build_view(state, None);
    let base_items: Vec<LoadOrderItem> = view
        .archives
        .into_iter()
        .filter(|item| item.deployed)
        .collect();
    let base: Vec<String> = base_items.iter().map(|item| item.id.clone()).collect();
    let base_pos: HashMap<&str, usize> = base
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();

    let meta: HashMap<&str, &ModEntry> = state
        .mods
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let pins: HashSet<&str> = state
        .load_order_pins
        .iter()
        .map(String::as_str)
        .collect();

    // ── 分组 ────────────────────────────────────────────────────────────────
    let mut groups: Vec<Group> = Vec::new();
    let mut group_of_mod: HashMap<String, usize> = HashMap::new();
    let mut archive_group: HashMap<String, usize> = HashMap::new();

    for (index, item) in base_items.iter().enumerate() {
        let group_index = match group_of_mod.get(&item.mod_id) {
            Some(&index) => index,
            None => {
                let entry = meta.get(item.mod_id.as_str());
                let group_index = groups.len();
                groups.push(Group {
                    name: item.mod_name.clone(),
                    archives: Vec::new(),
                    base: index,
                    framework: entry
                        .map(|mod_entry| is_framework(mod_entry))
                        .unwrap_or(false),
                    pinned: pins.contains(item.mod_id.as_str()),
                });
                group_of_mod.insert(item.mod_id.clone(), group_index);
                group_index
            }
        };
        groups[group_index].archives.push(item.id.clone());
        archive_group.insert(item.id.to_ascii_lowercase(), group_index);
    }

    // ── 冲突：只提示，不定向 ────────────────────────────────────────────────
    //
    // 必须说清的事实：目前能检测到的 archive「冲突」都是**同一个相对路径被两个
    // MOD 部署**（两个整合包都带 `chipwareexpansion.archive` 这种）。部署时后者
    // 已经覆盖前者，磁盘上只剩一份、`modlist.txt` 里也只有一行——加载顺序对它
    // 没有任何作用。真正靠顺序解决的「两个 archive **内部**含同名文件」需要解包
    // archive 才能发现，当前没有这个能力。
    //
    // 所以这里只统计、只提示，不假装能修。把「整理顺序」包装成「消除冲突」是最
    // 容易失去信任的做法：用户点完发现数字没变，之后所有提示都不会信了。
    let mut edges: Vec<(usize, usize)> = Vec::new();
    let mut reasons: Vec<OrderReason> = Vec::new();
    let mut pending_conflicts = 0usize;
    let mut deployed_conflicts = 0usize;
    let mut shared_paths: Vec<String> = Vec::new();
    for conflict in installer::collect_conflicts(&state.mods) {
        if conflict.pending {
            pending_conflicts += 1;
            continue;
        }
        deployed_conflicts += 1;
        if shared_paths.len() < 3 {
            shared_paths.push(filename_of(&conflict.target));
        }
    }
    if deployed_conflicts > 0 {
        reasons.push(OrderReason {
            kind: "deployConflict".to_string(),
            note: format!(
                "另有 {} 处重合是「同一路径被多个 MOD 部署」（{}），由部署顺序决定，调整加载顺序不会改变它们",
                deployed_conflicts,
                shared_paths.join("、")
            ),
            subjects: Vec::new(),
        });
    }

    // ── AI 约束 ─────────────────────────────────────────────────────────────
    let mut ai_rejected: Vec<String> = Vec::new();
    for constraint in constraints {
        let Some(before) = resolve_group(constraint.before.trim(), &groups, &group_of_mod, &archive_group)
        else {
            ai_rejected.push(constraint.before.clone());
            continue;
        };
        let Some(after) = resolve_group(constraint.after.trim(), &groups, &group_of_mod, &archive_group)
        else {
            ai_rejected.push(constraint.after.clone());
            continue;
        };
        if before == after {
            continue;
        }
        // 框架不下沉：任何「非框架 → 框架」的约束都不允许。
        if groups[after].framework && !groups[before].framework {
            ai_rejected.push(format!("{} → {}", constraint.before, constraint.after));
            continue;
        }
        if would_cycle(&edges, before, after) {
            ai_rejected.push(format!("{} → {}（成环）", constraint.before, constraint.after));
            continue;
        }
        edges.push((before, after));
        reasons.push(OrderReason {
            kind: "ai".to_string(),
            note: if constraint.reason.trim().is_empty() {
                format!("AI 建议「{}」先于「{}」加载", groups[before].name, groups[after].name)
            } else {
                constraint.reason.clone()
            },
            subjects: vec![groups[before].name.clone(), groups[after].name.clone()],
        });
    }

    // ── 拓扑排序 ────────────────────────────────────────────────────────────
    let (mut sequence, forced) = topo_order(&groups, &edges);

    if !forced.is_empty() {
        reasons.push(OrderReason {
            kind: "fallback".to_string(),
            note: format!(
                "有 {} 个 MOD 的排序约束互相矛盾（成环），已按原顺序兜底",
                forced.len()
            ),
            subjects: forced
                .iter()
                .map(|&index| groups[index].name.clone())
                .collect(),
        });
    }

    // ── 锁定项归位 ──────────────────────────────────────────────────────────
    // pinned 的组严格占它原来的槽位；自由组按拓扑结果的相对顺序填剩下的位置。
    //
    // base_sequence 必须**按组唯一化**：同一 MOD 的 archive 可能被用户拖散了
    // （m1 / 别的 MOD / m2），直接去重相邻重复会得到长度大于组数的序列，
    // 后面的槽位填充就会错位、甚至丢掉一行。
    let mut base_sequence: Vec<usize> = Vec::new();
    let mut seen_groups: HashSet<usize> = HashSet::new();
    for item in &base_items {
        if let Some(&group) = archive_group.get(&item.id.to_ascii_lowercase()) {
            if seen_groups.insert(group) {
                base_sequence.push(group);
            }
        }
    }

    let pinned_slots: Vec<(usize, usize)> = base_sequence
        .iter()
        .enumerate()
        .filter(|(_, &group)| groups[group].pinned)
        .map(|(slot, &group)| (slot, group))
        .collect();

    if !pinned_slots.is_empty() {
        let mut slots: Vec<Option<usize>> = vec![None; base_sequence.len()];
        for (slot, group) in &pinned_slots {
            if *slot < slots.len() {
                slots[*slot] = Some(*group);
            }
        }
        // 拓扑结果里去掉已占位的 pinned 组，剩下的按顺序填空。
        let mut free = sequence
            .iter()
            .copied()
            .filter(|group| !groups[*group].pinned)
            .collect::<Vec<_>>()
            .into_iter();
        for slot in slots.iter_mut() {
            if slot.is_none() {
                *slot = free.next();
            }
        }
        // 理论上不会缺项，但真缺了就按基线补齐而不是静默丢行。
        for (index, slot) in slots.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(base_sequence[index]);
            }
        }
        sequence = slots.into_iter().flatten().collect();
    }

    // ── 展开成 archive 列表 ─────────────────────────────────────────────────
    let mut order: Vec<String> = Vec::with_capacity(base.len());
    for &group in &sequence {
        order.extend(groups[group].archives.iter().cloned());
    }

    let mut moves: Vec<OrderMove> = Vec::new();
    for (to, id) in order.iter().enumerate() {
        if let Some(&from) = base_pos.get(id.as_str()) {
            if from != to {
                moves.push(OrderMove {
                    id: id.clone(),
                    from,
                    to,
                });
            }
        }
    }

    let frameworks: Vec<&Group> = groups.iter().filter(|group| group.framework).collect();
    if !frameworks.is_empty() {
        reasons.insert(
            0,
            OrderReason {
                kind: "framework".to_string(),
                note: format!(
                    "{} 个框架/核心 MOD 置于最前：它们的 archive 一旦被后加载的内容覆盖就会直接失效",
                    frameworks.len()
                ),
                subjects: frameworks
                    .iter()
                    .take(8)
                    .map(|group| group.name.clone())
                    .collect(),
            },
        );
    }

    if !ai_rejected.is_empty() {
        let mut note = ai_note.unwrap_or_default();
        if !note.is_empty() {
            note.push(' ');
        }
        note.push_str(&format!(
            "AI 的 {} 条建议未通过校验（名称不存在 / 会让框架后置 / 成环），已忽略",
            ai_rejected.len()
        ));
        ai_note = Some(note);
    }

    let skipped: Vec<String> = groups
        .iter()
        .filter(|group| group.pinned)
        .flat_map(|group| group.archives.iter().cloned())
        .collect();

    LoadOrderSuggestion {
        mode: if ai_used { "ai".to_string() } else { "rules".to_string() },
        order,
        moves,
        reasons,
        skipped,
        ai_used,
        ai_note,
        pending_conflicts,
    }
}

/// 框架判定：分类已经是「框架」，或者名字命中框架清单。
///
/// 两个条件都要看：分类可能被用户手动改过，而名字判定覆盖「分类被误判成玩法」的
/// 情况（框架的 archive 被后加载的内容覆盖，症状是整片功能静默失效）。
fn is_framework(entry: &ModEntry) -> bool {
    entry.category == "框架" || crate::ai::is_framework_name(&entry.name)
}

fn filename_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// 把 AI 写的名字映射回组下标。
///
/// 允许三种写法：archive 相对路径、archive 文件名、MOD 显示名。模型这三种都写，
/// 只认一种等于让大部分建议白写。
fn resolve_group(
    raw: &str,
    groups: &[Group],
    group_of_mod: &HashMap<String, usize>,
    archive_group: &HashMap<String, usize>,
) -> Option<usize> {
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    if let Some(&group) = archive_group.get(&lower) {
        return Some(group);
    }
    // 只给了文件名
    if let Some(&group) = archive_group.get(&format!("archive/pc/mod/{lower}")) {
        return Some(group);
    }
    // MOD 显示名（精确 → 去空格大小写不敏感）
    if let Some(&group) = group_of_mod.get(raw) {
        return Some(group);
    }
    let squashed = lower.replace([' ', '_', '-'], "");
    groups
        .iter()
        .position(|group| {
            group.name.to_ascii_lowercase().replace([' ', '_', '-'], "") == squashed
        })
        .or_else(|| {
            groups
                .iter()
                .position(|group| group.archives.iter().any(|archive| filename_of(archive).eq_ignore_ascii_case(raw)))
        })
}

/// 假设再加一条 `from → to` 会不会成环：只要 `to` 已经能走到 `from`，加这条就成环。
fn would_cycle(edges: &[(usize, usize)], from: usize, to: usize) -> bool {
    if from == to {
        return true;
    }
    let mut stack = vec![to];
    let mut seen = HashSet::new();
    while let Some(node) = stack.pop() {
        if node == from {
            return true;
        }
        if !seen.insert(node) {
            continue;
        }
        for &(source, target) in edges {
            if source == node && !seen.contains(&target) {
                stack.push(target);
            }
        }
    }
    false
}

/// 拓扑排序 + 稳定兜底。
///
/// 排序键是 `(是否框架, 基线位置)`：框架优先出队；同为框架（或同非框架）时按
/// 用户当前顺序，保证「同样的输入永远得到同样的输出」。成环时强制出队最小的那个
/// 并记录，绝不 panic、也不丢项。
fn topo_order(groups: &[Group], edges: &[(usize, usize)]) -> (Vec<usize>, Vec<usize>) {
    let total = groups.len();
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); total];
    let mut indegree = vec![0usize; total];
    let mut seen_edges: HashSet<(usize, usize)> = HashSet::new();
    for &(from, to) in edges {
        if from == to || !seen_edges.insert((from, to)) {
            continue;
        }
        adjacency[from].push(to);
        indegree[to] += 1;
    }

    let mut order: Vec<usize> = Vec::with_capacity(total);
    let mut done = vec![false; total];
    let mut forced: Vec<usize> = Vec::new();

    let rank = |index: usize| (!groups[index].framework, groups[index].base);

    for _ in 0..total {
        let mut pick: Option<usize> = None;
        for index in 0..total {
            if done[index] || indegree[index] > 0 {
                continue;
            }
            pick = match pick {
                None => Some(index),
                Some(current) => {
                    if rank(index) < rank(current) {
                        Some(index)
                    } else {
                        Some(current)
                    }
                }
            };
        }
        let chosen = match pick {
            Some(index) => index,
            None => {
                // 成环：挑剩余项里最小的强制出队，并记一笔。
                let mut best: Option<usize> = None;
                for index in 0..total {
                    if done[index] {
                        continue;
                    }
                    best = match best {
                        None => Some(index),
                        Some(current) => {
                            if rank(index) < rank(current) {
                                Some(index)
                            } else {
                                Some(current)
                            }
                        }
                    };
                }
                let index = best.expect("total > 0 时至少剩一个未出队项");
                forced.push(index);
                index
            }
        };
        done[chosen] = true;
        order.push(chosen);
        for &next in &adjacency[chosen] {
            indegree[next] = indegree[next].saturating_sub(1);
        }
    }

    (order, forced)
}

// ── AI 侧：只在「数据怎么给」和「结果怎么切」上做事，请求本身归 ai.rs ──────────

/// 给模型的事实清单。
///
/// ## 为什么不再只给「冲突对」
///
/// 我们目前能检测到的重合**全是同路径覆盖**（两个整合包都带同一个 archive 文件），
/// 那种情况由部署顺序决定、加载顺序管不着，模型看到也没有信息量。真正的排序依据在
/// **MOD 名字与描述**里：`Gone Away - Better Partner` 显然是 `Gone Away` 的补丁，
/// `ArchiveXL` 显然是框架。这类判断正是模型擅长、规则写不出来的东西。
///
/// 所以清单给三样：框架、全部已启用 MOD（名 / 分类 / 描述摘要 / 安装时间）、
/// 以及已知同路径重合（明确标注「别拿它当排序依据」）。条数与摘要长度都设上限，
/// 免得本地小模型被 158 条长描述淹掉。
pub fn build_ai_brief(state: &AppStateData) -> String {
    let view = loadorder::build_view(state, None);
    let archives: Vec<LoadOrderItem> = view
        .archives
        .into_iter()
        .filter(|item| item.deployed)
        .collect();
    let meta: HashMap<&str, &ModEntry> = state
        .mods
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();

    // 按当前加载顺序列出 MOD，让模型知道现状（免得把已经很合理的东西再翻一遍）。
    let mut ordered_mods: Vec<&ModEntry> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for item in &archives {
        if seen.insert(item.mod_id.as_str()) {
            if let Some(entry) = meta.get(item.mod_id.as_str()) {
                ordered_mods.push(entry);
            }
        }
    }

    let frameworks: Vec<String> = ordered_mods
        .iter()
        .filter(|entry| is_framework(entry))
        .map(|entry| entry.name.clone())
        .collect();

    let mut brief = String::new();
    brief.push_str(&format!(
        "已启用 MOD 共 {} 个，其中带 archive 的 {} 个。\n\n",
        ordered_mods.len(),
        archives.len()
    ));
    brief.push_str(&format!(
        "框架 / 核心（必须排在最前，永远不能出现在 after 位置）：{}\n\n",
        if frameworks.is_empty() {
            "（无）".to_string()
        } else {
            frameworks.join("、")
        }
    ));
    brief.push_str("按当前加载顺序（越靠前越早加载）：\n");
    for (index, entry) in ordered_mods.iter().take(220).enumerate() {
        let description = description_snippet(&entry.description);
        brief.push_str(&format!(
            "{:>3}. {}｜分类 {}｜{}｜装于 {}\n",
            index + 1,
            entry.name,
            entry.category,
            if description.is_empty() {
                "无描述".to_string()
            } else {
                description
            },
            entry.installed_at
        ));
    }
    if ordered_mods.len() > 220 {
        brief.push_str(&format!("（其余 {} 个略）\n", ordered_mods.len() - 220));
    }

    // 已知同路径重合：明确告诉模型这不是加载顺序问题，别拿它当依据。
    let mut same_path = 0usize;
    for conflict in installer::collect_conflicts(&state.mods) {
        if !conflict.pending {
            same_path += 1;
        }
    }
    if same_path > 0 {
        brief.push_str(&format!(
            "\n另有 {} 处「同一文件被多个 MOD 部署」，它们由部署覆盖决定、与加载顺序无关，不要作为排序依据。",
            same_path
        ));
    }
    brief
}

/// 描述摘要：去换行、压到 80 字。作者描述里常常混着安装说明和致谢，太长反而干扰判断。
fn description_snippet(raw: &str) -> String {
    let flat = raw.replace(['\r', '\n'], " ");
    let trimmed = flat.trim();
    if trimmed.chars().count() <= 80 {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(80).collect();
    format!("{cut}…")
}

/// 解析模型返回的 JSON。
///
/// 只做结构过滤（字段存在、条数上限），语义校验放在 `build_suggestion` ——
/// 那里才拿得到「已部署 archive 与 MOD 的对应关系」。
pub fn parse_constraints(raw: &str) -> (Vec<OrderConstraint>, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let text = strip_fence(raw);
    let value: serde_json::Value = match serde_json::from_str(text.trim()) {
        Ok(value) => value,
        Err(err) => {
            warnings.push(format!("AI 返回的不是合法 JSON：{err}"));
            return (Vec::new(), warnings);
        }
    };
    let Some(list) = value.get("rules").and_then(|node| node.as_array()) else {
        warnings.push("AI 返回里没有 rules 数组".to_string());
        return (Vec::new(), warnings);
    };
    let mut out: Vec<OrderConstraint> = Vec::new();
    for item in list.iter().take(MAX_AI_RULES) {
        let before = item
            .get("before")
            .and_then(|node| node.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let after = item
            .get("after")
            .and_then(|node| node.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if before.is_empty() || after.is_empty() {
            continue;
        }
        out.push(OrderConstraint {
            before,
            after,
            reason: item
                .get("reason")
                .and_then(|node| node.as_str())
                .unwrap_or_default()
                .trim()
                .to_string(),
        });
    }
    if list.len() > MAX_AI_RULES {
        warnings.push(format!(
            "AI 返回 {} 条规则，只取前 {} 条",
            list.len(),
            MAX_AI_RULES
        ));
    }
    if out.is_empty() {
        warnings.push("AI 没有给出可用的相对顺序".to_string());
    }
    (out, warnings)
}

/// 剥掉 ```json … ``` 包裹。模型很爱加，加了就是解析失败。
fn strip_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let rest = rest.split_once('\n').map(|(_, tail)| tail).unwrap_or(rest);
    rest.trim_end()
        .strip_suffix("```")
        .unwrap_or(rest)
        .trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{DeployedFile, InstallLayout, LinkType};

    fn entry_with(
        id: &str,
        name: &str,
        installed: &str,
        category: &str,
        archives: &[&str],
    ) -> ModEntry {
        ModEntry {
            id: id.to_string(),
            raw_name: None,
            name: name.to_string(),
            version: None,
            author: None,
            category: category.to_string(),
            category_locked: false,
            description: String::new(),
            source_zip: None,
            nexus: None,
            staging_path: format!("Z:/__cdl_test_missing__/{id}"),
            cover_path: None,
            enabled: true,
            installed_at: installed.to_string(),
            updated_at: None,
            size_bytes: 0,
            file_count: archives.len(),
            layout: InstallLayout::Archive,
            mod_folder: None,
            metadata_source: "filename".to_string(),
            planned_files: Vec::new(),
            warnings: Vec::new(),
            deployed_files: archives
                .iter()
                .map(|path| DeployedFile {
                    source: format!("Z:/staging/{id}/{}", filename_of(path)),
                    target: format!("C:/game/{path}"),
                    link_type: LinkType::HardLink,
                    relative_path: (*path).to_string(),
                    size: None,
                    modified_time: None,
                })
                .collect(),
            has_archive: true,
            has_redmod: false,
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

    fn entry(id: &str, name: &str, installed: &str, archives: &[&str]) -> ModEntry {
        entry_with(id, name, installed, "其他", archives)
    }

    fn state_of(mods: Vec<ModEntry>) -> AppStateData {
        let mut state = AppStateData::new("Z:/staging".to_string());
        state.mods = mods;
        state
    }

    fn ids(order: &[String]) -> Vec<String> {
        order
            .iter()
            .map(|path| filename_of(path))
            .collect::<Vec<_>>()
    }

    #[test]
    fn framework_group_is_moved_to_front() {
        let mut state = state_of(vec![
            entry("z", "Zzz Outfit", "2026-10-01T00:00:00Z", &["archive/pc/mod/zzz.archive"]),
            entry_with(
                "fw",
                "ArchiveXL",
                "2026-10-02T00:00:00Z",
                "框架",
                &["archive/pc/mod/archivexl.archive"],
            ),
            entry("a", "Aaa Visuals", "2026-10-03T00:00:00Z", &["archive/pc/mod/aaa.archive"]),
        ]);
        // 让当前位置明确把框架排在最后
        state.load_order = vec![
            "archive/pc/mod/aaa.archive".to_string(),
            "archive/pc/mod/zzz.archive".to_string(),
            "archive/pc/mod/archivexl.archive".to_string(),
        ];

        let suggestion = build_suggestion(&state, &[], false, None);
        assert_eq!(ids(&suggestion.order)[0], "archivexl.archive");
        assert!(suggestion
            .reasons
            .iter()
            .any(|reason| reason.kind == "framework"));
    }

    #[test]
    fn untouched_order_keeps_position_and_reports_no_moves() {
        let mut state = state_of(vec![
            entry("b", "B", "2026-10-01T00:00:00Z", &["archive/pc/mod/b.archive"]),
            entry("a", "A", "2026-10-01T00:00:00Z", &["archive/pc/mod/a.archive"]),
        ]);
        state.load_order = vec![
            "archive/pc/mod/b.archive".to_string(),
            "archive/pc/mod/a.archive".to_string(),
        ];

        let suggestion = build_suggestion(&state, &[], false, None);
        assert_eq!(ids(&suggestion.order), vec!["b.archive", "a.archive"]);
        assert!(suggestion.moves.is_empty());
    }

    #[test]
    fn archives_of_same_mod_stay_together() {
        let mut state = state_of(vec![
            entry(
                "multi",
                "Multi Part",
                "2026-10-05T00:00:00Z",
                &["archive/pc/mod/m1.archive", "archive/pc/mod/m2.archive"],
            ),
            entry("one", "Single", "2026-10-01T00:00:00Z", &["archive/pc/mod/one.archive"]),
        ]);
        state.load_order = vec![
            "archive/pc/mod/m1.archive".to_string(),
            "archive/pc/mod/one.archive".to_string(),
            "archive/pc/mod/m2.archive".to_string(),
        ];

        let suggestion = build_suggestion(&state, &[], false, None);
        let names = ids(&suggestion.order);
        let first = names.iter().position(|name| name == "m1.archive").unwrap();
        assert_eq!(names[first + 1], "m2.archive");
    }

    #[test]
    fn pinned_mod_keeps_its_slot() {
        let mut state = state_of(vec![
            entry("fw", "ArchiveXL", "2026-10-02T00:00:00Z", &["archive/pc/mod/archivexl.archive"]),
            entry("pin", "Pinned Mod", "2026-10-03T00:00:00Z", &["archive/pc/mod/pinned.archive"]),
            entry("x", "Other", "2026-10-04T00:00:00Z", &["archive/pc/mod/other.archive"]),
        ]);
        state.mods[0].category = "框架".to_string();
        state.load_order = vec![
            "archive/pc/mod/pinned.archive".to_string(),
            "archive/pc/mod/other.archive".to_string(),
            "archive/pc/mod/archivexl.archive".to_string(),
        ];
        state.load_order_pins = vec!["pin".to_string()];

        let suggestion = build_suggestion(&state, &[], false, None);
        let names = ids(&suggestion.order);
        // 锁定项留在原来的第 0 位；框架被提到最前只能落在剩余槽位。
        assert_eq!(names[0], "pinned.archive");
        assert_eq!(names[1], "archivexl.archive");
        assert!(!suggestion.skipped.is_empty());
    }

    #[test]
    fn deployed_same_path_is_reported_but_not_resorted() {
        // 两个 MOD 都部署同一个 archive 路径：磁盘上只剩一份、modlist 只有一行，
        // 排序对它无能为力。这里断言「只提示、不改顺序、不丢项」。
        let state = state_of(vec![
            entry("a", "Pack A", "2026-10-01T00:00:00Z", &["archive/pc/mod/shared.archive"]),
            entry("b", "Pack B", "2026-10-02T00:00:00Z", &["archive/pc/mod/shared.archive"]),
        ]);
        let suggestion = build_suggestion(&state, &[], false, None);
        // 同路径只会留下一条顺序项（modlist 就一行），关键是它被**提示**出来，
        // 而不是被当成可整理对象、也不是被静默吞掉。
        assert!(!suggestion.order.is_empty());
        assert!(suggestion
            .reasons
            .iter()
            .any(|reason| reason.kind == "deployConflict"));
    }

    #[test]
    fn pending_conflicts_are_excluded_but_counted() {
        let mut state = state_of(vec![
            entry("on", "Enabled", "2026-10-01T00:00:00Z", &["archive/pc/mod/on.archive"]),
            {
                let mut off = entry("off", "Disabled", "2026-10-02T00:00:00Z", &["archive/pc/mod/off.archive"]);
                off.enabled = false;
                off.planned_files = vec!["archive/pc/mod/on.archive".to_string()];
                off
            },
        ]);
        state.load_order = vec!["archive/pc/mod/on.archive".to_string()];

        let suggestion = build_suggestion(&state, &[], false, None);
        assert!(suggestion.pending_conflicts >= 1);
        assert_eq!(suggestion.order.len(), 1);
    }

    #[test]
    fn ai_constraint_is_applied() {
        let mut state = state_of(vec![
            entry("base", "Base Mod", "2026-10-01T00:00:00Z", &["archive/pc/mod/base.archive"]),
            entry("patch", "Patch Mod", "2026-10-09T00:00:00Z", &["archive/pc/mod/patch.archive"]),
        ]);
        state.load_order = vec![
            "archive/pc/mod/patch.archive".to_string(),
            "archive/pc/mod/base.archive".to_string(),
        ];

        let constraints = vec![OrderConstraint {
            before: "Base Mod".to_string(),
            after: "Patch Mod".to_string(),
            reason: "补丁要盖在基础包上".to_string(),
        }];
        let suggestion =
            build_suggestion(&state, &constraints, true, None);
        assert_eq!(ids(&suggestion.order), vec!["base.archive", "patch.archive"]);
        assert!(suggestion.reasons.iter().any(|reason| reason.kind == "ai"));
    }

    #[test]
    fn ai_constraint_that_pushes_framework_back_is_rejected() {
        let mut state = state_of(vec![
            entry("fw", "ArchiveXL", "2026-10-01T00:00:00Z", &["archive/pc/mod/archivexl.archive"]),
            entry("mod", "Some Mod", "2026-10-02T00:00:00Z", &["archive/pc/mod/some.archive"]),
        ]);
        state.mods[0].category = "框架".to_string();
        state.load_order = vec![
            "archive/pc/mod/archivexl.archive".to_string(),
            "archive/pc/mod/some.archive".to_string(),
        ];

        let constraints = vec![OrderConstraint {
            before: "Some Mod".to_string(),
            after: "ArchiveXL".to_string(),
            reason: "模型犯傻".to_string(),
        }];
        let suggestion =
            build_suggestion(&state, &constraints, true, None);
        assert_eq!(ids(&suggestion.order)[0], "archivexl.archive");
        assert!(suggestion
            .ai_note
            .as_deref()
            .unwrap_or_default()
            .contains("未通过校验"));
    }

    #[test]
    fn ai_cycle_is_rejected() {
        let mut state = state_of(vec![
            entry("a", "A Mod", "2026-10-01T00:00:00Z", &["archive/pc/mod/a.archive"]),
            entry("b", "B Mod", "2026-10-02T00:00:00Z", &["archive/pc/mod/b.archive"]),
        ]);
        state.load_order = vec![
            "archive/pc/mod/a.archive".to_string(),
            "archive/pc/mod/b.archive".to_string(),
        ];

        let constraints = vec![
            OrderConstraint {
                before: "A Mod".to_string(),
                after: "B Mod".to_string(),
                reason: String::new(),
            },
            OrderConstraint {
                before: "B Mod".to_string(),
                after: "A Mod".to_string(),
                reason: String::new(),
            },
        ];
        let suggestion =
            build_suggestion(&state, &constraints, true, None);
        assert_eq!(suggestion.order.len(), 2);
        assert!(suggestion
            .ai_note
            .as_deref()
            .unwrap_or_default()
            .contains("未通过校验"));
    }

    #[test]
    fn ai_unknown_name_is_ignored() {
        let state = state_of(vec![entry(
            "a",
            "A Mod",
            "2026-10-01T00:00:00Z",
            &["archive/pc/mod/a.archive"],
        )]);
        let constraints = vec![OrderConstraint {
            before: "不存在的 Mod".to_string(),
            after: "A Mod".to_string(),
            reason: String::new(),
        }];
        let suggestion = build_suggestion(&state, &constraints, true, None);
        assert_eq!(suggestion.order.len(), 1);
        assert!(suggestion
            .ai_note
            .as_deref()
            .unwrap_or_default()
            .contains("未通过校验"));
    }

    #[test]
    fn parse_constraints_accepts_fenced_json() {
        let raw = "```json\n{\"rules\":[{\"before\":\"A\",\"after\":\"B\",\"reason\":\"r\"}]}\n```";
        let (rules, warnings) = parse_constraints(raw);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].before, "A");
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_constraints_reports_garbage() {
        let (rules, warnings) = parse_constraints("我不知道");
        assert!(rules.is_empty());
        assert!(!warnings.is_empty());
    }

    #[test]
    fn parse_constraints_caps_rule_count() {
        let rules = (0..(MAX_AI_RULES + 5))
            .map(|index| format!("{{\"before\":\"b{index}\",\"after\":\"a{index}\"}}"))
            .collect::<Vec<_>>()
            .join(",");
        let raw = format!("{{\"rules\":[{rules}]}}");
        let (parsed, warnings) = parse_constraints(&raw);
        assert_eq!(parsed.len(), MAX_AI_RULES);
        assert!(warnings.iter().any(|item| item.contains("只取前")));
    }

    #[test]
    fn fresh_library_without_order_falls_back_to_name() {
        let state = state_of(vec![
            entry("b", "B", "2026-10-01T00:00:00Z", &["archive/pc/mod/b.archive"]),
            entry("a", "A", "2026-10-01T00:00:00Z", &["archive/pc/mod/a.archive"]),
        ]);
        let suggestion = build_suggestion(&state, &[], false, None);
        assert_eq!(ids(&suggestion.order), vec!["a.archive", "b.archive"]);
    }

    #[test]
    fn moves_only_list_rows_that_actually_moved() {
        let mut state = state_of(vec![
            entry("b", "B", "2026-10-01T00:00:00Z", &["archive/pc/mod/b.archive"]),
            entry("a", "A", "2026-10-01T00:00:00Z", &["archive/pc/mod/a.archive"]),
        ]);
        state.load_order = vec![
            "archive/pc/mod/a.archive".to_string(),
            "archive/pc/mod/b.archive".to_string(),
        ];
        let suggestion = build_suggestion(&state, &[], false, None);
        assert!(suggestion.moves.is_empty());
    }
}
