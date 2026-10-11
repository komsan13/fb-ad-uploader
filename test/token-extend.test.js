// เทสการต่ออายุ token ตอนบันทึกการ์ดบัญชี — token จาก Graph API Explorer อายุแค่ ~1 ชม.
// ถ้ารอ watchTick (ชั่วโมงละรอบ) token อาจหมดอายุก่อน แล้วต่ออายุไม่ได้อีกเลย
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, post, get } = require('./helpers');

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
// debug_token ของ token สั้นปกติ: ออกจากแอป app1 ใช้ได้ เหลือ 1 ชม.
const shortTok = (over = {}) => ({ data: { app_id: 'app1', is_valid: true, expires_at: now() + HOUR, ...over } });
// token ที่ได้จากการแลก — เซิร์ฟเวอร์ต้องตรวจตัวนี้ด้วย debug_token ก่อนอ้างว่าต่ออายุแล้ว
const longTok = (over = {}) => ({ data: { app_id: 'app1', is_valid: true, expires_at: now() + 60 * 24 * HOUR, ...over } });

// debug = คำตอบ debug_token ของ token ที่วาง • issued = คำตอบ debug_token ของ token ที่ได้จากการแลก (long-tok)
// pre(dir) = เตรียมไฟล์ก่อนบูตเซิร์ฟเวอร์ (เช่น สถานะโดน Meta สั่งพัก)
async function boot(t, profile, { debug = shortTok(), issued = longTok(), exchange = { access_token: 'long-tok' }, env, pre } = {}) {
  const world = {
    route: (m, p, params) => (p === 'debug_token' ? (params.input_token === 'long-tok' ? issued : debug)
      : p === 'oauth/access_token' ? exchange : null),
  };
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'เทส', adAccountId: '', pageId: '', ...profile }], activeProfileId: 'p1' } });
  if (pre) pre(dir);
  const srv = await startServer(dir, fb.port, env);
  t.after(() => { srv.stop(); fb.server.close(); });
  const token = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).profiles[0].accessToken;
  const calls = (p) => world.calls.filter((c) => c.path === p);
  return { base: srv.base, dir, token, calls, world };
}

test('วาง token สั้นในการ์ดที่มี App ID/Secret แล้ว ต้องได้ token 60 วันทันที', async (t) => {
  const { base, token, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1' });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.strictEqual(r.extended, true);
  assert.strictEqual(token(), 'long-tok');
  const [call] = calls('oauth/access_token');
  assert.strictEqual(call.params.grant_type, 'fb_exchange_token');
  assert.strictEqual(call.params.fb_exchange_token, 'short-tok');
  assert.strictEqual(call.params.client_id, 'app1');
  assert.strictEqual(call.params.client_secret, 'sec1');
});

test('ใส่ App Secret ทีหลัง token ก็ต้องแลกให้เหมือนกัน', async (t) => {
  const { base, token } = await boot(t, { appId: 'app1', accessToken: 'short-tok' });
  const r = await post(base, '/api/profiles/update', { id: 'p1', appSecret: 'sec1' });
  assert.strictEqual(r.extended, true);
  assert.strictEqual(token(), 'long-tok');
});

test('แลกไม่ผ่าน ต้องบอกเหตุผลจาก FB และเก็บ token ที่วางไว้ตามเดิม', async (t) => {
  const { base, token } = await boot(t, { appId: 'app1', appSecret: 'sec1' }, { exchange: { error: 'Error validating client secret' } });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.strictEqual(r.ok, true);
  assert.match(r.extendError, /client secret/);
  assert.strictEqual(token(), 'short-tok');
});

test('ข้อมูลยังไม่ครบ / แก้แค่ชื่อ / ส่ง App ID เดิมซ้ำ (ตอนกดล็อกอิน) ต้องไม่ยิงไปหา FB', async (t) => {
  const { base, calls } = await boot(t, { appId: 'app1', accessToken: 'tok' });
  await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'tok2' }); // ยังไม่มี secret
  await post(base, '/api/profiles/update', { id: 'p1', appSecret: 'sec1' });   // ครบ → ตรวจ+แลก 1 ครั้ง
  await post(base, '/api/profiles/update', { id: 'p1', label: 'ชื่อใหม่' });     // แก้ชื่อ → ไม่ยุ่ง
  await post(base, '/api/profiles/update', { id: 'p1', appId: 'app1' });        // ค่าเดิมซ้ำ → ไม่ยุ่ง
  // ตรวจ token ที่วาง 1 ครั้ง (ไม่นับการตรวจ token ใหม่ที่ได้จากการแลก)
  assert.strictEqual(calls('debug_token').filter((c) => c.params.input_token !== 'long-tok').length, 1);
  assert.strictEqual(calls('oauth/access_token').length, 1);
});

