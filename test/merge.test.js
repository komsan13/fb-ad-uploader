// เทสกติกา merge ของ saveApMerged ตรงๆ — บั๊ก P0 จากรีวิว 19 ก.ค. 2026 อยู่ที่นี่ทั้งคู่:
// ตัวนับเกราะกันแบนไม่สะสมข้าม tick และการล้างของผู้ใช้กลาง tick ถูกย้อน
// ต้องอยู่ไฟล์แยกเพราะกำหนด CONFIG_PATH ก่อน require server.js (node --test แยกโปรเซสต่อไฟล์)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbad-merge-'));
process.env.CONFIG_PATH = path.join(dir, 'config.json');
fs.writeFileSync(process.env.CONFIG_PATH, '{}');

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { loadAp, saveAp, apSnapshot, saveApMerged } = require('../server.js');

const statePath = path.join(dir, 'autopilot-state.json');
beforeEach(() => { fs.rmSync(statePath, { force: true }); });

test('ตัวนับ rejection ต้องสะสมข้าม tick ไม่ใช่โดนดิสก์ทับหาย', () => {
  const t1 = Date.now() - 1000, t2 = Date.now();

  // tick แรก: นับแอด A1
  const s1 = loadAp();
  const b1 = apSnapshot(s1);
  s1.counted.A1 = { v: 1, ts: t1 };
  s1.rejections['111'] = [t1];
  saveApMerged(s1, b1);

  // tick สอง: mark ของ A1 ต้องอยู่ (กันนับซ้ำ) และตัวนับต้องอยู่ด้วย — คู่กันเสมอ
  const s2 = loadAp();
  assert.ok(s2.counted.A1, 'mark กันนับซ้ำต้องอยู่');
  assert.strictEqual((s2.rejections['111'] || []).length, 1,
    'ตัวนับต้องอยู่คู่กับ mark — เวอร์ชันเก่าตัวนับหายแต่ mark อยู่ ทำให้เกราะ freeze ไม่มีวันถึงเกณฑ์');

  const b2 = apSnapshot(s2);
  s2.counted.A2 = { v: 1, ts: t2 };
  s2.rejections['111'] = s2.rejections['111'].concat(t2);
  saveApMerged(s2, b2);
  assert.strictEqual(loadAp().rejections['111'].length, 2, 'ต้องสะสมเป็น 2');
});

test('unfreeze กลาง tick: การล้างของผู้ใช้ชนะ ของที่ tick เพิ่งเขียนรอด และ log ไม่หาย', () => {
  // ดิสก์เริ่มต้น: บัญชีถูก freeze อยู่ มีตัวนับและ mark เก่า
  const d = loadAp();
  d.frozen['111'] = { since: 1, reason: 'x' };
  d.rejections['111'] = [Date.now() - 5000];
  d.reasonCounted.OLD = { v: 'หมวดเก่า', ts: Date.now() - 5000 };
  saveAp(d);

  // tick โหลด state แล้วเริ่มทำงาน
  const s = loadAp();
  const base = apSnapshot(s);
  s.reasonCounted.NEW = { v: 'หมวดใหม่', ts: Date.now() };        // tick เขียนใหม่รอบนี้
  s.frozen['222'] = { since: Date.now(), reason: 'freeze ใหม่' }; // tick เพิ่ง freeze อีกบัญชี
  s.log.unshift({ ts: Date.now() + 5, level: 'info', msg: 'จาก tick', acct: null });

  // ผู้ใช้กด unfreeze ระหว่าง tick วิ่ง (จำลองสิ่งที่ endpoint ทำเป๊ะๆ)
  const u = loadAp();
  delete u.frozen['111'];
  u.rejections['111'] = [];
  u.reasonCounted = {};
  u.log.unshift({ ts: Date.now() + 6, level: 'info', msg: 'ปลดล็อกบัญชี 111 ด้วยมือ', acct: '111' });
  saveAp(u);

  saveApMerged(s, base);
  const fin = loadAp();
  assert.ok(!fin.frozen['111'], 'ปลดล็อกของผู้ใช้ต้องรอด');
  assert.ok(fin.frozen['222'], 'freeze ที่ tick นี้เพิ่งตั้งต้องรอดเช่นกัน');
  assert.deepStrictEqual(fin.rejections['111'] || [], [], 'ตัวนับที่ผู้ใช้ล้างต้องไม่ฟื้นคืน');
  assert.ok(!fin.reasonCounted.OLD, 'mark เก่าที่ผู้ใช้ล้างต้องไม่ฟื้นคืน — ไม่งั้นแอดเก่าไม่ถูกนับใหม่');
  assert.ok(fin.reasonCounted.NEW, 'mark ที่ tick นี้เพิ่งเขียนต้องรอด');
  assert.ok(fin.log.some((l) => /ปลดล็อก/.test(l.msg)), 'บรรทัด audit ของผู้ใช้ต้องไม่หายเงียบ');
  assert.ok(fin.log.some((l) => l.msg === 'จาก tick'), 'บรรทัดของ tick ต้องอยู่ด้วย');
});

test('ของหมดอายุบนดิสก์ต้องไม่ฟื้นคืนผ่าน merge (ฐานมาจากดิสก์ที่ยังไม่ prune)', () => {
  const old = Date.now() - 70 * 24 * 3600 * 1000;
  const d = loadAp();
  d.counted.ANCIENT = { v: 1, ts: old };
  saveAp(d);

  const s = loadAp();
  const base = apSnapshot(s);
  saveApMerged(s, base);
  assert.ok(!loadAp().counted.ANCIENT, 'merge ต้อง prune ซ้ำ ไม่ให้ของเก่าเกิน 60 วันวนกลับมาทุกรอบ');
});
