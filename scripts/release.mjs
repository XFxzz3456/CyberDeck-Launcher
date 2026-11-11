#!/usr/bin/env node
// 一键发版（方案 B）：门禁 → 升版 → 构建 → 同步 exe → 提示 tag。
//
// 为什么把顺序写死成这一条链，而不是让 npm script 用 && 串起来：
//   1. 这些步骤里有两步会**改变工作区**（bump 改三处版本号 + CHANGELOG、
//      构建覆盖产物）。串在一个 shell 行里，中途失败时看不出走到了第几步，
//      也分不清「版本号已经改了但没构建」和「压根没动」。
//   2. 每步的失败处置不一样：门禁失败应原地停（什么都没改），构建失败则必须
//      明确告诉人「版本号已经升到 X 了，要么重跑构建要么回退 commit」。
//   3. 需要一个「构建产物真的是这一次生成的」硬校验。踩过的坑：tauri build
//      在没有改动时会命中缓存秒退，人以为出了新包，其实还是旧 exe。
//
// 刻意不做的事：
//   · 不自动 git commit / tag / push。提交信息要人写，tag 是已发布的事实，
//     推送要过代理和凭据——这三件都不该藏进一个 npm 命令里。脚本末只打印命令。
//   · 不打便携 ZIP。对外分发的压缩包必须由人确认后单独打（项目固定规则）。
//
// 用法：
//   npm run release                 # 全量：门禁 → 升版 → 构建 → 同步 release 目录
//   npm run release -- --dry-run    # 只打印将要执行的步骤与当前状态，不动任何文件
//   npm run release -- --skip-gate  # 跳过门禁（仅限「刚刚已跑过全绿」时省时间）
//   npm run release -- --skip-bump  # 跳过升版（三处版本号已手工改好，只盖 exe）
//   npm run release -- --skip-build # 只升版不构建（补 CHANGELOG 与版本号时用）
//   npm run release -- --level=patch|minor|major   # 强制升版级别，透传给 bump-version
//   npm run release -- --fast       # 门禁走 --fast（只验静态项，日常迭代可用，发版别用）
//   npm run release -- --allow-dirty    # 预检放行「工作区有未提交改动」（默认预检失败即停）
//   npm run release -- --allow-no-tag   # 预检放行「最新 tag 与版本不一致 / 不是 git 仓库」

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 发行目录在仓库外（D:\用户\CyberDeck-Launcher\release），源码目录是它的子目录。
const RELEASE_DIR = resolve(ROOT, "..", "release");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY = flag("dry-run");
const SKIP_GATE = flag("skip-gate");
const SKIP_BUMP = flag("skip-bump");
const SKIP_BUILD = flag("skip-build");
const FAST = flag("fast");
const LEVEL = value("level");
// 预检默认是「拦」而不是「提示」：脏工作区与 tag 不一致都会让升版基点悄悄跑偏，
// 事后只能靠翻 CHANGELOG 猜。确实要在这种状态下发版，就显式加放行开关。
const ALLOW_DIRTY = flag("allow-dirty");
const ALLOW_NO_TAG = flag("allow-no-tag");

const readPkg = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const currentVersion = readPkg().version;

// git 输出的路径默认会把非 ASCII 转成 \344\270\255 这种八进制转义，
// 而本项目工作区路径就带中文（D:\用户\…），关掉 quotepath 才看得懂。
const sh = (cmd) =>
  spawnSync(`git -c core.quotepath=false ${cmd}`, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
  }).stdout?.trim() ?? "";

// 构建开始的时刻。用来卡「产物确实是这一轮编译出来的」，
// 所以必须放在步骤定义之前（sync 步骤会读它）。
let buildStartedAt = 0;

// ── 步骤定义 ───────────────────────────────────────────────────────────────
const steps = [];