test('แก้แค่ App ID (ยังกรอก Secret ไม่เสร็จ) และบันทึกก่อนเปิดหน้าล็อกอิน ต้องไม่ตรวจ token', async (t) => {
  // เดิมตรวจทันทีด้วย App ID ใหม่คู่ Secret เก่า → ขึ้นแดง "App ID/Secret ใช้ไม่ได้" ระหว่างพิมพ์
  // และตอนกดล็อกอิน popup ค้างหน้าว่างรอ FB ตรวจ token ตัวเก่าที่กำลังจะถูกแทนอยู่แล้ว
  const { base, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1', accessToken: 'tok' });
  const r1 = await post(base, '/api/profiles/update', { id: 'p1', appId: 'app2' });
  const r2 = await post(base, '/api/profiles/update', { id: 'p1', appId: 'app3', appSecret: 'sec3', login: true });
  assert.ok(!r1.extendError && !r2.extendError);
  assert.strictEqual(calls('debug_token').length, 0);
});

test('FB ช้าแล้วกด "เชื่อมต่อ" ซ้ำด้วย token เดิม ต้องได้ลองต่ออายุจริง (ไม่ใช่ตอบ ok เงียบๆ)', async (t) => {
  const { base, token, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1', accessToken: 'short-tok' });
  const silent = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' }); // ค่าเดิมซ้ำ ไม่ได้กดปุ่ม
  assert.strictEqual(calls('debug_token').length, 0);
  assert.ok(!silent.extended);
  const r = await post(base, '/api/profiles/update', { id: 'p1', recheck: true });
  assert.strictEqual(r.extended, true);
  assert.strictEqual(token(), 'long-tok');
});

test('โดนจำกัดความถี่ ต้องไม่บอกว่า App ID/Secret ผิด • App Secret ผิดจริง (code 190) ต้องบอกว่า Secret ผิด', async (t) => {
  const throttled = await boot(t, { appId: 'app1', appSecret: 'sec1' }, { debug: { error: 'Application request limit reached', errorCode: 4 } });
  const r1 = await post(throttled.base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.match(r1.extendError, /จำกัดความถี่/);
  assert.doesNotMatch(r1.extendError, /Secret/);
  // ข้อความจริงจาก FB ตอน Secret ผิด (วัดแล้ว 12 ต.ค. 2026)
  const bad = await boot(t, { appId: 'app1', appSecret: 'wrong' }, { debug: { error: 'Invalid OAuth access token signature.', errorCode: 190 } });
  const r2 = await post(bad.base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.match(r2.extendError, /App ID\/Secret ใช้ไม่ได้/);
});

test('FB แลกแล้วได้ token ที่อายุไม่ได้ยาวขึ้น ต้องไม่อ้างว่าต่ออายุแล้ว และไม่ทับ token เดิม', async (t) => {
  const exp = now() + 5 * 24 * HOUR;
  const { base, token } = await boot(t, { appId: 'app1', appSecret: 'sec1' },
    { debug: shortTok({ expires_at: exp }), issued: shortTok({ expires_at: exp }) });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'old-long' });
  assert.ok(!r.extended);
  assert.match(r.extendError, /ไม่ได้ต่ออายุ/);
  assert.strictEqual(token(), 'old-long');
});

test('ต่ออายุสำเร็จ ต้องส่งวันหมดอายุจริงของ token ใหม่กลับไปให้หน้าเว็บโชว์', async (t) => {
  const exp = now() + 59 * 24 * HOUR;
  const { base } = await boot(t, { appId: 'app1', appSecret: 'sec1' }, { issued: longTok({ expires_at: exp }) });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.strictEqual(r.extended, true);
  assert.strictEqual(r.expiresAt, exp);
});

test('Meta สั่งพักการเรียกอยู่ ต้องไม่ยิง debug_token/แลก token และบอกเวลาที่พ้นช่วงพัก', async (t) => {
  const { base, calls, token } = await boot(t, { appId: 'app1', appSecret: 'sec1' }, {
    pre: (dir) => fs.writeFileSync(path.join(dir, 'fb-cooldown.json'), JSON.stringify({ coolUntil: Date.now() + 3600e3, coolHard: true })),
  });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.match(r.extendError, /สั่งพัก/);
  assert.strictEqual(calls('debug_token').length + calls('oauth/access_token').length, 0);
  assert.strictEqual(token(), 'short-tok', 'token ที่วางยังต้องถูกบันทึก');
});

test('รอบตรวจรายชั่วโมงต่ออายุ token เก่าอยู่ แล้วผู้ใช้วาง token ใหม่เข้ามา ต้องไม่โดนตัวเก่าทับ', async (t) => {
  const { base, token, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1', accessToken: 'old-tok' }, {
    // token เก่าเหลือ 5 วัน (ถึงเกณฑ์ต่ออายุ) • token ใหม่ที่ผู้ใช้วางเหลือ 50 วัน (ไม่ต้องแลก)
    debug: shortTok({ expires_at: now() + 5 * 24 * HOUR }),
    exchange: { access_token: 'long-tok', delay: 1500 },   // FB แลกช้า — ผู้ใช้วาง token ใหม่เข้ามาระหว่างนี้
    env: { WATCH_FIRST_DELAY_MS: '100' },
  });
  for (let i = 0; i < 50 && !calls('oauth/access_token').length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls('oauth/access_token').length, 1, 'รอบตรวจต้องเริ่มแลก token เก่าแล้ว');
  await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'new-tok', login: true });
  for (let i = 0; i < 60 && !calls('debug_token').some((c) => c.params.input_token === 'long-tok'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(token(), 'new-tok');
});

test('token ไม่หมดอายุ (System User) ต้องไม่ถูกแลกเป็นตัว 60 วัน', async (t) => {
  const { base, token, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1' }, { debug: shortTok({ expires_at: 0 }) });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'forever-tok' });
  assert.ok(!r.extended && !r.extendError, 'ไม่ต้องทำอะไร และไม่ใช่ error');
  assert.strictEqual(calls('oauth/access_token').length, 0);
  assert.strictEqual(token(), 'forever-tok');
});

test('token ที่ยังเหลือนาน (ต่ออายุมาแล้ว) ไม่ต้องแลกซ้ำ', async (t) => {
  const { base, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1' }, { debug: shortTok({ expires_at: now() + 50 * 24 * HOUR }) });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'long-already' });
  assert.ok(!r.extended && !r.extendError);
  assert.strictEqual(calls('oauth/access_token').length, 0);
});

test('token ออกจากแอปอื่น ต้องบอกตรงๆ ว่าคนละแอป ไม่ใช่เดาว่า secret ผิด', async (t) => {
  const { base, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1' }, { debug: shortTok({ app_id: '855299389015738' }) });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'other-app-tok' });
  assert.match(r.extendError, /855299389015738/);
  assert.strictEqual(calls('oauth/access_token').length, 0);
});

test('token หมดอายุแล้ว ต้องบอกให้ขอใหม่', async (t) => {
  const { base } = await boot(t, { appId: 'app1', appSecret: 'sec1' }, { debug: shortTok({ is_valid: false }) });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'dead-tok' });
  assert.match(r.extendError, /หมดอายุ/);
});

test('FB ตอบช้า ต้องตัดจบตามเวลาแล้วตอบหน้าเว็บ ไม่ค้าง และ token ที่วางยังบันทึกไว้', async (t) => {
  const { base, token } = await boot(t, { appId: 'app1', appSecret: 'sec1' },
    { debug: { ...shortTok(), delay: 3000 }, env: { FB_AUTH_TIMEOUT_MS: '300' } });
  const started = Date.now();
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.ok(Date.now() - started < 2000, `ต้องตอบภายในเวลา timeout ไม่ใช่รอ FB (ใช้ ${Date.now() - started}ms)`);
  assert.match(r.extendError, /ช้า/);
  assert.strictEqual(token(), 'short-tok');
});

test('บันทึก config ไม่ได้ (เช่นดิสก์เต็ม) ต้องตอบ error และเซิร์ฟเวอร์ต้องไม่ดับ', async (t) => {
  const { base, dir } = await boot(t, { appId: 'app1', appSecret: 'sec1' });
  // saveConfig เขียน config.json.tmp ก่อน rename — ทำให้ path นั้นเป็นโฟลเดอร์ การเขียนพังแน่นอน (แม้รันเป็น root)
  fs.mkdirSync(path.join(dir, 'config.json.tmp'));
  const res = await fetch(base + '/api/profiles/update', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p1', label: 'ชื่อใหม่' }),
  });
  assert.strictEqual(res.status, 500);
  assert.match((await res.json()).error, /บันทึกไม่สำเร็จ/);
  const alive = await get(base, '/api/profiles');
  assert.ok(Array.isArray(alive.profiles), 'เซิร์ฟเวอร์ต้องยังตอบได้ (เดิม unhandled rejection ทำ Node 20 ดับทั้งโปรเซส)');
});

test('วาง token ที่ใช้ไม่ได้ทับ token เดิมที่ยังใช้ได้ ต้องไม่บันทึก (ระบบอัตโนมัติต้องต่อ FB ได้ต่อ)', async (t) => {
  // เดิมบันทึกก่อนแล้วค่อยตรวจ — วางของเสียทีเดียว ตัวปิดแอดขาดทุนต่อ FB ไม่ได้ทันที
  const { base, token } = await boot(t, { appId: 'app1', appSecret: 'sec1', accessToken: 'good-60d' },
    { debug: shortTok({ is_valid: false }) });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'dead-tok' });
  assert.match(r.error, /ไม่ได้บันทึก token ใหม่/);
  assert.strictEqual(token(), 'good-60d');
  // คนละแอปก็เช่นกัน
  const b = await boot(t, { appId: 'app1', appSecret: 'sec1', accessToken: 'good-60d' }, { debug: shortTok({ app_id: '999' }) });
  const r2 = await post(b.base, '/api/profiles/update', { id: 'p1', accessToken: 'other-app' });
  assert.match(r2.error, /แอป 999/);
  assert.strictEqual(b.token(), 'good-60d');
});

