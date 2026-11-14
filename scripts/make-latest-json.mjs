#!/usr/bin/env node
// 生成 Tauri v2 自更新清单 latest.json（含更新包的 minisign 签名）。
//
// 为什么需要这个脚本：
//   tauri-plugin-updater 只认两样东西——`plugins.updater.endpoints` 里那个
//   `.../releases/latest/download/latest.json`，以及清单里 signature 字段能否
//   用 `plugins.updater.pubkey` 验通。两样都不由 `tauri build` 产出（本项目
//   构建走 `--no-bundle`，不走 bundler 的 createUpdaterArtifacts），所以清单
//   必须由发版流水线自己拼。放在脚本里而不是塞进 workflow 的 shell 片段，是因为
//   签名调用参数很容易写错，而写错的表现是「新版本静默收不到」——只能在用户
//   机器上复现。这里让它在 CI 里就炸。
//
// 签名怎么调：
//   项目用 `scripts/tauri-cli.cjs` 包住 @tauri-apps/cli（绕开内嵌 Node 的 argv
//   猜测），所以签名走 `node scripts/tauri-cli.cjs signer sign <文件>`，它会写出
//   `<文件>.sig`，内容就是 latest.json 里 signature 字段要的那串 base64。
//   私钥通过环境变量注入（TAURI_SIGNING_PRIVATE_KEY / ..._PATH 及其密码），
//   **不**走命令行，避免出现在进程列表与日志里。
//
// 用法（参数均可用环境变量给，带 LATEST_ 前缀，命令行优先）：
//   node scripts/make-latest-json.mjs \
//     --version 1.8.4 \
//     --artifact dist-release/CyberDeck.Launcher.1.8.4.zip \
//     --notes-file dist-release/notes.md \
//     --out dist-release/latest.json
//
//   --version <x.y.z>       必填，发布版本号（带不带 v 都行）
//   --artifact <path>       必填，要签名的更新包（--zip 是它的旧别名）
//   --url <https://...>     下载地址；缺省拼仓库的 releases/download/v<版本>/<文件名>
//   --notes <text>          更新说明正文
//   --notes-file <path>     更新说明正文从文件读（与 --notes 二选一，优先本项）
//   --out <path>            latest.json 输出路径，默认 dist-release/latest.json
//   --platform <key>        平台键，默认 windows-x86_64
//   --repo <owner/repo>     仓库；缺省取 package.json 的 repository.url
//   --key <path>            私钥文件（缺省：环境变量，或本机 .tauri/updater.key）
//   --help                  打印本说明
//
// 退出码：0 成功；1 参数缺失 / 私钥不可用 / 签名失败。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 仓库自带的 CLI 入口：直接调 main.run()，参数原样透传。 */
const TAURI_CLI = join(ROOT, "scripts", "tauri-cli.cjs");
const DEFAULT_PLATFORM = "windows-x86_64";
const DEFAULT_OUT = join("dist-release", "latest.json");

const argv = process.argv.slice(2);

/** `--name=value` 与 `--name value` 两种写法都收。 */
function arg(name) {
  const inline = argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] !== undefined && !argv[idx + 1].startsWith("--")) {
    return argv[idx + 1];
  }
  return null;
}

/** 同义参数：按顺序取第一个有值的。 */
function pick(names) {
  for (const name of names) {
    const value = arg(name);
    if (value !== null && value !== "") return value;
  }
  return null;
}

/** 命令行 > 环境变量 LATEST_<NAME>。 */
function param(names, envName) {
  const fromArgv = pick(names);
  if (fromArgv !== null) return fromArgv;
  const fromEnv = process.env[`LATEST_${envName}`];
  return fromEnv && fromEnv.trim() ? fromEnv : null;
}

function die(message, hint) {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("//"))
      .map((line) => line.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(0);
}

// ── 参数 ───────────────────────────────────────────────────────────────────
const versionRaw = param(["version"], "VERSION");
if (!versionRaw) {
  die(
    "缺少版本号（--version 或 LATEST_VERSION）",
    "例：--version 1.8.4   版本号必须与 package.json / tauri.conf.json 里的一致",
  );
}
const version = versionRaw.replace(/^v/i, "").trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  die(`版本号格式不对：${versionRaw}`, "要求形如 1.8.4，可带预发布后缀如 1.9.0-beta.1");
}

