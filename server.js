const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const API = 'https://graph.facebook.com/v23.0';
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

function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { cfg = {}; }
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
  const res = await fetch(url, opts);
  const json = await res.json();
  if (json.error) {
    const e = json.error;
    if (THROTTLE_CODES.has(e.code) && attempt < 2) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 20000));
      return fb(pathname, params, method, token, attempt + 1);
    }
    throw new Error(e.error_user_msg || e.message || 'FB API error');
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
async function uploadVideo(acct, file, token) {
  const form = new FormData();
  form.append('access_token', token);
  form.append('source', new Blob([file.buffer], { type: file.mimetype || 'video/mp4' }), file.originalname || 'video.mp4');
  const res = await fetch(`${API}/${acct}/advideos`, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(json.error.error_user_msg || json.error.message);
  return json.id;
}
// วิดีโอต้องประมวลผลก่อนใช้ — วนเช็คสถานะจน ready (สูงสุด ~3 นาที)
async function waitVideoReady(videoId, token, onTick) {
  for (let i = 0; i < 36; i++) {
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

// locale id ของภาษาไทยใน FB targeting (cache ไว้ใช้ซ้ำ)
let thaiLocaleId = null;
async function getThaiLocale(token) {
  if (thaiLocaleId !== null) return thaiLocaleId;
  try {
    const r = await fb('search', { type: 'adlocale', q: 'Thai', limit: 25 }, 'GET', token);
    const hit = (r.data || []).find((x) => /^thai$/i.test(x.name) || x.key === 'th_TH');
    thaiLocaleId = hit ? hit.key : 0;
  } catch { thaiLocaleId = 0; }
  return thaiLocaleId;
}

const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;
const LOGIN_SCOPES = 'ads_management,ads_read,business_management,pages_show_list,pages_read_engagement';

const OBJECTIVES = {
  OUTCOME_TRAFFIC: { optimization_goal: 'LINK_CLICKS' },
  OUTCOME_ENGAGEMENT: { optimization_goal: 'POST_ENGAGEMENT' },
  OUTCOME_SALES: { optimization_goal: 'OFFSITE_CONVERSIONS', event: 'PURCHASE', needsPixel: true },
  OUTCOME_LEADS: { optimization_goal: 'OFFSITE_CONVERSIONS', event: 'LEAD', needsPixel: true },
};

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
  for (const k of ['label', 'accessToken', 'adAccountId', 'pageId', 'appId', 'appSecret']) {
    if (req.body[k] !== undefined && req.body[k] !== '') p[k] = req.body[k];
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
    prof.accessToken = l.access_token || s.access_token;
    saveConfig(cfg);
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
      ? 'name,account_id,currency,account_status,business{id,name},funding_source_details,adspixels.limit(15){id,name,last_fired_time}'
      : 'name,account_id,currency,account_status,business{id,name}';
    const adAccounts = await fbAll('me/adaccounts', { fields: acctFields, limit: 100 }, prof.accessToken);
    const pages = await fb('me/accounts', { fields: 'name,id', limit: 200 }, 'GET', prof.accessToken);
    const accounts = adAccounts.map((a) => {
      const out = {
        name: a.name, account_id: a.account_id, currency: a.currency,
        account_status: a.account_status, business: a.business || null,
      };
      if (full) {
        const fsd = a.funding_source_details || {};
        out.hasPayment = !!(fsd.id || fsd.display_string);
        out.pixels = (a.adspixels && a.adspixels.data) ? a.adspixels.data : [];
      }
      return out;
    });
    res.json({ name: me.name, adAccounts: accounts, pages: pages.data || [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// map objective -> action_type ที่นับเป็น "ผลลัพธ์" ใน Ads Manager
const RESULT_ACTION = {
  OUTCOME_TRAFFIC: { type: 'link_click', label: 'คลิกลิงก์' },
  OUTCOME_ENGAGEMENT: { type: 'post_engagement', label: 'การมีส่วนร่วม' },
  OUTCOME_SALES: { type: 'offsite_conversion.fb_pixel_purchase', label: 'การซื้อ' },
  OUTCOME_LEADS: { type: 'offsite_conversion.fb_pixel_lead', label: 'ลูกค้าเป้าหมาย' },
};

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

    // งบรวมจาก ad set (กรณีตั้งงบระดับ ad set ไม่ใช่ระดับแคมเปญ)
    const adsetBudget = {};
    try {
      const as = await fbAll(`${acct}/adsets`, { fields: 'campaign_id,daily_budget', limit: 200 }, token);
      for (const s of as) {
        if (s.daily_budget) adsetBudget[s.campaign_id] = (adsetBudget[s.campaign_id] || 0) + Number(s.daily_budget);
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
      const ra = RESULT_ACTION[c.objective];
      let results = null;
      if (ra && Array.isArray(ins.actions)) {
        const hit = ins.actions.find((a) => a.action_type === ra.type);
        if (hit) results = Number(hit.value);
      }
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

// เปิด/ปิดแคมเปญ
app.post('/api/campaign-status', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.body.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ไม่พบบัญชี หรือยังไม่ได้เชื่อมต่อ' });
  if (!['ACTIVE', 'PAUSED'].includes(req.body.status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
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
  const objInfo = OBJECTIVES[data.campaign.objective];
  if (!objInfo) { send({ type: 'fatal', error: `วัตถุประสงค์ไม่รองรับ: ${data.campaign.objective}` }); return res.end(); }
  if (objInfo.needsPixel && !data.pixelId) { send({ type: 'fatal', error: 'บัญชีนี้ยังไม่มี Pixel (สร้างในเมนูบัญชี FB ก่อน)' }); return res.end(); }

  const status = data.active ? 'ACTIVE' : 'PAUSED';
  const acct = `act_${acctId}`;
  const token = prof.accessToken;
  const files = Object.fromEntries((req.files || []).map((f) => [f.fieldname, f]));
  const imageHashCache = {};
  let aborted = false;
  req.on('close', () => { aborted = true; }); // ผู้ใช้ปิดแท็บ/ยกเลิก = หยุดสร้างแอดที่เหลือ

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
    }
    send({ type: 'campaign', id: campaignId });
    const thaiLocale = await getThaiLocale(token);

    const processAd = async (i) => {
      const ad = data.ads[i];
      try {
        if (aborted) throw new Error('ยกเลิกแล้ว');
        const file = files[ad.imageField];
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
        if (thaiLocale) targeting.locales = [thaiLocale];  // ภาษาไทย
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
        // ABO: ไม่มี campaignBudget → ตั้งงบที่ ad set. CBO: งบอยู่ที่แคมเปญแล้ว ไม่ต้องใส่
        if (!data.campaignBudget) {
          adsetParams.daily_budget = Math.round(Number(ad.dailyBudget) * 100);
          adsetParams.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
        }
        if (objInfo.needsPixel) {
          adsetParams.promoted_object = {
            pixel_id: data.pixelId,
            custom_event_type: data.conversionEvent || objInfo.event,
          };
          adsetParams.destination_type = 'WEBSITE';
        }
        const adset = await fb(`${acct}/adsets`, adsetParams, 'POST', token);

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

app.listen(PORT, () => {
  console.log('');
  console.log('  FB Ad Uploader พร้อมใช้งานแล้ว!');
  console.log(`  เปิดเบราว์เซอร์ที่ ->  http://localhost:${PORT}`);
  console.log('');
});
