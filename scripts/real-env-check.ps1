# CyberDeck Launcher real-game preflight.
# Read-only by default. -ProbeWrite and -ProbeHardlink create and remove two
# temporary files inside the game directory to verify actual ACL / volume
# behavior instead of assuming it.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GameDir,
    [switch]$ProbeWrite,
    [switch]$ProbeHardlink
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $GameDir).Path
$exe = Join-Path $root "bin\x64\Cyberpunk2077.exe"
$failures = 0

function Report([string]$Kind, [string]$Label, [string]$Detail) {
    $color = switch ($Kind) {
        "PASS" { "Green" }
        "FAIL" { "Red" }
        "WARN" { "Yellow" }
        default { "Gray" }
    }
    Write-Host ("{0,-5} {1,-28} {2}" -f $Kind, $Label, $Detail) -ForegroundColor $color
}

function Check-Path([string]$Label, [string]$Path, [bool]$Required = $false) {
    if (Test-Path -LiteralPath $Path) {
        Report "PASS" $Label $Path
        return $true
    }
    if ($Required) {
        Report "FAIL" $Label "missing: $Path"
        $script:failures += 1
    } else {
        Report "WARN" $Label "not found: $Path"
    }
    return $false
}

Write-Host ""
Write-Host "CyberDeck Launcher - real environment preflight" -ForegroundColor Cyan
Write-Host "game: $root"
Write-Host ""

if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Report "FAIL" "game executable" "not found: $exe"
    exit 1
}
Report "PASS" "game executable" $exe

$item = Get-Item -LiteralPath $root
$drive = $item.PSDrive.Name
$volume = Get-Volume -DriveLetter $drive -ErrorAction SilentlyContinue
if ($volume) {
    Report "PASS" "volume" ("{0}: {1} / {2}" -f $drive, $volume.FileSystem, $volume.FileSystemLabel)
    Report "INFO" "free space" ("{0:N1} GB" -f ($volume.SizeRemaining / 1GB))
} else {
    Report "WARN" "volume" "Get-Volume did not return $drive"
}

$version = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
Report "INFO" "game version" ($(if ($version) { $version } else { "unknown" }))

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Report "INFO" "elevated shell" ($(if ($admin) { "yes" } else { "no (normal; hardlinks do not require it)" }))

$archive = Join-Path $root "archive\pc\mod"
Check-Path "archive/pc/mod" $archive $true | Out-Null
Check-Path "RED4ext.dll" (Join-Path $root "red4ext\RED4ext.dll") | Out-Null
# CET 核心：新版以 .asi 插件加载（bin\x64\plugins\cyber_engine_tweaks.asi），老版才是同名 .dll。
# 只认 .dll 会把「装了 CET 的新版本」误报成未安装（2026-11-14 用户实际反馈）。
$cetCandidates = @(
    (Join-Path $root "bin\x64\plugins\cyber_engine_tweaks.asi"),
    (Join-Path $root "bin\x64\plugins\cyber_engine_tweaks\cyber_engine_tweaks.dll")
)
$cetCore = $cetCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($cetCore) { Report "PASS" "CET core" $cetCore } else { Report "WARN" "CET core" "not found: cyber_engine_tweaks.asi / .dll" }
Check-Path "redscript-cli" (Join-Path $root "engine\tools\redscript-cli.exe") | Out-Null
Check-Path "ArchiveXL" (Join-Path $root "red4ext\plugins\ArchiveXL\ArchiveXL.dll") | Out-Null
Check-Path "TweakXL" (Join-Path $root "red4ext\plugins\TweakXL\TweakXL.dll") | Out-Null
# 菜单框架有两个名字：老版 ModSettings（值存 user.ini），新版改名 nativeSettings（值存 db.sqlite3）。
# 菜单文案本身不在这些值文件里，在各 mod 注册菜单时写的 Lua 字符串里（详见 menu_loc.rs）。
$menuRoot = Join-Path $root "bin\x64\plugins\cyber_engine_tweaks\mods"
$menuDirs = @("ModSettings", "nativeSettings") | ForEach-Object { Join-Path $menuRoot $_ }
$menuDir = $menuDirs | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($menuDir) { Report "PASS" "menu framework" $menuDir } else { Report "WARN" "menu framework" "not found: ModSettings / nativeSettings" }
$menuStores = @(
    (Join-Path $menuRoot "ModSettings\user.ini"),
    (Join-Path $menuRoot "nativeSettings\db.sqlite3")
)
$menuStore = $menuStores | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($menuStore) { Report "PASS" "menu settings store" $menuStore } else { Report "WARN" "menu settings store" "not found: user.ini / db.sqlite3" }
Check-Path "redscript.log" (Join-Path $root "r6\logs\redscript.log") | Out-Null
Check-Path "CET log" (Join-Path $root "bin\x64\plugins\cyber_engine_tweaks\cyber_engine_tweaks.log") | Out-Null

