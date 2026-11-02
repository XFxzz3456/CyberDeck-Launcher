// 安全模式 / 兼容扫描的静态守卫（看板【13】）。
//
// 这类"只断链接"的破坏性功能，最怕的是某次重构悄悄把"删文件"加回来。用源码断言
// 把三条红线钉住：二次确认、只按 deployed_files 撕除、不碰 staging、无声明不判过期。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel) => readFileSync(join(root, rel), "utf8");

const safemode = read("src-tauri/src/safemode.rs");
const compat = read("src-tauri/src/compat.rs");
const card = read("src/components/SafeModeCard.tsx");
const zh = read("src/i18n/zh-CN.ts");
// 只看非测试部分：测试里的临时目录清理会用到 remove_dir_all，属正常。
const safemodeImpl = safemode.split("#[cfg(test)]")[0];

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
};

// 1) 撕除只走 installer::undeploy_mod（它内部只读 deployed_files）
check(/installer::undeploy_mod/.test(safemode), "撕除复用 installer::undeploy_mod");
check(!/remove_dir_all/.test(safemodeImpl), "实现代码里不出现 remove_dir_all");
check(!/staging_dir\s*\)\s*\.\s*remove/.test(safemode), "不直接删除暂存目录");

// 2) 二次确认：卡片里必须同时有 enter/exit 两个确认态与 Modal
check(/setConfirm\("enter"\)/.test(card) && /setConfirm\("exit"\)/.test(card), "两个操作都有二次确认入口");
check(/<Modal/.test(card), "确认弹窗使用统一 Modal");
// 文案在词表里，卡片只引用 key：确认文案写清"不删文件"要看 zh-CN
check(/不删除任何 Mod 文件/.test(zh), "授权文案写清不删文件");
check(/safemode\.confirmEnterBody/.test(card), "进入确认使用专门文案");

// 3) 快照与回退
check(/safemode-snapshot\.json/.test(safemode), "快照文件固定命名");
check(/SAFEMODE_IDLE/.test(safemode), "无快照时明确报错而不是静默成功");
check(/failed_mods == 0/.test(safemode), "恢复失败时保留快照");

// 4) 兼容体检（b014cf 重构）：只查核心前置，绝不回到「逐 Mod 找元数据」的老路。
//    老实现会把 186 个 Mod 里的 114 个标成"兼容性未知"，纯焦虑制造；这条断言
//    就是防止某次重构又把 read_declaration 捡回来。
const compatImpl = compat.split("#[cfg(test)]")[0];
check(!/read_declaration/.test(compatImpl), "不再逐 Mod 读元数据（read_declaration 已删除）");
check(
  ["red4ext", "archivexl", "tweakxl", "codeware"].every((id) => compatImpl.includes(`id: "${id}"`)),
  "核心前置清单含 RED4ext / ArchiveXL / TweakXL / Codeware",
);
check(/report\.risks\.push/.test(compatImpl), "风险只来自前置缺失/半装");
check(/healthy = report\.risks\.is_empty\(\)/.test(compatImpl), "无风险才算健康");
check(/gamever::describe/.test(compatImpl), "目标版本走 gamever 映射，不直接回显内部号");

// 5) 版本号映射：内部四段号必须换成社区叫法，且阈值表是数据不是逻辑。
const gamever = read("src-tauri/src/gamever.rs");
check(/INTERNAL_FLOORS/.test(gamever), "版本阈值表集中在 gamever.rs");
check(/\(80, "2\.5"\)/.test(gamever), "2.5 桶按 3.0.80 起算");
check(/LEGACY_LABEL/.test(gamever), "过老版本有明确兜底标签，不退化成前三段");
check(/UNKNOWN_LABEL/.test(gamever), "认不出来时给未知，不猜");

// 5b) 前后端阈值表必须逐项一致 —— 两边查表结果不同会出现「侧栏说 2.5、
//     诊断说别的」这种鬼故事。这里直接把两张表抽出来做全等比较。
const rustFloors = [...gamever.matchAll(/\((\d+), "([0-9.]+)"\)/g)].map((m) => `${m[1]}:${m[2]}`);
const tsFloors = [
  ...read("src/lib/gameVersion.ts").matchAll(/\{ patch: (\d+), label: "([0-9.]+)" \}/g),
].map((m) => `${m[1]}:${m[2]}`);
check(
  rustFloors.length >= 3 && rustFloors.join(",") === tsFloors.join(","),
  `前后端版本阈值表一致（rust=${rustFloors.join(",")} / ts=${tsFloors.join(",")}）`,
);

// 6) 卡片不再渲染"未知"长列表，健康时只给绿色结论
check(/compat-ok/.test(card), "健康结论用 .compat-ok 绿条");
check(!/compat-warn-block/.test(card), "未知列表的折叠块已移除");
check(/scan\.healthy/.test(card), "卡片按 healthy 分支渲染");

console.log(`checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
