// 登录态探活 + 从已登录的浏览器（Edge/Chrome）把 cookie 补回去（2026-10-31 加）
//
// 为什么需要它：B 站没有 refresh 接口，SESSDATA 到期只能重新登录换一张 ✗
//   但**浏览器里那张 cookie 是浏览器在维护的** → 只要她还登着 B 站，浏览器手里就永远是新的 ✓
//   于是流程变成：探活失败 → 从 CDP 抓一份 → 验过账号（mid 必须还是自己）→ 原子写回 credentials.json ✓
//
// 安全底线（三条都不能破）：
//   ① 只接受「nav 验证通过 + mid 与旧凭据一致」的 cookie；账号不一致直接拒（防止把别人的号写进来）
//   ② 写文件走 临时文件 → fsync → rename；任何一步失败都保留旧凭据（宁可没补上，也不能写坏 ✗）
//   ③ 不打印、不落盘任何 cookie 明文到日志（只报长度/尾号）
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { credentialsPath, dshPath } from './paths.mjs'
import { loadCred } from './cred.mjs'

const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = 'https://www.bilibili.com/'
/** 常见调试端口：9222 是默认，另外兼容手动换过的 */
export const DEFAULT_PORTS = [9222, 9223, 9224, 9333]

export function cookieHeader(c) {
  const parts = []
  if (c?.sessdata) parts.push('SESSDATA=' + c.sessdata)
  if (c?.bili_jct) parts.push('bili_jct=' + c.bili_jct)
  if (c?.buvid3) parts.push('buvid3=' + c.buvid3)
  return parts.join('; ')
}

/** 上次验证通过的账号（自动补位靠它核对「还是不是自己那个号」） */
export const AUTH_STATE = dshPath('whale-auth.json')

export function readAuthState() {
  try { return JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8')) } catch { return null }
}

function rememberAuth(probe) {
  if (!probe?.ok) return
  try {
    fs.writeFileSync(AUTH_STATE, JSON.stringify({ mid: probe.mid, name: probe.name, at: new Date().toISOString() }, null, 2) + '\n')
  } catch {}
}

/** 探活：只发一个 nav 请求。网络失败也算「不 ok」，但错误原因分开写（别把断网说成 cookie 过期 ✗）。 */
export async function probeLogin(credentials, { fetch: fetcher = globalThis.fetch, timeoutMs = 12000 } = {}) {
  let cred = credentials
  try { cred ??= loadCred() } catch (e) { return { ok: false, code: null, reason: 'credential_file', message: String(e.message).slice(0, 200) } }
  try {
    const response = await fetcher(NAV, {
      headers: { 'user-agent': UA, referer: REF, cookie: cookieHeader(cred) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json()
    const data = body?.data ?? {}
    const ok = body?.code === 0 && data.isLogin === true && /^[1-9]\d{0,19}$/.test(String(data.mid ?? ''))
    const probe = {
      ok,
      code: Number(body?.code),
      message: String(body?.message ?? ''),
      mid: ok ? String(data.mid) : null,
      name: ok ? String(data.uname ?? '') : null,
      reason: ok ? null : (body?.code === -101 ? 'expired' : 'rejected'),
    }
    rememberAuth(probe)
    return probe
  } catch (e) {
    return { ok: false, code: null, reason: 'network', message: String(e?.message ?? e).slice(0, 200) }
  }
}

function wsCollect(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket
    const timer = setTimeout(() => { try { socket?.close() } catch {} ; reject(new Error('CDP 读取超时')) }, timeoutMs)
    const done = (fn, value) => { clearTimeout(timer); try { socket?.close() } catch {} ; fn(value) }
    try {
      socket = new WebSocket(url)
    } catch (e) { clearTimeout(timer); reject(new Error('WebSocket 建不起来：' + String(e?.message ?? e))); return }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} }))
    })
    socket.addEventListener('message', event => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== 1) return
      if (msg.error) { done(reject, new Error('Storage.getCookies 失败：' + String(msg.error.message ?? ''))); return }
      done(resolve, Array.isArray(msg.result?.cookies) ? msg.result.cookies : [])
    })
    socket.addEventListener('error', () => done(reject, new Error('CDP 连接被拒绝（端口开着但没授权？）')))
    socket.addEventListener('close', () => { /* 由上面两个分支收尾 */ })
  })
}

