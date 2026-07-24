const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer } = require('./helpers');

async function boot(t, extraEnv = {}) {
  const fb = await makeFakeFb({});
  const dir = tmpDir();
  seed(dir, { config: {} });
  const srv = await startServer(dir, fb.port, extraEnv);
  t.after(() => { srv.stop(); fb.server.close(); });
  return srv;
}

test('รากต้องเป็นหน้าเข้าสู่ระบบด้วยฟอร์ม และไม่ใส่รหัสผ่านไว้ใน URL', async (t) => {
  const { base } = await boot(t);
  const root = await fetch(base + '/');
  const rootHtml = await root.text();
  assert.strictEqual(root.status, 200);
  assert.match(rootHtml, /เข้าสู่พื้นที่ทำงาน/);
  assert.match(rootHtml, /id="loginForm"/);
  assert.match(rootHtml, /type="password"/);
  assert.match(rootHtml, /credentials:'same-origin'/);
  assert.doesNotMatch(rootHtml, /https?:\/\/[^\s"']+:[^\s"']+@/, 'ห้ามส่งรหัสผ่านผ่าน URL');
  assert.match(rootHtml, /data:image\/svg\+xml/, 'หน้า login ต้องฝัง favicon เพื่อไม่ให้ browser ขอ favicon ที่ถูกป้องกัน');

  const login = await fetch(base + '/login');
  assert.strictEqual(login.status, 200);
  assert.match(await login.text(), /id="loginForm"/);

  const app = await fetch(base + '/app');
  const appHtml = await app.text();
  assert.strictEqual(app.status, 200);
  assert.match(appHtml, /FB Ad Uploader/, 'dashboard ต้องยังเปิดจากเส้นทางหลัง Basic Auth ได้');
});

test('หน้าเข้าสู่ระบบของ tenant ส่ง form กลับเข้า profile เดิม', async (t) => {
  const code = 'a'.repeat(32);
  const { base } = await boot(t, { PUBLIC_URL_PATH: `/p/${code}` });
  const page = await (await fetch(base + '/')).text();
  assert.match(page, new RegExp(`const loginUrl="/p/${code}/login"`));
  assert.match(page, new RegExp(`const next="/p/${code}/app"`));
});

test('form login ตรวจ hash เดิมและออก HttpOnly session สำหรับ route ที่ Traefik ทำเครื่องหมาย', async (t) => {
  const authHash = `tester:${bcrypt.hashSync('password', 4)}`;
  const { base } = await boot(t, { APP_AUTH_HASH: authHash });
  const sessionRoute = { 'x-fbad-session-route': '1' };

  const noSession = await fetch(base + '/app', { redirect: 'manual', headers: sessionRoute });
  assert.strictEqual(noSession.status, 303);
  assert.strictEqual(noSession.headers.get('location'), '/');
  const blockedApi = await fetch(base + '/api/env', { headers: sessionRoute });
  assert.strictEqual(blockedApi.status, 401);

  const bad = await fetch(base + '/login', { method: 'POST', headers: { ...sessionRoute, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'wrong' }) });
  assert.strictEqual(bad.status, 401);
  const good = await fetch(base + '/login', { method: 'POST', headers: { ...sessionRoute, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'password' }) });
  assert.strictEqual(good.status, 200);
  const cookie = good.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const app = await fetch(base + '/app', { headers: { ...sessionRoute, cookie: cookie.split(';', 1)[0] } });
  assert.strictEqual(app.status, 200);
  const api = await fetch(base + '/api/env', { headers: { ...sessionRoute, cookie: cookie.split(';', 1)[0] } });
  assert.strictEqual(api.status, 200);
});

test('Traefik เปิดเฉพาะ form/app/API ที่ต้องใช้ session และเก็บ Basic Auth ไว้กับเส้นทางอื่น', () => {
  const root = path.join(__dirname, '..');
  const master = fs.readFileSync(path.join(root, 'redeploy.sh'), 'utf8');
  const tenant = fs.readFileSync(path.join(root, 'tenant-deploy.sh'), 'utf8');
  assert.match(master, /Path\(`\/`\) \|\| Path\(`\/login`\) \|\| Path\(`\/login\/`\) \|\| Path\(`\/app`\)/,
    'master root ต้องถึงหน้า login โดยไม่ผ่าน Basic Auth');
  assert.match(tenant, /Path\(\\`\/p\/\$\{PROFILE_CODE\}\\`\) \|\| Path\(\\`\/p\/\$\{PROFILE_CODE\}\/\\`\) \|\| Path\(\\`\/p\/\$\{PROFILE_CODE\}\/login\\`\) \|\| Path\(\\`\/p\/\$\{PROFILE_CODE\}\/login\/\\`\) \|\| Path\(\\`\/p\/\$\{PROFILE_CODE\}\/app\\`\)/,
    'tenant ต้องเปิดเฉพาะเส้นทางที่ server ตรวจ session');
  assert.match(master, /APP_AUTH_HASH=\$HASH/);
  assert.match(tenant, /APP_AUTH_HASH=\$\{AUTH_HASH\}/);
  assert.match(master, /fbad-session-route\.headers\.customrequestheaders\.X-Fbad-Session-Route=1/);
  assert.match(tenant, /session-route\.headers\.customrequestheaders\.X-Fbad-Session-Route=1/);
  assert.match(master, /MASTER_APP_STATUS" = "303".*MASTER_API_STATUS" = "401"/s,
    'master deploy ต้องตรวจว่า dashboard ไม่มี session กลับหน้า login และ API ยังปิดอยู่');
  assert.match(tenant, /APP_STATUS" = "303".*API_STATUS" = "401"/s,
    'tenant deploy ต้องตรวจว่า dashboard ไม่มี session กลับหน้า login และ API ยังปิดอยู่');
  assert.match(master, /realm=fbad-master-login-v2/,
    'ต้องเปลี่ยน Basic Auth realm เพื่อให้ browser ที่เคยยกเลิก challenge แสดงกล่อง login ใหม่');
  assert.match(tenant, /realm=fbad-tenant-\$\{PROFILE_CODE\}-login-v2/,
    'tenant ต้องมี realm ใหม่ของตัวเองเพื่อไม่แชร์ session กับ master');
});