const artifactArg = param(["artifact", "zip"], "ARTIFACT");
if (!artifactArg) {
  die(
    "缺少更新包路径（--artifact 或 LATEST_ARTIFACT）",
    "例：--artifact dist-release/CyberDeck.Launcher.1.8.4.zip",
  );
}
const artifact = resolve(process.cwd(), artifactArg);
if (!existsSync(artifact)) {
  die(`更新包不存在：${artifact}`, "先跑构建与打包步骤，再生成清单");
}
const artifactStat = statSync(artifact);
if (!artifactStat.isFile() || artifactStat.size === 0) {
  die(`更新包不是有效文件或大小为 0：${artifact}`);
}
const artifactName = basename(artifact);

const repoArg = param(["repo"], "REPO");
let repo = repoArg;
if (!repo) {
  // 缺省取 package.json 的 repository.url，避免把 owner/repo 硬编码两处。
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
    const hit = url.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?$/);
    if (hit) repo = `${hit[1]}/${hit[2]}`;
  } catch {
    // 读不到就落到下面的报错，不掩盖问题。
  }
}
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  die(`无法确定仓库（--repo 或 LATEST_REPO）：${repo ?? "空"}`, "要求形如 owner/repo");
}

const url = param(["url"], "URL")
  ?? `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(artifactName)}`;
if (!/^https:\/\//i.test(url)) {
  // 更新器默认拒绝明文 http（除非开 dangerousInsecureTransportProtocol）。
  die(`下载地址必须是 https：${url}`, "GitHub Releases 的资产地址天然是 https，检查是否写成了 http 或相对路径");
}

const notesFile = param(["notes-file"], "NOTES_FILE");
const notesInline = param(["notes"], "NOTES");
let notes;
if (notesFile) {
  const notesPath = resolve(process.cwd(), notesFile);
  if (!existsSync(notesPath)) die(`说明文件不存在：${notesPath}`);
  notes = readFileSync(notesPath, "utf8").trim();
} else if (notesInline) {
  notes = notesInline.trim();
} else {
  // 不给说明不是错误，但空说明会让更新弹窗看起来像出错，给一句兜底。
  notes = `CyberDeck Launcher v${version}`;
}

const platform = (param(["platform"], "PLATFORM") ?? DEFAULT_PLATFORM).trim();
const outPath = resolve(process.cwd(), param(["out"], "OUT") ?? DEFAULT_OUT);

// ── 私钥 ───────────────────────────────────────────────────────────────────
// 三种来源，优先级：--key > TAURI_SIGNING_PRIVATE_KEY_PATH > 私钥串 > 本机默认。
// 私钥串（TAURI_SIGNING_PRIVATE_KEY）交给 CLI 自己从环境读，脚本不碰它的内容。
const keyArg = param(["key", "private-key"], "KEY");
const envKeyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
const envKeyString = process.env.TAURI_SIGNING_PRIVATE_KEY;

let keyPath = keyArg ? resolve(process.cwd(), keyArg) : envKeyPath ? resolve(envKeyPath) : null;
let keyFromEnvString = false;
if (!keyPath) {
  if (envKeyString && envKeyString.trim()) {
    keyFromEnvString = true;
  } else {
    // 本机开发者的默认位置（.gitignore 已忽略，从不入库）。
    const local = join(ROOT, ".tauri", "updater.key");
    if (existsSync(local)) keyPath = local;
  }
}
if (keyPath && !existsSync(keyPath)) {
  die(
    `私钥文件不存在：${keyPath}`,
    "CI 上应使用 TAURI_SIGNING_PRIVATE_KEY（密钥正文）；本机可用 --key 指向 .tauri/updater.key",
  );
}
if (!keyPath && !keyFromEnvString) {
  die(
    "没有可用的签名私钥",
    "设置 TAURI_SIGNING_PRIVATE_KEY（密钥正文，CI 用）/ TAURI_SIGNING_PRIVATE_KEY_PATH（路径），或用 --key 指定；本机默认位置 .tauri/updater.key 也不存在",
  );
}
if (envKeyString && keyPath) {
  console.warn("! 同时设置了 TAURI_SIGNING_PRIVATE_KEY 与私钥路径，以路径为准");
}
// 密码只从环境变量走（TAURI_SIGNING_PRIVATE_KEY_PASSWORD，CLI 自动读取）。
if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  console.log("· 未设置 TAURI_SIGNING_PRIVATE_KEY_PASSWORD：密钥若带密码，签名会失败");
}

