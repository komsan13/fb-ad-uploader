// กันเว็บอื่นแอบสั่งงานแทนผู้ใช้ (CSRF) — basic auth ที่เบราว์เซอร์จำไว้ถูกแนบไปกับฟอร์มข้ามเว็บได้
// รีวิวเจอจริง: ฟอร์ม text/plain จากเว็บอื่นยิง /api/ai-key แล้ว key ถูกล้างเป็นค่าว่าง
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer } = require('./helpers');

describe('คำสั่งที่มาจากเว็บอื่นต้องไม่ถูกทำ', () => {
  let fbSrv, srv, dir;
  const keyOnDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).anthropicKey;
  const post = (headers, body = '{"key":"sk-ใหม่"}', type = 'application/json') => fetch(srv.base + '/api/ai-key', {
    method: 'POST', headers: { 'content-type': type, ...headers }, body,
  });

  before(async () => {
    dir = tmpDir();
    seed(dir, { config: { anthropicKey: 'sk-เดิม', profiles: [] } });
    fbSrv = await makeFakeFb({});
    srv = await startServer(dir, fbSrv.port, { ANTHROPIC_API_KEY: '' });
  });
  after(() => { srv.stop(); fbSrv.server.close(); });

  test('ฟอร์ม text/plain จากเว็บอื่น (Sec-Fetch-Site: cross-site) = 403 และ key เดิมยังอยู่', async () => {
    const r = await post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, 'x=1', 'text/plain');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(keyOnDisk(), 'sk-เดิม');
  });

  test('Origin ของเว็บอื่นโดยไม่มี Sec-Fetch-Site = 403', async () => {
    const r = await post({ origin: 'https://evil.example' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(keyOnDisk(), 'sk-เดิม');
  });

  test('subdomain ข้างเคียง (same-site) และ origin "null" ก็ไม่ผ่าน', async () => {
    assert.strictEqual((await post({ origin: 'https://other.senball.com', 'sec-fetch-site': 'same-site' })).status, 403);
    assert.strictEqual((await post({ origin: 'null' })).status, 403);
    assert.strictEqual(keyOnDisk(), 'sk-เดิม');
  });

  test('หน้าเว็บของเราเอง (Origin ตรงกับ Host, same-origin) ยังบันทึกได้', async () => {
    const r = await post({ origin: srv.base, 'sec-fetch-site': 'same-origin' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(keyOnDisk(), 'sk-ใหม่');
  });

  test('ส่วนขยาย Chrome (chrome-extension://) ยังส่งวงเงินเข้ามาได้ — ไม่โดนเกราะนี้บล็อก', async () => {
    const r = await fetch(srv.base + '/api/am-limits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop', 'sec-fetch-site': 'none' },
      body: JSON.stringify({ limits: [] }),
    });
    assert.notStrictEqual(r.status, 403);
  });

  test('GET ไม่โดนบล็อก (อ่านอย่างเดียว)', async () => {
    const r = await fetch(srv.base + '/api/ai-key', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.strictEqual(r.status, 200);
  });
});
