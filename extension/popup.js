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

// ค่าใน <select> = "<โปรไฟล์ของหน้าเว็บ>|<id บัญชี FB>" — ต้องจำคู่กันเสมอ (ดู appApi ใน shared.js)
const keyOf = (t) => `${t.ws}|${t.profile}`;
function choiceOf(v) {
  const i = String(v || '').indexOf('|');
  return i < 0 ? null : { ws: v.slice(0, i), profile: v.slice(i + 1) };
}
// สร้างด้วย DOM ไม่ประกอบ HTML — ชื่อบัญชีมาจากหน้าเว็บ มี < > ได้
function addOption(parent, value, text, disabled) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  o.disabled = !!disabled;
  parent.appendChild(o);
}

// โหลดรายชื่อบัญชี FB จากหน้าเว็บเอง (ทุกโปรไฟล์) — ผู้ใช้จะได้ไม่ต้องไปหา id มากรอกเอง
// คืน { picked } เมื่อโหลดได้ (picked = null แปลว่าต้องให้ผู้ใช้เลือกเอง) หรือ null เมื่อโหลดไม่ได้
async function loadProfiles(cfg) {
  const sel = $('profile');
  if (!cfg.appUrl) return null;
  let groups;
  try {
    groups = await listTargets(cfg);
  } catch (e) {
    sel.textContent = '';
    addOption(sel, '', `— โหลดรายชื่อไม่ได้: ${e.message} —`);
    return null;
  }
  sel.textContent = '';
  const picked = pickTarget(groups, cfg);
  const total = groups.reduce((n, g) => n + g.profiles.length, 0);
  // หลายบัญชีและยังไม่ได้เลือก = ตัวแรกของรายการต้องเป็นช่องว่าง ไม่งั้น <select> โชว์บัญชีแรกเหมือนเลือกไว้แล้ว
  if (!picked && total) addOption(sel, '', '— เลือกบัญชีที่จะส่งวงเงินเข้า —');
  for (const g of groups) {
    let parent = sel;
    if (groups.length > 1) {
      parent = document.createElement('optgroup');
      parent.label = `โปรไฟล์ ${g.name}`;
      sel.appendChild(parent);
    }
    if (g.error) addOption(parent, '', `โหลดไม่ได้: ${g.error}`, true);
    for (const p of g.profiles) addOption(parent, keyOf({ ws: g.ws, profile: p.id }), p.label);
  }
  if (!total && !groups.some((g) => g.error)) addOption(sel, '', '— ไม่พบบัญชี —');
  sel.value = picked ? keyOf(picked) : '';
  return { picked };
}

async function remember(t) {
  await chrome.storage.local.set({ workspace: t.ws, profile: t.profile });
}

async function init() {
  const cfg = await chrome.storage.local.get(['appUrl', 'user', 'pass', 'workspace', 'profile', 'status']);
  if (!cfg.appUrl) cfg.appUrl = DEFAULT_APP_URL;
  $('appUrl').value = cfg.appUrl;
  $('user').value = cfg.user || '';
  $('pass').value = cfg.pass || '';
  show(cfg.status);
  const r = await loadProfiles(cfg);
  // มีทางเลือกที่ชัดเจนทางเดียว (บัญชีเดียว / ตัวที่เคยเลือกไว้) = จำให้เลย ไม่ต้องกดบันทึกเอง
  // หลายบัญชีต้องให้ผู้ใช้เลือกเอง — เดาผิดคือวงเงินไปโผล่ผิดบัญชีเงียบๆ
  if (r && r.picked && (r.picked.ws !== cfg.workspace || r.picked.profile !== cfg.profile)) {
    await chrome.storage.local.set({ appUrl: cfg.appUrl });
    await remember(r.picked);
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
  const chosen = choiceOf($('profile').value);
  await chrome.storage.local.set({ appUrl, user: $('user').value.trim(), pass: $('pass').value });
  if (chosen) await remember(chosen);
  // รายชื่อโหลดใหม่ตามที่อยู่/รหัสที่เพิ่งกรอก — ตัวที่เลือกไว้ต้องยังอยู่ในรายการใหม่ถึงจะนับ
  const cfg = await chrome.storage.local.get(['appUrl', 'user', 'pass', 'workspace', 'profile']);
  const r = await loadProfiles(cfg);
  if (!r) return show({ text: 'บันทึกแล้ว แต่โหลดรายชื่อบัญชีไม่ได้ — ดูข้อความในช่องเลือกบัญชี', at: Date.now() });
  if (r.picked) await remember(r.picked);
  show(r.picked
    ? { text: 'บันทึกแล้ว', ok: true, at: Date.now() }
    : { text: 'บันทึกแล้ว — เลือกบัญชีที่จะส่งวงเงินเข้าด้วย', at: Date.now() });
});

$('profile').addEventListener('change', async () => {
  const t = choiceOf($('profile').value);
  if (t) await remember(t);
});

$('now').addEventListener('click', async () => {
  show({ text: 'กำลังอ่านวงเงิน...', at: Date.now() });
  const s = await chrome.runtime.sendMessage({ type: 'pull' });
  show(s);
});

init();
