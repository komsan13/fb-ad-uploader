const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const API = process.env.FB_API_BASE || 'https://graph.facebook.com/v23.0';
// วิดีโอต้องอัปโหลดเข้า host เฉพาะ — host ปกติจะตอบ 413 (ตัวเปล่า) เมื่อไฟล์ใหญ่
const VIDEO_API = API.includes('graph.facebook.com') ? API.replace('graph.facebook.com', 'graph-video.facebook.com') : API;
const PORT = process.env.PORT || 4000;
// URL สาธารณะของแอป (ตั้งผ่าน env ตอน deploy) — ใช้สร้าง redirect URI ของ OAuth
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const app = express();
app.set('etag', false);
app.use(express.json());
// API ต้องได้ข้อมูลสดเสมอ — ห้าม browser/proxy cache
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

const BACKUP_DIR = path.join(path.dirname(CONFIG_PATH), 'config-backups');
function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch {
    // ไฟล์หาย/พัง — กู้จาก backup ล่าสุดก่อน ห้ามเริ่มค่าว่างทับ (token ทุกบัญชีอยู่ในนี้)
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('config-')).sort().reverse();
      for (const f of files) {
        try {
          cfg = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
          console.log(`config.json พัง — กู้จาก backup ${f}`);
          try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch { /* เขียนซ่อมไม่ได้ก็ใช้ค่าที่กู้ในหน่วยความจำไปก่อน */ }
          break;
        } catch { /* ไฟล์นี้ก็พัง ลองตัวถัดไป */ }
      }
    } catch { /* ไม่มีโฟลเดอร์ backup */ }
    if (!cfg) cfg = {};
  }
  if (!cfg.profiles) {
    // migrate จาก config เวอร์ชันเก่า (บัญชีเดียว)
    const profiles = cfg.accessToken
      ? [{ id: 'p1', label: 'บัญชีหลัก', accessToken: cfg.accessToken, adAccountId: cfg.adAccountId || '', pageId: cfg.pageId || '' }]
      : [];
    cfg = { profiles, activeProfileId: profiles.length ? profiles[0].id : null };
    saveConfig(cfg);
  }
  return cfg;
}
function saveConfig(cfg) {
  // สำรองของเดิมวันละชุดก่อนเขียนทับ (เก็บ 14 วันล่าสุด) — backup พลาดต้องไม่ขวางการบันทึก
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const day = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // วันตามเวลาไทย
      const bak = path.join(BACKUP_DIR, `config-${day}.json`);
      if (!fs.existsSync(bak)) {
        fs.copyFileSync(CONFIG_PATH, bak);
        const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('config-')).sort();
        while (files.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
      }
    }
  } catch { /* ข้าม */ }
  // เขียนลงไฟล์ชั่วคราวแล้ว rename ทับ — rename เป็น atomic ระดับไฟล์ระบบ
  // ไฟดับ/ถูก kill กลางคันจะได้ config ตัวเก่าครบๆ ไม่ใช่ไฟล์ที่เขียนค้างครึ่งทาง (token ทุกบัญชีอยู่ในนี้)
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}
function getProfile(cfg, id) {
  // ระบุ id มา = ต้องเจอตัวนั้นเท่านั้น (กันยิงผิดบัญชีเมื่อ id ไม่ตรง เช่นเพิ่งถูกลบ)
  if (id) return cfg.profiles.find((p) => p.id === id) || null;
  // ไม่ระบุ = ใช้บัญชีที่กำลังใช้งานอยู่
  return cfg.profiles.find((p) => p.id === cfg.activeProfileId) || cfg.profiles[0] || null;
}
// ส่งข้อมูล profile ให้หน้าเว็บโดยไม่ส่ง token กลับไป
function publicProfiles(cfg) {
  return {
    activeProfileId: cfg.activeProfileId,
    profiles: cfg.profiles.map((p) => ({
      id: p.id, label: p.label, adAccountId: p.adAccountId, pageId: p.pageId,
      hasToken: !!p.accessToken, appId: p.appId || '', hasSecret: !!p.appSecret,
    })),
  };
}

// error code ของ FB ที่แปลว่า "ยิงเร็วเกิน" — รอแล้วลองใหม่ได้ ไม่ใช่ความผิดของแอด
const THROTTLE_CODES = new Set([4, 17, 613, 80000, 80003, 80004, 80014]);

// เรียก Graph API — โดน rate limit จะรอแล้ว retry อัตโนมัติ (สูงสุด 2 ครั้ง), error อื่นโยนพร้อมข้อความจาก FB
async function fb(pathname, params, method, token, attempt = 0) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  body.append('access_token', token);
  let url = `${API}/${pathname}`;
  const opts = { method };
  if (method === 'GET') url += '?' + body.toString();
  else opts.body = body;
  // เน็ต/FB สะดุด (ตอบว่าง, ตอบไม่เป็น JSON, ต่อไม่ติด) = อาการชั่วคราว → รอสั้นๆ แล้วลองใหม่
  let json;
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    try { json = JSON.parse(text); }
    catch { throw new Error(`FB ตอบกลับผิดปกติ (HTTP ${res.status})`); }
  } catch (err) {
    // ลองใหม่ได้เฉพาะ GET — POST ที่ FB รับไปแล้วแต่สายหลุดตอนอ่านคำตอบ ถ้ายิงซ้ำจะได้แคมเปญ/แอด/Pixel ซ้ำ
    if (attempt < 2 && method === 'GET') {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
      return fb(pathname, params, method, token, attempt + 1);
    }
    throw new Error(`เชื่อมต่อ FB ไม่สำเร็จ: ${err.message} — กดขึ้นอีกครั้งได้เลย (ตัวที่สำเร็จแล้วไม่ขึ้นซ้ำ)`);
  }
  if (json.error) {
    const e = json.error;
    if (THROTTLE_CODES.has(e.code) && attempt < 2) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 20000));
      return fb(pathname, params, method, token, attempt + 1);
    }
    // error_user_msg เป็นภาษาตาม locale ของ token — เก็บ message อังกฤษดิบไว้ให้โค้ดที่ต้องจับ pattern ใช้ด้วย
    let msg = e.error_user_msg || e.message || 'FB API error';
    // แปล error ระดับระบบให้เป็นคำแนะนำที่ทำตามได้จริง
    if (e.code === 200 && /API access blocked/i.test(e.message || '')) {
      msg = 'Meta บล็อกการเข้า API ของ "แอป" ที่ใช้เชื่อม (ไม่ใช่ตัวบัญชี FB) — เปิด developers.facebook.com/apps เพื่อดูประกาศ/กดอุทธรณ์ หรือสร้างแอปใหม่แล้วใส่ App ID/Secret ในหน้า "บัญชี FB" แล้วล็อกอินใหม่';
    } else if (e.code === 190) {
      msg = 'token หมดอายุหรือถูกยกเลิก — ไปหน้า "บัญชี FB" แล้วกด "เข้าสู่ระบบด้วย Facebook" ใหม่' + (e.message ? ` (${e.message})` : '');
    }
    const err = new Error(msg);
    err.fbMessage = e.message || '';
    throw err;
  }
  return json;
}

// ดึงข้อมูลแบบแบ่งหน้า (ตาม paging.next ของ Graph API) กันข้อมูลถูกตัดเงียบๆ
async function fbAll(pathname, params, token, maxPages = 25) {
  let out = [];
  let after;
  for (let i = 0; i < maxPages; i++) {
    const p = { ...params, limit: params.limit || 200 };
    if (after) p.after = after;
    const r = await fb(pathname, p, 'GET', token);
    out = out.concat(r.data || []);
    if (r.paging && r.paging.next && r.paging.cursors && r.paging.cursors.after) after = r.paging.cursors.after;
    else break;
  }
  return out;
}

// อัปโหลดวิดีโอ (multipart) → คืน video_id
async function uploadVideo(acct, file, token, attempt = 0) {
  const form = new FormData();
  form.append('access_token', token);
  // ชื่อไฟล์ที่ส่งขึ้น FB สุ่มใหม่ทุกครั้ง (ตามที่ผู้ใช้ต้องการ) — คงนามสกุลเดิมไว้ให้ FB เดา container ถูก
  const ext = ((file.originalname || '').match(/\.[a-z0-9]{2,4}$/i) || ['.mp4'])[0];
  const sendName = crypto.randomBytes(8).toString('hex') + ext;
  form.append('source', new Blob([file.buffer], { type: file.mimetype || 'video/mp4' }), sendName);
  let json;
  try {
    const res = await fetch(`${VIDEO_API}/${acct}/advideos`, { method: 'POST', body: form });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { throw new Error(`FB ตอบกลับผิดปกติ (HTTP ${res.status})`); }
  } catch (err) {
    // การเชื่อมต่อสะดุด/FB ตอบไม่เป็น JSON — รอแล้วอัปโหลดใหม่ได้อีก 2 รอบ
    // จงใจต่างจาก fb() ที่ไม่ retry POST: ตัวซ้ำที่นี่เป็นแค่วิดีโอลอยในคลัง FB (ไม่ถูกผูกกับแอด
    // เพราะเราใช้ id ของรอบที่สำเร็จเท่านั้น) แลกกับการไม่ต้องให้ผู้ใช้อัปไฟล์ใหญ่ใหม่ทั้งก้อน
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
      return uploadVideo(acct, file, token, attempt + 1);
    }
    throw new Error(`อัปโหลดวิดีโอไป FB ไม่สำเร็จ (${err.message}) — กดขึ้นอีกครั้งได้เลย`);
  }
  if (json.error) throw new Error(json.error.error_user_msg || json.error.message);
  return json.id;
}
// วิดีโอต้องประมวลผลก่อนใช้ — วนเช็คสถานะจน ready (สูงสุด ~10 นาที)
async function waitVideoReady(videoId, token, onTick) {
  for (let i = 0; i < 120; i++) {
    const r = await fb(videoId, { fields: 'status' }, 'GET', token);
    const s = r.status && r.status.video_status;
    if (s === 'ready') return;
    if (s === 'error') throw new Error('วิดีโอประมวลผลไม่สำเร็จ');
    if (onTick) onTick(s || 'processing');
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error('วิดีโอประมวลผลนานเกินไป (timeout)');
}
// รูป thumbnail อัตโนมัติของวิดีโอ (เอาไว้ใส่ในครีเอทีฟ)
async function videoThumb(videoId, token) {
  try {
    const r = await fb(`${videoId}/thumbnails`, {}, 'GET', token);
    const list = r.data || [];
    const pick = list.find((t) => t.is_preferred) || list[0];
    return pick ? pick.uri : null;
  } catch { return null; }
}

// locale id ของภาษาไทยใน FB targeting
// ค่าคงที่ 35 — ยืนยันกับ FB จริงผ่าน targetingsentencelines ("ภาษา: ภาษาไทย")
// ห้ามใช้ search type=adlocale q=Thai (คืนค่าว่าง) และห้ามใช้ 24 (= English UK)
const THAI_LOCALE = 35;

const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;
const LOGIN_SCOPES = 'ads_management,ads_read,business_management,pages_show_list,pages_read_engagement';

const OBJECTIVES = {
  OUTCOME_TRAFFIC: { optimization_goal: 'LINK_CLICKS' },
  OUTCOME_ENGAGEMENT: { optimization_goal: 'POST_ENGAGEMENT' },
  OUTCOME_SALES: { optimization_goal: 'OFFSITE_CONVERSIONS', event: 'PURCHASE', needsPixel: true },
  OUTCOME_LEADS: { optimization_goal: 'OFFSITE_CONVERSIONS', event: 'LEAD', needsPixel: true },
};

// ---------- คลังวิดีโอที่อัปโหลดล่วงหน้า (ลากไฟล์ปุ๊บอัปขึ้น server เลย ไม่ต้องรอตอนกดขึ้นแอด) ----------
const MEDIA_DIR = path.join(os.tmpdir(), 'fbad-media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const mediaStore = new Map(); // id -> {path, mimetype, originalname, ts}
// ไล่ลบจากไฟล์จริงบนดิสก์ ไม่ใช่จาก Map — restart แล้ว Map ว่าง แต่ไฟล์เก่ายังอยู่ ถ้าวน Map จะไม่มีวันถูกลบ
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let names = [];
  try { names = fs.readdirSync(MEDIA_DIR); } catch { return; }
  for (const name of names) {
    const p = path.join(MEDIA_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); mediaStore.delete(name); }
    } catch { /* ไฟล์หายไปแล้ว/อ่านไม่ได้ ข้าม */ }
  }
}, 3600 * 1000).unref();

