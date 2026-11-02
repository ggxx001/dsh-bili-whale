# 登录态看门狗（2026-10-31 加）—— 每 30 分钟探一次 B 站登录态
# 失效时：先从已登录的浏览器（CDP 9222）抓一份 → 验过账号（mid 必须与上次一致）→ 原子写回 credentials.json
# 只在「出问题」或「真补过」时写日志，正常就一声不吭（免得不看日志也被刷屏）
# 踩过的坑：① 脚本必须存成 UTF-8 带 BOM，否则 Windows PowerShell 5.1 按 GBK 读，中文全乱、直接报语法错；
#           ② 中文输出会被按 GBK 解码成乱码 → 判据只用 --json 的结构化字段，不 match 中文文案
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$log = 'C:\Users\28579\.dsh\whale-auth-watch.log'
$node = (Get-ChildItem 'C:\Users\28579\.dsh\dsh-runtimes' -Recurse -Filter node.exe | Select-Object -First 1).FullName
if (-not $node) { Add-Content -Path $log -Value ('[' + (Get-Date -f 'yyyy-MM-dd HH:mm:ss') + '] 找不到 node.exe，跳过') -Encoding UTF8; exit 2 }
$raw = (& $node 'D:\deepseek\plugins\dsh-bili-whale\tools\bili.mjs' auth-check --sync --go --json 2>&1) -join [Environment]::NewLine
$code = $LASTEXITCODE
$stamp = Get-Date -f 'yyyy-MM-dd HH:mm:ss'
$j = $null; try { $j = $raw | ConvertFrom-Json } catch {}
if ($code -eq 0 -and $j -and $j.probe.ok) {
  if ($j.synced -and $j.synced.changed) {
    Add-Content -Path $log -Value ('[' + $stamp + '] 登录态曾失效 → 已从浏览器自动补上（mid ' + $j.synced.mid + '，端口 ' + $j.synced.port + '）') -Encoding UTF8
  }
  exit 0
}
$why = 'exit=' + $code
if ($j) {
  if ($j.probe -and -not $j.probe.ok) { $why = $why + ' probe=' + $j.probe.reason }
  if ($j.synced -and $j.synced.error) { $why = $why + ' sync=' + $j.synced.error }
} else { $why = $why + ' 输出不是 JSON：' + $raw.Substring(0, [Math]::Min(160, $raw.Length)) }
Add-Content -Path $log -Value ('[' + $stamp + '] 登录态异常 · ' + $why) -Encoding UTF8
exit $code
