// เทสตัวกลางหลายโปรไฟล์ (hub.js): รัน hub จริง ซึ่งสตาร์ท server.js หนึ่งตัวต่อโปรไฟล์ ชี้ FB ไปตัวปลอม
// ยืนยันว่าแต่ละโปรไฟล์แยกขาดกันจริง (ข้อมูลอยู่คนละโฟลเดอร์) และการสลับ/ลบ/หน้า Landing สาธารณะทำงาน
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed } = require('./helpers');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function bootHub(t) {
  const fb = await makeFakeFb({ accounts: [], pages: [] });
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'บัญชีของ TOP', accessToken: 'tok' }], activeProfileId: 'p1' } });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'hub.js')], {
    env: {
      ...process.env, PORT: String(port), CONFIG_PATH: path.join(dir, 'config.json'),
      FB_API_BASE: `http://127.0.0.1:${fb.port}`, FX_API_URL: `http://127.0.0.1:${fb.port}/fx`, PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  hub.stdout.on('data', (d) => { log += d; });
  hub.stderr.on('data', (d) => { log += d; });
  t.after(() => { hub.kill(); fb.server.close(); });
  // รอจนโปรไฟล์ TOP ตอบได้จริงผ่านตัวกลาง
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/env')).status === 200) break; } catch { /* ยังไม่ขึ้น */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  // ทุกคำขอส่ง cookie ที่ตัวกลางตั้งให้กลับไป เหมือนเบราว์เซอร์
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text };
  };
  return { base, dir, call, getLog: () => log, getCookie: () => cookie };
}

test('โปรไฟล์ TOP = ข้อมูลเดิมทั้งหมด • เพิ่มโปรไฟล์ใหม่แล้วข้อมูลแยกขาดจากกันจริง', async (t) => {
  const h = await bootHub(t);
  const list = (await h.call('GET', '/hub/api/workspaces')).json;
  assert.deepStrictEqual(list.list.map((w) => w.id), ['top']);
  assert.strictEqual(list.current, 'top');
  const top = (await h.call('GET', '/api/profiles')).json;
  assert.strictEqual(top.profiles[0].label, 'บัญชีของ TOP', 'TOP ต้องเห็นบัญชีเดิม (ไม่ย้ายข้อมูล)');

  const made = (await h.call('POST', '/hub/api/workspaces', { name: 'BRAND' })).json;
  assert.ok(made.ok, JSON.stringify(made));
  await h.call('POST', '/hub/api/select', { id: made.id });
  assert.match(h.getCookie(), new RegExp(`fbws=${made.id}`));
  const brand = (await h.call('GET', '/api/profiles')).json;
  assert.strictEqual(brand.profiles.length, 0, 'โปรไฟล์ใหม่ต้องว่าง ไม่เห็นบัญชีของ TOP');
  await h.call('POST', '/api/profiles', { label: 'บัญชีของ BRAND', accessToken: 'tok2' });

  // ข้อมูลอยู่คนละโฟลเดอร์จริง
  const brandCfg = JSON.parse(fs.readFileSync(path.join(h.dir, 'ws', made.id, 'config.json'), 'utf8'));
  assert.deepStrictEqual(brandCfg.profiles.map((p) => p.label), ['บัญชีของ BRAND']);
  const topCfg = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
  assert.deepStrictEqual(topCfg.profiles.map((p) => p.label), ['บัญชีของ TOP'], 'TOP ต้องไม่โดนแตะ');

  await h.call('POST', '/hub/api/select', { id: 'top' });
  assert.strictEqual((await h.call('GET', '/api/profiles')).json.profiles[0].label, 'บัญชีของ TOP');
  // ชื่อซ้ำ / ชื่อว่าง ต้องไม่ผ่าน
  assert.strictEqual((await h.call('POST', '/hub/api/workspaces', { name: 'brand' })).status, 400);
  assert.strictEqual((await h.call('POST', '/hub/api/workspaces', { name: '  ' })).status, 400);
});