// วิดีโอเขียนลงดิสก์โดยตรง ไม่ผ่าน memoryStorage — ไฟล์ 512MB ไม่ต้องกอง RAM ทั้งก้อน
const uploadDisk = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
});
app.post('/api/media', uploadDisk.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่ได้แนบไฟล์' });
  const id = req.file.filename;
  mediaStore.set(id, { path: req.file.path, mimetype: req.file.mimetype, originalname: req.file.originalname, ts: Date.now() });
  res.json({ id });
});

// ---------- คลังวิดีโอถาวร (อัปเก็บไว้ก่อน แล้วหยิบมาใช้ตอนขึ้นแอดกี่ครั้งก็ได้) ----------
// อยู่ข้าง config.json = โฟลเดอร์ /data ที่ deploy.sh mount ไว้ → รอดจาก redeploy (ต่างจาก MEDIA_DIR ที่อยู่ใน tmp)
const LIB_DIR = path.join(path.dirname(CONFIG_PATH), 'media-library');
const LIB_INDEX = path.join(LIB_DIR, 'index.json');
fs.mkdirSync(LIB_DIR, { recursive: true });
function loadLib() {
  try { const a = JSON.parse(fs.readFileSync(LIB_INDEX, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveLib(items) { fs.writeFileSync(LIB_INDEX, JSON.stringify(items, null, 2)); }
const libFile = (id) => path.join(LIB_DIR, id + '.bin');
const libThumb = (id) => path.join(LIB_DIR, id + '.jpg');

const uploadLib = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LIB_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.bin'),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
});

app.get('/api/library', (req, res) => res.json(loadLib()));

app.post('/api/library', uploadLib.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่ได้แนบไฟล์' });
  const id = path.basename(req.file.filename, '.bin');
  // thumbnail ทำจากเฟรมแรกฝั่งเบราว์เซอร์แล้วส่งมาเป็น data URL — server ไม่ต้องมี ffmpeg
  const thumb = String(req.body.thumb || '');
  const m = thumb.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (m) { try { fs.writeFileSync(libThumb(id), Buffer.from(m[1], 'base64')); } catch { /* ไม่มีรูปตัวอย่างก็ใช้งานได้ */ } }
  const item = {
    id,
    name: String(req.body.name || req.file.originalname || 'วิดีโอ').slice(0, 120),
    filename: req.file.originalname || 'video.mp4',
    mimetype: req.file.mimetype || 'video/mp4',
    size: req.file.size,
    ts: Date.now(),
  };
  const items = loadLib();
  items.unshift(item);
  saveLib(items);
  res.json(item);
});

app.post('/api/library/rename', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'ชื่อว่างไม่ได้' });
  const items = loadLib();
  const item = items.find((x) => x.id === String(req.body.id));
  if (!item) return res.status(404).json({ error: 'ไม่พบวิดีโอนี้ในคลัง' });
  item.name = name;
  saveLib(items);
  res.json({ ok: true });
});

app.post('/api/library/delete', (req, res) => {
  const id = String(req.body.id || '');
  const items = loadLib();
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return res.status(404).json({ error: 'ไม่พบวิดีโอนี้ในคลัง' });
  items.splice(i, 1);
  saveLib(items);
  try { fs.unlinkSync(libFile(id)); } catch { /* ไฟล์หายไปแล้ว */ }
  try { fs.unlinkSync(libThumb(id)); } catch { /* ไม่มี thumbnail */ }
  res.json({ ok: true });
});

app.get('/api/library/thumb/:id', (req, res) => {
  // :id มาจาก URL — ยัน format uuid ก่อนเอาไปต่อ path กัน ../ หลุดออกนอก LIB_DIR
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).end();
  res.sendFile(libThumb(req.params.id), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ---------- คลังแคปชั่น (ผู้ใช้เตรียมข้อความไว้เอง แล้วให้ตัวจัดแผนหยิบไปใช้) ----------
const CAPTION_PATH = path.join(path.dirname(CONFIG_PATH), 'captions.json');
function loadCaptions() {
  try { const a = JSON.parse(fs.readFileSync(CAPTION_PATH, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveCaptions(items) { fs.writeFileSync(CAPTION_PATH, JSON.stringify(items, null, 2)); }

app.get('/api/captions', (req, res) => res.json(loadCaptions()));

app.post('/api/captions', (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'ต้องมีข้อความหลัก' });
  const item = {
    id: 'c' + crypto.randomUUID(),
    message: message.slice(0, 5000),
    headline: String(req.body.headline || '').trim().slice(0, 255),
    ts: Date.now(),
  };
  const items = loadCaptions();
  items.unshift(item);
  saveCaptions(items);
  res.json(item);
});

app.post('/api/captions/update', (req, res) => {
  const items = loadCaptions();
  const item = items.find((x) => x.id === String(req.body.id));
  if (!item) return res.status(404).json({ error: 'ไม่พบแคปชั่นนี้' });
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'ข้อความหลักว่างไม่ได้' });
  item.message = message.slice(0, 5000);
  item.headline = String(req.body.headline || '').trim().slice(0, 255);
  saveCaptions(items);
  res.json({ ok: true });
});

app.post('/api/captions/delete', (req, res) => {
  const items = loadCaptions();
  const i = items.findIndex((x) => x.id === String(req.body.id));
  if (i < 0) return res.status(404).json({ error: 'ไม่พบแคปชั่นนี้' });
  items.splice(i, 1);
  saveCaptions(items);
  res.json({ ok: true });
});

// ---------- ตัวจัดแผนขึ้นแอด: จับคู่วิดีโอ+แคปชั่นให้แต่ละบัญชี ----------
// ตรรกะธรรมดา ไม่ใช้ AI — ผลลัพธ์คาดเดาได้ ทำงานทันที ไม่มีค่า token
// กติกา: (1) เลี่ยงวิดีโอที่บัญชีนั้นเคยขึ้นไปแล้ว (2) ในรอบเดียวกันห้ามบัญชีอื่นได้ตัวซ้ำ
app.post('/api/autoplan', (req, res) => {
  const accounts = Array.isArray(req.body.accounts) ? req.body.accounts : [];
  const perAccount = Math.max(1, Math.min(10, Number(req.body.perAccount) || 3));
  if (!accounts.length) return res.status(400).json({ error: 'ยังไม่ได้เลือกบัญชี' });

  const videos = loadLib();
  const captions = loadCaptions();
  if (!videos.length) return res.status(400).json({ error: 'คลังวิดีโอยังว่าง — อัปวิดีโอเข้าคลังก่อน' });
  if (!captions.length) return res.status(400).json({ error: 'คลังแคปชั่นยังว่าง — เพิ่มแคปชั่นก่อน' });

  const usedThisRound = new Set();
  let captionCursor = 0;
  const warnings = [];

  const plan = accounts.map((acct) => {
    const acctId = String(acct.acctId || '');
    // เรียงลำดับความน่าหยิบ: ยังไม่เคยใช้กับบัญชีนี้ และยังไม่ถูกจองในรอบนี้ มาก่อน
    const ranked = videos.slice().sort((a, b) => {
      const score = (v) => (v.usedOn && v.usedOn.includes(acctId) ? 2 : 0) + (usedThisRound.has(v.id) ? 1 : 0);
      return score(a) - score(b) || b.ts - a.ts;
    });
    const picked = ranked.slice(0, perAccount);
    // เตือนก่อนที่ usedThisRound จะถูกอัปเดต ไม่งั้นจะนับตัวของตัวเองเป็นตัวซ้ำ
    const label = acct.name || acctId;
    if (picked.length < perAccount) {
      warnings.push(`${label}: คลังมีวิดีโอไม่พอ ได้ ${picked.length} จาก ${perAccount} ตัว`);
    }
    const dupInRound = picked.filter((v) => usedThisRound.has(v.id));
    if (dupInRound.length) {
      warnings.push(`${label}: วิดีโอในคลังไม่พอ ${dupInRound.length} ตัวจึงซ้ำกับบัญชีอื่นในรอบนี้ (${dupInRound.map((v) => v.name).join(', ')})`);
    }
    const reused = picked.filter((v) => v.usedOn && v.usedOn.includes(acctId));
    if (reused.length) {
      warnings.push(`${label}: ต้องใช้วิดีโอที่เคยขึ้นในบัญชีนี้แล้ว ${reused.length} ตัว (${reused.map((v) => v.name).join(', ')})`);
    }
    picked.forEach((v) => usedThisRound.add(v.id));

    return {
      pid: acct.pid,
      acctId,
      name: acct.name,
      ads: picked.map((v) => {
        const cap = captions[captionCursor++ % captions.length];
        return {
          mediaId: v.id,
          videoName: v.name,
          name: v.name,
          message: cap.message,
          headline: cap.headline,
          captionId: cap.id,
        };
      }),
    };
  });

  const totalAds = plan.reduce((s, a) => s + a.ads.length, 0);
  if (captions.length < totalAds) {
    warnings.push(`คลังแคปชั่นมี ${captions.length} อัน แต่ต้องใช้ ${totalAds} แอด — แคปชั่นจะวนซ้ำ`);
  }
  res.json({ plan, warnings, stats: { videos: videos.length, captions: captions.length, totalAds } });
});

// บันทึกว่าวิดีโอตัวนี้ถูกใช้กับบัญชีไหนไปแล้ว (เรียกหลังขึ้นแอดสำเร็จ)
function markVideoUsed(mediaId, acctId) {
  try {
    const items = loadLib();
    const item = items.find((x) => x.id === String(mediaId));
    if (!item) return;
    if (!Array.isArray(item.usedOn)) item.usedOn = [];
    if (item.usedOn.includes(acctId)) return;
    item.usedOn.push(acctId);
    saveLib(items);
  } catch { /* บันทึกประวัติไม่สำเร็จ ไม่ควรทำให้การขึ้นแอดพัง */ }
}

// หา media จาก id: คลังถาวรก่อน แล้วค่อยตกไปที่ไฟล์ชั่วคราวของรอบขึ้นแอดปัจจุบัน
function resolveMedia(id) {
  const key = String(id);
  const item = loadLib().find((x) => x.id === key);
  if (item) return { path: libFile(key), mimetype: item.mimetype, originalname: item.filename };
  return mediaStore.get(key) || null;
}

// ---------- AI วิเคราะห์ผลแคมเปญ แล้วเสนอว่าควรทำอะไรต่อ ----------
const Anthropic = require('@anthropic-ai/sdk');

const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'สรุปภาพรวมสั้นๆ 2-3 ประโยค เป็นภาษาไทย' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          campaignId: { type: 'string' },
          campaignName: { type: 'string' },
          action: { type: 'string', enum: ['scale', 'pause', 'watch', 'keep'] },
          reason: { type: 'string', description: 'เหตุผลสั้นๆ อ้างตัวเลขจริง เป็นภาษาไทย' },
        },
        required: ['campaignId', 'campaignName', 'action', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'actions'],
  additionalProperties: false,
};

