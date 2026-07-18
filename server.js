const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const API = 'https://graph.facebook.com/v23.0';
const PORT = process.env.PORT || 4000;
// URL สาธารณะของแอป (ตั้งผ่าน env ตอน deploy) — ใช้สร้าง redirect URI ของ OAuth
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

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
  return cfg.profiles.find((p) => p.id === id)
    || cfg.profiles.find((p) => p.id === cfg.activeProfileId)
    || cfg.profiles[0];
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

// เรียก Graph API — โยน Error พร้อมข้อความจาก FB ถ้าพลาด
async function fb(pathname, params, method, token) {
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
    throw new Error(e.error_user_msg || e.message || 'FB API error');
  }
  return json;
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
    const adAccounts = await fb('me/adaccounts', { fields: 'name,account_id,currency,account_status', limit: 200 }, 'GET', prof.accessToken);
    const pages = await fb('me/accounts', { fields: 'name,id', limit: 200 }, 'GET', prof.accessToken);
    res.json({ name: me.name, adAccounts: adAccounts.data || [], pages: pages.data || [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// รายการแคมเปญล่าสุดในบัญชี (โชว์ในหน้า "แคมเปญของฉัน")
app.get('/api/campaigns', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.query.profile);
  if (!prof || !prof.accessToken) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อบัญชี' });
  if (!prof.adAccountId) return res.status(400).json({ error: `บัญชี "${prof.label}" ยังไม่ได้เลือกบัญชีโฆษณา` });
  const acct = `act_${String(prof.adAccountId).replace(/^act_/, '')}`;
  try {
    const out = await fb(`${acct}/campaigns`, {
      fields: 'name,objective,status,effective_status,created_time',
      limit: 25,
    }, 'GET', prof.accessToken);
    res.json({ campaigns: out.data || [], account: acct.replace('act_', '') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// เปิด/ปิดแคมเปญ
app.post('/api/campaign-status', async (req, res) => {
  const cfg = loadConfig();
  const prof = getProfile(cfg, req.body.profile);
  try {
    await fb(req.body.id, { status: req.body.status }, 'POST', prof.accessToken);
    res.json({ ok: true });
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
  res.setHeader('Content-Type', 'application/x-ndjson');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  const data = JSON.parse(req.body.data);
  const prof = getProfile(cfg, data.profileId);
  if (!prof || !prof.accessToken || !prof.adAccountId || !prof.pageId) {
    send({ type: 'fatal', error: `บัญชี "${prof ? prof.label : '?'}" ตั้งค่าไม่ครบ (token / บัญชีโฆษณา / เพจ)` });
    return res.end();
  }

  const status = data.active ? 'ACTIVE' : 'PAUSED';
  const acct = `act_${String(prof.adAccountId).replace(/^act_/, '')}`;
  const token = prof.accessToken;
  const files = Object.fromEntries((req.files || []).map((f) => [f.fieldname, f]));
  const objInfo = OBJECTIVES[data.campaign.objective];
  const imageHashCache = {};

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
      const campaign = await fb(`${acct}/campaigns`, {
        name: data.campaign.name,
        objective: data.campaign.objective,
        status,
        special_ad_categories: [],
      }, 'POST', token);
      campaignId = campaign.id;
    }
    send({ type: 'campaign', id: campaignId });

    const processAd = async (i) => {
      const ad = data.ads[i];
      try {
        send({ type: 'status', index: i, msg: 'กำลังสร้าง...' });

        const file = files[ad.imageField];
        if (!file) throw new Error('ไม่ได้แนบรูปภาพ');
        const imageHash = await getImageHash(file);

        const targeting = {
          geo_locations: { countries: ad.countries },
          age_min: ad.ageMin,
          age_max: ad.ageMax,
          targeting_automation: { advantage_audience: 0 },
        };
        if (ad.gender === 'male') targeting.genders = [1];
        if (ad.gender === 'female') targeting.genders = [2];
        if (ad.interests && ad.interests.length) {
          targeting.flexible_spec = [{ interests: ad.interests.map((x) => ({ id: x.id, name: x.name })) }];
        }

        const adsetParams = {
          name: `${ad.name} - Ad Set`,
          campaign_id: campaignId,
          daily_budget: Math.round(Number(ad.dailyBudget) * 100),
          billing_event: 'IMPRESSIONS',
          optimization_goal: objInfo.optimization_goal,
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          targeting,
          status,
        };
        if (objInfo.needsPixel) {
          adsetParams.promoted_object = { pixel_id: data.pixelId, custom_event_type: objInfo.event };
        }
        const adset = await fb(`${acct}/adsets`, adsetParams, 'POST', token);

        const creative = await fb(`${acct}/adcreatives`, {
          name: `${ad.name} - Creative`,
          object_story_spec: {
            page_id: prof.pageId,
            link_data: {
              link: ad.link,
              message: ad.message,
              name: ad.headline || undefined,
              image_hash: imageHash,
              call_to_action: { type: data.cta, value: { link: ad.link } },
            },
          },
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
      while (cursor < data.ads.length) {
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
