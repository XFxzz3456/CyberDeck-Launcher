// 打包用的 Tauri CLI 入口，绕开 @tauri-apps/cli/tauri.js 的 argv 猜测逻辑。
//
// 原因：DSH 桌面版把 Node 内嵌在 Electron 里运行，此时 process.argv[0] 是
// "D:\Programs\DSH Desktop\DSH Desktop.exe"。tauri.js 会检查 argv[0] 的文件名
// 是否形如 node / bun / electron，不像就把整个 argv[0] 当成子命令塞进参数表，
// 于是底层 CLI 报：unrecognized subcommand 'D:\Programs\DSH Desktop\DSH Desktop.exe'。
// 这里直接调用 main.run()，参数原样透传。
const path = require("path");

const cli = require(
  path.join(__dirname, "..", "node_modules", "@tauri-apps", "cli", "main.js"),
);

cli.run(process.argv.slice(2), "node tauri").catch((error) => {
  cli.logError(error && error.message ? error.message : String(error));
  process.exit(1);
});