const ADVICE_SYSTEM = `คุณคือคนดูแลบัญชีโฆษณา Facebook ให้เจ้าของธุรกิจไทย หน้าที่คือดูตัวเลขแคมเปญแล้วบอกตรงๆ ว่าควรทำอะไรกับแต่ละตัว

เกณฑ์ตัดสิน:
- scale = ต้นทุนต่อผลลัพธ์ต่ำกว่าค่าเฉลี่ยชัดเจน และใช้จ่ายมากพอจะเชื่อตัวเลขได้ → ควรเพิ่มงบ
- pause = ใช้จ่ายไปพอสมควรแล้วแต่ยังไม่มีผลลัพธ์ หรือต้นทุนต่อผลลัพธ์แพงกว่าค่าเฉลี่ยมาก → ควรหยุด
- watch = ตัวเลขยังน้อยเกินจะตัดสิน หรือมีสัญญาณผิดปกติ (แอดโดนปฏิเสธ/ค้างรีวิว) → ต้องจับตา
- keep = ปกติดี ปล่อยไว้

กฎ:
- ห้ามแนะนำ pause หรือ scale จากตัวเลขที่ยังน้อยเกินไป ถ้าใช้จ่ายยังน้อยมากให้ตอบ watch
- เหตุผลต้องอ้างตัวเลขจริงจากข้อมูลที่ให้ ห้ามแต่งตัวเลขเอง
- ตอบเป็นภาษาไทย กระชับ ตรงประเด็น ไม่ต้องเกริ่น
- ทุกแคมเปญที่ได้รับต้องมีคำแนะนำครบทุกตัว`;

app.post('/api/ai-advice', async (req, res) => {
  const cfg = loadConfig();
  const apiKey = cfg.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'ยังไม่ได้ใส่ Anthropic API key (ไปที่เมนู "บัญชี FB" → ส่วน AI)' });

  const campaigns = Array.isArray(req.body.campaigns) ? req.body.campaigns : [];
  if (!campaigns.length) return res.status(400).json({ error: 'ไม่มีแคมเปญให้วิเคราะห์' });

  // ส่งเฉพาะฟิลด์ที่ใช้ตัดสินจริง — ไม่เทข้อมูลทั้งก้อนเข้าไปเปลืองโทเคน
  const slim = campaigns.slice(0, 120).map((c) => ({
    id: String(c.id),
    name: String(c.name || '').slice(0, 120),
    บัญชี: c.accountName || undefined,
    สถานะ: c.effective_status || c.status,
    งบต่อวัน: c.dailyBudget || 0,
    ใช้จ่าย: Math.round(Number(c.spend) || 0),
    ผลลัพธ์: c.results || 0,
    ชื่อผลลัพธ์: c.resultLabel || undefined,
    ต้นทุนต่อผลลัพธ์: c.costPerResult != null ? Math.round(c.costPerResult) : null,
    แอดโดนปฏิเสธ: c.adsDisapproved || 0,
    แอดรอรีวิว: c.adsPending || 0,
    แอดที่ยิงอยู่: c.adsActive || 0,
  }));

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: ADVICE_SCHEMA } },
      system: ADVICE_SYSTEM,
      messages: [{
        role: 'user',
        content: `ข้อมูลแคมเปญช่วง "${req.body.datePreset || 'ไม่ระบุช่วง'}" สกุลเงิน ${req.body.currency || 'THB'}\n\n${JSON.stringify(slim, null, 1)}`,
      }],
    });

    if (msg.stop_reason === 'refusal') return res.status(400).json({ error: 'AI ปฏิเสธคำขอนี้' });
    const block = msg.content.find((b) => b.type === 'text');
    if (!block) return res.status(502).json({ error: 'AI ตอบกลับว่างเปล่า' });
    let out;
    try { out = JSON.parse(block.text); }
    catch { return res.status(502).json({ error: 'AI ตอบกลับผิดรูปแบบ' }); }
    res.json({ ...out, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens } });
  } catch (e) {
    // ข้อความจาก SDK เป็น JSON ดิบ ผู้ใช้อ่านไม่รู้เรื่อง — ดึงเฉพาะข้อความจริงแล้วแปลเคสที่เจอบ่อย
    const apiMsg = (e && e.error && e.error.error && e.error.error.message) || e.message || '';
    const m = e.status === 401 ? 'API key ไม่ถูกต้อง — เช็คที่เมนู "บัญชี FB" → ส่วน AI'
      : /credit balance is too low/i.test(apiMsg)
        ? 'เครดิต Anthropic หมด — เข้า console.anthropic.com → Plans & Billing → Add credits (ขั้นต่ำ $5) แล้วลองใหม่'
      : e.status === 429 ? 'เรียกถี่เกินไป/เกินโควตา — รอสักครู่แล้วลองใหม่'
      : e.status === 400 ? `คำขอไม่ถูกต้อง: ${apiMsg}`
      : `เรียก AI ไม่สำเร็จ: ${apiMsg}`;
    res.status(502).json({ error: m });
  }
});

app.get('/api/ai-key', (req, res) => {
  const cfg = loadConfig();
  res.json({ hasKey: !!(cfg.anthropicKey || process.env.ANTHROPIC_API_KEY), fromEnv: !cfg.anthropicKey && !!process.env.ANTHROPIC_API_KEY });
});
app.post('/api/ai-key', (req, res) => {
  const cfg = loadConfig();
  cfg.anthropicKey = String(req.body.key || '').trim();
  saveConfig(cfg);
  res.json({ ok: true, hasKey: !!cfg.anthropicKey });
});

// ---------- จัดการบัญชี FB (profiles) ----------
app.get('/api/profiles', (req, res) => res.json(publicProfiles(loadConfig())));

// redirect URI ที่ต้องเอาไปใส่ในแอป FB (เปลี่ยนตาม env ตอน deploy)
app.get('/api/env', (req, res) => res.json({ redirectUri: REDIRECT_URI }));

app.post('/api/profiles', (req, res) => {
  const cfg = loadConfig();
  const id = 'p' + Date.now();
  cfg.profiles.push({
    id,
    label: req.body.label || `บัญชี FB ${cfg.profiles.length + 1}`,
    accessToken: req.body.accessToken || '',
    adAccountId: '', pageId: '',
  });
  if (!cfg.activeProfileId) cfg.activeProfileId = id;
  saveConfig(cfg);
  res.json({ id });
});

