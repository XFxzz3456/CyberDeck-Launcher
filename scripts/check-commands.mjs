#!/usr/bin/env node
// Tauri 命令契约静态校验。
//
// 背景（0.9.0 r22 踩过）：新增命令必须同时做三件事 ——
//   1) `#[tauri::command] fn xxx`        定义
//   2) `tauri::generate_handler![..., xxx]`  注册
//   3) 前端 `invoke("xxx")`              调用
// 漏第 2 步编译期不报错，运行时才炸「command xxx not found」。
// 本脚本把这三处的名字对齐，缺一处就红。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "src-tauri", "src", "lib.rs");
const SRC = join(ROOT, "src");

const lib = readFileSync(LIB, "utf8");

// 1) 声明的命令：`#[tauri::command]` 之后（中间允许有 doc 注释/属性）的第一个 fn 名
const declared = new Set();
const declRe = /#\[tauri::command\][\s\S]{0,400}?\bfn\s+([a-z0-9_]+)/g;
for (let m = declRe.exec(lib); m; m = declRe.exec(lib)) declared.add(m[1]);

// 2) 注册的命令：generate_handler! 列表内的标识符
const handlerStart = lib.indexOf("generate_handler!");
if (handlerStart < 0) {
  console.log("commands=0 missing=0 unresolved=0 error=no_generate_handler");
  process.exit(1);
}
const handlerBlock = lib.slice(handlerStart);
const handlerEnd = handlerBlock.indexOf("])");
const handlerBody = handlerBlock.slice(0, handlerEnd < 0 ? undefined : handlerEnd);
const handled = new Set();
for (const m of handlerBody.matchAll(/\b([a-z0-9_]+)\b/g)) handled.add(m[1]);

// 3) 前端 invoke 的名字
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if ([".ts", ".tsx"].includes(extname(p))) out.push(p);
  }
  return out;
}

const invoked = new Map(); // name -> [file:line]
// 两种写法都要抓：直接 `invoke("x")`，以及项目包装 `call("x")`（见 src/lib/api.ts）。
// 允许泛型参数里有换行、名字字符串前也有换行（`invoke<{a:1}>(\n  "x"` 这种）。
const CALL_RE = /\b(?:invoke|call)\s*(?:<[^>()]*>)?\s*\(\s*["'`]([a-z0-9_]+)["'`]/g;
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const rel = file.replace(ROOT + "\\", "").replace(ROOT + "/", "");
  for (const m of text.matchAll(CALL_RE)) {
    const key = m[1];
    if (key === "call" || key === "invoke") continue;
    if (!invoked.has(key)) invoked.set(key, []);
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    invoked.get(key).push(`${rel}:${line}`);
  }
}

const missingInHandler = [...declared].filter((c) => !handled.has(c)).sort();
const unresolved = [...invoked.keys()].filter((c) => !handled.has(c)).sort();

for (const c of missingInHandler) console.log(`  ✗ 已定义但未注册: ${c}`);
for (const c of unresolved) console.log(`  ✗ 前端调用了未注册的命令: ${c}  (${invoked.get(c).slice(0, 3).join(", ")})`);

const deadRegistered = [...handled].filter((c) => declared.has(c) && !invoked.has(c)).sort();

console.log(
  `commands=${declared.size} registered=${[...handled].filter((c) => declared.has(c)).length} ` +
    `invoked=${invoked.size} missing=${missingInHandler.length} unresolved=${unresolved.length}`,
);
if (deadRegistered.length) {
  console.log(`  · 仅后端调用/未在前端直接 invoke（供参考，不判失败）: ${deadRegistered.join(", ")}`);
}

process.exit(missingInHandler.length === 0 && unresolved.length === 0 ? 0 : 1);
