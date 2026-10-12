// แก้ตามการทดสอบในเบราว์เซอร์จริงรอบสุดท้าย (12 ต.ค. 2026) — รันโค้ดจริงจาก index.html ใน vm กับ DOM จำลอง
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
// ฟังก์ชันระดับบนสุดในไฟล์นี้ปิดด้วย "}" ที่คอลัมน์แรกเสมอ
function grab(name) {
  const m = HTML.match(new RegExp(`\\n((?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n)`));
  assert.ok(m, `ไม่พบฟังก์ชัน ${name} ใน index.html`);
  return m[1];
}

test('หน้าต่างขึ้นแอด: โหลดบัญชีของโปรไฟล์ไม่ได้ ต้องบอกสาเหตุ ไม่ใช่วาดบัญชีชื่อ "undefined"', async () => {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, innerHTML: '', textContent: '', scrollTop: 0,
    querySelectorAll: () => [], closest: () => null,
  });
  const ctx = vm.createContext({
    document: { getElementById: el, querySelectorAll: () => [] },
    profiles: [{ id: 'p1', label: 'หนึ่ง', hasToken: true }],
    fullAccountCache: {},
    // Meta สั่งพัก → /api/accounts ตอบ 503 {cooling:true}
    fetch: async () => new Response(JSON.stringify({ error: 'FB สั่งพักการเรียก API อยู่ถึง 11:43', cooling: true }),
      { status: 503, headers: { 'content-type': 'application/json' } }),
    ic: () => '', ensureFxRates() {}, updateStats() {},
    evalReady: () => ({ ready: false, missing: ['บัญชีถูกปิด/มีปัญหา'] }),
  });
  vm.runInContext([
    grab('esc'), grab('jsStr'), grab('apiJson'), grab('loadFullAccounts'),
    'let launchAccountsBuilt = false;', 'let launchAccounts = [];', 'let launchAccountErrs = [];',
    grab('loadLaunchAccounts'), grab('renderLaunchAccounts'),
  ].join('\n'), ctx);
  await vm.runInContext('loadLaunchAccounts(true)', ctx);
  const html = els.launchAccounts.innerHTML;
  assert.doesNotMatch(html, /undefined/, 'ห้ามมีกลุ่ม/บัญชีชื่อ undefined');
  assert.match(html, /FB สั่งพักการเรียก API อยู่ถึง 11:43/, 'ต้องบอกสาเหตุจริง');
  assert.match(html, /หนึ่ง/, 'ต้องบอกว่าโปรไฟล์ไหน');
  assert.strictEqual(els.launchAcctSummary.textContent, 'พร้อม 0/0 บัญชี');
  assert.strictEqual(vm.runInContext('launchAccountsBuilt', ctx), false, 'โหลดพลาด = เปิดหน้าต่างรอบหน้าต้องลองโหลดใหม่');
});

test('ให้ AI ขึ้นต่อ ช่วงโหลดบัญชีไม่ได้ (Meta สั่งพัก): กล่องยืนยันห้ามบอก "รวม 0 บาท/วัน" ต้องบอกงบต่อบัญชีและว่านับไม่ได้', async () => {
  // รีวิวรอบสุดท้ายวัดจริง: ช่วงพัก /api/accounts ตอบ 503 → readyAccounts() ว่าง → กล่องบอก 0 บัญชี 0 บาท/วัน
  // ทั้งที่พอพักจบ autopilot เติมทุกบัญชีที่ใช้ได้ (CLAUDE.md: ทวน minAds × บัญชี × งบ ก่อนเปิดระบบเสมอ)
  const vals = { 'tpl-link': 'https://example.com/', campaignBudget: '500', planPerAccount: '2', ruleCpr: '100' };
  const asked = [];
  const ctx = vm.createContext({
    document: { getElementById: (id) => ({ value: vals[id] || '', checked: id === 'ruleOn', textContent: '', disabled: false }) },
    launchAccounts: [], launchAccountErrs: [{ pid: 'p1', label: 'หนึ่ง', error: 'FB สั่งพักการเรียก API อยู่ถึง 11:43' }],
    evalReady: () => ({ ready: true, missing: [] }),
    fetch: async () => new Response(JSON.stringify({ enabled: false, fastMins: 10, fullMins: 20 }), { status: 200 }),
    confirm: (m) => { asked.push(m); return false; },   // ตอบ "ยกเลิก" — ดูแค่ข้อความ ไม่บันทึกอะไร
    toast: () => {},
  });
  vm.runInContext([grab('readyAccounts'), grab('handToAi')].join('\n'), ctx);
  await vm.runInContext('handToAi({ textContent: "" })', ctx);
  assert.strictEqual(asked.length, 1);
  assert.doesNotMatch(asked[0], /รวม 0 บาท/, 'ห้ามบอกว่างบรวม 0 บาท/วัน');
  assert.match(asked[0], /บัญชีละ 1,000/, 'ต้องบอกงบต่อบัญชี (2 แอด × 500)');
  assert.match(asked[0], /นับตอนนี้ไม่ได้[\s\S]*FB สั่งพัก/, 'ต้องบอกว่านับจำนวนบัญชีไม่ได้เพราะอะไร');
});
