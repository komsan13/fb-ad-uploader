// ---------- ตัวกลางหลายโปรไฟล์ ----------
// แต่ละโปรไฟล์ (เช่น TOP) คือ server.js หนึ่งตัวที่มีโฟลเดอร์ข้อมูลของตัวเอง — แยกขาดทุกอย่าง:
// บัญชี FB, ค่าขึ้นแอด, คลังสื่อ/แคปชั่น, ระบบอัตโนมัติ, หน้า Landing, Telegram, AI
// ตัวกลางนี้แค่จัดการรายชื่อโปรไฟล์ แล้วส่ง request ต่อให้ตัวที่เลือกอยู่ (จำใน cookie)
// เลือกทางนี้แทนการแก้ server.js ให้รู้จักหลายโปรไฟล์ทุกจุด: โค้ดเงินที่ผ่านเทสแล้วไม่ต้องแตะเลย
// และระบบอัตโนมัติของทุกโปรไฟล์ทำงานพร้อมกันเองโดยธรรมชาติ (แต่ละตัวมี timer ของตัวเอง)
//
// ที่อยู่ข้อมูล: TOP = โฟลเดอร์เดิม (dirname ของ CONFIG_PATH) ไม่ต้องย้ายไฟล์ของจริงเลย
//              โปรไฟล์อื่น = <โฟลเดอร์เดิม>/ws/<id>/  • ลบโปรไฟล์ = ย้ายไป ws-trash/ ไม่ลบทิ้งจริง
// หน้า Landing สาธารณะ: TOP = /lp (เดิม) • โปรไฟล์อื่น = /w/<id>/lp (ตัวกลางตัด /w/<id> ก่อนส่งต่อ)
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4000;
const ROOT_CONFIG = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const DATA_ROOT = path.dirname(ROOT_CONFIG);
const REG_PATH = path.join(DATA_ROOT, 'workspaces.json');
const WS_DIR = path.join(DATA_ROOT, 'ws');
const TRASH_DIR = path.join(DATA_ROOT, 'ws-trash');
const COOKIE = 'fbws';
const TOP = 'top';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// หน้าเว็บแนบโปรไฟล์ของหน้าต่างตัวเองมากับทุกคำขอ (ดู wrapper ต้น <script> ใน index.html)
// ไม่ตรงกับ cookie = หน้าต่างนี้ค้างโปรไฟล์เก่า → ตอบ 409 + header x-fbws-mismatch แทนการส่งต่อ
const PAGE_HDR = 'x-fbws-page';
// หนึ่งโปรไฟล์ = หนึ่งโปรเซส Node + timer ระบบอัตโนมัติของตัวเอง — ไม่มีเพดาน = สร้างวนจนเครื่องเต็มได้
const MAX_WS = 20;

// ---------- รายชื่อโปรไฟล์ ----------
function loadReg() {
  try {
    const r = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
    const list = (Array.isArray(r.list) ? r.list : [])
      .filter((w) => w && ID_RE.test(String(w.id)))
      .map((w) => ({ id: String(w.id), name: String(w.name || w.id).slice(0, 40) }));
    if (!list.some((w) => w.id === TOP)) list.unshift({ id: TOP, name: 'TOP' });   // TOP ต้องมีเสมอ (ข้อมูลเดิมทั้งหมด)
    return { list };
  } catch {
    return { list: [{ id: TOP, name: 'TOP' }] };
  }
}
function saveReg(r) {
  const tmp = REG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, REG_PATH);
}
// การแก้รายชื่อโปรไฟล์ทำทีละคำขอ แล้วอ่านรายชื่อสดภายในคิวเสมอ — เดิมลบสองโปรไฟล์พร้อมกัน ตัวหนึ่งโหลดรายชื่อไว้
// แล้วรอโปรเซสลูกปิด (หลายวิ) ก่อนเขียนรายชื่อเก่าทับ โปรไฟล์ที่ย้ายไปถังขยะแล้วฟื้นกลับมาในรายชื่อ ตอบ 503 ไปตลอด
let regQueue = Promise.resolve();
function withRegLock(fn) {
  const run = regQueue.then(fn);
  regQueue = run.catch(() => {});
  return run;
}
const wsDir = (id) => (id === TOP ? DATA_ROOT : path.join(WS_DIR, id));
const wsConfig = (id) => (id === TOP ? ROOT_CONFIG : path.join(wsDir(id), 'config.json'));
const lpPrefix = (id) => (id === TOP ? '' : `/w/${id}`);

