<#
  把 ZCode 客户端里已登录的 Coding Plan JWT 导入 zcode2api 账号池。

  凭证只在这个脚本内部流转：从客户端配置读出后直接 POST 给本机网关，
  既不打印全文、也不写入任何文件。JWT 轮换后（客户端会刷新）重跑一次即可。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\import-zcode-client-token.ps1
    # 可覆盖：-ProviderKey / -Gateway / -AdminKey / -Name
#>
[CmdletBinding()]
param(
  [string]$ClientConfig = "$env:USERPROFILE\.zcode\v2\config.json",
  [string]$ProviderKey = 'builtin:zai-start-plan',
  [string]$Gateway = 'http://127.0.0.1:3000',
  [string]$AdminKey = 'zcode',
  [string]$Name = 'zcode-client'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ClientConfig)) { throw "找不到 ZCode 客户端配置：$ClientConfig" }

$cfg = Get-Content $ClientConfig -Raw | ConvertFrom-Json
$entry = $cfg.provider.PSObject.Properties[$ProviderKey]
if (-not $entry) { throw "ZCode 配置里没有 provider '$ProviderKey'（可用键：$(($cfg.provider.PSObject.Properties.Name) -join ', ')）" }

$jwt = [string]$entry.Value.options.apiKey
if ([string]::IsNullOrWhiteSpace($jwt)) { throw "provider '$ProviderKey' 的 apiKey 是空的——先在 ZCode 客户端里登录 Coding Plan" }

$isJwt = ($jwt.Split('.').Count -eq 3)
Write-Host ("取到凭证：长度 {0}，前缀 {1}…，形态 {2}（{3}）" -f `
  $jwt.Length, $jwt.Substring(0, [Math]::Min(6, $jwt.Length)), $(if ($isJwt) { 'JWT' } else { 'API Key' }), $ProviderKey)

# 探一下网关是否在跑
try {
  Invoke-RestMethod -Method Get -Uri "$Gateway/v1/models" -TimeoutSec 5 | Out-Null
} catch {
  throw "网关没在跑（$Gateway）：先在插件管理里启用 dsh-zcode2api，或运行它的 zcode2api_gateway start。原始错误：$($_.Exception.Message)"
}

$body = @{ provider = 'zai'; tokens = @($jwt); name = $Name } | ConvertTo-Json -Depth 3
$resp = Invoke-RestMethod -Method Post -Uri "$Gateway/admin/api/accounts" `
  -Headers @{ Authorization = "Bearer $AdminKey" } -ContentType 'application/json' -Body $body

Write-Host ("已导入：{0} 个账号，id = {1}" -f $resp.count, ($resp.ids -join ', '))
Write-Host "下一步：调用 zcode2api_quota 看额度（JWT 账号会自动刷新余额）"
