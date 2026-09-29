# 探测计划端点接受哪些模型名（经 zcode2api 网关，验证码走浏览器求解 + 缓存）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

function Invoke-Gateway([string]$model) {
  $json = @{ model = $model; max_tokens = 24; messages = @(@{ role = 'user'; content = 'Reply with exactly: OK' }) } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $req = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:3000/v1/messages')
  $req.Method = 'POST'; $req.ContentType = 'application/json'
  $req.Timeout = 240000; $req.ReadWriteTimeout = 240000; $req.ContentLength = $bytes.Length
  $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  try {
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $body = $sr.ReadToEnd()
    "{0,-18} -> HTTP {1}  {2}" -f $model, [int]$resp.StatusCode, $body.Substring(0, [Math]::Min(180, $body.Length)).Replace("`n", ' ')
  } catch {
    $r = $_.Exception.Response
    if ($r) {
      $sr = New-Object System.IO.StreamReader($r.GetResponseStream(), [System.Text.Encoding]::UTF8)
      $t = $sr.ReadToEnd()
      "{0,-18} -> HTTP {1}  {2}" -f $model, [int]$r.StatusCode, $t.Substring(0, [Math]::Min(220, $t.Length)).Replace("`n", ' ')
    } else {
      "{0,-18} -> 失败 {1}" -f $model, $_.Exception.Message
    }
  }
}

foreach ($m in @('GLM-5.3-Flash', 'glm-5.3-flash', 'GLM-5.2', 'glm-5-turbo', 'GLM-5.3')) { Invoke-Gateway $m }