// ---------- โปรเซสของแต่ละโปรไฟล์ ----------
const kids = new Map();   // id -> { proc, port, ready, stopping, backoff }
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function pipeLog(stream, id, out) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) out(`[${id}] ${l}`);
  });
}
async function startKid(id) {
  const prev = kids.get(id);
  const port = await freePort();
  // รีสตาร์ทอัตโนมัติชนกับคำสั่งลบ (ลบเสร็จระหว่างรอพอร์ต) — ห้ามสร้างโฟลเดอร์/โปรเซสของโปรไฟล์ที่ถูกลบไปแล้ว
  if (kids.get(id) !== prev) return { ready: false };
  const k = { proc: null, port, ready: false, stopping: false, backoff: prev ? prev.backoff : 2000 };
  kids.set(id, k);
  fs.mkdirSync(wsDir(id), { recursive: true });
  k.proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, PORT: String(k.port), CONFIG_PATH: wsConfig(id), LP_PREFIX: lpPrefix(id), WS_ID: id,
      // ไม่ตั้ง PUBLIC_URL (npm start ในเครื่อง) ลูกจะเดาจากพอร์ตภายในที่สุ่มมา — redirect URI ของ FB ผิดพอร์ต
      // URL ที่คนเปิดจริงคือพอร์ตของตัวกลาง
      PUBLIC_URL: process.env.PUBLIC_URL || `http://localhost:${PORT}`,
      // ให้ลูกหา config ของโปรไฟล์อื่นได้ (ใช้กันบอท Telegram ตัวเดียวกันถูกใช้หลายโปรไฟล์)
      HUB_ROOT_CONFIG: ROOT_CONFIG,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],   // ช่อง IPC = สายชีวิต: ตัวกลางตาย ลูกปิดตัวเองตาม (ดูท้าย server.js)
  });
  pipeLog(k.proc.stdout, id, console.log);
  pipeLog(k.proc.stderr, id, console.error);
  k.proc.on('exit', (code) => {
    k.ready = false;
    if (k.stopping || kids.get(id) !== k) return;
    // ตายเอง = เริ่มใหม่ (หน่วงเพิ่มขึ้นเรื่อยๆ กันวนพังถี่) — ระบบอัตโนมัติของโปรไฟล์นั้นต้องกลับมาทำงานเอง
    console.error(`[hub] โปรไฟล์ ${id} หยุดทำงาน (code ${code}) — เริ่มใหม่ใน ${k.backoff / 1000} วิ`);
    const wait = k.backoff;
    k.backoff = Math.min(k.backoff * 2, 60000);
    setTimeout(() => { if (kids.get(id) === k && !k.stopping) startKid(id).catch((e) => console.error('[hub]', e)); }, wait);
  });
  // รอจนตอบได้จริงก่อนส่ง request เข้า
  for (let i = 0; i < 150 && !k.stopping && kids.get(id) === k; i++) {
    try {
      const ok = await new Promise((resolve) => {
        const r = http.get({ host: '127.0.0.1', port: k.port, path: '/api/env', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
        r.on('error', () => resolve(false));
        r.on('timeout', () => { r.destroy(); resolve(false); });
      });
      if (ok) { k.ready = true; k.backoff = 2000; break; }
    } catch { /* ยังไม่พร้อม */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return k;
}
function stopKid(id) {
  const k = kids.get(id);
  kids.delete(id);
  if (!k || !k.proc) return Promise.resolve();
  k.stopping = true;
  return new Promise((resolve) => {
    if (k.proc.exitCode !== null) return resolve();
    k.proc.once('exit', () => resolve());
    k.proc.kill();
    setTimeout(resolve, 5000).unref();
  });
}

// ---------- คำขอ ----------
function cookieOf(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-z0-9-]+)`));
  return m ? m[1] : '';
}
function currentWs(req, reg) {
  const id = cookieOf(req);
  return reg.list.some((w) => w.id === id) ? id : TOP;
}
function sendJson(res, code, obj, extra = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const wsCookie = (id) => `${COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;

async function hubApi(req, res, url) {
  const reg = loadReg();
  const cur = currentWs(req, reg);
  const view = () => ({ current: cur, list: reg.list.map((w) => ({ ...w, lpUrl: `${lpPrefix(w.id)}/lp`, ready: !!(kids.get(w.id) || {}).ready })) });

  if (req.method === 'GET' && url === '/hub/api/workspaces') return sendJson(res, 200, view());

  // คำสั่งแก้โปรไฟล์รับเฉพาะ JSON — <form> จากเว็บอื่นส่ง text/plain มาได้โดยไม่ต้องขออนุญาต (ไม่มี preflight)
  // และเบราว์เซอร์แนบรหัส basic auth ที่จำไว้ให้เอง = เว็บอื่นสั่งสร้าง/ลบ/สลับโปรไฟล์แทนเราได้ (วัดจริง: สร้างได้)
  // application/json ข้ามเว็บต้องผ่าน CORS preflight ซึ่งเราไม่ตอบ เบราว์เซอร์จึงไม่ยอมส่ง
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
    return sendJson(res, 415, { error: 'คำสั่งนี้รับเฉพาะ JSON (content-type: application/json)' });
  }

  if (req.method === 'POST' && url === '/hub/api/workspaces') {
    const name = String((await readJson(req)).name || '').trim().slice(0, 40);
    if (!name) return sendJson(res, 400, { error: 'ตั้งชื่อโปรไฟล์ก่อน' });
    // ถือคิวจนโปรไฟล์ใหม่บูตเสร็จ — ลบโปรไฟล์ที่ยังบูตไม่เสร็จ = โปรเซสลูกเกิดทีหลังแล้วค้างวิ่งนอกรายชื่อ
    return withRegLock(async () => {
      const r = loadReg();
      if (r.list.length >= MAX_WS) return sendJson(res, 400, { error: `มีโปรไฟล์ครบ ${MAX_WS} แล้ว — ลบโปรไฟล์ที่ไม่ใช้ก่อน` });
      if (r.list.some((w) => w.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 400, { error: `มีโปรไฟล์ชื่อ "${name}" อยู่แล้ว` });
      let id;
      do { id = 'p' + crypto.randomBytes(3).toString('hex'); } while (r.list.some((w) => w.id === id) || fs.existsSync(wsDir(id)));
      r.list.push({ id, name });
      saveReg(r);
      const k = await startKid(id);
      if (!k.ready) return sendJson(res, 500, { error: 'สร้างโปรไฟล์แล้วแต่เริ่มทำงานไม่สำเร็จ — ดู log ของเซิร์ฟเวอร์' });
      return sendJson(res, 200, { ok: true, id, name });
    });
  }

  if (req.method === 'POST' && url === '/hub/api/workspaces/delete') {
    const id = String((await readJson(req)).id || '');
    if (id === TOP) return sendJson(res, 400, { error: 'ลบโปรไฟล์ TOP ไม่ได้ — เป็นโปรไฟล์หลักที่เก็บข้อมูลเดิมทั้งหมด' });
    return withRegLock(async () => {
      const r = loadReg();
      if (!r.list.some((w) => w.id === id)) return sendJson(res, 404, { error: 'ไม่พบโปรไฟล์นี้' });
      await stopKid(id);   // หยุดระบบอัตโนมัติของโปรไฟล์นี้ก่อน ค่อยย้ายข้อมูล
      // ไม่ลบทิ้งจริง — ในนั้นมี token, คลังคลิป, บันทึกการทำงาน ย้ายไปถังขยะ กู้คืนด้วยมือได้
      if (fs.existsSync(wsDir(id))) {
        fs.mkdirSync(TRASH_DIR, { recursive: true });
        fs.renameSync(wsDir(id), path.join(TRASH_DIR, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
      }
      r.list = r.list.filter((w) => w.id !== id);
      saveReg(r);
      // ลบตัวที่เลือกอยู่ = กลับไป TOP
      return sendJson(res, 200, { ok: true }, cur === id ? { 'set-cookie': wsCookie(TOP) } : {});
    });
  }

  if (req.method === 'POST' && url === '/hub/api/select') {
    const id = String((await readJson(req)).id || '');
    if (!reg.list.some((w) => w.id === id)) return sendJson(res, 404, { error: 'ไม่พบโปรไฟล์นี้' });
    return sendJson(res, 200, { ok: true, current: id }, { 'set-cookie': wsCookie(id) });
  }
  return sendJson(res, 404, { error: 'ไม่รู้จักคำสั่งนี้' });
}

function proxy(req, res, id, url) {
  try { proxyTo(req, res, id, url); }
  catch (e) { if (!res.headersSent) sendJson(res, 502, { error: 'ส่งต่อคำขอไม่สำเร็จ: ' + e.message }); }
}
// คนกดแอดเข้าหน้า Landing ตอนโปรไฟล์กำลังบูต (deploy/รีสตาร์ท) เดิมเห็น JSON ดิบ {"error":...} บนจอมือถือ
// คำขอหน้าเว็บ (/lp หรือเบราว์เซอร์ขอ HTML) ได้หน้าเล็กๆ ภาษาไทยที่รีเฟรชเองแทน • /api ยังได้ JSON (หน้าแอดมินอ่านข้อความ error)
const isPageReq = (req, url) => (req.method === 'GET' || req.method === 'HEAD') && !url.startsWith('/api/')
  && (/^\/lp\/?(\?|$)/.test(url) || /text\/html/.test(String(req.headers.accept || '')));
const LOADING_HTML = '<!doctype html><html lang="th"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3">'
  + '<title>กำลังโหลด</title></head><body style="font-family:sans-serif;text-align:center;padding:64px 16px;color:#444">'
  + '<p style="font-size:18px">กำลังโหลด กรุณารีเฟรช</p><p style="color:#999;font-size:14px">หน้านี้จะลองใหม่เองในไม่กี่วินาที</p>'
  // meta refresh ไปที่อยู่เดิมที่มี #page (หน้าแอดมินมี # เสมอ) เบราว์เซอร์ถือเป็นการเลื่อนในหน้า ไม่โหลดใหม่ — ค้างหน้านี้
  // จนกด F5 เอง (ทดสอบในเบราว์เซอร์จริง: /#dashboard ค้าง ส่วน / กับ /lp กลับมาเอง) → สั่ง reload ตรงๆ ด้วย JS
  + '<script>setTimeout(function () { location.reload(); }, 3000);</script></body></html>';
function sendUnavailable(req, res, url, code, error) {
  if (!isPageReq(req, url)) return sendJson(res, code, { error }, { 'retry-after': '3' });
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3' });
  res.end(req.method === 'HEAD' ? undefined : LOADING_HTML);
}
function proxyTo(req, res, id, url) {
  const k = kids.get(id);
  if (!k || !k.ready) {
    return sendUnavailable(req, res, url, 503, 'โปรไฟล์นี้กำลังเริ่มทำงาน — ลองใหม่ในอีกสักครู่');
  }
  const preq = http.request({
    host: '127.0.0.1', port: k.port, method: req.method, path: url,
    headers: { ...req.headers, 'x-fbws': id },
  }, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);   // ส่งต่อแบบสตรีม — รองรับ SSE (log สด) และ NDJSON ตอนขึ้นแอด
  });
  preq.on('error', () => {
    if (!res.headersSent) sendUnavailable(req, res, url, 502, 'ต่อโปรไฟล์นี้ไม่ได้ชั่วคราว — ลองใหม่อีกครั้ง');
    else res.destroy();
  });
  // ผู้ใช้ปิดแท็บ/ยกเลิก = ตัดสายไปที่โปรไฟล์ด้วย (server.js ใช้สัญญาณนี้หยุดขึ้นแอดที่เหลือ)
  res.on('close', () => { if (!res.writableEnded) preq.destroy(); });
  req.pipe(preq);   // อัปโหลดไฟล์ใหญ่ส่งต่อแบบสตรีม ไม่พักไว้ในหน่วยความจำ
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/hub/api/')) {
    return hubApi(req, res, url.split('?')[0]).catch((e) => {
      console.error('[hub]', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'จัดการโปรไฟล์ไม่สำเร็จ: ' + e.message });
    });
  }
  const reg = loadReg();
  // /w/<id>/... = เจาะจงโปรไฟล์ทางลิงก์ (หน้า Landing สาธารณะของโปรไฟล์อื่น) ไม่สน cookie
  const m = url.match(/^\/w\/([a-z0-9][a-z0-9-]*)(\/.*)?$/);
  if (m) {
    if (!reg.list.some((w) => w.id === m[1])) return sendJson(res, 404, { error: 'ไม่พบโปรไฟล์นี้' });
    return proxy(req, res, m[1], m[2] || '/');
  }
  const cur = currentWs(req, reg);
  // หน้าต่างที่เปิดค้างไว้ส่งโปรไฟล์ของตัวเองมา (x-fbws-page) แต่ cookie ถูกหน้าต่างอื่นสลับไปแล้ว
  // เดิมส่งต่อตาม cookie อย่างเดียว: จอ TOP กด "หยุดฉุกเฉิน" → ไปหยุด BRAND-B แทน TOP ยิงเงินต่อ จอบอกว่าหยุดแล้ว
  // ไม่ส่งต่อให้โปรไฟล์ไหนเลย ตอบ 409 ให้หน้าเว็บบอกผู้ใช้แล้วโหลดใหม่ • ไม่มี header (โหลดหน้าแรก, ส่วนขยาย Chrome) = ตาม cookie เหมือนเดิม
  const page = req.headers[PAGE_HDR];
  if (page && page !== cur) {
    const nm = (id) => (reg.list.find((w) => w.id === id) || { name: String(id).slice(0, 41) }).name;
    return sendJson(res, 409, {
      error: `หน้าต่างนี้เปิดโปรไฟล์ "${nm(page)}" ค้างไว้ แต่ตอนนี้เลือกโปรไฟล์ "${nm(cur)}" อยู่ (สลับจากหน้าต่างอื่น) — คำสั่งนี้ยังไม่ถูกทำ`,
      wsMismatch: true, current: cur,
    }, { 'x-fbws-mismatch': cur });
  }
  return proxy(req, res, cur, url);
});
// ห้ามให้ request แปลกๆ ตัวเดียวทำตัวกลางล้ม — ตัวกลางล้ม = ทุกโปรไฟล์ล้มตาม
server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ข้าม */ } });
// อัปโหลดวิดีโอใหญ่ใช้เวลานาน — ตัวกลางห้ามตัดก่อน (server.js ปลายทางมีเพดานของมันเองอยู่แล้ว)
server.requestTimeout = 0;

