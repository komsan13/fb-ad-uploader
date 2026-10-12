// ของที่ทั้ง background (importScripts) และป๊อปอัป (<script>) ใช้คุยกับหน้าเว็บของเรา — ที่เดียวจะได้ไม่หลุดซิงก์กัน
// ⛔ ไฟล์นี้คุยกับหน้าเว็บของเราเท่านั้น token ของ Facebook ห้ามผ่านเข้ามาในนี้เด็ดขาด (ดู background.js)

// id โปรไฟล์ของตัวกลาง (hub.js) — รูปแบบเดียวกับ ID_RE ฝั่ง hub กันค่าแปลกๆ ไปประกอบเป็น path
const WS_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// หัว Authorization แบบ basic — เข้ารหัสเป็น UTF-8 ก่อนค่อย btoa
// btoa รับได้แค่ตัวอักษร Latin-1 รหัสผ่านภาษาไทยทำให้มัน throw InvalidCharacterError
// เดิมเรียก btoa ตรงๆ นอก try: ส่วนขยายค้างทั้งรอบ ป๊อปอัปรอคำตอบไม่มีวันได้ และป้าย ✓ ของรอบก่อนค้างอยู่
// เหมือนยังส่งได้ปกติ • UTF-8 คือสิ่งที่ Chrome ส่งเองเมื่อกรอกรหัสภาษาไทยในกล่องถามรหัส (RFC 7617)
function basicAuth(user, pass) {
  const bytes = new TextEncoder().encode(`${user}:${pass || ''}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

// ที่อยู่ API ของโปรไฟล์ (workspace) ที่ผู้ใช้เลือก — ระบุผ่าน /w/<id> ตรงๆ เสมอ
// ตัวกลางส่งคำขอที่ไม่มี /w/ ไปตาม cookie fbws = โปรไฟล์ที่หน้าเว็บเลือกค้างไว้ล่าสุด และส่วนขยายแนบ cookie
// ไปด้วย (credentials:'include') เดิมพอผู้ใช้สลับโปรไฟล์บนหน้าเว็บ วงเงินก็ไปผิดโปรไฟล์หรือได้ 404 ทันที
// ws = '' = ไม่มีตัวกลาง (รัน server.js เดี่ยว) ใช้ path ตรงๆ
function appApi(cfg, ws, p) {
  return String(cfg.appUrl || '').replace(/\/+$/, '') + (ws ? `/w/${ws}` : '') + p;
}

// credentials:'include' = ใช้รหัส basic auth ที่เบราว์เซอร์จำไว้ ช่องในป๊อปอัปมีไว้เผื่อไม่ได้จำ
function appFetch(cfg, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cfg.user) headers.Authorization = basicAuth(cfg.user, cfg.pass);
  return fetch(url, { ...opts, headers, credentials: 'include' });
}

// รายชื่อบัญชี FB ทุกตัวในทุกโปรไฟล์ของหน้าเว็บ: [{ ws, name, profiles:[{id,label}], error? }]
// โปรไฟล์ไหนโหลดไม่ได้ (เช่นกำลังรีสตาร์ท) แยก error เป็นรายโปรไฟล์ ตัวเดียวพังไม่ลากทั้งรายการ
async function listTargets(cfg) {
  let wss = null;
  const r = await appFetch(cfg, appApi(cfg, '', '/hub/api/workspaces'));
  if (r.status === 401) throw new Error('ชื่อผู้ใช้/รหัสผ่านไม่ถูก');
  // 404 เท่านั้นที่แปลว่าไม่มีตัวกลาง (server.js เดี่ยว) = มีโปรไฟล์เดียว ไม่ต้องใส่ /w/
  // 502/503 ตอน deploy/รีสตาร์ทต้องถือว่า "ยังไม่รู้" — ถ้าเดาว่าไม่มีตัวกลาง ตั้งค่ารุ่นเก่าจะถูกจำเป็น
  // "ไม่ระบุโปรไฟล์" ถาวร แล้ววงเงินกลับไปลงตาม cookie ของหน้าเว็บเหมือนบั๊กเดิม
  if (r.status !== 404) {
    let d = null;
    if (r.ok) { try { d = await r.json(); } catch { /* ไม่ใช่ JSON */ } }
    if (!d || !Array.isArray(d.list)) throw new Error(`โหลดรายชื่อโปรไฟล์ไม่ได้ (HTTP ${r.status})`);
    wss = d.list;
  }
  const groups = wss ? wss.filter((w) => WS_ID_RE.test(String(w.id))) : [{ id: '', name: '' }];
  return Promise.all(groups.map(async (w) => {
    const g = { ws: String(w.id), name: String(w.name || w.id), profiles: [] };
    try {
      const pr = await appFetch(cfg, appApi(cfg, g.ws, '/api/profiles'));
      if (!pr.ok) throw new Error(pr.status === 401 ? 'ชื่อผู้ใช้/รหัสผ่านไม่ถูก' : pr.status === 503 ? 'โปรไฟล์นี้กำลังเริ่มทำงาน' : 'HTTP ' + pr.status);
      const d = await pr.json();
      g.profiles = (d.profiles || []).map((p) => ({ id: String(p.id), label: String(p.label || p.id) }));
    } catch (e) { g.error = e.message; }
    return g;
  }));
}

// ปลายทางที่ "ชัดเจน" เพียงทางเดียว หรือ null = ต้องให้ผู้ใช้เลือกเอง
// • เคยเลือกไว้และยังมีอยู่ → ตัวนั้น (รุ่นก่อนจำแค่ id บัญชี FB ไม่ได้จำโปรไฟล์ — หาจาก id ซึ่งสร้างจากเวลา
//   จึงไม่ซ้ำข้ามโปรไฟล์ เจอตัวเดียวถึงนับ) • ไม่เคยเลือกและมีบัญชีเดียว → ตัวนั้น
// เดิมป๊อปอัปบันทึกตัวแรกของรายการให้เองแม้มีหลายบัญชี (<select> เลือกตัวแรกไว้เสมอ) — วงเงินไปผิดที่เงียบๆ
function pickTarget(groups, saved) {
  const all = groups.flatMap((g) => g.profiles.map((p) => ({ ws: g.ws, profile: p.id })));
  if (saved.profile) {
    const hit = all.filter((t) => t.profile === saved.profile && (saved.workspace === undefined || t.ws === saved.workspace));
    return hit.length === 1 ? hit[0] : null;
  }
  return all.length === 1 ? all[0] : null;
}
