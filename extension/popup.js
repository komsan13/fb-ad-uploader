const $ = (id) => document.getElementById(id);

// ที่อยู่หน้าเว็บของระบบนี้ — เติมไว้ให้เลย ผู้ใช้ไม่ต้องมานั่งพิมพ์เอง
// (โดเมนนี้อยู่ใน host_permissions ของ manifest ด้วย จะได้ไม่ต้องกดอนุญาตสิทธิ์อีกรอบ)
const DEFAULT_APP_URL = 'https://ad.senball.com';

function show(s) {
  const el = $('status');
  if (!s || !s.text) { el.textContent = 'ยังไม่เคยส่ง'; el.className = ''; return; }
  const when = new Date(s.at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  el.textContent = `${s.text}\n${when}`;
  el.className = s.ok ? 'ok' : 'bad';
}

// โหลดรายชื่อบัญชี FB จากหน้าเว็บเอง — ผู้ใช้จะได้ไม่ต้องไปหา profile id มากรอกเอง
async function loadProfiles(cfg) {
  const sel = $('profile');
  if (!cfg.appUrl) return;
  const headers = {};
  if (cfg.user) headers.Authorization = 'Basic ' + btoa(`${cfg.user}:${cfg.pass || ''}`);
  try {
    // credentials:'include' = ใช้รหัส basic auth ที่เบราว์เซอร์จำไว้อยู่แล้ว
    // ผู้ใช้ส่วนใหญ่จึงไม่ต้องกรอกชื่อผู้ใช้/รหัสซ้ำในนี้เลย
    const r = await fetch(cfg.appUrl.replace(/\/+$/, '') + '/api/profiles', { headers, credentials: 'include' });
    if (!r.ok) throw new Error(r.status === 401 ? 'ชื่อผู้ใช้/รหัสผ่านไม่ถูก' : 'HTTP ' + r.status);
    const d = await r.json();
    sel.innerHTML = (d.profiles || []).map((p) =>
      `<option value="${p.id}">${p.label || p.id}</option>`).join('') || '<option value="">— ไม่พบบัญชี —</option>';
    if (cfg.profile) sel.value = cfg.profile;
    // หน้าเว็บมีบัญชีเดียวก็เลือกให้เลย ไม่ต้องให้ผู้ใช้กดซ้ำ
    if (!sel.value && sel.options.length === 1) sel.selectedIndex = 0;
  } catch (e) {
    sel.innerHTML = `<option value="">— โหลดรายชื่อไม่ได้: ${e.message} —</option>`;
  }
}

async function init() {
  const cfg = await chrome.storage.local.get(['appUrl', 'user', 'pass', 'profile', 'status']);
  if (!cfg.appUrl) cfg.appUrl = DEFAULT_APP_URL;
  $('appUrl').value = cfg.appUrl;
  $('user').value = cfg.user || '';
  $('pass').value = cfg.pass || '';
  show(cfg.status);
  await loadProfiles(cfg);
  // มีบัญชีเดียวและยังไม่เคยตั้งค่า = ตั้งให้เสร็จเลย ไม่ต้องให้กดบันทึกเอง
  if (!cfg.profile && $('profile').value) {
    await chrome.storage.local.set({ appUrl: cfg.appUrl, profile: $('profile').value });
  }
}

$('save').addEventListener('click', async () => {
  const appUrl = $('appUrl').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(appUrl)) return show({ text: 'ที่อยู่หน้าเว็บต้องขึ้นต้นด้วย http:// หรือ https://', at: Date.now() });
  // ต้องขอสิทธิ์เข้าโดเมนของหน้าเว็บก่อน ไม่งั้น fetch จากส่วนขยายจะถูกบล็อก
  // (ขอเฉพาะโดเมนที่ผู้ใช้กรอก ไม่ได้ขอสิทธิ์ทุกเว็บไว้ล่วงหน้า)
  const origin = new URL(appUrl).origin + '/*';
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) return show({ text: 'ไม่ได้รับสิทธิ์เข้าโดเมนนี้ — กดอนุญาตด้วย', at: Date.now() });
  const cfg = { appUrl, user: $('user').value.trim(), pass: $('pass').value, profile: $('profile').value };
  await chrome.storage.local.set(cfg);
  await loadProfiles(cfg);
  // รายชื่อเพิ่งโหลดมา ค่าที่เลือกอาจเปลี่ยน — บันทึกทับอีกรอบให้ตรงกับที่เห็นบนจอ
  await chrome.storage.local.set({ profile: $('profile').value });
  show({ text: 'บันทึกแล้ว', ok: true, at: Date.now() });
});

$('profile').addEventListener('change', () => chrome.storage.local.set({ profile: $('profile').value }));

$('now').addEventListener('click', async () => {
  show({ text: 'กำลังดึง token...', at: Date.now() });
  const s = await chrome.runtime.sendMessage({ type: 'pull' });
  show(s);
});

init();
