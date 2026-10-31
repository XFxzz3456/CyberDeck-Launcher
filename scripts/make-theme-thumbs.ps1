# 主题缩略图再生成：从 shots/audit/{theme}-library.png 裁出模组库首屏区域，
# 缩放到 176×104 写入 public/theme-thumbs/{theme}.png。
# 用法：先跑 node scripts/audit-shots.mjs 生成截图，再运行本脚本。
# 前置：本机 PowerShell 5+（System.Drawing），无需额外依赖。
#
# 主题配色改动后必须重跑本脚本，否则外观设置页的缩略图会滞后。
#
# 注意：modern（现代通用）不在这里生成——它明暗两套各一张，取景需要按真实 DOM 坐标算，
# 由 scripts/make-modern-thumb.mjs 负责（输出 modern-dark.png / modern-light.png + modern.png 兜底）。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot   # 项目根（scripts/ 的上一级）
$srcDir = Join-Path $root 'shots/audit'
$outDir = Join-Path $root 'public/theme-thumbs'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$themes = @('ncpd', 'netrunner', 'arasaka', 'militech', 'mono')   # modern 见 make-modern-thumb.mjs
$cropX = 248; $cropY = 96; $cropW = 1000; $cropH = 590   # 模组库首屏内容区
$outW = 176; $outH = 104

foreach ($theme in $themes) {
    $src = Join-Path $srcDir "$theme-library.png"
    if (-not (Test-Path $src)) {
        Write-Warning "缺少截图 $src —— 先运行 node scripts/audit-shots.mjs"
        continue
    }
    $srcImg = [System.Drawing.Image]::FromFile($src)
    try {
        $dstImg = New-Object System.Drawing.Bitmap($outW, $outH)
        $graph = [System.Drawing.Graphics]::FromImage($dstImg)
        $graph.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $srcRect = New-Object System.Drawing.Rectangle($cropX, $cropY, $cropW, $cropH)
        $dstRect = New-Object System.Drawing.Rectangle(0, 0, $outW, $outH)
        $graph.DrawImage($srcImg, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        $graph.Dispose()
        $dst = Join-Path $outDir "$theme.png"
        $dstImg.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
        $dstImg.Dispose()
        Write-Host "OK $dst"
    } finally {
        $srcImg.Dispose()
    }
}
Write-Host 'DONE'