app.post('/api/profiles/update', (req, res) => {
  const cfg = loadConfig();
  const p = cfg.profiles.find((x) => x.id === req.body.id);
  if (!p) return res.status(404).json({ error: 'ไม่พบบัญชีนี้' });
  // ความลับ (token/secret): ช่องว่าง = "ไม่เปลี่ยน" เพราะหน้าเว็บโชว์เป็น placeholder ไม่เคยส่งค่าเดิมกลับมา
  for (const k of ['accessToken', 'appSecret']) {
    if (req.body[k]) p[k] = req.body[k];
  }
  // ค่าธรรมดา: ช่องว่าง = ตั้งใจล้างค่า (เดิมล้าง appId/เพจ/บัญชีโฆษณาที่เลือกผิดไว้ไม่ได้เลย)
  for (const k of ['label', 'adAccountId', 'pageId', 'appId']) {
    if (req.body[k] !== undefined) p[k] = req.body[k];
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post('/api/profiles/delete', (req, res) => {
  const cfg = loadConfig();
  cfg.profiles = cfg.profiles.filter((x) => x.id !== req.body.id);
  if (cfg.activeProfileId === req.body.id) {
    cfg.activeProfileId = cfg.profiles.length ? cfg.profiles[0].id : null;
  }
  saveConfig(cfg);
  res.json(publicProfiles(cfg));
});

app.post('/api/profiles/active', (req, res) => {
  const cfg = loadConfig();
  if (cfg.profiles.some((x) => x.id === req.body.id)) cfg.activeProfileId = req.body.id;
  saveConfig(cfg);
  res.json({ ok: true });
});

// ---------- Login with Facebook (OAuth) ----------
app.get('/auth/login', (req, res) => {
  const cfg = loadConfig();
  const prof = cfg.profiles.find((p) => p.id === req.query.profile);
  if (!prof) return res.status(404).send('ไม่พบบัญชี');
  if (!prof.appId) return res.status(400).send('ยังไม่ได้ใส่ App ID ในการ์ดบัญชี');
  const url = `https://www.facebook.com/v23.0/dialog/oauth`
    + `?client_id=${encodeURIComponent(prof.appId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${encodeURIComponent(prof.id)}`
    + `&response_type=code&scope=${encodeURIComponent(LOGIN_SCOPES)}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const cfg = loadConfig();
  const prof = cfg.profiles.find((p) => p.id === req.query.state);
  const done = (ok, msg) => res.send(`<!doctype html><meta charset="utf8">`
    + `<body style="font-family:'Segoe UI',sans-serif;padding:48px;text-align:center;color:#1c1e21">`
    + `<h2>${ok ? '✅ เชื่อมต่อสำเร็จ' : '❌ ไม่สำเร็จ'}</h2><p style="color:#65676b">${msg}</p>`
    + `<p style="color:#aaa;font-size:13px">หน้านี้จะปิดเอง…</p>`
    + `<script>if(window.opener){window.opener.postMessage('fb-auth-done','*');setTimeout(function(){window.close()},1400)}else{setTimeout(function(){location.href='/'},1400)}</script>`
    + `</body>`);

  if (req.query.error) return done(false, req.query.error_description || req.query.error);
  if (!prof) return done(false, 'ไม่พบบัญชี (state ไม่ตรง)');
  if (!prof.appSecret) return done(false, 'ยังไม่ได้ใส่ App Secret');
  try {
    // แลก code → short-lived token
    const s = await (await fetch(`${API}/oauth/access_token`
      + `?client_id=${encodeURIComponent(prof.appId)}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&client_secret=${encodeURIComponent(prof.appSecret)}`
      + `&code=${encodeURIComponent(req.query.code)}`)).json();
    if (s.error) throw new Error(s.error.message);
    // แลก → long-lived token (~60 วัน)
    const l = await (await fetch(`${API}/oauth/access_token`
      + `?grant_type=fb_exchange_token`
      + `&client_id=${encodeURIComponent(prof.appId)}`
      + `&client_secret=${encodeURIComponent(prof.appSecret)}`
      + `&fb_exchange_token=${encodeURIComponent(s.access_token)}`)).json();
    if (l.error) throw new Error(l.error.message);
    // โหลด config สดก่อนเขียน — ระหว่างรอ FB ตอบ (หลายวินาที) อาจมีการแก้ค่าอื่นเข้ามา
    // เช่น watchTick ต่ออายุ token ให้บัญชีอื่น ถ้าเขียนทับด้วย cfg ที่โหลดไว้ตั้งแต่ต้น ค่านั้นจะหาย
    const cfgNow = loadConfig();
    const profNow = cfgNow.profiles.find((p) => p.id === prof.id);
    if (!profNow) return done(false, 'บัญชีนี้ถูกลบไประหว่างล็อกอิน');
    profNow.accessToken = l.access_token || s.access_token;
    saveConfig(cfgNow);
    done(true, 'ได้ token แล้ว (ต่ออายุ 60 วันอัตโนมัติ) — กลับไปที่โปรแกรมได้เลย');
  } catch (e) {
    done(false, e.message);
  }
});

// ---------- ข้อมูลจาก FB ----------
// ตรวจ token + ดึงรายชื่อบัญชีโฆษณาและเพจ (ระบุ ?profile=id ได้)
app.get('/api/accounts', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้ใส่ Access Token' });
  try {
    const me = await fb('me', { fields: 'name' }, 'GET', prof.accessToken);
    // ?full=1 = ดึง Pixel + วิธีจ่ายเงินมาด้วยในครั้งเดียว (สำหรับหน้าขึ้นแอด/ต้นแบบ)
    const full = req.query.full === '1';
    const acctFields = full
      ? 'name,account_id,currency,account_status,business{id,name},funding_source_details,adspixels.limit(15){id,name,last_fired_time},dsa_recommendations{recommendations}'
      : 'name,account_id,currency,account_status,business{id,name}';
    const adAccounts = await fbAll('me/adaccounts', { fields: acctFields, limit: 100 }, prof.accessToken);
    const pages = await fb('me/accounts', { fields: 'name,id', limit: 200 }, 'GET', prof.accessToken);
    // ธุรกิจที่ยืนยันตัวตนแล้ว = ตัวเลือก "ผู้ลงโฆษณา" (ส่งเป็น id ใน regional_regulation_identities)
    let verifiedBiz = [];
    if (full) {
      try {
        const vb = await fbAll('me/businesses', { fields: 'name,verification_status', limit: 100 }, prof.accessToken);
        verifiedBiz = vb.filter((b) => b.verification_status === 'verified').map((b) => ({ id: b.id, name: b.name }));
      } catch { /* ไม่มีสิทธิ์ก็ข้าม */ }
    }
    const accounts = adAccounts.map((a) => {
      const out = {
        name: a.name, account_id: a.account_id, currency: a.currency,
        account_status: a.account_status, business: a.business || null,
      };
      if (full) {
        const fsd = a.funding_source_details || {};
        out.hasPayment = !!(fsd.id || fsd.display_string);
        out.pixels = (a.adspixels && a.adspixels.data) ? a.adspixels.data : [];
        // ตัวเลือก "ผู้ลงโฆษณา" = ธุรกิจที่ยืนยันตัวตนแล้ว (ใช้ id จริงตั้งบน ad set ได้ — พิสูจน์แล้ว)
        out.beneficiaryOptions = verifiedBiz;
        out.savedBeneficiaryId = String((cfg.beneficiaries || {})[a.account_id] || '');
      }
      return out;
    });
    res.json({ name: me.name, adAccounts: accounts, pages: pages.data || [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// จำ "ผู้ลงโฆษณา" ที่ผู้ใช้ตั้งไว้ต่อบัญชีโฆษณา (ตั้งครั้งเดียวใช้ตลอด)
app.post('/api/beneficiary', (req, res) => {
  const acctId = String(req.body.account || '').replace(/[^0-9]/g, '');
  if (!acctId) return res.status(400).json({ error: 'ไม่ได้ระบุบัญชีโฆษณา' });
  const cfg = loadConfig();
  cfg.beneficiaries = cfg.beneficiaries || {};
  const id = String(req.body.id || '').replace(/[^0-9]/g, '');
  if (id) cfg.beneficiaries[acctId] = id;
  else delete cfg.beneficiaries[acctId];
  saveConfig(cfg);
  res.json({ ok: true });
});

// "ผลลัพธ์" ของแคมเปญ pixel (Sales/Leads) ขึ้นกับ "เหตุการณ์คอนเวอร์ชั่น" ของชุดโฆษณา ไม่ใช่วัตถุประสงค์
// พิสูจน์จากบัญชีจริง: event สมัครรับข้อมูล (SUBSCRIBE) มาใน insights เป็น offsite_conversion.fb_pixel_custom
// จึงไล่หา action_type เป็นลิสต์ตามลำดับ ตัวแรกที่เจอ = ผลลัพธ์
const EVENT_RESULT = {
  PURCHASE: { types: ['offsite_conversion.fb_pixel_purchase', 'omni_purchase', 'purchase'], label: 'การซื้อ' },
  LEAD: { types: ['offsite_conversion.fb_pixel_lead', 'lead'], label: 'ลูกค้าเป้าหมาย' },
  SUBSCRIBE: { types: ['subscribe_total', 'offsite_conversion.fb_pixel_subscribe', 'offsite_conversion.fb_pixel_custom'], label: 'สมัครรับข้อมูล' },
  COMPLETE_REGISTRATION: { types: ['offsite_conversion.fb_pixel_complete_registration', 'omni_complete_registration', 'complete_registration'], label: 'ลงทะเบียนเสร็จ' },
  ADD_TO_CART: { types: ['offsite_conversion.fb_pixel_add_to_cart', 'omni_add_to_cart', 'add_to_cart'], label: 'หยิบใส่ตะกร้า' },
  INITIATE_CHECKOUT: { types: ['offsite_conversion.fb_pixel_initiate_checkout', 'omni_initiated_checkout', 'initiate_checkout'], label: 'เริ่มชำระเงิน' },
  CONTACT: { types: ['contact_total', 'offsite_conversion.fb_pixel_custom'], label: 'ติดต่อ' },
};
const OBJECTIVE_RESULT = {
  OUTCOME_TRAFFIC: { types: ['link_click'], label: 'คลิกลิงก์' },
  OUTCOME_ENGAGEMENT: { types: ['post_engagement'], label: 'การมีส่วนร่วม' },
  OUTCOME_SALES: { types: ['offsite_conversion.fb_pixel_purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_custom'], label: 'คอนเวอร์ชั่น' },
  OUTCOME_LEADS: { types: ['offsite_conversion.fb_pixel_lead', 'lead', 'offsite_conversion.fb_pixel_custom'], label: 'คอนเวอร์ชั่น' },
};
// เลือกเกณฑ์ผลลัพธ์: รู้ event ของชุดโฆษณา → ใช้ event, ไม่รู้ → ใช้วัตถุประสงค์
function resultSpec(objective, event) {
  return (event && EVENT_RESULT[event]) || OBJECTIVE_RESULT[objective] || null;
}
function pickResult(spec, actions) {
  if (!spec || !Array.isArray(actions)) return null;
  for (const t of spec.types) {
    const hit = actions.find((a) => a.action_type === t);
    if (hit) return Number(hit.value);
  }
  return null;
}

// รายการแคมเปญพร้อมสถิติ (Insights) แบบ Ads Manager
app.get('/api/campaigns', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  // ?account=... ระบุบัญชีโฆษณาตรงๆ ได้ (หน้าแคมเปญแบบหลายบัญชี) — ไม่ระบุใช้ตัวที่ตั้งไว้ใน profile
  const acctId = String(req.query.account || prof.adAccountId || '').replace(/[^0-9]/g, '');
  if (!acctId) return res.status(400).json({ error: `บัญชี "${prof.label}" ยังไม่ได้เลือกบัญชีโฆษณา` });
  const acct = `act_${acctId}`;
  const token = prof.accessToken;
  const datePreset = ['today', 'last_7d', 'last_30d', 'last_90d', 'maximum'].includes(req.query.date) ? req.query.date : 'maximum';
  try {
    const acctInfo = await fb(acct, { fields: 'currency' }, 'GET', token);
    const campData = await fbAll(`${acct}/campaigns`, {
      fields: 'name,objective,status,effective_status,daily_budget,lifetime_budget,created_time,stop_time',
      limit: 100,
    }, token);
    const camps = { data: campData };

    // insights ต่อแคมเปญ (ห่อ try เผื่อไม่มีข้อมูล/สิทธิ์)
    let insights = [];
    try {
      insights = await fbAll(`${acct}/insights`, {
        level: 'campaign',
        fields: 'campaign_id,spend,impressions,reach,actions',
        date_preset: datePreset,
        limit: 200,
      }, token);
    } catch { /* ไม่มีข้อมูล */ }
    const insMap = Object.fromEntries(insights.map((r) => [r.campaign_id, r]));

    // งบรวมจาก ad set (กรณีตั้งงบระดับ ad set ไม่ใช่ระดับแคมเปญ) + เหตุการณ์คอนเวอร์ชั่นของแคมเปญ
    const adsetBudget = {};
    const campaignEvent = {};
    try {
      const as = await fbAll(`${acct}/adsets`, { fields: 'campaign_id,daily_budget,promoted_object', limit: 200 }, token);
      for (const s of as) {
        if (s.daily_budget) adsetBudget[s.campaign_id] = (adsetBudget[s.campaign_id] || 0) + Number(s.daily_budget);
        const ev = s.promoted_object && s.promoted_object.custom_event_type;
        if (ev && !campaignEvent[s.campaign_id]) campaignEvent[s.campaign_id] = ev;
      }
    } catch { /* ข้าม */ }

    // สถานะระดับ "แอด" — การโดนปฏิเสธ (DISAPPROVED) เกิดที่ระดับนี้ ไม่โผล่ในสถานะแคมเปญ
    const adStatus = {};
    try {
      const ads = await fbAll(`${acct}/ads`, { fields: 'campaign_id,effective_status', limit: 200 }, token);
      for (const a of ads) {
        const st = adStatus[a.campaign_id] || (adStatus[a.campaign_id] = { disapproved: 0, pending: 0, issues: 0, active: 0, total: 0 });
        st.total++;
        if (a.effective_status === 'DISAPPROVED') st.disapproved++;
        else if (a.effective_status === 'PENDING_REVIEW' || a.effective_status === 'IN_PROCESS' || a.effective_status === 'PREAPPROVED') st.pending++;
        else if (a.effective_status === 'WITH_ISSUES') st.issues++;
        else if (a.effective_status === 'ACTIVE') st.active++;
      }
    } catch { /* ข้าม */ }

    const rows = (camps.data || []).map((c) => {
      const ins = insMap[c.id] || {};
      const ra = resultSpec(c.objective, campaignEvent[c.id]);
      const results = pickResult(ra, ins.actions);
      const spend = ins.spend ? Number(ins.spend) : 0;
      const dailyBudget = c.daily_budget ? Number(c.daily_budget) : (adsetBudget[c.id] || 0);
      return {
        id: c.id, name: c.name, objective: c.objective,
        status: c.status, effective_status: c.effective_status,
        created_time: c.created_time, stop_time: c.stop_time || null,
        dailyBudget: dailyBudget / 100,
        lifetimeBudget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
        spend,
        impressions: ins.impressions ? Number(ins.impressions) : 0,
        reach: ins.reach ? Number(ins.reach) : 0,
        results,
        resultLabel: ra ? ra.label : null,
        costPerResult: (results && results > 0) ? spend / results : null,
        adsDisapproved: (adStatus[c.id] || {}).disapproved || 0,
        adsPending: (adStatus[c.id] || {}).pending || 0,
        adsIssues: (adStatus[c.id] || {}).issues || 0,
        adsActive: (adStatus[c.id] || {}).active || 0,
        adsTotal: (adStatus[c.id] || {}).total || 0,
      };
    });
    res.json({ campaigns: rows, account: acct.replace('act_', ''), currency: acctInfo.currency || '', datePreset });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ใช้จ่ายรายวันระดับบัญชี (สำหรับกราฟหน้าแดชบอร์ด)
app.get('/api/daily', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  const acctId = String(req.query.account || prof.adAccountId || '').replace(/[^0-9]/g, '');
  if (!acctId) return res.status(400).json({ error: 'ไม่ได้ระบุบัญชีโฆษณา' });
  const datePreset = ['today', 'last_7d', 'last_30d', 'last_90d'].includes(req.query.date) ? req.query.date : 'last_7d';
  try {
    const rows = await fbAll(`act_${acctId}/insights`, {
      level: 'account',
      fields: 'spend,impressions,reach',
      time_increment: 1,
      date_preset: datePreset,
      limit: 100,
    }, prof.accessToken);
    res.json({
      account: acctId,
      days: rows.map((r) => ({
        date: r.date_start,
        spend: Number(r.spend) || 0,
        impressions: Number(r.impressions) || 0,
        reach: Number(r.reach) || 0,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// รายละเอียดแคมเปญ: ชุดโฆษณา + โฆษณา พร้อมสถิติ (ดูแบบ Ads Manager)
app.get('/api/campaign-detail', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'campaign id ไม่ถูกต้อง' });
  const token = prof.accessToken;
  const datePreset = ['today', 'last_7d', 'last_30d', 'last_90d', 'maximum'].includes(req.query.date) ? req.query.date : 'maximum';
  try {
    const camp = await fb(id, { fields: 'name,objective' }, 'GET', token);
    const adsets = await fbAll(`${id}/adsets`, { fields: 'name,status,effective_status,daily_budget,promoted_object', limit: 100 }, token);
    const ads = await fbAll(`${id}/ads`, { fields: 'name,status,effective_status,adset_id,creative{thumbnail_url}', limit: 200 }, token);
    let ins = [];
    try {
      ins = await fbAll(`${id}/insights`, {
        level: 'ad', fields: 'ad_id,spend,impressions,reach,actions',
        date_preset: datePreset, limit: 500,
      }, token);
    } catch { /* ไม่มีข้อมูล */ }
    const campEvent = (adsets.find((s) => s.promoted_object && s.promoted_object.custom_event_type) || { promoted_object: {} }).promoted_object.custom_event_type;
    const ra = resultSpec(camp.objective, campEvent);
    const insByAd = Object.fromEntries(ins.map((r) => [r.ad_id, r]));
    const resultOf = (r) => pickResult(ra, r && r.actions);
    const adRows = ads.map((a) => {
      const r = insByAd[a.id] || {};
      return {
        id: a.id, name: a.name, adsetId: a.adset_id,
        status: a.status, effective_status: a.effective_status,
        thumb: (a.creative && a.creative.thumbnail_url) || null,
        spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0,
        results: resultOf(r),
      };
    });
    const asRows = adsets.map((s) => {
      const own = adRows.filter((a) => a.adsetId === s.id);
      return {
        id: s.id, name: s.name, status: s.status, effective_status: s.effective_status,
        dailyBudget: s.daily_budget ? Number(s.daily_budget) / 100 : null,
        spend: own.reduce((x, a) => x + a.spend, 0),
        impressions: own.reduce((x, a) => x + a.impressions, 0),
        results: own.some((a) => a.results != null) ? own.reduce((x, a) => x + (a.results || 0), 0) : null,
        nAds: own.length,
      };
    });
    res.json({ name: camp.name, objective: camp.objective, resultLabel: ra ? ra.label : null, adsets: asRows, ads: adRows, datePreset });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// เปิด/ปิดแคมเปญ (ใช้กับชุดโฆษณาและโฆษณาได้ด้วย — FB ใช้วิธีเดียวกัน)
app.post('/api/campaign-status', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.body.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ไม่พบบัญชี หรือยังไม่ได้เชื่อมต่อ' });
  if (!['ACTIVE', 'PAUSED'].includes(req.body.status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  if (!/^\d+$/.test(String(req.body.id || ''))) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  try {
    await fb(req.body.id, { status: req.body.status }, 'POST', prof.accessToken);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ลบแคมเปญ (FB ใช้วิธีตั้ง status = DELETED — ลบแล้วกู้คืนไม่ได้ แต่สถิติยังดูย้อนหลังได้ใน Ads Manager)
app.post('/api/campaign-delete', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.body.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ไม่พบบัญชี หรือยังไม่ได้เชื่อมต่อ' });
  if (!/^\d+$/.test(String(req.body.id || ''))) return res.status(400).json({ error: 'campaign id ไม่ถูกต้อง' });
  try {
    await fb(req.body.id, { status: 'DELETED' }, 'POST', prof.accessToken);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// เช็คสภาพบัญชีโฆษณา: มีบัตร/วิธีจ่ายเงินไหม + มี Pixel อะไรบ้าง
app.get('/api/account-health', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  const acctId = String(req.query.account || prof.adAccountId || '').replace(/[^0-9]/g, '');
  if (!acctId) return res.status(400).json({ error: 'ไม่ได้ระบุบัญชีโฆษณา' });
  const acct = `act_${acctId}`;
  try {
    const info = await fb(acct, { fields: 'account_status,funding_source,funding_source_details,currency' }, 'GET', prof.accessToken);
    let pixels = [];
    try {
      const px = await fb(`${acct}/adspixels`, { fields: 'id,name,last_fired_time' }, 'GET', prof.accessToken);
      pixels = px.data || [];
    } catch { /* ไม่มีสิทธิ์/ไม่มี pixel */ }
    const fsd = info.funding_source_details || {};
    res.json({
      accountId: acctId,
      currency: info.currency || '',
      accountStatus: info.account_status,
      hasPayment: !!(info.funding_source || fsd.id || fsd.display_string),
      paymentText: fsd.display_string || '',
      pixels,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ภาพรวมสุขภาพ: บัญชีโฆษณา (สถานะ/Pixel/บัตร) + เพจ (เผยแพร่/สิทธิ์ลงโฆษณา) ของ profile เดียว
// promotion_eligible = FB บอกตรงๆ ว่าเพจนี้ใช้ลงโฆษณา/บูสต์ได้ไหม (พิสูจน์กับบัญชีจริงแล้ว: เพจบิน = false)
app.get('/api/health-overview', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  const token = prof.accessToken;
  try {
    const [accts, pages] = await Promise.all([
      fbAll('me/adaccounts', { fields: 'name,account_id,account_status,business{name},funding_source_details,adspixels.limit(15){id,name}', limit: 100 }, token),
      fbAll('me/accounts', { fields: 'name,is_published,promotion_eligible,promotion_ineligible_reason', limit: 100 }, token),
    ]);
    res.json({
      accounts: accts.map((a) => ({
        id: a.account_id, name: a.name, status: a.account_status,
        business: a.business ? a.business.name : null,
        pixels: ((a.adspixels || {}).data || []).map((x) => ({ id: x.id, name: x.name })),
        funding: (a.funding_source_details && (a.funding_source_details.display_string || 'เชื่อมแล้ว')) || null,
      })),
      pages: (pages || []).map((p) => ({
        id: p.id, name: p.name, published: !!p.is_published,
        eligible: !!p.promotion_eligible, reason: p.promotion_ineligible_reason || null,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ก๊อปชุดโฆษณา (พร้อมแอดข้างใน) เป็น PAUSED ในแคมเปญเดิม — ไว้สเกลตัวชนะ
app.post('/api/adset-copy', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.body.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  const id = String(req.body.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'adset id ไม่ถูกต้อง' });
  try {
    const r = await fb(`${id}/copies`, {
      deep_copy: true,
      status_option: 'PAUSED',
      rename_options: { rename_strategy: 'ONLY_TOP_LEVEL_RENAME', rename_suffix: ' - Copy' },
    }, 'POST', prof.accessToken);
    res.json({ ok: true, newId: r.copied_adset_id || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// สร้าง Pixel (Dataset) ใหม่ให้บัญชีโฆษณา
app.post('/api/create-pixel', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.body.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  const acctId = String(req.body.account || prof.adAccountId || '').replace(/[^0-9]/g, '');
  if (!acctId) return res.status(400).json({ error: 'ไม่ได้ระบุบัญชีโฆษณา' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'กรุณาตั้งชื่อ Pixel' });
  try {
    const r = await fb(`act_${acctId}/adspixels`, { name }, 'POST', prof.accessToken);
    res.json({ ok: true, id: r.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/interests', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  try {
    const out = await fb('search', { type: 'adinterest', q: req.query.q || '', limit: 10 }, 'GET', prof.accessToken);
    res.json(out.data || []);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- ขึ้นแอดทั้งชุด — ตอบเป็น NDJSON stream ----------
app.post('/api/launch', upload.any(), async (req, res) => {
  const cfg = loadConfig();
  // header กัน proxy/Traefik สะสม response — ให้ส่งทีละบรรทัดแบบเรียลไทม์
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); if (res.flush) res.flush(); };

  let data;
  try { data = JSON.parse(req.body.data); }
  catch { send({ type: 'fatal', error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' }); return res.end(); }

  const prof = getProfile(cfg, data.profileId);
  if (!prof) { send({ type: 'fatal', error: 'ไม่พบบัญชีที่เลือก (อาจถูกลบไปแล้ว) — รีเฟรชหน้าแล้วลองใหม่' }); return res.end(); }
  // บัญชีโฆษณา: ใช้ที่ระบุมา (ต้นแบบ = ติ๊กหลายบัญชี) หรือ fallback ที่ตั้งไว้ใน profile
  const acctId = String(data.accountId || prof.adAccountId || '').replace(/[^0-9]/g, '');
  const pageId = data.pageId || prof.pageId;
  if (!prof.accessToken || !acctId || !pageId) {
    send({ type: 'fatal', error: `บัญชี "${prof.label}" ตั้งค่าไม่ครบ (token / บัญชีโฆษณา / เพจ)` });
    return res.end();
  }
  // เช็ครูปร่าง payload ก่อนแตะ field ข้างใน — เดิมอ่าน data.campaign.objective ตรงๆ
  // payload เพี้ยนจึงโยน TypeError นอก try → ตอบ 500 กลางสตรีม แทน {type:'fatal'} ที่หน้าเว็บอ่านได้
  if (!data.campaign || !Array.isArray(data.ads) || !data.ads.length) {
    send({ type: 'fatal', error: 'ข้อมูลที่ส่งมาไม่ครบ (ไม่มีแคมเปญหรือรายการแอด) — รีเฟรชหน้าแล้วลองใหม่' });
    return res.end();
  }
  const objInfo = OBJECTIVES[data.campaign.objective];
  if (!objInfo) { send({ type: 'fatal', error: `วัตถุประสงค์ไม่รองรับ: ${data.campaign.objective}` }); return res.end(); }
  if (objInfo.needsPixel && !data.pixelId) { send({ type: 'fatal', error: 'บัญชีนี้ยังไม่มี Pixel (สร้างในเมนูบัญชี FB ก่อน)' }); return res.end(); }

  const status = data.active ? 'ACTIVE' : 'PAUSED';
  const acct = `act_${acctId}`;
  const token = prof.accessToken;
  const files = Object.fromEntries((req.files || []).map((f) => [f.fieldname, f]));
  const imageHashCache = {};
  let aborted = false;
  // ผู้ใช้ปิดแท็บ/ยกเลิก = หยุดสร้างแอดที่เหลือ
  // ห้ามใช้ req.on('close') — ใน Node ใหม่ event นี้ยิงตอนรับ request ครบด้วย (ไม่ใช่แค่ตอนหลุด)
  // ทำให้ aborted=true ทันทีทุกครั้ง → สร้างแคมเปญแล้วข้ามการสร้างแอดทั้งหมด
  res.on('close', () => { if (!res.writableEnded) aborted = true; });

  // รูปเดิมอัปโหลดครั้งเดียว — เก็บเป็น promise กันอัปโหลดซ้ำตอนวิ่งขนานกัน
  function getImageHash(file) {
    const md5 = crypto.createHash('md5').update(file.buffer).digest('hex');
    if (!imageHashCache[md5]) {
      imageHashCache[md5] = fb(`${acct}/adimages`, { bytes: file.buffer.toString('base64') }, 'POST', token)
        .then((r) => Object.values(r.images)[0].hash)
        .catch((e) => { delete imageHashCache[md5]; throw e; });
    }
    return imageHashCache[md5];
  }

  try {
    let campaignId = data.campaignId;
    if (!campaignId) {
      send({ type: 'progress', msg: 'กำลังสร้างแคมเปญ...' });
      const campaignParams = {
        name: data.campaign.name,
        objective: data.campaign.objective,
        status,
        special_ad_categories: [],
      };
      // CBO: ตั้งงบที่ระดับแคมเปญ (FB กระจายให้ชุดโฆษณาเอง)
      if (data.campaignBudget) {
        campaignParams.daily_budget = Math.round(Number(data.campaignBudget) * 100);
        campaignParams.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
      }
      const campaign = await fb(`${acct}/campaigns`, campaignParams, 'POST', token);
      campaignId = campaign.id;
      // กฎหยุดอัตโนมัติบนเซิร์ฟเวอร์ Meta (ทำงานแม้โปรแกรมปิด): ใช้จ่ายเกิน minSpend และ CPA เกิน cpr → pause แคมเปญ
      // ต้องเป็นระดับ CAMPAIGN เท่านั้น (ADSET+เงื่อนไขต้นทุน FB ไม่ให้ใช้กับงบ CBO — พิสูจน์แล้ว), หน่วยเงิน = สตางค์
      if (data.autoRule && Number(data.autoRule.cpr) > 0) {
        try {
          await fb(`${acct}/adrules_library`, {
            name: `หยุดอัตโนมัติ: ${data.campaign.name}`,
            schedule_spec: { schedule_type: 'SEMI_HOURLY' },
            evaluation_spec: {
              evaluation_type: 'SCHEDULE',
              filters: [
                { field: 'entity_type', value: 'CAMPAIGN', operator: 'EQUAL' },
                { field: 'campaign.id', value: [campaignId], operator: 'IN' },
                { field: 'time_preset', value: 'LIFETIME', operator: 'EQUAL' },
                { field: 'spent', value: Math.round(Number(data.autoRule.minSpend || 0) * 100), operator: 'GREATER_THAN' },
                { field: 'cpa', value: Math.round(Number(data.autoRule.cpr) * 100), operator: 'GREATER_THAN' },
              ],
            },
            execution_spec: { execution_type: 'PAUSE' },
          }, 'POST', token);
          send({ type: 'progress', msg: `ตั้งกฎหยุดอัตโนมัติแล้ว (CPA เกิน ${data.autoRule.cpr} บาท หลังใช้เกิน ${data.autoRule.minSpend || 0} บาท)` });
        } catch (e) {
          send({ type: 'warn', index: 0, msg: `ตั้งกฎหยุดอัตโนมัติไม่สำเร็จ (${e.message}) — แอดขึ้นต่อตามปกติ` });
        }
      }
    }
    send({ type: 'campaign', id: campaignId });

    let verifyDone = false;

    const processAd = async (i) => {
      const ad = data.ads[i];
      try {
        if (aborted) throw new Error('ยกเลิกแล้ว');
        let file = files[ad.imageField];
        if (!file && ad.mediaId) {
          const m = resolveMedia(ad.mediaId);
          try { if (m) file = { buffer: fs.readFileSync(m.path), mimetype: m.mimetype, originalname: m.originalname }; }
          catch { /* ไฟล์หาย */ }
          if (!file) throw new Error('ไม่พบไฟล์วิดีโอบนเซิร์ฟเวอร์ (ถูกลบออกจากคลัง หรือ server เพิ่งรีสตาร์ทระหว่างอัป) — เลือกวิดีโอใส่การ์ดนี้ใหม่แล้วกดขึ้นอีกครั้ง');
        }
        if (!file) throw new Error('ไม่ได้แนบไฟล์สื่อ');
        const isVideo = (file.mimetype || '').startsWith('video/');

        // เตรียมสื่อ: รูป = hash, วิดีโอ = อัปโหลด + รอประมวลผล + ดึง thumbnail
        let imageHash = null, videoId = null, videoThumbUrl = null;
        if (isVideo) {
          send({ type: 'status', index: i, msg: 'อัปโหลดวิดีโอ...' });
          videoId = await uploadVideo(acct, file, token);
          await waitVideoReady(videoId, token, () => send({ type: 'status', index: i, msg: 'FB กำลังประมวลผลวิดีโอ...' }));
          videoThumbUrl = await videoThumb(videoId, token);
        } else {
          send({ type: 'status', index: i, msg: 'กำลังสร้าง...' });
          imageHash = await getImageHash(file);
        }

        // targeting ตายตัวตามแบบที่ตั้งไว้ + ค่าที่ปรับได้ (อายุ/เพศ/ประเทศ/ความสนใจ)
        const targeting = {
          geo_locations: { countries: ad.countries },
          age_min: ad.ageMin,
          age_max: ad.ageMax,
          targeting_automation: { advantage_audience: 0 }, // ปิด Advantage+ audience
          publisher_platforms: ['facebook'],               // FB เท่านั้น
          facebook_positions: ['feed', 'profile_feed', 'story', 'facebook_reels'],
          device_platforms: ['mobile'],                    // มือถือเท่านั้น
        };
        targeting.locales = [THAI_LOCALE];                // ภาษาไทย
        if (ad.gender === 'male') targeting.genders = [1];
        if (ad.gender === 'female') targeting.genders = [2];
        if (ad.interests && ad.interests.length) {
          targeting.flexible_spec = [{ interests: ad.interests.map((x) => ({ id: x.id, name: x.name })) }];
        }

        send({ type: 'status', index: i, msg: 'สร้างชุดโฆษณา...' });
        const adsetParams = {
          name: `${ad.name} - Ad Set`,
          campaign_id: campaignId,
          billing_event: 'IMPRESSIONS',
          optimization_goal: objInfo.optimization_goal,
          targeting,
          status,
        };
        // งบอยู่ที่ระดับแคมเปญเสมอ (CBO) — ไม่ต้องตั้งที่ ad set
        // กลยุทธ์วงจรลูกค้า — เลือกจากหน้าเว็บ: '100' = รับทุกกลุ่ม, '0' = หาลูกค้าใหม่, '' = ไม่ส่ง ปล่อยตาม default ของ FB
        const lifecycleStrategy = data.lifecycleStrategy === undefined ? '100' : String(data.lifecycleStrategy);
        if (objInfo.needsPixel) {
          adsetParams.promoted_object = {
            pixel_id: data.pixelId,
            custom_event_type: data.conversionEvent || objInfo.event,
          };
          adsetParams.destination_type = 'WEBSITE';
          if (lifecycleStrategy !== '') adsetParams.existing_customer_budget_percentage = Number(lifecycleStrategy);
        }
        // ผู้ลงโฆษณา = id ธุรกิจที่ยืนยันตัวตนแล้ว (regional_regulation_identities — พิสูจน์แล้วว่า FB บันทึกจริง)
        const beneficiaryId = String(data.beneficiaryId || '').replace(/[^0-9]/g, '');
        if (beneficiaryId) {
          adsetParams.regional_regulation_identities = {
            universal_beneficiary: beneficiaryId,
            universal_payer: beneficiaryId,
          };
        }
        // สร้างชุดโฆษณา — field เสริมตัวไหน FB ไม่รับ ให้ถอดออกแล้วลองใหม่ (ไม่ให้ล้มทั้งแอด)
        let adset;
        for (let tryNo = 0; ; tryNo++) {
          try {
            adset = await fb(`${acct}/adsets`, adsetParams, 'POST', token);
            break;
          } catch (e) {
            const msg = `${e.message} ${e.fbMessage || ''}`; // ข้อความแปลไทย + อังกฤษดิบ — จับ pattern ได้ทั้งคู่
            if (tryNo < 2 && adsetParams.regional_regulation_identities && /regional_regulation|beneficiary|payer|payor/i.test(msg)) {
              send({ type: 'warn', index: i, msg: `FB ไม่ยอมรับผู้ลงโฆษณาของบัญชีนี้ (${e.message}) — ขึ้นต่อโดยไม่ระบุ` });
              delete adsetParams.regional_regulation_identities;
              continue;
            }
            if (tryNo < 2 && adsetParams.existing_customer_budget_percentage !== undefined && /existing_customer|เพดานงบประมาณของลูกค้า/i.test(msg)) {
              send({ type: 'warn', index: i, msg: 'FB ไม่รองรับกลยุทธ์วงจรลูกค้ากับแคมเปญแบบนี้ — ขึ้นต่อโดยไม่ตั้งค่านี้' });
              delete adsetParams.existing_customer_budget_percentage;
              continue;
            }
            throw e;
          }
        }
        // ตรวจค่าจริงจาก FB ครั้งเดียวต่อบัญชี แล้วรายงานให้หน้าเว็บโชว์ (ให้มั่นใจว่าตั้งติดจริง)
        if (!verifyDone) {
          verifyDone = true;
          try {
            const [sent, av] = await Promise.all([
              fb(`${adset.id}/targetingsentencelines`, {}, 'GET', token),
              fb(adset.id, { fields: 'existing_customer_budget_percentage,daily_min_spend_target,daily_spend_cap,regional_regulation_identities' }, 'GET', token),
            ]);
            const langLine = ((sent.targetingsentencelines || []).find((t) => (t.content || '').includes('ภาษา')) || {});
            const lang = (langLine.children || []).join(', ') || 'ทุกภาษา';
            const rri = av.regional_regulation_identities || {};
            const items = [{ ok: /ไทย|Thai/.test(lang), label: `ภาษา: ${lang}` }];
            if (objInfo.needsPixel) {
              items.push(lifecycleStrategy !== ''
                ? {
                    ok: Number(av.existing_customer_budget_percentage) === Number(lifecycleStrategy),
                    label: `กลยุทธ์วงจรลูกค้า: ${lifecycleStrategy === '0' ? 'หาลูกค้าใหม่ (0)' : 'รับคอนเวอร์ชั่นจากกลุ่มเป้าหมายทั้งหมด (100)'}`,
                  }
                : { ok: !av.existing_customer_budget_percentage, label: 'กลยุทธ์วงจรลูกค้า: ไม่ส่งค่า (ตามค่าเริ่มต้นของ FB)' });
            }
            items.push({ ok: !av.daily_min_spend_target && !av.daily_spend_cap, label: 'วงเงินใช้จ่ายชุดโฆษณา: ไม่จำกัด' });
            items.push(beneficiaryId
              ? { ok: String(rri.universal_beneficiary || '') === beneficiaryId, label: `ผู้ลงโฆษณา: ${data.beneficiaryName || beneficiaryId}` }
              : { ok: true, label: 'ผู้ลงโฆษณา: ไม่ระบุ (ตามที่เลือก)' });
            send({ type: 'verify', items });
          } catch { /* ตรวจไม่ได้ก็ข้าม ไม่กระทบการขึ้นแอด */ }
        }

        // ครีเอทีฟ: วิดีโอใช้ video_data, รูปใช้ link_data
        const spec = { page_id: pageId };
        if (isVideo) {
          spec.video_data = {
            video_id: videoId,
            message: ad.message,
            title: ad.headline || undefined,
            call_to_action: { type: data.cta, value: { link: ad.link } },
          };
          if (videoThumbUrl) spec.video_data.image_url = videoThumbUrl;
        } else {
          spec.link_data = {
            link: ad.link,
            message: ad.message,
            name: ad.headline || undefined,
            image_hash: imageHash,
            call_to_action: { type: data.cta, value: { link: ad.link } },
          };
        }
        const creative = await fb(`${acct}/adcreatives`, {
          name: `${ad.name} - Creative`,
          object_story_spec: spec,
        }, 'POST', token);

        const adRes = await fb(`${acct}/ads`, {
          name: ad.name,
          adset_id: adset.id,
          creative: { creative_id: creative.id },
          status,
        }, 'POST', token);

        // จดไว้ว่าวิดีโอตัวนี้ขึ้นบัญชีนี้แล้ว — รอบหน้าตัวจัดแผนจะได้เลี่ยงไปหยิบตัวอื่น
        if (ad.mediaId) markVideoUsed(ad.mediaId, acctId);

        send({ type: 'result', index: i, ok: true, adId: adRes.id, adsetId: adset.id });
      } catch (e) {
        send({ type: 'result', index: i, ok: false, error: e.message });
      }
    };

    // ขึ้นขนานกันทีละ 4 ตัว (มากกว่านี้เสี่ยงชน rate limit ของ FB)
    const CONCURRENCY = 4;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, data.ads.length) }, async () => {
      while (cursor < data.ads.length && !aborted) {
        const i = cursor++;
        await processAd(i);
      }
    }));

    send({ type: 'done', campaignId, account: acct.replace('act_', '') });
  } catch (e) {
    send({ type: 'fatal', error: e.message });
  }
  res.end();
});

// ---------- ระบบเฝ้าระวัง: แจ้งเตือน Telegram + ต่ออายุ token อัตโนมัติ ----------
const WATCH_STATE_PATH = path.join(path.dirname(CONFIG_PATH), 'watch-state.json');
function loadWatchState() { try { return JSON.parse(fs.readFileSync(WATCH_STATE_PATH, 'utf8')); } catch { return {}; } }
function saveWatchState(s) { try { fs.writeFileSync(WATCH_STATE_PATH, JSON.stringify(s)); } catch { /* ข้าม */ } }

async function tgSend(cfg, text) {
  const t = cfg.telegram || {};
  if (!t.botToken || !t.chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${t.botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text, disable_web_page_preview: true }),
    });
    return !!(await r.json()).ok;
  } catch { return false; }
}

const ACCT_ST_TXT = { 2: 'ถูกปิดใช้งาน', 3: 'ค้างชำระ', 7: 'รอตรวจความเสี่ยง', 8: 'รอชำระ', 9: 'ช่วงผ่อนผัน', 100: 'กำลังปิด', 101: 'ปิดแล้ว' };

// รอบตรวจรายชั่วโมง: token ตาย/ใกล้หมด (ต่ออายุให้เอง), บัญชีเปลี่ยนสถานะ, แอดโดนปฏิเสธเพิ่ม
async function watchTick() {
  const cfg = loadConfig();
  const state = loadWatchState();
  const alerts = [];
  for (const prof of cfg.profiles || []) {
    if (!prof.accessToken) continue;
    // 1) token ยังใช้ได้ไหม
    try { await fb('me', { fields: 'id' }, 'GET', prof.accessToken); state['tok:' + prof.id] = 'ok'; }
    catch (e) {
      if (state['tok:' + prof.id] !== 'bad') { alerts.push(`🔴 ${prof.label}: เชื่อม FB ไม่ได้ — ${e.message}`); state['tok:' + prof.id] = 'bad'; }
      continue; // token ตาย ตรวจอย่างอื่นต่อไม่ได้
    }
    // 2) ใกล้หมดอายุ (<14 วัน) → ต่ออายุอัตโนมัติ (ต้องมี appId+appSecret ของโปรไฟล์)
    if (prof.appId && prof.appSecret) {
      try {
        const appTok = `${prof.appId}|${prof.appSecret}`;
        const dbg = await (await fetch(`${API}/debug_token?input_token=${encodeURIComponent(prof.accessToken)}&access_token=${encodeURIComponent(appTok)}`)).json();
        const exp = dbg.data && dbg.data.expires_at; // 0 = ไม่หมดอายุ
        if (exp && exp * 1000 - Date.now() < 14 * 864e5) {
          const l = await (await fetch(`${API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(prof.appId)}&client_secret=${encodeURIComponent(prof.appSecret)}&fb_exchange_token=${encodeURIComponent(prof.accessToken)}`)).json();
          if (l.access_token) {
            const cfg2 = loadConfig(); // โหลดสดกันทับค่าที่เพิ่งแก้ระหว่างรอบ
            const p2 = cfg2.profiles.find((x) => x.id === prof.id);
            if (p2) { p2.accessToken = l.access_token; saveConfig(cfg2); alerts.push(`🔁 ${prof.label}: ต่ออายุ token ให้แล้ว (+60 วัน)`); }
          } else if (state['exp:' + prof.id] !== 'warned') {
            alerts.push(`🟠 ${prof.label}: token จะหมดอายุใน ${Math.max(1, Math.round((exp * 1000 - Date.now()) / 864e5))} วัน และต่ออัตโนมัติไม่ได้ — เข้าเว็บแล้วกดล็อกอินใหม่`);
            state['exp:' + prof.id] = 'warned';
          }
        } else state['exp:' + prof.id] = '';
      } catch { /* ตรวจอายุไม่ได้ก็ข้าม */ }
    }
    // 3) สถานะบัญชีโฆษณาเปลี่ยน + แอดโดนปฏิเสธเพิ่ม
    try {
      const accts = await fbAll('me/adaccounts', { fields: 'name,account_id,account_status', limit: 100 }, prof.accessToken);
      for (const a of accts) {
        const k = 'st:' + a.account_id;
        if (state[k] !== undefined && state[k] !== a.account_status && a.account_status !== 1) {
          alerts.push(`⚠️ บัญชี ${a.name}: ${ACCT_ST_TXT[a.account_status] || 'สถานะ ' + a.account_status}`);
        }
        if (state[k] !== undefined && state[k] !== 1 && a.account_status === 1) alerts.push(`🟢 บัญชี ${a.name}: กลับมาใช้ได้แล้ว`);
        state[k] = a.account_status;
      }
      for (const a of accts.filter((x) => x.account_status === 1)) {
        try {
          const ads = await fbAll(`act_${a.account_id}/ads`, { fields: 'effective_status', limit: 200 }, prof.accessToken);
          const n = ads.filter((x) => x.effective_status === 'DISAPPROVED').length;
          const k = 'dis:' + a.account_id;
          if (state[k] !== undefined && n > state[k]) alerts.push(`✕ ${a.name}: แอดโดนปฏิเสธเพิ่ม ${n - state[k]} ตัว (รวม ${n})`);
          state[k] = n;
        } catch { /* บัญชีนี้อ่านไม่ได้ ข้าม */ }
      }
    } catch { /* ข้ามรอบนี้ */ }
  }
  saveWatchState(state);
  if (alerts.length) await tgSend(cfg, '📣 FB Ad Uploader แจ้งเตือน\n\n' + alerts.join('\n'));
}

// ================= AUTOPILOT: จัดการแอดโดนปฏิเสธเอง =================
// หลักการ: แก้ที่เหตุ ไม่ใช่ยิงซ้ำ — อ่านเหตุผลจริงจาก FB, ให้ Claude ชี้ว่าผิดข้อไหน,
// แก้ได้เฉพาะที่ข้อความเท่านั้น และแก้ได้ครั้งเดียวต่อครีเอทีฟตลอดชีพ
// ยิงซ้ำจนหลุดคือทางที่ทำให้บัญชีโดนแบน ระบบนี้จงใจไม่รองรับ
const AP_PATH = path.join(path.dirname(CONFIG_PATH), 'autopilot-state.json');
const AP_MAX_FIX_PER_DAY = 10;      // เพดานการแก้อัตโนมัติทั้งระบบต่อวัน
const AP_FREEZE_REJECTIONS = 3;     // โดนปฏิเสธกี่ตัวใน 24 ชม. ถึงหยุดบัญชีนั้น
const AP_LOG_MAX = 200;

function loadAp() {
  try {
    const s = JSON.parse(fs.readFileSync(AP_PATH, 'utf8'));
    return { frozen: {}, handled: {}, retryOf: {}, rejections: {}, fixes: [], log: [], baselined: {}, ...s };
  } catch {
    return { frozen: {}, handled: {}, retryOf: {}, rejections: {}, fixes: [], log: [], baselined: {} };
  }
}
function saveAp(s) { try { fs.writeFileSync(AP_PATH, JSON.stringify(s)); } catch { /* ข้าม */ } }
function apLog(s, level, msg, acct) {
  s.log.unshift({ ts: Date.now(), level, msg, acct: acct || null });
  if (s.log.length > AP_LOG_MAX) s.log.length = AP_LOG_MAX;
}
const apRecent = (arr, ms) => (arr || []).filter((t) => Date.now() - t < ms);

const REJECT_SCHEMA = {
  type: 'object',
  properties: {
    where: { type: 'string', enum: ['text', 'video', 'landing_page', 'account', 'unclear'] },
    violation: { type: 'string', description: 'อธิบายเป็นภาษาไทยว่าอะไรในแอดที่ผิดนโยบายข้อนี้ อ้างข้อความจริงที่มีปัญหา' },
    fixable: { type: 'boolean', description: 'true เฉพาะเมื่อระบุได้ชัดว่าข้อความส่วนไหนผิด และแก้ที่ข้อความแล้วจะผ่านได้' },
    newMessage: { type: ['string', 'null'], description: 'ข้อความหลักที่แก้แล้ว (null ถ้า fixable=false)' },
    newHeadline: { type: ['string', 'null'], description: 'หัวข้อที่แก้แล้ว (null ถ้าไม่ต้องแก้)' },
  },
  required: ['where', 'violation', 'fixable', 'newMessage', 'newHeadline'],
  additionalProperties: false,
};

const REJECT_SYSTEM = `คุณคือผู้เชี่ยวชาญนโยบายโฆษณา Facebook หน้าที่คือดูว่าแอดโดนปฏิเสธเพราะอะไร และแก้ได้ไหม

ตัดสินว่าปัญหาอยู่ที่ไหน:
- text = ข้อความในแอด (เคลมเกินจริง, เคลมทางการแพทย์, พาดพิงเรื่องส่วนตัว, before/after, คำต้องห้าม)
- video = ตัววิดีโอเอง (ภาพ, เสียง, ตัวหนังสือในคลิป)
- landing_page = ปลายทางลิงก์
- account = ปัญหาระดับบัญชี/เพจ ไม่เกี่ยวกับแอดตัวนี้
- unclear = เหตุผลกำกวมเกินกว่าจะระบุ

กฎเหล็ก:
- fixable=true ได้เฉพาะเมื่อ where=text และคุณชี้ได้ชัดว่าประโยคไหนผิดข้อไหน
- ถ้าไม่แน่ใจว่าอะไรผิด ต้องตอบ fixable=false เสมอ ห้ามเดา
- ห้ามแก้ด้วยการเลี่ยงคำ สลับคำ หรือเขียนอ้อมให้ระบบตรวจจับไม่ได้ — ต้องเอาข้อความที่ผิดจริงออก
- ถ้าสิ่งที่โฆษณาผิดนโยบายโดยเนื้อหา (ไม่ใช่แค่วิธีเขียน) ต้องตอบ fixable=false
- ข้อความใหม่ต้องสื่อสารสิ่งเดียวกันแบบที่ไม่ผิดนโยบาย ถ้าทำไม่ได้ให้ fixable=false
- เขียนเป็นภาษาไทย`;

async function aiDiagnoseRejection(apiKey, info) {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: REJECT_SCHEMA } },
    system: REJECT_SYSTEM,
    messages: [{
      role: 'user',
      content: `แอดนี้โดน Facebook ปฏิเสธ

นโยบายที่อ้าง: ${info.policy || 'ไม่ระบุ'}
คำอธิบายจาก FB: ${info.reason || 'ไม่ระบุ'}

ข้อความหลักในแอด:
"""${info.message || '(ไม่มี)'}"""

หัวข้อ: "${info.headline || '(ไม่มี)'}"`,
    }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('AI ปฏิเสธการวิเคราะห์เคสนี้');
  const b = msg.content.find((x) => x.type === 'text');
  if (!b) throw new Error('AI ตอบว่าง');
  return JSON.parse(b.text);
}

// สร้างแอดใหม่จากครีเอทีฟเดิม เปลี่ยนแค่ข้อความ
async function apResubmit(acct, token, origCreative, adsetId, adName, newMessage, newHeadline) {
  const spec = JSON.parse(JSON.stringify(origCreative.object_story_spec || {}));
  if (spec.video_data) {
    spec.video_data.message = newMessage;
    if (newHeadline) spec.video_data.title = newHeadline;
  } else if (spec.link_data) {
    spec.link_data.message = newMessage;
    if (newHeadline) spec.link_data.name = newHeadline;
  } else {
    throw new Error('ครีเอทีฟรูปแบบนี้ยังแก้อัตโนมัติไม่ได้');
  }
  const creative = await fb(`${acct}/adcreatives`, {
    name: `${adName} (แก้ข้อความ) - Creative`, object_story_spec: spec,
  }, 'POST', token);
  const ad = await fb(`${acct}/ads`, {
    name: `${adName} (แก้ข้อความ)`.slice(0, 100),
    adset_id: adsetId,
    creative: { creative_id: creative.id },
    status: 'ACTIVE',
  }, 'POST', token);
  return ad.id;
}

async function autopilotTick() {
  const cfg = loadConfig();
  const ap = cfg.autopilot || {};
  if (!ap.enabled) return;

  const s = loadAp();
  if (s.killSwitch) return;

  const apiKey = cfg.anthropicKey || process.env.ANTHROPIC_API_KEY;
  const alerts = [];
  s.fixes = apRecent(s.fixes, 24 * 3600 * 1000);

  for (const prof of cfg.profiles || []) {
    if (!prof.accessToken) continue;
    let accts = [];
    try { accts = await fbAll('me/adaccounts', { fields: 'name,account_id,account_status', limit: 100 }, prof.accessToken); }
    catch { continue; }

    for (const a of accts.filter((x) => x.account_status === 1)) {
      const acctId = a.account_id;
      const acct = `act_${acctId}`;
      if (s.frozen[acctId]) continue;

      let ads = [];
      try {
        ads = await fbAll(`${acct}/ads`, {
          fields: 'id,name,effective_status,adset_id,issues_info,creative{id,object_story_spec}',
          limit: 200,
        }, prof.accessToken);
      } catch { continue; }

      const rejected = ads.filter((x) => x.effective_status === 'DISAPPROVED');

      // รอบแรกของบัญชีนี้ = จดไว้เฉยๆ ไม่ลงมือ กันไปไล่แก้ของเก่าที่ค้างมานานรวดเดียว
      if (!s.baselined[acctId]) {
        rejected.forEach((x) => { s.handled[x.id] = 'baseline'; });
        s.baselined[acctId] = Date.now();
        apLog(s, 'info', `เริ่มเฝ้า ${a.name} — แอดที่โดนปฏิเสธอยู่ก่อนแล้ว ${rejected.length} ตัว จะไม่แตะ`, acctId);
        continue;
      }

      for (const ad of rejected) {
        if (s.handled[ad.id]) continue;

        // นับการโดนปฏิเสธ → ถึงเพดานเมื่อไหร่หยุดทั้งบัญชี (ตัวป้องกันบัญชีโดนแบน)
        s.rejections[acctId] = apRecent(s.rejections[acctId], 24 * 3600 * 1000).concat(Date.now());
        if (s.rejections[acctId].length >= AP_FREEZE_REJECTIONS) {
          s.frozen[acctId] = { since: Date.now(), reason: `โดนปฏิเสธ ${s.rejections[acctId].length} ตัวใน 24 ชม.` };
          s.handled[ad.id] = 'frozen';
          const m = `🧊 หยุดระบบอัตโนมัติของบัญชี ${a.name} — โดนปฏิเสธ ${s.rejections[acctId].length} ตัวใน 24 ชม. เสี่ยงโดนแบน เข้าไปดูเองก่อนแล้วค่อยปลดล็อกในเว็บ`;
          alerts.push(m); apLog(s, 'freeze', m, acctId);
          break;
        }

        // ตัวที่เกิดจากการแก้อัตโนมัติแล้วยังโดนอีก = ตายถาวร ห้ามแตะต่อ
        if (s.retryOf[ad.id]) {
          s.handled[ad.id] = 'dead-after-retry';
          const m = `⛔ ${a.name}: "${ad.name}" แก้ข้อความไปแล้วยังโดนปฏิเสธอีก — หยุดถาวร ไม่ลองต่อ`;
          alerts.push(m); apLog(s, 'dead', m, acctId);
          continue;
        }

        const issue = (ad.issues_info || [])[0] || {};
        const spec = (ad.creative || {}).object_story_spec || {};
        const vd = spec.video_data || spec.link_data || {};
        const curMsg = vd.message || '';
        const curHead = vd.title || vd.name || '';

        if (!apiKey) {
          s.handled[ad.id] = 'no-key';
          const m = `✕ ${a.name}: "${ad.name}" โดนปฏิเสธ (${issue.error_summary || 'ไม่ระบุ'}) — ยังไม่ได้ใส่ Anthropic key เลยวินิจฉัยไม่ได้`;
          alerts.push(m); apLog(s, 'warn', m, acctId);
          continue;
        }
        if (s.fixes.length >= AP_MAX_FIX_PER_DAY) {
          s.handled[ad.id] = 'cap';
          const m = `✋ ${a.name}: "${ad.name}" โดนปฏิเสธ แต่วันนี้แก้อัตโนมัติครบ ${AP_MAX_FIX_PER_DAY} ครั้งแล้ว — รอคุณจัดการเอง`;
          alerts.push(m); apLog(s, 'warn', m, acctId);
          continue;
        }

        let dx;
        try {
          dx = await aiDiagnoseRejection(apiKey, {
            policy: issue.error_summary, reason: issue.error_message, message: curMsg, headline: curHead,
          });
        } catch (e) {
          s.handled[ad.id] = 'diag-failed';
          const m = `⚠️ ${a.name}: "${ad.name}" โดนปฏิเสธ แต่วินิจฉัยไม่สำเร็จ (${e.message})`;
          alerts.push(m); apLog(s, 'warn', m, acctId);
          continue;
        }

        if (!dx.fixable || dx.where !== 'text' || !dx.newMessage) {
          s.handled[ad.id] = 'not-fixable';
          const where = { video: 'ตัววิดีโอ', landing_page: 'หน้าปลายทาง', account: 'ระดับบัญชี/เพจ', unclear: 'ไม่ชัดเจน', text: 'ข้อความ' }[dx.where] || dx.where;
          const m = `✕ ${a.name}: "${ad.name}" โดนปฏิเสธ — แก้อัตโนมัติไม่ได้ (ปัญหาอยู่ที่${where})\n   ${dx.violation}`;
          alerts.push(m); apLog(s, 'manual', m, acctId);
          continue;
        }

        try {
          const newId = await apResubmit(acct, prof.accessToken, ad.creative, ad.adset_id, ad.name, dx.newMessage, dx.newHeadline);
          s.handled[ad.id] = 'fixed';
          s.retryOf[newId] = ad.id;
          s.fixes.push(Date.now());
          const m = `🔧 ${a.name}: "${ad.name}" โดนปฏิเสธเพราะ ${dx.violation}\n   → แก้ข้อความแล้วขึ้นใหม่ให้ (ครั้งเดียว ถ้าโดนอีกจะหยุดถาวร)\n   ข้อความใหม่: ${dx.newMessage.slice(0, 150)}`;
          alerts.push(m); apLog(s, 'fixed', m, acctId);
        } catch (e) {
          s.handled[ad.id] = 'resubmit-failed';
          const m = `⚠️ ${a.name}: "${ad.name}" แก้ข้อความได้แต่สร้างแอดใหม่ไม่สำเร็จ (${e.message})`;
          alerts.push(m); apLog(s, 'warn', m, acctId);
        }
      }
    }
  }

  saveAp(s);
  if (alerts.length) await tgSend(cfg, '🤖 ระบบอัตโนมัติ\n\n' + alerts.join('\n\n'));
}

app.get('/api/autopilot', (req, res) => {
  const cfg = loadConfig();
  const s = loadAp();
  res.json({
    enabled: !!(cfg.autopilot || {}).enabled,
    killSwitch: !!s.killSwitch,
    frozen: s.frozen,
    fixesToday: apRecent(s.fixes, 24 * 3600 * 1000).length,
    maxPerDay: AP_MAX_FIX_PER_DAY,
    log: s.log.slice(0, 60),
  });
});
app.post('/api/autopilot', (req, res) => {
  const cfg = loadConfig();
  cfg.autopilot = { ...(cfg.autopilot || {}), enabled: !!req.body.enabled };
  saveConfig(cfg);
  const s = loadAp();
  if (typeof req.body.killSwitch === 'boolean') s.killSwitch = req.body.killSwitch;
  apLog(s, 'info', req.body.killSwitch ? '🛑 กดหยุดฉุกเฉิน' : (cfg.autopilot.enabled ? '▶️ เปิดระบบอัตโนมัติ' : '⏸️ ปิดระบบอัตโนมัติ'));
  saveAp(s);
  res.json({ ok: true, enabled: cfg.autopilot.enabled, killSwitch: s.killSwitch });
});
// สั่งตรวจทันที ไม่ต้องรอครบ 30 นาที
let apRunning = false;
app.post('/api/autopilot/run', async (req, res) => {
  if (apRunning) return res.status(409).json({ error: 'กำลังตรวจอยู่ รอรอบนี้จบก่อน' });
  if (!(loadConfig().autopilot || {}).enabled) return res.status(400).json({ error: 'ยังไม่ได้เปิดระบบอัตโนมัติ' });
  apRunning = true;
  try {
    await autopilotTick();
    res.json({ ok: true, log: loadAp().log.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally { apRunning = false; }
});

app.post('/api/autopilot/unfreeze', (req, res) => {
  const s = loadAp();
  const id = String(req.body.acctId || '');
  if (!s.frozen[id]) return res.status(404).json({ error: 'บัญชีนี้ไม่ได้ถูกหยุดอยู่' });
  delete s.frozen[id];
  s.rejections[id] = [];
  apLog(s, 'info', `ปลดล็อกบัญชี ${id} ด้วยมือ`, id);
  saveAp(s);
  res.json({ ok: true });
});

setInterval(() => autopilotTick().catch(() => {}), 30 * 60 * 1000).unref();

// สรุปยอดเมื่อวานทุกเช้า 08:00 เวลาไทย
async function dailySummary() {
  const cfg = loadConfig();
  if (!(cfg.telegram || {}).botToken) return;
  const lines = [];
  for (const prof of cfg.profiles || []) {
    if (!prof.accessToken) continue;
    try {
      const accts = await fbAll('me/adaccounts', { fields: 'name,account_id,account_status,currency', limit: 100 }, prof.accessToken);
      for (const a of accts.filter((x) => x.account_status === 1)) {
        try {
          const ins = await fb(`act_${a.account_id}/insights`, { fields: 'spend,impressions', date_preset: 'yesterday' }, 'GET', prof.accessToken);
          const row = (ins.data || [])[0];
          if (row && Number(row.spend) > 0) lines.push(`• ${a.name}: ${Number(row.spend).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${a.currency} • ${Number(row.impressions || 0).toLocaleString()} อิมเพรสชัน`);
        } catch { /* ข้าม */ }
      }
    } catch { /* ข้าม */ }
  }
  await tgSend(cfg, `🌅 สรุปการใช้จ่ายเมื่อวาน\n\n${lines.length ? lines.join('\n') : 'ไม่มีการใช้จ่าย'}`);
}

setTimeout(() => watchTick().catch(() => {}), 30 * 1000);           // รอบแรกหลังบูต 30 วิ
setInterval(() => watchTick().catch(() => {}), 60 * 60 * 1000);     // แล้วทุก 1 ชม.
setInterval(() => {
  const th = new Date(Date.now() + 7 * 3600 * 1000);
  const day = th.toISOString().slice(0, 10);
  if (th.getUTCHours() !== 8) return;
  // จำวันที่ส่งล่าสุดลงไฟล์ ไม่ใช่ตัวแปรในหน่วยความจำ — restart ช่วง 8-9 โมงจะได้ไม่ส่งสรุปซ้ำ
  const st = loadWatchState();
  if (st.lastSummaryDay === day) return;
  st.lastSummaryDay = day;
  saveWatchState(st);
  dailySummary().catch(() => {});
}, 5 * 60 * 1000);

// ตั้งค่า Telegram จากหน้าเว็บ
app.get('/api/telegram', (req, res) => {
  const t = loadConfig().telegram || {};
  res.json({ hasToken: !!t.botToken, botTokenMasked: t.botToken ? '••••••' + String(t.botToken).slice(-4) : '', chatId: t.chatId || '' });
});
app.post('/api/telegram', (req, res) => {
  const cfg = loadConfig();
  const cur = cfg.telegram || {};
  let botToken = String(req.body.botToken || '').trim();
  if (!botToken || botToken.startsWith('••••')) botToken = cur.botToken || ''; // ช่องโชว์ masked = ไม่เปลี่ยน
  cfg.telegram = { botToken, chatId: String(req.body.chatId || '').trim() };
  saveConfig(cfg);
  res.json({ ok: true });
});
app.post('/api/telegram-test', async (req, res) => {
  const ok = await tgSend(loadConfig(), '✅ ทดสอบแจ้งเตือนจาก FB Ad Uploader สำเร็จ! ระบบจะเตือนเมื่อ: แอดโดนปฏิเสธ • บัญชีถูกปิด/ค้างชำระ • token มีปัญหา และสรุปยอดทุกเช้า 8 โมง');
  res.json(ok ? { ok: true } : { error: 'ส่งไม่สำเร็จ — เช็ค Bot Token / Chat ID และต้องกด Start ในแชทบอทของคุณก่อน' });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  FB Ad Uploader พร้อมใช้งานแล้ว!');
  console.log(`  เปิดเบราว์เซอร์ที่ ->  http://localhost:${PORT}`);
  console.log('');
});