async function main() {
  const reg = loadReg();
  if (!fs.existsSync(REG_PATH)) saveReg(reg);
  // รับคำขอได้ทันที — โปรไฟล์ที่ยังบูตไม่เสร็จตอบ 503 "กำลังเริ่มทำงาน" แทนการปล่อยให้ทั้งเว็บเงียบ
  server.listen(PORT);
  await Promise.all(reg.list.map((w) => startKid(w.id)));
  console.log('');
  console.log(`  FB Ad Uploader (โปรไฟล์: ${reg.list.map((w) => w.name).join(', ')}) พร้อมใช้งานแล้ว!`);
  console.log(`  เปิดเบราว์เซอร์ที่ ->  http://localhost:${PORT}`);
  console.log('');
}
// ตัวกลางหยุด = ปิดทุกโปรไฟล์ด้วย (บน Windows โปรเซสลูกไม่ตายตามแม่เอง จะค้างถือพอร์ตไว้)
let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  await Promise.all([...kids.keys()].map((id) => stopKid(id)));
  process.exit(0);
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('exit', () => { for (const k of kids.values()) { try { k.proc.kill(); } catch { /* ข้าม */ } } });

main().catch((e) => { console.error('[hub] เริ่มไม่สำเร็จ:', e); process.exit(1); });
