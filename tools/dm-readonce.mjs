import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { signWbi } from './lib/bili-api.mjs'

const cred = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || os.homedir(), '.bili-ai', 'credentials.json'), 'utf8'))
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  referer: 'https://message.bilibili.com/',
  cookie: 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + (cred.buvid3 || ''),
}
const OWNER = '3493111630138048'
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H })).json()
if (nav.code !== 0 || !nav.data?.wbi_img) { console.log('NAV_FAIL', nav.code); process.exit(1) }
const q = signWbi({ talker_id: OWNER, session_type: 1, size: 30, begin_seqno: '0' }, nav.data.wbi_img)
const res = await fetch('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?' + q, { headers: H })
const body = await res.json()
if (body.code !== 0) { console.log('MSG_FAIL', body.code, body.message); process.exit(1) }
const mine = (body.data.messages || []).filter(m => String(m.sender_uid) === OWNER)
mine.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
console.log('总消息', body.data.messages.length, '｜她发的', mine.length)
for (const m of mine.slice(-6)) {
  let text = String(m.content ?? '')
  try { const j = JSON.parse(text); text = j.content ?? j.text ?? text } catch {}
  console.log(new Date(Number(m.timestamp) * 1000).toLocaleString('zh-CN', { hour12: false }), '|', text.slice(0, 160))
}
