// Service worker: จับ/คืน cookie ของ facebook.com ต่อบัญชี (profile) แล้วสลับให้อัตโนมัติ
// session เก็บใน chrome.storage.local ของเบราว์เซอร์นี้เท่านั้น — ไม่ส่งขึ้นเซิร์ฟเวอร์
const FB_DOMAIN = 'facebook.com';
const KEY = (pid) => 'sess_' + pid;

// URL ที่ chrome.cookies ใช้ระบุ cookie (โดเมน + path ต้องตรง)
function cookieUrl(c) {
  const host = c.domain.replace(/^\./, '');
  return (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
}

// แปลง cookie ที่อ่านมา → รูปแบบที่ chrome.cookies.set รับ
function toSetDetails(c) {
  const d = {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  };
  // hostOnly คุมด้วย "มี domain ไหม" — cookie ที่ไม่ hostOnly ต้องคง domain (.facebook.com) ไว้
  if (!c.hostOnly) d.domain = c.domain;
  // session cookie (ไม่มีวันหมดอายุ) ต้องไม่ใส่ expirationDate ไม่งั้นกลายเป็น persistent
  if (!c.session && typeof c.expirationDate === 'number') d.expirationDate = c.expirationDate;
  return d;
}

async function getFbCookies() {
  return chrome.cookies.getAll({ domain: FB_DOMAIN });
}

// ล้าง cookie facebook.com ปัจจุบันก่อนใส่ของบัญชีใหม่ — กันสถานะสองบัญชีปนกัน
async function clearFbCookies() {
  const cur = await getFbCookies();
  for (const c of cur) {
    try { await chrome.cookies.remove({ url: cookieUrl(c), name: c.name }); } catch (e) { /* ข้าม */ }
  }
}

async function captureFor(pid) {
  const cookies = await getFbCookies();
  const cu = cookies.find((c) => c.name === 'c_user');
  if (!cu) return { ok: false, error: 'ยังไม่ได้ล็อกอิน facebook.com ในเบราว์เซอร์นี้ — ล็อกอินบัญชีที่ต้องการก่อนแล้วกดใหม่' };
  await chrome.storage.local.set({ [KEY(pid)]: { cookies, cUser: cu.value, at: Date.now() } });
  return { ok: true, cUser: cu.value, count: cookies.length };
}

async function restoreCookies(cookies) {
  await clearFbCookies();
  for (const c of cookies) {
    try { await chrome.cookies.set(toSetDetails(c)); } catch (e) { /* best effort */ }
  }
}

async function openAs(pid, url) {
  const got = await chrome.storage.local.get(KEY(pid));
  const st = got[KEY(pid)];
  if (!st) return { ok: false, needCapture: true };
  // สำรอง session ปัจจุบันไว้ก่อน — ถ้าสลับไม่ติดจะได้กู้คืน ไม่ให้ facebook.com ค้างสถานะพัง (กัน checkpoint)
  const before = await getFbCookies();
  await restoreCookies(st.cookies);
  // ยืนยันว่าสลับติดจริง: c_user ต้องตรงกับที่เก็บไว้ และต้องมี xs (ตัวยืนยัน session)
  const after = await getFbCookies();
  const cu = after.find((c) => c.name === 'c_user');
  const hasXs = after.some((c) => c.name === 'xs');
  if (!cu || cu.value !== st.cUser || !hasXs) {
    await restoreCookies(before); // คืนสถานะเดิม
    return { ok: false, error: 'สลับบัญชีไม่สำเร็จ (session อาจหมดอายุ) — คืนสถานะเดิมให้แล้ว ล็อกอินบัญชีนี้ใหม่แล้วกด "เชื่อมบัญชีนี้" อีกครั้ง' };
  }
  await chrome.tabs.create({ url });
  return { ok: true, cUser: st.cUser };
}

async function listSessions() {
  const all = await chrome.storage.local.get(null);
  const sessions = {};
  for (const k in all) {
    if (k.startsWith('sess_')) sessions[k.slice(5)] = { cUser: all[k].cUser, at: all[k].at };
  }
  return { ok: true, sessions };
}

async function clearSession(pid) {
  await chrome.storage.local.remove(KEY(pid));
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const done = (p) => p.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  switch (msg && msg.action) {
    case 'ping': sendResponse({ ok: true, present: true }); return false;
    case 'capture': done(captureFor(msg.pid)); return true;
    case 'open': done(openAs(msg.pid, msg.url)); return true;
    case 'list': done(listSessions()); return true;
    case 'clear': done(clearSession(msg.pid)); return true;
    default: sendResponse({ ok: false, error: 'unknown action' }); return false;
  }
});