test('ตรวจ token ใหม่หลังแลกไม่ได้เพราะโดนจำกัดความถี่ ต้องบอกให้ลองใหม่ ไม่ใช่ว่า token ใช้ไม่ได้', async (t) => {
  const { base, token } = await boot(t, { appId: 'app1', appSecret: 'sec1' },
    { issued: { error: 'Application request limit reached', errorCode: 4 } });
  const r = await post(base, '/api/profiles/update', { id: 'p1', accessToken: 'short-tok' });
  assert.ok(!r.extended);
  assert.match(r.extendError, /เชื่อมต่อ" อีกครั้ง/);
  assert.doesNotMatch(r.extendError, /ใช้ไม่ได้กลับมา/);
  assert.strictEqual(token(), 'short-tok', 'ยังยืนยัน token ใหม่ไม่ได้ = ไม่เขียน');
});

test('โดนจำกัดความถี่ครั้งหนึ่งแล้ว กด "เชื่อมต่อ" ซ้ำต้องไม่ยิง FB อีก (พักตามที่ Meta สั่ง)', async (t) => {
  const { base, calls } = await boot(t, { appId: 'app1', appSecret: 'sec1', accessToken: 'tok' },
    { debug: { error: 'Application request limit reached', errorCode: 4 } });
  await post(base, '/api/profiles/update', { id: 'p1', recheck: true });
  const r = await post(base, '/api/profiles/update', { id: 'p1', recheck: true });
  assert.match(r.extendError, /สั่งพัก/);
  assert.strictEqual(calls('debug_token').length, 1);
});
