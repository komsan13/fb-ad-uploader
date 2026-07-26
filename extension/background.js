// ตัวหลักของส่วนขยาย: อ่าน "วงเงินใช้จ่ายต่อวัน" ของทุกบัญชีโฆษณา แล้วส่งเข้าหน้าสุขภาพบัญชี
//
// ⛔ token ห้ามออกจากเบราว์เซอร์เครื่องนี้เด็ดขาด
//    เวอร์ชันแรกส่ง token ให้เซิร์ฟเวอร์ไปยิง Graph เอง ผลคือ Meta เห็น session เดียวกัน
//    โผล่จาก IP ศูนย์ข้อมูล เลยสั่ง checkpoint ทั้งบัญชี FB ของผู้ใช้ (26 ก.ค. 2026)
//    ตอนนี้เรายิง Graph จากในเบราว์เซอร์ตรงนี้ — IP และ session เดียวกับที่ผู้ใช้ล็อกอินอยู่
//    แล้วส่งออกไปแค่ตัวเลข
importScripts('extract.js');

const ADS_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';
const GRAPH = 'https://graph.facebook.com/v23.0';
// ดึงทุกครึ่งชั่วโมงพอให้ตัวเลขไม่เก่า และไม่ถี่จนดูผิดปกติ
const PULL_MINUTES = 30;

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
function schedule() {
  chrome.alarms.create('pull', { periodInMinutes: PULL_MINUTES, delayInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pull') refresh('ตามรอบ'); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // content script บอกว่าผู้ใช้เพิ่งเปิดหน้า Ads Manager — token ที่ได้ตอนนี้สดที่สุด
  if (msg && msg.type === 'token') { refresh('จากแท็บ Ads Manager', msg.token).then(reply); return true; }
  if (msg && msg.type === 'pull') { refresh('สั่งเอง').then(reply); return true; }
  return false;
});

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

// ยิง Graph จากในเบราว์เซอร์ — ครั้งเดียวได้ทุกบัญชีข้ามทุก BM ที่ผู้ใช้เข้าถึงได้
async function readLimits(token) {
  const q = new URLSearchParams({
    fields: 'account_id,adtrust_dsl,adspaymentcycle{threshold_amount}',
    limit: '200',
    access_token: token,
  });
  const r = await fetch(`${GRAPH}/me/adaccounts?${q}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return (j.data || []).map((a) => ({
    id: a.account_id,
    // ค่าดิบ ไม่แปลงหน่วยตรงนี้ — ให้หน้าเว็บเป็นคนตัดสินใจแสดงผลที่เดียว
    dsl: a.adtrust_dsl === undefined ? null : a.adtrust_dsl,
    threshold: ((a.adspaymentcycle || {}).data || [])[0]
      ? a.adspaymentcycle.data[0].threshold_amount
      : null,
  }));
}

async function pushLimits(limits, why) {
  const cfg = await chrome.storage.local.get(['appUrl', 'user', 'pass', 'profile']);
  if (!cfg.appUrl || !cfg.profile) return setStatus('ยังไม่ได้ตั้งค่า — กดไอคอนส่วนขยายแล้วตั้งค่าก่อน');
  const headers = { 'content-type': 'application/json' };
  // ปกติใช้รหัส basic auth ที่เบราว์เซอร์จำไว้ (credentials:'include') ช่องในป๊อปอัปมีไว้เผื่อไม่ได้จำ
  if (cfg.user) headers.Authorization = 'Basic ' + btoa(`${cfg.user}:${cfg.pass || ''}`);
  try {
    const r = await fetch(cfg.appUrl.replace(/\/+$/, '') + '/api/am-limits', {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({ profile: cfg.profile, limits }),
    });
    if (r.status === 401) return setStatus('หน้าเว็บขอรหัสผ่าน (401) — กรอกชื่อผู้ใช้/รหัสในป๊อปอัปแล้วลองใหม่');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return setStatus(`ส่งไม่สำเร็จ: ${d.error || 'HTTP ' + r.status}`);
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