steps.push({
  key: "preflight",
  title: "预检（版本 / tag / 工作区）",
  run() {
    if (!existsSync(join(ROOT, ".git"))) {
      if (!ALLOW_NO_TAG) {
        console.error("    ✗ 这不是 git 仓库：版本追踪只能靠 CHANGELOG，升版判定会退化成 HEAD~1 比对");
        console.error("      确认要这样发版，就加 --allow-no-tag。");
        return false;
      }
      console.log("    这不是 git 仓库（已放行）：版本追踪只能靠 CHANGELOG，升版判定会退化成 HEAD~1 比对");
      return true;
    }
    const tag = sh("describe --tags --abbrev=0");
    const dirty = sh("status --porcelain").split("\n").filter(Boolean);
    console.log(`    当前版本 ${currentVersion} · 最新 tag ${tag || "（无）"}`);
    let ok = true;
    if (tag && tag !== `v${currentVersion}`) {
      if (ALLOW_NO_TAG) {
        console.log(`    注意（已放行）：最新 tag ${tag} 与当前版本 v${currentVersion} 不一致`);
      } else {
        console.error(`    ✗ 最新 tag ${tag} 与当前版本 v${currentVersion} 不一致，升版基点可能不是你以为的那个。`);
        console.error("      先处理 tag，或确认无误后加 --allow-no-tag。");
        ok = false;
      }
    }
    if (dirty.length) {
      if (ALLOW_DIRTY) {
        console.log(`    注意（已放行）：工作区有 ${dirty.length} 个未提交改动`);
      } else {
        console.error(`    ✗ 工作区有 ${dirty.length} 个未提交改动，升版判定会把它们算进本次发布：`);
        for (const line of dirty.slice(0, 8)) console.error(`      ${line}`);
        if (dirty.length > 8) console.error(`      …还有 ${dirty.length - 8} 项`);
        console.error("      先提交或 stash，或确认无误后加 --allow-dirty。");
        ok = false;
      }
    }
    return ok;
  },
});

if (!SKIP_GATE) {
  steps.push({
    key: "gate",
    title: `合入门禁${FAST ? "（--fast）" : ""}`,
    // 门禁输出要实时看得到，所以走 inherit 而不是捕获。
    spawn: [process.execPath, ["scripts/gate.mjs", ...(FAST ? ["--fast"] : [])]],
    // 门禁失败就不该动版本号，直接中止。
    onFail: "门禁没过，什么都没有改动。先修红项再发版。",
  });
}

// 升版这一步是唯一「改了文件就回不去」的环节（其余都能重跑），所以给一个显式的
// 跳过开关：手工已经改好三处版本号、只想补构建时用 --skip-bump，别再自动升一级。
if (!SKIP_BUMP) {
  steps.push({
    key: "bump",
    title: `版本号升版${LEVEL ? `（--level=${LEVEL}）` : "（自动判定）"}`,
    spawn: [
      process.execPath,
      ["scripts/bump-version.mjs", "--apply", ...(LEVEL ? ["--level", LEVEL] : [])],
    ],
    onFail: "升版失败，脚本内部已回滚四个文件（三处版本号 + CHANGELOG）。",
  });
}

if (!SKIP_BUILD) {
  steps.push({
    key: "build",
    title: "构建 exe（tauri build --no-bundle）",
    // 走仓库自带的 CLI 入口，绕开 @tauri-apps/cli 对内嵌 Node 的 argv 猜测。
    spawn: [process.execPath, ["scripts/tauri-cli.cjs", "build", "--no-bundle"]],
    onFail:
      "构建失败。版本号在上一阶段已经改成新值且没有回退：要么修好后重跑 `npm run release -- --skip-gate`（bump 会自动判定为 patch，可能多升一级，介意就先手动改回目标版本），要么 `git checkout -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md` 整体退回。",
  });

  steps.push({
    key: "sync",
    title: "同步到 release 目录（备份 + md5）",
    run() {
      // 产物目录要跟着 CARGO_TARGET_DIR 走：本机为省 C 盘空间把它指到 D:/cdbuild。
      // 以前硬编码 src-tauri/target，结果读到上一轮的旧 exe，被下面的时间校验拦下（2026-11-10 踩过）。
      const releaseProfile = process.env.CARGO_TARGET_DIR
        ? join(resolve(process.env.CARGO_TARGET_DIR), "release")
        : join(ROOT, "src-tauri", "target", "release");
      const built = newestExe(releaseProfile);
      if (!built) throw new Error(`${releaseProfile} 下找不到 exe，构建可能没真正执行`);
      const info = statSync(built);
      // 硬校验：产物必须是这一轮构建出来的。tauri build 命中缓存时会秒退，
      // 只靠「命令返回 0」判断会把人骗过去。
      if (buildStartedAt && info.mtimeMs < buildStartedAt - 5000) {
        throw new Error(
          `产物时间 ${info.mtime.toLocaleString("zh-CN")} 早于本次构建开始，像是命中了缓存而不是新编译`,
        );
      }
      const target = join(RELEASE_DIR, "CyberDeck Launcher.exe");
      if (!existsSync(RELEASE_DIR)) {
        console.log(`    release 目录不存在，跳过同步：${RELEASE_DIR}`);
        return true;
      }
      if (existsSync(target)) {
        copyFileSync(target, target.replace(/\.exe$/, ".prev.exe"));
        console.log(`    旧版已备份为 CyberDeck Launcher.prev.exe`);
      }
      replaceExe(built, target);
      const bytes = readFileSync(target);
      const md5 = createHash("md5").update(bytes).digest("hex");
      console.log(`    已替换 ${target}`);
      console.log(`    大小 ${(bytes.length / 1024 / 1024).toFixed(2)} MB · md5 ${md5}`);
      return true;
    },
  });
}

