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
Check-Path "CET dll" (Join-Path $root "bin\x64\plugins\cyber_engine_tweaks\cyber_engine_tweaks.dll") | Out-Null
Check-Path "redscript-cli" (Join-Path $root "engine\tools\redscript-cli.exe") | Out-Null
Check-Path "ArchiveXL" (Join-Path $root "red4ext\plugins\ArchiveXL\ArchiveXL.dll") | Out-Null
Check-Path "TweakXL" (Join-Path $root "red4ext\plugins\TweakXL\TweakXL.dll") | Out-Null
Check-Path "ModSettings" (Join-Path $root "bin\x64\plugins\cyber_engine_tweaks\mods\ModSettings") | Out-Null
Check-Path "ModSettings user.ini" (Join-Path $root "bin\x64\plugins\cyber_engine_tweaks\mods\ModSettings\user.ini") | Out-Null
Check-Path "redscript.log" (Join-Path $root "r6\logs\redscript.log") | Out-Null
Check-Path "CET log" (Join-Path $root "bin\x64\plugins\cyber_engine_tweaks\cyber_engine_tweaks.log") | Out-Null

$statePath = Join-Path $env:APPDATA "com.arol.cyberdeck\launcher-state.json"
if (Test-Path -LiteralPath $statePath) {
    try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $deployed = @($state.mods | Where-Object { $_.deployedFiles.Count -gt 0 })
        Report "INFO" "launcher state" ("{0} mods / {1} deployed" -f @($state.mods).Count, $deployed.Count)
        if ($state.gameDir -and ($state.gameDir -ne $root)) {
            Report "WARN" "state game dir" "launcher points at $($state.gameDir), not $root"
        }
    } catch {
        Report "WARN" "launcher state" "could not parse: $($_.Exception.Message)"
    }
} else {
    Report "WARN" "launcher state" "not found (app has not been started yet)"
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
