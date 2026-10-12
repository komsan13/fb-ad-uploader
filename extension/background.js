// ตัวหลักของส่วนขยาย: อ่าน "วงเงินใช้จ่ายต่อวัน" ของทุกบัญชีโฆษณา แล้วส่งเข้าหน้าสุขภาพบัญชี
//
// ⛔ token ห้ามออกจากเบราว์เซอร์เครื่องนี้เด็ดขาด
//    เวอร์ชันแรกส่ง token ให้เซิร์ฟเวอร์ไปยิง Graph เอง ผลคือ Meta เห็น session เดียวกัน
//    โผล่จาก IP ศูนย์ข้อมูล เลยสั่ง checkpoint ทั้งบัญชี FB ของผู้ใช้ (26 ก.ค. 2026)
//    ตอนนี้เรายิง Graph จากในเบราว์เซอร์ตรงนี้ — IP และ session เดียวกับที่ผู้ใช้ล็อกอินอยู่
//    แล้วส่งออกไปแค่ตัวเลข
importScripts('extract.js', 'shared.js');

const ADS_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';
const GRAPH = 'https://graph.facebook.com/v23.0';
// ดึงทุกครึ่งชั่วโมงพอให้ตัวเลขไม่เก่า และไม่ถี่จนดูผิดปกติ
const PULL_MINUTES = 30;
// รอบที่มาจากการเปิดหน้า Ads Manager — เดิมยิง Graph + ส่งเข้าหน้าเว็บทุกครั้งที่หน้าโหลด (สลับบัญชีใน
// Ads Manager ก็โหลดใหม่) ขัดกับเหตุผลของรอบ 30 นาทีข้างบน จึงข้ามถ้ารอบล่าสุดเพิ่งส่งสำเร็จไปไม่ถึงเท่านี้
// ปุ่ม "อ่านวงเงินแล้วส่งเดี๋ยวนี้" ในป๊อปอัปไม่ติดเงื่อนไขนี้ (ผู้ใช้สั่งเองตรงๆ)
const TAB_MIN_GAP_MINUTES = 10;
// เพดานหน้าของ me/adaccounts (200 บัญชีต่อหน้า) — เท่ากับ fbAll ฝั่งเซิร์ฟเวอร์ กันวนไม่จบถ้า Graph ตอบเพี้ยน
const MAX_PAGES = 25;

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
function schedule() {
  chrome.alarms.create('pull', { periodInMinutes: PULL_MINUTES, delayInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pull') run('ตามรอบ'); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // content script บอกว่าผู้ใช้เพิ่งเปิดหน้า Ads Manager — token ที่ได้ตอนนี้สดที่สุด
  if (msg && msg.type === 'token') { fromTab(msg.token).then(reply); return true; }
  if (msg && msg.type === 'pull') { run('สั่งเอง').then(reply); return true; }
  return false;
});

// ข้ามเฉพาะเมื่อรอบล่าสุดสำเร็จ "กับปลายทางเดียวกับตอนนี้" — เพิ่งเปลี่ยนบัญชีในป๊อปอัปต้องส่งรอบใหม่ได้ทันที
async function fromTab(token) {
  try {
    const s = await chrome.storage.local.get(['status', 'lastOk', 'workspace', 'profile']);
    const recent = s.status && s.status.ok && s.lastOk && Date.now() - s.lastOk.at < TAB_MIN_GAP_MINUTES * 60000;
    if (recent && s.lastOk.workspace === s.workspace && s.lastOk.profile === s.profile) return s.status;
  } catch { /* อ่านสถานะเดิมไม่ได้ = วิ่งรอบตามปกติ */ }
  return run('จากแท็บ Ads Manager', token);
}

// ทุกทางเข้า (รอบเวลา/แท็บ/ป๊อปอัป) ผ่านตรงนี้: วิ่งทีละรอบ (เปิดหลายแท็บพร้อมกันได้รอบเดียว)
// และพังแบบไม่คาดคิดก็ต้องจบด้วยสถานะ "!" เสมอ — เดิม throw หลุดออกไป ป๊อปอัปรอคำตอบค้าง ป้าย ✓ เก่าค้างอยู่
let running = null;
function run(why, token) {
  if (!running) {
    running = refresh(why, token)
      .catch((e) => setStatus(`ผิดพลาด: ${e.message}`))
      .finally(() => { running = null; });
  }
  return running;
}

async function refresh(why, tokenFromTab) {
  let token = tokenFromTab;
  if (!token) {
    try {
      const r = await fetch(ADS_URL, { credentials: 'include' });
      token = extractFbToken(await r.text());
    } catch (e) {
      return setStatus(`เปิดหน้า Ads Manager ไม่ได้: ${e.message}`);
    }
  }
  // FB ตอบหน้าล็อกอิน/redirect แทนได้เมื่อ session หมด — ไม่ใช่ของพัง แค่ต้องล็อกอินใหม่
  if (!token) return setStatus('หา token ไม่เจอ — เปิด adsmanager.facebook.com แล้วล็อกอิน FB ก่อน');

  let limits;
  try {
    limits = await readLimits(token);
  } catch (e) {
    return setStatus(`อ่านวงเงินไม่สำเร็จ: ${e.message}`);
  }
  if (!limits.length) return setStatus('ไม่พบบัญชีโฆษณาในบัญชี FB นี้');
  return pushLimits(limits, why);
}

// ยิง Graph จากในเบราว์เซอร์ — ได้ทุกบัญชีข้ามทุก BM ที่ผู้ใช้เข้าถึงได้
// ต้องไล่ทุกหน้า: เซิร์ฟเวอร์แทนที่ตัวเลขชุดเดิมทั้งชุดทุกครั้งที่ส่ง เดิมอ่านแค่หน้าแรก (200 บัญชี)
// บัญชีที่อยู่หน้าถัดไปจึงหายตัวเลขไปเงียบๆ • ประกอบ URL เองจาก cursors.after ไม่เดินตาม paging.next
// ตรงๆ เพราะ next มี token ติดมาด้วย — ประกอบเองจึงมั่นใจว่า token ไปที่ graph.facebook.com เท่านั้น
async function readLimits(token) {
  const out = [];
  let after = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({
      fields: 'account_id,adtrust_dsl,adspaymentcycle{threshold_amount}',
      limit: '200',
      access_token: token,
    });
    if (after) q.set('after', after);
    const r = await fetch(`${GRAPH}/me/adaccounts?${q}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    for (const a of j.data || []) {
      out.push({
        id: a.account_id,
        // ค่าดิบ ไม่แปลงหน่วยตรงนี้ — ให้หน้าเว็บเป็นคนตัดสินใจแสดงผลที่เดียว
        dsl: a.adtrust_dsl === undefined ? null : a.adtrust_dsl,
        threshold: ((a.adspaymentcycle || {}).data || [])[0]
          ? a.adspaymentcycle.data[0].threshold_amount
          : null,
      });
    }
    const p = j.paging || {};
    if (!p.next || !(p.cursors && p.cursors.after)) break;
    after = p.cursors.after;
  }
  return out;
}

async function pushLimits(limits, why) {
  const cfg = await chrome.storage.local.get(['appUrl', 'user', 'pass', 'workspace', 'profile']);
  if (!cfg.appUrl || !cfg.profile) return setStatus('ยังไม่ได้ตั้งค่า — กดไอคอนส่วนขยายแล้วตั้งค่าก่อน');
  try {
    // ตั้งค่าจากรุ่นก่อนจำแค่ id บัญชี FB ไม่ได้จำว่าอยู่โปรไฟล์ไหนของหน้าเว็บ — หาให้ครั้งเดียวแล้วจำไว้
    if (cfg.workspace === undefined) {
      const t = pickTarget(await listTargets(cfg), cfg);
      if (!t) return setStatus('หาไม่เจอว่าบัญชีที่ตั้งไว้อยู่โปรไฟล์ไหน — กดไอคอนส่วนขยายแล้วเลือกบัญชีใหม่');
      cfg.workspace = t.ws;
      await chrome.storage.local.set({ workspace: t.ws });
    }
    if (cfg.workspace && !WS_ID_RE.test(cfg.workspace)) return setStatus('ค่าโปรไฟล์ที่ตั้งไว้ผิดรูปแบบ — กดไอคอนส่วนขยายแล้วเลือกบัญชีใหม่');
    const r = await appFetch(cfg, appApi(cfg, cfg.workspace, '/api/am-limits'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: cfg.profile, limits }),
    });
    if (r.status === 401) return setStatus('หน้าเว็บขอรหัสผ่าน (401) — กรอกชื่อผู้ใช้/รหัสในป๊อปอัปแล้วลองใหม่');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return setStatus(`ส่งไม่สำเร็จ: ${d.error || 'HTTP ' + r.status}`);
    await chrome.storage.local.set({ lastOk: { at: Date.now(), workspace: cfg.workspace, profile: cfg.profile } });
    return setStatus(`ส่งวงเงิน ${d.saved} บัญชีแล้ว (${why})`, true);
  } catch (e) {
    return setStatus(`ต่อกับหน้าเว็บไม่ได้: ${e.message}`);
  }
}

// สถานะล่าสุดต้องเห็นได้เสมอ — ส่วนขยายที่เงียบแล้วพังคือตัวที่อันตรายที่สุด
async function setStatus(text, ok = false) {
  const status = { text, ok, at: Date.now() };
  await chrome.storage.local.set({ status });
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#0e9268' : '#d93025' });
  return status;
}
