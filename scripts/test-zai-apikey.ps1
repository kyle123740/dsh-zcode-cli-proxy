# 试 ZCode 客户端里的 zai-coding-plan API Key（走 api.z.ai 回退端点，不需要验证码）。
# 凭证只在脚本内部流转，不打印。
$ErrorActionPreference = 'Stop'
$cfgPath = "$env:USERPROFILE\.zcode\v2\config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$key = [string]$cfg.provider.'builtin:zai-coding-plan'.options.apiKey
if ([string]::IsNullOrWhiteSpace($key)) { throw "客户端里 zai-coding-plan 没有 apiKey" }
"凭证长度 $($key.Length)，前缀 $($key.Substring(0,6))…（不回显）"

$admin = @{ Authorization = 'Bearer zcode' }
$body = @{ provider = 'zai'; tokens = @($key); name = 'zai-apikey-from-client' } | ConvertTo-Json -Depth 3
$added = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/admin/api/accounts' -Headers $admin -ContentType 'application/json' -Body $body
"已加入账号: $($added.ids -join ', ')"

# 直接把这份 key 当作 API Key 压上游（api.z.ai 回退端点），看是否真的可用
$payload = '{"model":"GLM-4.6","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
try {
  $r = Invoke-WebRequest -Method Post -Uri 'https://api.z.ai/api/anthropic/v1/messages' `
    -Headers @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01' } `
    -ContentType 'application/json' -Body $payload -TimeoutSec 60 -UseBasicParsing
  "上游 HTTP $($r.StatusCode)"
  $r.Content.Substring(0, [Math]::Min(300, $r.Content.Length))
} catch {
  "上游请求失败: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    $t = $sr.ReadToEnd()
    "响应体: " + $t.Substring(0, [Math]::Min(400, $t.Length))
  }
}

# 看看账号池状态
$list = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3000/admin/api/accounts' -Headers $admin
$list.accounts | ForEach-Object { "{0} [{1}/{2}] status={3} err={4}" -f $_.name, $_.provider, $_.mode, $_.status, $_.last_error }
