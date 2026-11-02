// 收编（adopt）禁用的安全红线 + Rust 测试接线守卫。
//
// 背景一（2026-11-02 用户实测报错）：「恢复目标已存在，请先检查暂存目录
// ...staging\adopt-xxx」。真因是 `undeploy_mod` 对**收编**来的模组也走
// 「暂存丢了就从游戏目录复制一份回去」的恢复逻辑，而收编模组的母本在外部工具
// （Vortex）目录里，这层恢复既无意义、又会在目标目录名被占时把禁用卡死。
//
// 背景二（同日发现）：`adopt_tests.rs` / `installer_tests.rs` / `game_tests.rs` /
// `ai_tools_tests.rs` / `nxm_tests.rs` 共 1600 多行用例**从未被编译**——lib.rs 里
// 缺 `mod xxx_tests;`，`cargo test` 一直只跑内联用例，等于这批测试一个都没生效。
// 这里直接把"每个 *_tests.rs 都必须挂载"变成断言，防止再次静默失效。
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_SRC = join(ROOT, "src-tauri", "src");
const read = (rel) => readFileSync(join(TAURI_SRC, rel), "utf8");

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
};

// ── 一、收编禁用只断链接 ─────────────────────────────────────────────
const installer = read("installer.rs");
const undeploy = installer.slice(
  installer.indexOf("pub fn undeploy_mod"),
  installer.indexOf("/// 暂存区里的东西还在不在"),
);

check(/let adopted = entry\.origin == "adopted"/.test(undeploy), "禁用时识别收编来源");
check(
  /if !adopted && staging_gone && !entry\.deployed_files\.is_empty\(\)/.test(undeploy),
  "收编模组不得进入 recover_staging（复制回暂存）分支",
);
check(/trust_manifest/.test(undeploy), "暂存丢失的收编模组按清单直删（不再比 inode）");
check(
  /重新扫描收编/.test(undeploy),
  "禁用成功后明确告知：重新启用需要重新收编",
);

// recover_staging 的定义本身不该被收编分支复用：断言它只在 `!adopted` 条件下被调用。
const recoverCalls = [...installer.matchAll(/recover_staging\(\s*store/g)].length;
check(recoverCalls >= 2, `恢复逻辑仍在（${recoverCalls} 处），只对自建模组生效`);

// 硬链接身份校验必须能被 trust_manifest 短路，否则暂存一丢就删不掉。
check(
  /file\.link_type == LinkType::HardLink && !trust_manifest/.test(installer),
  "硬链接 inode 校验受 trust_manifest 控制",
);

// 启用时暂存丢失：收编模组要报可解释的错，不能把库里条目直接删掉。
check(
  /ADOPT_STAGING_MISSING/.test(installer),
  "收编模组暂存丢失时不走 forget_mod（避免模组从列表里凭空消失）",
);

// ── 二、每个 *_tests.rs 必须挂进 lib.rs ──────────────────────────────
const lib = read("lib.rs");
const testFiles = readdirSync(TAURI_SRC).filter((name) => name.endsWith("_tests.rs"));
const missing = testFiles.filter(
  (name) => !new RegExp(`mod\\s+${name.replace(/\.rs$/, "")}\\s*;`).test(lib),
);
check(
  testFiles.length >= 5 && missing.length === 0,
  `所有 *_tests.rs 均已挂载（共 ${testFiles.length} 个${missing.length ? `，缺：${missing.join(", ")}` : ""}）`,
);

console.log(`checks_failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
