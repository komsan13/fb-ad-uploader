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
