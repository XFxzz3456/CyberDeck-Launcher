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

// 4) 兼容扫描：无声明 → warn，绝不 stale
check(/report\.warn\.push/.test(compat), "无声明走 warn 分支");
check(/version_lt/.test(compat), "版本比较集中在一个函数");
check(/TARGET_GAME_VERSION/.test(compat), "目标版本常量存在");

console.log(`checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