/** 从已登录的浏览器抓 b 站 cookie。找不到浏览器/端口没开 → 抛错（调用方决定要不要喊人）。 */
export async function pullFromBrowser({ ports = DEFAULT_PORTS, fetch: fetcher = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const tried = []
  for (const port of ports) {
    let ws
    let info
    try {
      const response = await fetcher('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) { tried.push(port + ':HTTP ' + response.status); continue }
      info = await response.json()
      ws = info?.webSocketDebuggerUrl
      if (!ws) { tried.push(port + ':没有 webSocketDebuggerUrl'); continue }
    } catch { tried.push(port + ':连不上'); continue }
    let cookies
    try { cookies = await wsCollect(ws) } catch (e) { tried.push(port + ':' + String(e?.message ?? e).slice(0, 60)); continue }
    const pick = name => cookies.filter(c => String(c.domain ?? '').includes('bilibili.com') && c.name === name)
      .sort((a, b) => Number(b.expires ?? 0) - Number(a.expires ?? 0))[0]?.value
    const found = { sessdata: pick('SESSDATA'), bili_jct: pick('bili_jct'), buvid3: pick('buvid3') }
    if (found.sessdata && found.bili_jct) return { credentials: found, port, browser: String(info?.Browser ?? '') }
    tried.push(port + ':连上了但没有 b 站登录 cookie（浏览器里没登？）')
  }
  throw new Error(tried.join(' · ') || '没有可用的调试端口')
}

/** 原子写回凭据：临时文件 → fsync → rename；不动旧文件直到新内容验过。 */
export function saveCredentials(credentials, { file = credentialsPath } = {}) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ sessdata: credentials.sessdata, bili_jct: credentials.bili_jct, buvid3: credentials.buvid3 ?? '' }, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    if (process.platform === 'win32') {
      // 收紧 ACL 失败不算致命（文件本来就是 0600 之外的用户目录），但要说一声
      try {
        const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
        const sid = execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)?.[0]
        if (sid) {
          execFileSync(path.join(system, 'icacls.exe'), [temp, '/inheritance:r', '/grant:r', '*' + sid + ':(F)', '/Q'], { encoding: 'utf8', windowsHide: true })
        }
      } catch {}
    }
    fs.renameSync(temp, file)
    return { saved: true }
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch {}
  }
}

/** 一条龙：探活 → （失败才）从浏览器抓 → 验账号 → 写回。dryRun 只报不写。 */
export async function syncFromEdge({ expectMid, file = credentialsPath, ports = DEFAULT_PORTS, dryRun = true, force = false } = {}) {
  const before = await probeLogin(undefined, {})
  if (before.ok && !force) return { ok: true, changed: false, mid: before.mid, name: before.name, note: '登录态正常，不用补' }
  if (before.reason === 'network') return { ok: false, changed: false, error: '探活请求本身失败（网络/代理），不是 cookie 的问题：' + (before.message ?? '') }
  let pulled
  try { pulled = await pullFromBrowser({ ports }) } catch (e) { return { ok: false, changed: false, error: '抓不到浏览器 cookie：' + String(e.message).slice(0, 300) } }
  const verified = await probeLogin(pulled.credentials, {})
  if (!verified.ok) return { ok: false, changed: false, error: '从 ' + pulled.port + ' 抓到的 cookie 也验不过（code=' + verified.code + ' ' + (verified.message || verified.reason) + '）' }
  const want = expectMid ?? readAuthState()?.mid ?? null
  if (!want) return { ok: false, changed: false, error: '没有上次验证过的账号记录（whale-auth.json），不敢盲写；先跑一次 auth-check 探活' }
  if (String(verified.mid) !== String(want)) {
    return { ok: false, changed: false, error: '浏览器里的号（mid ' + verified.mid + '）不是自己那个（mid ' + want + '），拒绝写入' }
  }
  if (dryRun) return { ok: true, changed: false, dryRun: true, mid: verified.mid, name: verified.name, port: pulled.port, note: '验过了，--go 才真写' }
  saveCredentials(pulled.credentials, { file })
  return { ok: true, changed: true, mid: verified.mid, name: verified.name, port: pulled.port }
}
