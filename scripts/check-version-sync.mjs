#!/usr/bin/env node
// 版本号一致性校验：package.json / Cargo.toml / tauri.conf.json 必须是同一个值。
//
// 为什么要单独一条门禁：这三处分别是 npm 工具链、Rust 编译、以及**真正打进
// exe 的那个版本**（tauri.conf.json 的 version 就是 `app.getVersion()` 读到的）。
// 只改一两处的后果是「关于页显示 1.0.0、安装器/文件名显示 1.0.1」，而且不报错，
// 只有用户拿着两个版本号来问的时候才会发现。
//
// 与 tag 的关系只做"提示"不做 fail：发版前版本号先升、tag 后打是正常顺序，
// 强行要求 tag 已存在会让正常流程走不下去。
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const pkgVersion = JSON.parse(read("package.json")).version;
const tauriVersion = JSON.parse(read("src-tauri/tauri.conf.json")).version;
const cargoVersion = read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const all = { "package.json": pkgVersion, "Cargo.toml": cargoVersion, "tauri.conf.json": tauriVersion };

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "ok" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed += 1;
};

check(SEMVER.test(pkgVersion), "版本号是合法 SemVer", pkgVersion);
check(
  new Set(Object.values(all)).size === 1,
  "三处版本号一致",
  Object.entries(all).map(([f, v]) => `${f}=${v}`).join(" / "),
);
check(cargoVersion !== "", "Cargo.toml 能读到 version");

// tag 只做提示：当前版本没有对应 tag 时提醒一句，不算失败。
let latestTag = "";
try {
  latestTag = execSync("git describe --tags --abbrev=0", { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  latestTag = "";
}
const tagged = latestTag === `v${pkgVersion}`;
console.log(`${tagged ? "ok" : "note"} 发行 tag：最新 tag ${latestTag || "（无）"} / 当前版本 v${pkgVersion}`);

console.log(`version_sync=${failed === 0 ? 1 : 0}`);
console.log(`current_version=${pkgVersion}`);
process.exit(failed === 0 ? 0 : 1);
