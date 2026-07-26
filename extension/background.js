// ตัวหลักของส่วนขยาย: หา token ของ Ads Manager แล้วส่งเข้าหน้าสุขภาพบัญชีให้เอง
// ทำงานสองทาง — ตามรอบ (ผู้ใช้ไม่ต้องเปิดแท็บอะไรเลย) และตอนผู้ใช้เปิดหน้า Ads Manager พอดี
importScripts('extract.js');

const ADS_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';
// token อายุราว 1-2 ชม. ดึงทุกครึ่งชั่วโมงพอให้ไม่มีช่วงขาด และไม่ถี่จนดูผิดปกติ
const PULL_MINUTES = 30;

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
function schedule() {
  chrome.alarms.create('pull', { periodInMinutes: PULL_MINUTES, delayInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pull') pullAndPush('ตามรอบ'); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // content script บอกว่าผู้ใช้เพิ่งเปิดหน้า Ads Manager — จังหวะนี้ token สดและเชื่อถือได้ที่สุด
  if (msg && msg.type === 'token') { push(msg.token, 'จากแท็บ Ads Manager').then(reply); return true; }
  if (msg && msg.type === 'pull') { pullAndPush('สั่งเอง').then(reply); return true; }
  return false;
});

async function pullAndPush(why) {
  let html;
  try {
    const r = await fetch(ADS_URL, { credentials: 'include' });
    html = await r.text();
  } catch (e) {
    return setStatus(`ดึงหน้า Ads Manager ไม่ได้: ${e.message}`);
  }
  const token = extractFbToken(html);
  // FB ตอบหน้า redirect/ล็อกอินแทนได้เมื่อ session หมด — ไม่ใช่ของพัง แค่ต้องล็อกอินใหม่
  if (!token) return setStatus('หา token ไม่เจอ — เปิด adsmanager.facebook.com แล้วล็อกอิน FB ก่อน');
  return push(token, why);
}

async function push(token, why) {
  const cfg = await chrome.storage.local.get(['appUrl', 'user', 'pass', 'profile']);
  if (!cfg.appUrl || !cfg.profile) return setStatus('ยังไม่ได้ตั้งค่า — กดไอคอนส่วนขยายแล้วตั้งค่าก่อน');
  const headers = { 'content-type': 'application/json' };
  // หน้าเว็บอยู่หลัง basic auth — ส่วนขยายไม่มี session ของเบราว์เซอร์ ต้องแนบ header เอง
  if (cfg.user) headers.Authorization = 'Basic ' + btoa(`${cfg.user}:${cfg.pass || ''}`);
  try {
    const r = await fetch(cfg.appUrl.replace(/\/+$/, '') + '/api/am-token', {
      method: 'POST', headers, body: JSON.stringify({ profile: cfg.profile, token }),
    });
    if (r.status === 401) return setStatus('ชื่อผู้ใช้/รหัสผ่านของหน้าเว็บไม่ถูก (401)');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return setStatus(`ส่งไม่สำเร็จ: ${d.error || 'HTTP ' + r.status}`);
    return setStatus(`ส่ง token แล้ว (${why})`, true);
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
