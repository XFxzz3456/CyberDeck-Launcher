# 本地 OpenAI 兼容端点探针（Ollama 等）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-ollama.ps1 [-BaseUrl http://localhost:11434/v1] [-Model qwen2.5:7b]
param(
    [string]$BaseUrl = "http://localhost:11434/v1",
    [string]$Model = "qwen2.5:7b"
)

$ErrorActionPreference = "Stop"
$env:NO_PROXY = "127.0.0.1,localhost"
$failures = 0

function Report([string]$Kind, [string]$Label, [string]$Detail) {
    $color = switch ($Kind) { "PASS" { "Green" } "WARN" { "Yellow" } "FAIL" { "Red" } default { "Gray" } }
    Write-Host ("{0,-5} {1,-28} {2}" -f $Kind, $Label, $Detail) -ForegroundColor $color
}

# 1) 服务存活
try {
    $models = Invoke-RestMethod -Uri "$BaseUrl/models" -TimeoutSec 8
    $ids = @($models.data | ForEach-Object { $_.id })
    Report "PASS" "GET /v1/models" ("{0} model(s)" -f $ids.Count)
    if ($ids.Count -gt 0) { Write-Host ("      " + ($ids -join ", ")) -ForegroundColor DarkGray }
    if ($ids -notcontains $Model) {
        Report "WARN" "model present" "$Model not in list (check: ollama list)"
    } else {
        Report "PASS" "model present" $Model
    }
} catch {
    Report "FAIL" "GET /v1/models" $_.Exception.Message
    $failures++
}

# 2) 对话补全
$body = @{
    model      = $Model
    max_tokens = 32
    messages   = @(@{ role = "user"; content = "只回复两个字：收到" })
} | ConvertTo-Json -Depth 6

try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/chat/completions" -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 120
    $text = $resp.choices[0].message.content
    if ([string]::IsNullOrWhiteSpace($text)) {
        Report "FAIL" "POST /chat/completions" "empty content"
        $failures++
    } else {
        Report "PASS" "POST /chat/completions" ("reply: " + $text.Trim())
    }
} catch {
    Report "FAIL" "POST /chat/completions" $_.Exception.Message
    $failures++
}

Write-Host ""
Write-Host ("RESULT: {0} failure(s)" -f $failures) -ForegroundColor ($(if ($failures -gt 0) { "Red" } else { "Green" }))
exit $(if ($failures -gt 0) { 1 } else { 0 })