test('หน้า Landing สาธารณะของโปรไฟล์อื่นอยู่ที่ /w/<id>/lp และรูปต้องโหลดจากโปรไฟล์นั้น', async (t) => {
  const h = await bootHub(t);
  const { id } = (await h.call('POST', '/hub/api/workspaces', { name: 'แบรนด์ลูก' })).json;
  await h.call('POST', '/hub/api/select', { id });
  // อัปโหลดรูปผ่านตัวกลาง (multipart ต้องส่งต่อแบบสตรีมได้)
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  const up = await (await fetch(h.base + '/api/landing/upload', { method: 'POST', body: form, headers: { cookie: h.getCookie() } })).json();
  assert.match(up.url, /^\/lp-asset\/[0-9a-f-]{36}\.png$/);
  const { rev, ws } = (await h.call('GET', '/api/landing')).json;   // บันทึกต้องส่ง rev + โปรไฟล์ ที่อ่านมาล่าสุด
  await h.call('POST', '/api/landing', { title: 'หน้าของแบรนด์ลูก', avatar: up.url, rev, ws });

  // คนกดแอดไม่มี cookie — เข้าทางลิงก์ /w/<id>/lp
  const page = await (await fetch(`${h.base}/w/${id}/lp`)).text();
  assert.ok(page.includes('หน้าของแบรนด์ลูก'), 'ต้องเป็นหน้า Landing ของโปรไฟล์นี้ ไม่ใช่ของ TOP');
  assert.ok(page.includes(`/w/${id}${up.url}`), 'ลิงก์รูปต้องชี้ไปที่โปรไฟล์นี้');
  const img = await fetch(`${h.base}/w/${id}${up.url}`);
  assert.strictEqual(img.status, 200, 'รูปต้องโหลดได้โดยไม่มี cookie');
  // หน้า Landing ของ TOP ยังเป็นของ TOP
  const topPage = await (await fetch(`${h.base}/lp`)).text();
  assert.ok(!topPage.includes('หน้าของแบรนด์ลูก'));
  // หน้าเว็บรู้ว่าหน้า Landing ของโปรไฟล์นี้อยู่ไหน
  assert.strictEqual((await h.call('GET', '/api/env')).json.lpUrl, `/w/${id}/lp`);
});

test('ลบโปรไฟล์: TOP ลบไม่ได้ • ตัวอื่นย้ายข้อมูลไปถังขยะ (ไม่ลบถาวร) และกลับไป TOP', async (t) => {
  const h = await bootHub(t);
  assert.strictEqual((await h.call('POST', '/hub/api/workspaces/delete', { id: 'top' })).status, 400);
  const { id } = (await h.call('POST', '/hub/api/workspaces', { name: 'ลบทิ้ง' })).json;
  await h.call('POST', '/hub/api/select', { id });
  await h.call('POST', '/api/profiles', { label: 'จะถูกย้าย', accessToken: 'x' });
  const del = await h.call('POST', '/hub/api/workspaces/delete', { id });
  assert.strictEqual(del.status, 200);
  assert.match(h.getCookie(), /fbws=top/, 'ลบตัวที่เลือกอยู่ = กลับไป TOP');
  assert.ok(!fs.existsSync(path.join(h.dir, 'ws', id)));
  const trashed = fs.readdirSync(path.join(h.dir, 'ws-trash')).find((n) => n.startsWith(id + '-'));
  assert.ok(trashed, 'ข้อมูลต้องอยู่ในถังขยะ');
  assert.ok(fs.readFileSync(path.join(h.dir, 'ws-trash', trashed, 'config.json'), 'utf8').includes('จะถูกย้าย'));
  const list = (await h.call('GET', '/hub/api/workspaces')).json;
  assert.deepStrictEqual(list.list.map((w) => w.id), ['top']);
  assert.strictEqual((await h.call('GET', '/api/profiles')).json.profiles[0].label, 'บัญชีของ TOP');
});

test('รีสตาร์ทตัวกลางแล้วโปรไฟล์ที่สร้างไว้ยังอยู่ครบ และ cookie ที่ชี้โปรไฟล์ที่ไม่มีแล้วต้องตกไป TOP', async (t) => {
  const h = await bootHub(t);
  const { id } = (await h.call('POST', '/hub/api/workspaces', { name: 'อยู่ถาวร' })).json;
  const reg = JSON.parse(fs.readFileSync(path.join(h.dir, 'workspaces.json'), 'utf8'));
  assert.ok(reg.list.some((w) => w.id === id && w.name === 'อยู่ถาวร'));
  const r = await fetch(h.base + '/api/profiles', { headers: { cookie: 'fbws=pdeadbe' } });
  assert.strictEqual((await r.json()).profiles[0].label, 'บัญชีของ TOP');
});
