const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

test('รากต้องเป็นหน้าเข้าสู่ระบบ และ dashboard อยู่ที่ /app', async (t) => {
  const { base } = await boot(t);
  const root = await fetch(base + '/');
  const rootHtml = await root.text();
  assert.strictEqual(root.status, 200);
  assert.match(rootHtml, /เข้าสู่พื้นที่ทำงาน/);
  assert.match(rootHtml, /href="\/app"/);
  assert.match(rootHtml, /data:image\/svg\+xml/, 'หน้า login ต้องฝัง favicon เพื่อไม่ให้ browser ขอ favicon ที่ถูกป้องกัน');

  const app = await fetch(base + '/app');
  const appHtml = await app.text();
  assert.strictEqual(app.status, 200);
  assert.match(appHtml, /FB Ad Uploader/, 'dashboard ต้องยังเปิดจากเส้นทางหลัง Basic Auth ได้');
});

test('หน้าเข้าสู่ระบบของ tenant ต้องพาไปยัง /p/<code>/app ไม่หลุดไป master', async (t) => {
  const code = 'a'.repeat(32);
  const { base } = await boot(t, { PUBLIC_URL_PATH: `/p/${code}` });
  const page = await (await fetch(base + '/')).text();
  assert.match(page, new RegExp(`href="/p/${code}/app"`));
});

test('Traefik เปิดเฉพาะ root entry ของ master และ tenant โดยให้ /app ยังอยู่หลัง Basic Auth', () => {
  const root = path.join(__dirname, '..');
  const master = fs.readFileSync(path.join(root, 'redeploy.sh'), 'utf8');
  const tenant = fs.readFileSync(path.join(root, 'tenant-deploy.sh'), 'utf8');
  assert.match(master, /Path\(`\/`\) \|\| Path\(`\/privacy\.html`\)/,
    'master root ต้องถึงหน้า login โดยไม่ผ่าน Basic Auth');
  assert.match(tenant, /Path\(\\`\/p\/\$\{PROFILE_CODE\}\\`\) \|\| Path\(\\`\/p\/\$\{PROFILE_CODE\}\/\\`\)/,
    'tenant root ต้องถึงหน้า login โดยไม่เปิด /app หรือ API เป็น public');
  assert.doesNotMatch(master, /Path\(`\/app`\)/, '/app ของ master ต้องยังอยู่หลัง Basic Auth');
  assert.doesNotMatch(tenant, /Path\(\\`\/p\/\$\{PROFILE_CODE\}\/app\\`\)/, '/app ของ tenant ต้องยังอยู่หลัง Basic Auth');
  assert.match(master, /MASTER_ENTRY_STATUS.*MASTER_APP_STATUS/s,
    'master deploy ต้องแยกตรวจหน้า entry public ออกจาก dashboard private');
  assert.match(master, /MASTER_ENTRY_STATUS" = "200".*MASTER_APP_STATUS" = "401"/s,
    'master deploy ต้องยอมให้ root เป็น 200 และบังคับ /app เป็น 401');
  assert.match(tenant, /ENTRY_STATUS.*APP_STATUS/s,
    'tenant deploy ต้องแยกตรวจหน้า entry public ออกจาก dashboard private');
  assert.match(tenant, /ENTRY_STATUS" = "200".*APP_STATUS" = "401"/s,
    'tenant deploy ต้องยอมให้ root เป็น 200 และบังคับ /app เป็น 401');
});
