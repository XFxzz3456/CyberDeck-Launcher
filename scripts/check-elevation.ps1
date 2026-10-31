# 提权 / DPAPI / 数据目录回归：跑两次 `--self-check`（普通权限 + 提权），diff 结论。
#
# 为什么需要这个脚本：任务【1】里「管理员提权构建实测」的四项（UAC 启动、浏览器跳转、
# 拖拽是否被 UIPI 拦、DPAPI Key 读回）以前只能人工点界面。其中「数据目录落到哪」
# 和「DPAPI 能不能解密」完全可以用无窗口自检回答，且必须每次发版都看一眼：
# 提权后如果数据目录换成另一份，用户会看到"模组全没了"。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-elevation.ps1
#       只跑普通权限那一趟（安全、无弹窗）。
#   ... -Elevated
#       额外用 Start-Process -Verb RunAs 起一次提权实例；会弹 UAC，需要点「是」。
#
# 注意：这个脚本只读状态、不启动游戏、不改任何设置。唯一的写操作是往
# shots/gate 里写两份 JSON。
param(
    [string]$Exe = "",
    [switch]$Elevated,
    [int]$TimeoutSec = 120
)

$ErrorActionPreference = "Stop"

# Start-Process 在 PS 5.1 上会因为环境变量里同时有 HTTPS_PROXY 和 https_proxy
# 而抛「字典中的关键字重复」（Windows 环境块大小写不敏感，PowerShell 的字典不是）。
# 只在本进程里去掉小写变体，不影响系统设置。
foreach ($name in @("https_proxy", "http_proxy", "all_proxy", "no_proxy")) {
    if (Test-Path "Env:$name") { Remove-Item "Env:$name" -Force -ErrorAction SilentlyContinue }
}

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "shots\gate"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (-not $Exe) {
    $candidates = @(
        "D:\用户\工作区\release\CyberDeck Launcher.exe",
        (Join-Path $root "src-tauri\target\release\cyberdeck-launcher.exe"),
        (Join-Path $root "src-tauri\target\debug\cyberdeck-launcher.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $Exe = $candidate; break }
    }
}
if (-not $Exe -or -not (Test-Path $Exe)) {
    Write-Host "FAIL  找不到启动器 exe；用 -Exe 指定路径" -ForegroundColor Red
    exit 1
}
Write-Host "exe : $Exe"
Write-Host ""

function Invoke-SelfCheck {
    param([string]$Target, [switch]$AsAdmin)

    if (Test-Path $Target) { Remove-Item $Target -Force }
    $arguments = @("--self-check", "`"$Target`"")
    # 子进程的 stderr 会把整份 JSON 打到控制台，混在自己这几行结论里很难看；
    # 单独重定向到 <target>.stderr.log，排查时再看。
    $stderrLog = "$Target.stderr.log"
    if ($AsAdmin) {
        # -Verb RunAs 必须走 ShellExecute，而 ShellExecute 不支持重定向 stdout/stderr；
        # 好在提权实例自带独立控制台窗口，输出不会混进本脚本的输出里。
        $process = Start-Process -FilePath $Exe -ArgumentList $arguments -Verb RunAs -PassThru
    } else {
        # 普通权限这一趟把 stderr 单独落文件：否则整份 JSON 会糊在结论中间。
        $stderrLog = "$Target.stderr.log"
        $process = Start-Process -FilePath $Exe -ArgumentList $arguments -PassThru -RedirectStandardError $stderrLog
    }
    if (-not $process.WaitForExit($TimeoutSec * 1000)) {
        try { $process.Kill() } catch { }
        throw "自检进程 $TimeoutSec 秒未退出（可能卡在 UAC 确认框）"
    }
    if (-not (Test-Path $Target)) {
        throw "自检没有产出 $Target（退出码 $($process.ExitCode)）"
    }
    # 必须显式 UTF8：PS 5.1 的 Get-Content 默认按 ANSI 读，会把 JSON 里的中文路径读成乱码，
    # 然后 ConvertFrom-Json 报「无法识别的转义序列」。
    return Get-Content -Raw -Encoding UTF8 -Path $Target | ConvertFrom-Json
}

$failures = @()

Write-Host "== 普通权限 ==" -ForegroundColor Cyan
$standard = $null
try {
    $standard = Invoke-SelfCheck -Target (Join-Path $outDir "selfcheck-standard.json")
} catch {
    Write-Host "FAIL  $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ("  elevated      : {0}" -f $standard.elevated)
Write-Host ("  dataDir       : {0}" -f $standard.dataDir)
Write-Host ("  dataDirProbe  : {0}" -f $standard.dataDirProbe)
Write-Host ("  state         : loaded={0} mods={1} profiles={2}" -f $standard.state.loaded, $standard.state.mods, $standard.state.profiles)
Write-Host ("  secrets       : ai={0} nexus={1}" -f $standard.secrets.aiKey, $standard.secrets.nexusKey)
if ($standard.game) {
    Write-Host ("  game          : {0} (exe={1})" -f $standard.game.root, $standard.game.exePresent)
} else {
    Write-Host "  game          : 未绑定"
}

if ($standard.dataDirProbe -ne "ok") { $failures += "普通权限下数据目录不可写：$($standard.dataDirProbe)" }
if ($standard.elevated) { $failures += "当前进程已经是提权状态，这一趟不能作为普通权限基线" }
foreach ($key in @("aiKey", "nexusKey")) {
    $value = $standard.secrets.$key
    if ($value -like "error*") { $failures += "DPAPI 解密失败（$key）：$value" }
}

if (-not $Elevated) {
    Write-Host ""
    Write-Host "跳过提权对照（加 -Elevated 会弹 UAC）。" -ForegroundColor Yellow
    Write-Host "提权那一趟要看的三件事：dataDir 与普通权限完全一致、secrets 仍然 readable、state.mods 数不变。"
} else {
    Write-Host ""
    Write-Host "== 提权（UAC 请点是）==" -ForegroundColor Cyan
    try {
        $admin = Invoke-SelfCheck -Target (Join-Path $outDir "selfcheck-elevated.json") -AsAdmin
    } catch {
        Write-Host "FAIL  $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
    Write-Host ("  elevated      : {0}" -f $admin.elevated)
    Write-Host ("  dataDir       : {0}" -f $admin.dataDir)
    Write-Host ("  state         : loaded={0} mods={1}" -f $admin.state.loaded, $admin.state.mods)
    Write-Host ("  secrets       : ai={0} nexus={1}" -f $admin.secrets.aiKey, $admin.secrets.nexusKey)

    if (-not $admin.elevated) { $failures += "提权实例报告 elevated=false（UAC 被拒或没起来）" }
    if ($admin.dataDir -ne $standard.dataDir) {
        $failures += "提权后数据目录变了：$($standard.dataDir) -> $($admin.dataDir)（用户会看到模组全没）"
    }
    if ($admin.state.mods -ne $standard.state.mods) {
        $failures += "提权后模组数变了：$($standard.state.mods) -> $($admin.state.mods)"
    }
    foreach ($key in @("aiKey", "nexusKey")) {
        $value = $admin.secrets.$key
        if ($value -like "error*") { $failures += "提权后 DPAPI 解密失败（$key）：$value" }
        elseif ($standard.secrets.$key -eq "readable" -and $value -ne "readable") {
            $failures += "普通权限能读的 $key，提权后读不到（$value）"
        }
    }
}

Write-Host ""
if ($failures.Count -eq 0) {
    Write-Host "RESULT: 0 failure(s)" -ForegroundColor Green
    exit 0
}
foreach ($item in $failures) { Write-Host "FAIL  $item" -ForegroundColor Red }
Write-Host ("RESULT: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
exit 1
