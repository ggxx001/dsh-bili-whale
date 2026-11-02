import { probeLogin, syncFromEdge, readAuthState, DEFAULT_PORTS } from '../lib/cookie-sync.mjs'
// 登录态体检 / 自动补位（2026-10-31 加）
//
// 用法：
//   node bili.mjs auth-check                探活：现在这个 cookie 还能不能用
//   node bili.mjs auth-check --sync         探活 + 从已登录的浏览器抓一份并验证（不写）
//   node bili.mjs auth-check --sync --go    验过了就写回 credentials.json ✓
//   node bili.mjs auth-check --json         机器可读（给调度器/我自己判断用）
//
// 退出码：0 = 登录态正常（或已补好）｜ 3 = 未登录且没补上 ｜ 4 = 探活本身失败（网络/凭据文件）

const argv = process.argv.slice(2)
const has = flag => argv.includes(flag)
const JSON_OUT = has('--json')
const SYNC = has('--sync')
const GO = has('--go')
const FORCE = has('--force')
const pi = argv.indexOf('--port')
const ports = pi >= 0 && argv[pi + 1] ? [Number(argv[pi + 1])] : DEFAULT_PORTS

const say = (...a) => { if (!JSON_OUT) console.log(...a) }

const before = await probeLogin()
const state = readAuthState()
const result = { probe: before, state, synced: null }

if (!before.ok) {
  say('✗ 登录态不可用：' + (before.reason === 'network'
    ? '探活请求失败（网络/代理），不是 cookie 的问题 · ' + (before.message ?? '')
    : 'code=' + before.code + ' ' + (before.message || before.reason)))
  if (SYNC) {
    const synced = await syncFromEdge({ ports, dryRun: !GO, force: true })
    result.synced = synced
    if (synced.ok) {
      say(GO ? '✓ 已从浏览器补上（端口 ' + synced.port + '，mid ' + synced.mid + ' ' + (synced.name || '') + '）'
             : '✓ 浏览器里有可用的 cookie（端口 ' + synced.port + '，mid ' + synced.mid + '），加 --go 才写回')
    } else say('✗ 自动补位失败：' + synced.error)
  } else {
    say('  试试：node bili.mjs auth-check --sync --go（从已登录 B 站的浏览器里抓一份新的）')
    say('  浏览器都没开的话，只能回设置页重新扫码 ✓')
  }
} else {
  say('✓ 登录态正常：' + (before.name || '(无名)') + ' · mid ' + before.mid)
  if (state?.at) say('  （上次验证：' + new Date(state.at).toLocaleString('zh-CN', { hour12: false }) + '）')
  if (SYNC && (FORCE || !before.ok)) {
    const synced = await syncFromEdge({ ports, dryRun: !GO, force: true })
    result.synced = synced
    say(synced.ok ? '✓ 也拿到浏览器里那份了' + (synced.changed ? '，已写回' : '（未写回）') : '✗ ' + synced.error)
  }
}

if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
process.exit(before.ok || result.synced?.ok ? 0 : (before.reason === 'network' || before.reason === 'credential_file' ? 4 : 3))
