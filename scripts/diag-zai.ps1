# 诊断：zai API Key 直连 api.z.ai 的可用性 + 当前账号池原始状态
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$cfg = Get-Content "$env:USERPROFILE\.zcode\v2\config.json" -Raw | ConvertFrom-Json
$key = [string]$cfg.provider.'builtin:zai-coding-plan'.options.apiKey
"凭证: 长度 $($key.Length) 前缀 $($key.Substring(0,6))…"

function Try-Model([string]$model) {
  $payload = @{ model = $model; max_tokens = 16; messages = @(@{ role = 'user'; content = 'ping' }) } | ConvertTo-Json -Depth 5
  try {
    $r = Invoke-WebRequest -Method Post -Uri 'https://api.z.ai/api/anthropic/v1/messages' `
      -Headers @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01' } `
      -ContentType 'application/json' -Body $payload -TimeoutSec 60 -UseBasicParsing
    "  {0,-12} -> HTTP {1}  {2}" -f $model, $r.StatusCode, $r.Content.Substring(0, [Math]::Min(160, $r.Content.Length))
  } catch {
    $resp = $_.Exception.Response
    $body = ''
    if ($resp) { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8); $body = $sr.ReadToEnd() }
    "  {0,-12} -> HTTP {1}  {2}" -f $model, $(if ($resp) { [int]$resp.StatusCode } else { 'ERR' }), $body.Substring(0, [Math]::Min(200, $body.Length))
  }
}

Write-Host "`n=== 直连 api.z.ai（API Key 路径，无需验证码） ==="
foreach ($m in @('glm-4.6', 'GLM-4.6', 'glm-4.5', 'glm-4.6-flash')) { Try-Model $m }

Write-Host "`n=== 账号池原始状态 ==="
try {
  $list = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3000/admin/api/accounts' -Headers @{ Authorization = 'Bearer zcode' }
  ($list.accounts | Select-Object name, provider, mode, status, enabled, last_error | ConvertTo-Json -Depth 4)
  "stats: " + ($list.stats | ConvertTo-Json -Compress)
} catch { "读取账号池失败: $($_.Exception.Message)" }

Write-Host "`n=== 经网关 /v1/messages（走账号池） ==="
$payload = @{ model = 'GLM-5.2'; max_tokens = 16; messages = @(@{ role = 'user'; content = 'ping' }) } | ConvertTo-Json -Depth 5
try {
  $r = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:3000/v1/messages' -ContentType 'application/json' -Body $payload -TimeoutSec 120 -UseBasicParsing
  "HTTP $($r.StatusCode)"; $r.Content.Substring(0, [Math]::Min(300, $r.Content.Length))
} catch {
  $resp = $_.Exception.Response
  if ($resp) { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8); "HTTP $([int]$resp.StatusCode)"; $sr.ReadToEnd().Substring(0, [Math]::Min(300, 300)) } else { "失败: $($_.Exception.Message)" }
}
