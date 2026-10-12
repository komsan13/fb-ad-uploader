// ปุ่มสร้างแคปชั่นอัตโนมัติ (ภาษาเวียดนามสั้นๆ) ในหน้าคลังสื่อ
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, post } = require('./helpers');

async function boot(t, existing) {
  const fb = await makeFakeFb({});
  const dir = tmpDir();
  seed(dir, { config: { profiles: [], activeProfileId: null }, captions: 0 });
  if (existing) fs.writeFileSync(path.join(dir, 'captions.json'), JSON.stringify(existing));
  const srv = await startServer(dir, fb.port);
  t.after(() => { srv.stop(); fb.server.close(); });
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'captions.json'), 'utf8'));
  return { base: srv.base, saved };
}

test('สร้างตามจำนวนที่ขอ เป็นวลีเวียดนามสั้นๆ ไม่ซ้ำกัน และบันทึกลงคลังจริง', async (t) => {
  const { base, saved } = await boot(t);
  const r = await post(base, '/api/captions/auto', { count: 12 });
  assert.strictEqual(r.added.length, 12);
  const msgs = r.added.map((c) => c.message);
  assert.strictEqual(new Set(msgs).size, 12, 'ห้ามซ้ำกันเอง');
  for (const m of msgs) {
    assert.ok(m.length > 0 && m.length <= 30, `ต้องสั้น: "${m}"`);
    assert.ok(m.split(' ').length <= 4, `ไม่เกิน 4 คำ: "${m}"`);
  }
  assert.ok(msgs.some((m) => /[ăâđêôơưáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ]/i.test(m)), 'ต้องเป็นภาษาเวียดนาม (มีวรรณยุกต์)');
  assert.strictEqual(saved().length, 12, 'ต้องอยู่ในไฟล์คลัง ไม่ใช่แค่ตอบกลับ');
  assert.ok(r.added.every((c) => c.id && c.ts), 'ต้องมี id/ts เหมือนแคปชั่นที่เพิ่มเอง');
});

test('ต้องไม่สร้างซ้ำกับแคปชั่นที่มีอยู่แล้วในคลัง', async (t) => {
  const { base } = await boot(t);
  const first = await post(base, '/api/captions/auto', { count: 50 });
  const second = await post(base, '/api/captions/auto', { count: 50 });
  const all = [...first.added, ...second.added].map((c) => c.message.toLowerCase());
  assert.strictEqual(new Set(all).size, all.length);
});

test('จำนวนแปลกๆ ถูกบีบให้อยู่ในกรอบ 1–100', async (t) => {
  const { base } = await boot(t);
  assert.strictEqual((await post(base, '/api/captions/auto', { count: 999 })).added.length, 100);
  assert.strictEqual((await post(base, '/api/captions/auto', { count: 'abc' })).added.length, 10, 'ไม่ใช่ตัวเลข = ค่าตั้งต้น 10');
  assert.strictEqual((await post(base, '/api/captions/auto', { count: -5 })).added.length, 1);
});

test('แคปชั่นที่พิมพ์เองแบบแยกวรรณยุกต์ (NFD) หรือมีช่องว่างซ้อน ต้องนับว่าซ้ำ ไม่สร้างหน้าตาเหมือนกันซ้ำ', async (t) => {
  // เดิมเทียบสตริงดิบ — แคปชั่นที่พิมพ์ด้วยคีย์บอร์ดแบบ NFD ถูกสร้างซ้ำหน้าตาเหมือนกันเป๊ะ (รีวิวเจอ 20/20)
  const a = await boot(t);
  const first = await post(a.base, '/api/captions/auto', { count: 100 });
  const total = first.added.length + first.left;   // จำนวนคู่คำทั้งหมดในคลังคำ
  const typed = first.added.map((c) => ({ ...c, message: c.message.normalize('NFD').replace(' ', '  ') }));
  const b = await boot(t, typed);
  const made = [];
  for (let i = 0; i < 10; i++) {
    const r = await post(b.base, '/api/captions/auto', { count: 100 });
    made.push(...r.added.map((c) => c.message));
    if (!r.left) break;
  }
  const have = new Set(first.added.map((c) => c.message.normalize('NFC')));
  assert.ok(made.every((m) => !have.has(m.normalize('NFC'))), 'ต้องไม่สร้างคำที่มีอยู่แล้วซ้ำ');
  assert.strictEqual(made.length, total - typed.length, 'ต้องสร้างได้ครบเฉพาะคู่ที่ยังไม่มี');
});

test('ใส่ลิงก์ปลายทาง: แคปชั่นต้องเป็น "ลิงก์" ขึ้นบรรทัดใหม่ "วลี" • ลิงก์แปลกต้องไม่ผ่าน', async (t) => {
  const { base, saved } = await boot(t);
  const r = await post(base, '/api/captions/auto', { count: 5, link: 'https://heylink.me/VtMwM/' });
  assert.strictEqual(r.added.length, 5);
  for (const c of r.added) {
    const [first, second, ...rest] = c.message.split('\n');
    assert.strictEqual(first, 'https://heylink.me/VtMwM/');
    assert.ok(second && second.split(' ').length <= 4 && !rest.length, c.message);
  }
  assert.ok(saved().every((c) => c.message.startsWith('https://heylink.me/VtMwM/\n')));
  // วลีเดิมกับลิงก์อื่น = คนละแคปชั่น ไม่นับว่าซ้ำ
  const r2 = await post(base, '/api/captions/auto', { count: 100, link: 'https://heylink.me/other/' });
  assert.strictEqual(r2.added.length, 100);
  for (const bad of ['javascript:alert(1)', 'heylink.me/x', 'https://a b']) {
    const res = await fetch(base + '/api/captions/auto', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 1, link: bad }) });
    assert.strictEqual(res.status, 400, bad);
  }
});
