// เกราะกลางของเซิร์ฟเวอร์ (รีวิว 12 ต.ค. 2026)
// 1) route แบบ async โยน error ต้องไม่ทำให้ทั้งโปรเซสดับ — เดิม Express 4 ปล่อยเป็น unhandled rejection → exit 1
//    ระบบอัตโนมัติ/บอท Telegram ดับไปด้วย (วัดจริง: /api/adset-copy กับ {"id":{"toString":1}})
// 2) หน้าดูข้อมูลบัญชี/สุขภาพ ห้ามยิง FB ระหว่าง Meta สั่งพัก — call ที่โดนกั้นต่อเวลาพักใหม่ autopilot หยุดยาว
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer } = require('./helpers');

const PROFILE = { id: 'p1', label: 'หนึ่ง', accessToken: 'TOKEN_P1' };

async function boot(t, { cooldown } = {}) {
  const fb = await makeFakeFb({ accounts: [{ id: 'act_111', account_id: '111', name: 'บัญชี 111', currency: 'THB', account_status: 1 }] });
  const dir = tmpDir();
  seed(dir, { config: { profiles: [PROFILE], activeProfile: 'p1' } });
  if (cooldown) fs.writeFileSync(path.join(dir, 'fb-cooldown.json'), JSON.stringify(cooldown));
  const srv = await startServer(dir, fb.port, { ANTHROPIC_API_KEY: '' });
  t.after(() => { srv.stop(); fb.server.close(); });
  return { ...srv, dir, fb };
}

test('body แปลกที่ทำ handler แบบ async พัง ต้องได้ 500 JSON และเซิร์ฟเวอร์ยังอยู่', async (t) => {
  const s = await boot(t);
  let exited = null;
  s.child.on('exit', (code) => { exited = code; });
  for (const p of ['/api/adset-copy', '/api/campaign-status', '/api/ai-advice']) {
    const r = await fetch(s.base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: { toString: 1 }, campaigns: [null], profile: 'p1' }),
    });
    assert.ok(r.status >= 400 && r.status < 600, `${p} ต้องตอบ error ไม่ใช่เงียบ (ได้ ${r.status})`);
    assert.match(r.headers.get('content-type') || '', /json/, `${p} ต้องตอบเป็น JSON ให้หน้าเว็บอ่านได้`);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(exited, null, 'โปรเซสต้องไม่ดับ');
  const alive = await fetch(s.base + '/api/autopilot');
  assert.strictEqual(alive.status, 200);
});

test('JSON ผิดรูปได้ 400 แบบ JSON ไม่ใช่หน้า HTML พร้อม stack trace', async (t) => {
  const s = await boot(t);
  const r = await fetch(s.base + '/api/hidden', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{เสีย' });
  assert.strictEqual(r.status, 400);
  const d = await r.json();
  assert.ok(d.error);
  assert.ok(!/at .*\.js:\d+/.test(JSON.stringify(d)), 'ห้ามส่ง stack trace ออกไป');
});

test('ระหว่าง Meta สั่งพัก /api/accounts และหน้าสุขภาพไม่ยิง FB และไม่ต่อเวลาพัก', async (t) => {
  const coolUntil = Date.now() + 20 * 60000;
  const s = await boot(t, { cooldown: { coolUntil, coolHard: true, appBlocks: {} } });
  const before = s.fb.world.calls.length;
  for (const p of ['/api/accounts?profile=p1', '/api/health-overview?profile=p1', '/api/account-health?profile=p1&account=111']) {
    const r = await fetch(s.base + p);
    assert.strictEqual(r.status, 503, p);
    const d = await r.json();
    assert.strictEqual(d.cooling, true, p);
    assert.match(d.error, /พัก/, p);
  }
  assert.strictEqual(s.fb.world.calls.length, before, 'ต้องไม่มี call ไปถึง FB เลย');
  const after = JSON.parse(fs.readFileSync(path.join(s.dir, 'fb-cooldown.json'), 'utf8'));
  assert.strictEqual(after.coolUntil, coolUntil, 'ช่วงพักต้องไม่ถูกต่อเวลา');
});

test('พ้นช่วงพักแล้ว /api/accounts ทำงานปกติ', async (t) => {
  const s = await boot(t, { cooldown: { coolUntil: Date.now() - 1000, coolHard: true, appBlocks: {} } });
  const r = await fetch(s.base + '/api/accounts?profile=p1');
  assert.strictEqual(r.status, 200);
});