steps.push({
  key: "next",
  title: "下一步（人工执行）",
  run() {
    const next = readPkg().version;
    console.log(`    git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md`);
    console.log(`    git commit -m "chore(release): ${next}"`);
    console.log(`    git tag v${next}`);
    console.log(`    git push origin main --tags        # 需要走代理与一次性凭据，确认后再执行`);
    return true;
  },
});

/** target/release 里最新的业务 exe（排除 build script 之类的小工具）。 */
function newestExe(dir) {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).size > 2 * 1024 * 1024)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

/**
 * 覆盖发行目录里的 exe。
 * 启动器正在运行时 Windows 会锁住该文件（EPERM/EBUSY）。项目已授权「替换 exe 时
 * 可直接结束启动器进程，状态会自动保存」，所以这里直接收掉再重试一次，
 * 不把「请先手动关闭程序」这种等待抛回给人。
 */
function replaceExe(src, dst) {
  try {
    copyFileSync(src, dst);
    return;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EBUSY" && error.code !== "EACCES") throw error;
    console.log("    目标 exe 被占用，结束后台启动器进程后重试");
    spawnSync("taskkill", ["/IM", "CyberDeck Launcher.exe", "/F"], { stdio: "ignore" });
    // 进程退出到文件句柄释放之间有个很短的窗口，同步等一下再复制。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    copyFileSync(src, dst);
  }
}

// ── 执行 ───────────────────────────────────────────────────────────────────
console.log("◆ CyberDeck Launcher 发版编排");
console.log(`  根目录 ${ROOT}`);
console.log(`  发行目录 ${RELEASE_DIR}`);
console.log(`  计划：${steps.map((step) => step.title).join(" → ")}`);

if (DRY) {
  console.log("\n（--dry-run：预检 + 预演升版判定，不构建、不动任何文件）\n");
  const preflight = steps[0];
  console.log(`▸ ${preflight.title}`);
  const preflightOk = preflight.run();
  if (!preflightOk) {
    console.error("\n✗ 预检未通过，--dry-run 到此为止（真实发版同样会被拦下）。");
    process.exit(1);
  }
  if (!SKIP_BUMP) {
    console.log("\n▸ 升版预演（bump-version 不带 --apply，只打印判定）");
    spawnSync(
      process.execPath,
      ["scripts/bump-version.mjs", ...(LEVEL ? ["--level", LEVEL] : [])],
      { cwd: ROOT, stdio: "inherit" },
    );
  }
  process.exit(0);
}

const t0 = Date.now();
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.title}`;
  console.log(`\n▸ ${label}`);
  const started = Date.now();

  if (step.spawn) {
    const [cmd, args] = step.spawn;
    if (step.key === "build") buildStartedAt = Date.now();
    const result = spawnSync(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        // cargo 不一定在非交互 shell 的 PATH 里，补上官方默认位置。
        PATH: [
          join(process.env.USERPROFILE ?? "", ".cargo", "bin"),
          process.env.PATH ?? "",
        ].join(";"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    });
    if (result.status !== 0) {
      console.error(`\n✗ ${step.title} 失败（退出码 ${result.status}）`);
      if (step.onFail) console.error(`  ${step.onFail}`);
      console.error(`  已耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，后续步骤未执行。`);
      process.exit(1);
    }
  } else {
    try {
      const ok = step.run();
      if (ok === false) {
        console.error(`\n✗ ${step.title} 未通过`);
        if (step.onFail) console.error(`  ${step.onFail}`);
        console.error(`  已耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，后续步骤未执行。`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`\n✗ ${step.title} 失败：${error.message}`);
      process.exit(1);
    }
  }

  console.log(`  ✓ ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

console.log(`\n✓ 发版链路完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  版本 ${currentVersion} → ${readPkg().version}`);
console.log(`  提示：便携 ZIP 不在此脚本内，需要对外分发时单独确认后打包。`);