# 状态文件有两个落点：便携模式在启动器 exe 同级的 cyberdeck-data，安装/旧版在 %APPDATA%。
# 以前只认 APPDATA，便携用户永远读到 "not found"（2026-11-14 修正）。
$stateCandidates = @(
    (Join-Path $env:APPDATA "com.arol.cyberdeck\launcher-state.json"),
    (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "release\cyberdeck-data\launcher-state.json")
)
$statePath = $stateCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($statePath) {
    try {
        # 必须显式 -Encoding UTF8：默认按 ANSI(GBK) 读，中文一律变乱码后解析失败。
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $deployed = @($state.mods | Where-Object { $_.deployedFiles.Count -gt 0 })
        Report "INFO" "launcher state" ("{0} mods / {1} deployed" -f @($state.mods).Count, $deployed.Count)
        if ($state.gameDir -and ($state.gameDir -ne $root)) {
            Report "WARN" "state game dir" "launcher points at $($state.gameDir), not $root"
        }
    } catch {
        # ConvertFrom-Json 的异常正文会带整段 JSON（实测 134 KB 刷屏），这里只留前 160 字符。
        $msg = "$($_.Exception.Message)"
        if ($msg.Length -gt 160) { $msg = $msg.Substring(0, 160) + " …" }
        Report "WARN" "launcher state" "could not parse ($statePath): $msg"
    }
} else {
    Report "WARN" "launcher state" "not found: %APPDATA%\com.arol.cyberdeck 或 release\cyberdeck-data"
}

if ($ProbeWrite) {
    $probe = Join-Path $archive ".cyberdeck-write-probe-$PID.tmp"
    try {
        [System.IO.File]::WriteAllText($probe, "cyberdeck")
        Remove-Item -LiteralPath $probe -Force
        Report "PASS" "write probe" "create + delete succeeded"
    } catch {
        Report "FAIL" "write probe" $_.Exception.Message
        $script:failures += 1
    } finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
    }
}

if ($ProbeHardlink) {
    if (-not (Test-Path -LiteralPath $archive -PathType Container)) {
        Report "FAIL" "hardlink probe" "archive/pc/mod is missing"
        $script:failures += 1
    } else {
        $source = Join-Path $root ".cyberdeck-hardlink-source-$PID.tmp"
        $target = Join-Path $archive ".cyberdeck-hardlink-target-$PID.tmp"
        try {
            [System.IO.File]::WriteAllText($source, "cyberdeck")
            New-Item -ItemType HardLink -Path $target -Target $source -ErrorAction Stop | Out-Null
            Report "PASS" "hardlink probe" "same-volume hardlink succeeded"
        } catch {
            Report "FAIL" "hardlink probe" $_.Exception.Message
            $script:failures += 1
        } finally {
            foreach ($path in @($target, $source)) {
                if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
            }
        }
    }
}

Write-Host ""
Write-Host "Next manual checks:" -ForegroundColor Cyan
Write-Host "  1. Import a real archive mod, enable it, confirm it appears in archive/pc/mod."
Write-Host "  2. Import a CET mod whose ZIP contains bin/x64/plugins/cyber_engine_tweaks, enable it,"
Write-Host "     launch, press ~, and confirm the mod appears in the CET console."
Write-Host "  3. Import a .xl alongside its .archive and confirm both land in archive/pc/mod."
Write-Host "  4. If a ZIP contains Wrapper/Inner/archive/..., import it and confirm the staging root"
Write-Host "     is Inner (the launcher reports the normalized path, not a fake success)."
Write-Host "  5. Open Diagnostics -> Logs, pick redscript.log, and confirm Error lines are red."
Write-Host "  6. Add a real DeepSeek key, consent, run AI diagnostics once; confirm usage in your account."
Write-Host ""
Write-Host ("RESULT: {0} failure(s)" -f $failures) -ForegroundColor ($(if ($failures -gt 0) { "Red" } else { "Green" }))
if ($failures -gt 0) { exit 1 }
