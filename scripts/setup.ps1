<#
  dsh-zcode2api — 运行时装配脚本（幂等，可重复执行）

  做三件事：
    1. 更新内置的 zcode2api 源码（vendor\zcode2api，git fetch + reset）
    2. 在 <RuntimeHome>\venv 建立 Python 虚拟环境并安装 requirements.txt
    3. 在 vendor\zcode2api\captcha_node 安装 Node 无痕验证求解器依赖（jsdom）

  用法:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipVendor
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Force   # 重建 venv

  可用环境变量覆盖：ZCODE2API_HOME / ZCODE2API_PYTHON / ZCODE2API_PROJECT
#>
[CmdletBinding()]
param(
  [switch]$SkipVendor,
  [switch]$SkipNode,
  [switch]$Force,
  [string]$RuntimeHome = $(if ($env:ZCODE2API_HOME) { $env:ZCODE2API_HOME } else { Join-Path $env:USERPROFILE '.dsh\zcode2api' }),
  [string]$Python = $env:ZCODE2API_PYTHON
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$pluginDir = Split-Path -Parent $PSScriptRoot
$projectDir = if ($env:ZCODE2API_PROJECT) { $env:ZCODE2API_PROJECT } else { Join-Path $pluginDir 'vendor\zcode2api' }
$venvDir = Join-Path $RuntimeHome 'venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'

function Say([string]$msg) { Write-Host "[zcode2api] $msg" }

# 原生命令（git / pip / npm）会把进度和 warning 写到 stderr；在 EAP=Stop 下
# PowerShell 5.1 会把它当成终止性错误。这里统一用继续模式执行，只认退出码。
function Invoke-Native([string]$label, [scriptblock]$action) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $action 2>&1 | ForEach-Object { if ("$_".Trim() -ne '') { Say $_ } }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { throw "$label 失败 (exit $LASTEXITCODE)" }
}

if (-not (Test-Path $projectDir)) { throw "找不到内置项目目录: $projectDir" }
New-Item -ItemType Directory -Force -Path $RuntimeHome, (Join-Path $RuntimeHome 'data'), (Join-Path $RuntimeHome 'logs') | Out-Null

# ── 1. 源码 ────────────────────────────────────────────────────────────────────
if (-not $SkipVendor) {
  if (Test-Path (Join-Path $projectDir '.git')) {
    Say '更新内置源码 (vendor\zcode2api)…'
    Invoke-Native 'git fetch' { git -C $projectDir fetch --depth 1 origin }
    Invoke-Native 'git reset' { git -C $projectDir reset --hard FETCH_HEAD }
  } else {
    Say '源码目录没有 .git（离线副本），跳过更新'
  }
}

# ── 2. Python venv ────────────────────────────────────────────────────────────
if ($Force -and (Test-Path $venvDir)) {
  Say '重建 venv（-Force）'
  Remove-Item -Recurse -Force $venvDir
}

if (-not (Test-Path $venvPython)) {
  if (-not $Python) {
    # 优先 py 启动器挑一个 >=3.11 的解释器，退回到 PATH 上的 python
    $candidates = @()
    foreach ($version in @('-3.13', '-3.12', '-3.11')) {
      try { $candidates += (& py $version -c 'import sys;print(sys.executable)' 2>$null) } catch { }
    }
    try { $candidates += (& python -c 'import sys;print(sys.executable)' 2>$null) } catch { }
    $Python = ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
  }
  if (-not $Python) { throw '未找到 Python 3.11+。请安装后重试，或用 -Python 指定解释器路径。' }
  Say "创建 venv: $venvDir （基于 $Python）"
  Invoke-Native 'venv 创建' { & $Python -m venv $venvDir }
}

Say '安装 Python 依赖…'
Invoke-Native 'pip 升级' { & $venvPython -m pip install --disable-pip-version-check --quiet --upgrade pip }
Invoke-Native 'requirements 安装' { & $venvPython -m pip install --disable-pip-version-check --quiet -r (Join-Path $projectDir 'requirements.txt') }

# ── 3. Node 求解器依赖 ────────────────────────────────────────────────────────
$captchaDir = Join-Path $projectDir 'captcha_node'
if (-not $SkipNode -and (Test-Path (Join-Path $captchaDir 'package.json'))) {
  if (Test-Path (Join-Path $captchaDir 'node_modules\jsdom')) {
    Say 'jsdom 已安装，跳过'
  } else {
    Say '安装无痕验证求解器依赖 (jsdom)…'
    Push-Location $captchaDir
    try {
      Invoke-Native 'npm install' { npm install --no-audit --no-fund }
    } finally { Pop-Location }
  }
}

Say '完成。'
Say "  项目目录 : $projectDir"
Say "  Python   : $venvPython"
Say "  数据目录 : $(Join-Path $RuntimeHome 'data')"