// ── 签名 ───────────────────────────────────────────────────────────────────
/** 老版本 CLI 没有 --app-version，先探一次，别拿不存在的参数去调。 */
function supportsAppVersion() {
  const help = spawnSync(process.execPath, [TAURI_CLI, "signer", "sign", "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return `${help.stdout ?? ""}${help.stderr ?? ""}`.includes("--app-version");
}

function signArtifact() {
  const args = [TAURI_CLI, "signer", "sign", artifact];
  if (keyPath) args.push("-f", keyPath);
  // 把签名绑到版本号：开启 requireSignedVersion 的客户端会拒绝「清单版本 ≠ 签名版本」，
  // 这里提前绑上，省得以后打开那个开关时所有旧清单都要重签。
  if (supportsAppVersion()) args.push("--app-version", version);

  const label = keyPath ?? "(环境变量 TAURI_SIGNING_PRIVATE_KEY)";
  console.log(`· 签名 ${artifactName}（私钥：${label}）`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    console.error(stdout.trim());
    die(
      `签名失败（退出码 ${result.status}）`,
      stderr.trim() || "检查私钥是否配错、密码是否正确、更新包是否被占用",
    );
  }
  return stdout;
}

const signStdout = signArtifact();

/** CLI 会把签名写进 `<产物>.sig`；文件读不到时退回解析 stdout。 */
function readSignature(stdout) {
  const sigPath = `${artifact}.sig`;
  if (existsSync(sigPath)) {
    const content = readFileSync(sigPath, "utf8").trim();
    if (content) return { signature: content, source: sigPath };
  }
  const marker = stdout.indexOf("Public signature:");
  if (marker !== -1) {
    const line = stdout
      .slice(marker + "Public signature:".length)
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item && /^[A-Za-z0-9+/=]+$/.test(item));
    if (line) return { signature: line, source: "stdout" };
  }
  die("签名命令跑通了但拿不到签名内容", "检查 <产物>.sig 是否被写到了只读目录");
}

const { signature, source: signSource } = readSignature(signStdout);

// ── 拼清单 ─────────────────────────────────────────────────────────────────
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    [platform]: { signature, url },
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// ── 自检与汇报 ─────────────────────────────────────────────────────────────
// 更新器解 zip 时只读**第一层**、且只认 .exe/.msi（tauri-plugin-updater 的
// extract_zip）。便携包是「CyberDeck Launcher <版本>/」套一层目录，喂进去必然
// 报 BinaryNotFoundInArchive，所以文件名不像更新包时给一条显式警告。
const lowerName = artifactName.toLowerCase();
if (lowerName.endsWith(".zip") && !/(setup|nsis)/.test(lowerName)) {
  console.warn(
    "! 这个 zip 名字不像 Tauri 生成的更新包（通常形如 *-setup.nsis.zip）。\n" +
      "  更新器解压后只在 zip 根目录找 .exe/.msi，普通便携包会安装失败。\n" +
      "  确认要用它做更新源，再忽略这条警告。",
  );
}
if (!lowerName.endsWith(".zip") && !lowerName.endsWith(".exe") && !lowerName.endsWith(".msi")) {
  console.warn(`! 更新包后缀不常见（${lowerName}）：更新器只认 .zip（内含安装器）/.exe/.msi`);
}

const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
console.log("");
console.log("✓ latest.json 已生成");
console.log(`  路径 ${outPath}`);
console.log(`  版本 ${version} · 平台 ${platform}`);
console.log(`  下载 ${url}`);
console.log(`  签名 ${signature.length} 字节（取自 ${signSource}）`);
console.log(
  `  产物 ${artifactName} · ${(artifactStat.size / 1024 / 1024).toFixed(2)} MB · sha256 ${sha256}`,
);
console.log("");
console.log(JSON.stringify(manifest, null, 2));
