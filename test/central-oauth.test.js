const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createProvisioner } = require('../tenant-provisioner');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer } = require('./helpers');

const controlToken = 'c'.repeat(64);
const projectRoot = path.join(__dirname, '..');
const listen = (server, target) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(target, () => { server.off('error', reject); resolve(); });
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const unixSocket = (root) => process.platform === 'win32'
  ? `\\\\.\\pipe\\fbad-central-oauth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  : path.join(root, 'provisioner.sock');
const socketRequest = (socketPath, method, target, body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body || {});
  const req = http.request({ socketPath, method, path: target, headers: {
    authorization: `Bearer ${controlToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
  } }, (res) => {
    let raw = '';
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
  });
  req.on('error', reject);
  req.end(payload);
});

test('deploy เปิดเฉพาะ callback กลาง และไม่ส่ง App Secret เข้า tenant container', () => {
  const masterDeploy = fs.readFileSync(path.join(projectRoot, 'redeploy.sh'), 'utf8');
  const tenantDeploy = fs.readFileSync(path.join(projectRoot, 'tenant-deploy.sh'), 'utf8');
  assert.match(masterDeploy, /Path\(`\/oauth\/facebook\/callback`\)/, 'callback ต้องข้าม Basic Auth ได้เฉพาะ path ที่เจาะจง');
  assert.match(masterDeploy, /Path\(`\/oauth\/review`\)/, 'หน้าทดสอบ App Review ต้องข้าม Basic Auth แบบจำกัด path');
  assert.match(masterDeploy, /--env-file "\$CENTRAL_OAUTH_ENV"/, 'App Secret ต้องเข้าฝั่ง master ผ่านไฟล์ secret ไม่ใช่ command argument');
  assert.match(tenantDeploy, /TENANT_OAUTH_ARGS\+=\(-e "FB_APP_ID=\$FB_APP_ID"/, 'tenant ต้องได้เพียง App ID');
  const tenantDockerRun = tenantDeploy.slice(tenantDeploy.indexOf('if ! docker run'));
  assert.doesNotMatch(tenantDockerRun, /FB_APP_SECRET/, 'tenant docker run ห้ามได้รับ App Secret');
  assert.match(fs.readFileSync(path.join(projectRoot, 'systemd', 'fbad-provisioner.service'), 'utf8'), /EnvironmentFile=-\/etc\/fbad-oauth\/central\.env/, 'root provisioner ต้องถือ secret เพื่อหมุน token แทน tenant');
  assert.match(fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8'), /e\.origin !== location\.origin/, 'popup ต้องยอมรับข้อความเสร็จสิ้นเฉพาะ origin เดียวกัน');
});

test('หน้า App Review ขอเฉพาะ ads_read และไม่บันทึก token หรือเปิด tenant', async (t) => {
  const masterDir = tmpDir();
  seed(masterDir, { config: {} });
  const fb = await makeFakeFb({ route: (method, requestPath, params) => {
    if (method === 'GET' && requestPath === 'oauth/access_token') {
      return params.grant_type === 'fb_exchange_token'
        ? { access_token: 'review-long-token-0123456789' }
        : { access_token: 'review-short-token-0123456789' };
    }
    return null;
  } });
  const master = await startServer(masterDir, fb.port, {
    // review flow ไม่เรียก provisioner แต่ master ต้องมองว่า central OAuth ถูกเปิดครบ
    TENANT_PROVISIONER_SOCKET: 'review-test-provisioner.sock', TENANT_PROVISIONER_TOKEN: controlToken,
    FB_APP_ID: '12345678', FB_APP_SECRET: 'b'.repeat(32), CENTRAL_OAUTH_ENABLED: '1',
  });
  t.after(async () => {
    master.stop(); fb.server.close(); fs.rmSync(masterDir, { recursive: true, force: true });
  });

  assert.match(await (await fetch(master.base + '/oauth/review')).text(), /Facebook Login สำหรับการตรวจสอบ Meta/);
  const start = await fetch(master.base + '/oauth/review/login', { redirect: 'manual' });
  assert.strictEqual(start.status, 302);
  const loginUrl = new URL(start.headers.get('location'));
  assert.strictEqual(loginUrl.searchParams.get('scope'), 'ads_read');
  const state = loginUrl.searchParams.get('state');
  assert.match(state, /^review\.[a-f0-9]{64}$/);
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const done = await fetch(`${master.base}/oauth/facebook/callback?code=review-code&state=${encodeURIComponent(state)}`, { headers: { cookie } });
  assert.match(await done.text(), /ไม่ได้เก็บ token จากการตรวจสอบนี้/);
  assert.ok(!fs.readFileSync(path.join(masterDir, 'config.json'), 'utf8').includes('review-long-token'), 'token ของ reviewer ห้ามถูกเก็บใน config');
});

test('App กลางแลก token ที่ master แล้วส่งกลับ tenant ที่เริ่ม login เท่านั้น', async (t) => {
  const root = tmpDir();
  const code = 'a'.repeat(32);
  const tenantDir = path.join(root, code);
  const registryPath = path.join(root, 'registry.json');
  const deployScript = path.join(root, 'tenant-deploy.sh');
  fs.mkdirSync(tenantDir, { recursive: true });
  seed(tenantDir, { config: {
    activeProfileId: 'p1', profiles: [{ id: 'p1', label: 'ร้าน A', accessToken: 'legacy-token', appId: 'old-app', appSecret: 'old-secret' }],
  } });
  fs.writeFileSync(deployScript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(registryPath, JSON.stringify({ tenants: [{
    code, displayName: 'ร้าน A', ownerName: 'เจ้าของ', ownerEmail: 'a@example.com', plan: '', expiresAt: null,
    status: 'active', adminUrl: `https://ad.senball.com/p/${code}/`, landingUrl: `https://ad.senball.com/p/${code}/lp`,
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z', revision: 1,
  }] }));
  const socket = unixSocket(root);
  const provisioner = createProvisioner({
    token: controlToken, socketPath: socket, deployScript, registryPath, auditPath: path.join(root, 'audit.jsonl'),
    dataRoot: root, archiveRoot: path.join(root, 'archive'), deployLock: path.join(root, 'deploy.lock'),
    image: 'sha256:' + 'a'.repeat(64), run: async () => ({ stdout: '', stderr: '' }),
  });
  await listen(provisioner.server, socket);
  const fb = await makeFakeFb({ route: (method, requestPath, params) => {
    if (method === 'GET' && requestPath === 'oauth/access_token') {
      return params.grant_type === 'fb_exchange_token'
        ? { access_token: 'central-long-token-0123456789' }
        : { access_token: 'central-short-token-0123456789' };
    }
    return null;
  } });
  const masterDir = tmpDir();
  seed(masterDir, { config: {} });
  const master = await startServer(masterDir, fb.port, {
    TENANT_PROVISIONER_SOCKET: socket, TENANT_PROVISIONER_TOKEN: controlToken,
    FB_APP_ID: '12345678', FB_APP_SECRET: 'b'.repeat(32), CENTRAL_OAUTH_ENABLED: '1',
  });
  const tenant = await startServer(tenantDir, fb.port, {
    MAX_PROFILES: '1', TENANT_CODE: code, PUBLIC_URL_PATH: `/p/${code}`,
    FB_APP_ID: '12345678', CENTRAL_OAUTH_ENABLED: '1', CENTRAL_OAUTH_REDIRECT_URI: `${master.base}/oauth/facebook/callback`,
  });
  t.after(async () => {
    master.stop(); tenant.stop(); await close(provisioner.server); fb.server.close();
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(masterDir, { recursive: true, force: true });
    if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
  });

  const login = await fetch(tenant.base + '/auth/login?profile=p1', { redirect: 'manual' });
  const loginUrl = new URL(login.headers.get('location'));
  const state = loginUrl.searchParams.get('state');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(state, new RegExp(`^${code}\\.[a-f0-9]{64}$`));
  assert.strictEqual(loginUrl.searchParams.get('redirect_uri'), `${master.base}/oauth/facebook/callback`);

  // เริ่ม flow ซ้อนกัน: state เก่าห้ามเขียนทับ token ของ flow ใหม่ แม้ master เพิ่งแลก code ของมันเสร็จ.
  assert.strictEqual((await socketRequest(socket, 'POST', `/v1/tenants/${code}/oauth/consume`, { state })).status, 200);
  const newerLogin = await fetch(tenant.base + '/auth/login?profile=p1', { redirect: 'manual' });
  const newerState = new URL(newerLogin.headers.get('location')).searchParams.get('state');
  assert.strictEqual((await socketRequest(socket, 'POST', `/v1/tenants/${code}/oauth/consume`, { state: newerState })).status, 200);
  const staleStore = await socketRequest(socket, 'POST', `/v1/tenants/${code}/oauth/store-token`, { state, accessToken: 'central-stale-token-0123456789' });
  assert.strictEqual(staleStore.status, 409, 'flow เก่าที่เสร็จช้ากว่าห้ามทับ flow ล่าสุด');
  const freshStore = await socketRequest(socket, 'POST', `/v1/tenants/${code}/oauth/store-token`, { state: newerState, accessToken: 'central-newer-token-0123456789' });
  assert.strictEqual(freshStore.status, 200);

  const finalLogin = await fetch(tenant.base + '/auth/login?profile=p1', { redirect: 'manual' });
  const finalState = new URL(finalLogin.headers.get('location')).searchParams.get('state');
  const finalCookie = finalLogin.headers.get('set-cookie').split(';')[0];

  const completed = await fetch(`${master.base}/oauth/facebook/callback?code=facebook-code&state=${encodeURIComponent(finalState)}`, { headers: { cookie: finalCookie } });
  assert.match(await completed.text(), /เชื่อมต่อสำเร็จ/);
  const config = JSON.parse(fs.readFileSync(path.join(tenantDir, 'config.json'), 'utf8'));
  assert.strictEqual(config.profiles[0].accessToken, 'central-long-token-0123456789');
  assert.strictEqual(config.profiles[0].oauthProvider, 'central');
  assert.ok(!config.profiles[0].centralOAuth && !config.profiles[0].appId && !config.profiles[0].appSecret);
  assert.strictEqual(fb.world.calls.filter((call) => call.path === 'oauth/access_token').length, 2);
  assert.ok(!fs.readFileSync(registryPath, 'utf8').includes('central-long-token-0123456789'), 'registry ของสมาชิกห้ามเก็บ token');

  const replay = await fetch(`${master.base}/oauth/facebook/callback?code=facebook-code&state=${encodeURIComponent(finalState)}`, { headers: { cookie: finalCookie } });
  assert.match(await replay.text(), /หมดอายุ|ใช้ไปแล้ว/);
  assert.strictEqual(fb.world.calls.filter((call) => call.path === 'oauth/access_token').length, 2, 'state ที่ใช้แล้วห้ามไปแลก token ซ้ำ');
});

test('root provisioner หมุนเฉพาะ token App กลางที่ใกล้หมดและไม่ทับการ login ใหม่', async (t) => {
  const root = tmpDir();
  const code = 'd'.repeat(32);
  const tenantDir = path.join(root, code);
  const registryPath = path.join(root, 'registry.json');
  const deployScript = path.join(root, 'tenant-deploy.sh');
  fs.mkdirSync(tenantDir, { recursive: true });
  seed(tenantDir, { config: { activeProfileId: 'p1', profiles: [{ id: 'p1', accessToken: 'central-old-token-0123456789', oauthProvider: 'central' }] } });
  fs.writeFileSync(deployScript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(registryPath, JSON.stringify({ tenants: [{ code, displayName: 'ร้าน D', ownerName: 'D', ownerEmail: 'd@example.com', plan: '', expiresAt: null, status: 'active', createdAt: '', updatedAt: '', revision: 1 }] }));
  const fb = await makeFakeFb({ route: (method, requestPath) => {
    if (method === 'GET' && requestPath === 'debug_token') return { data: { expires_at: Math.floor(Date.now() / 1000) + 60 } };
    if (method === 'GET' && requestPath === 'oauth/access_token') return { access_token: 'central-refreshed-token-0123456789' };
    return null;
  } });
  const provisioner = createProvisioner({
    token: controlToken, deployScript, registryPath, auditPath: path.join(root, 'audit.jsonl'), dataRoot: root,
    archiveRoot: path.join(root, 'archive'), deployLock: path.join(root, 'deploy.lock'), image: 'sha256:' + 'd'.repeat(64),
    fbApiBase: `http://127.0.0.1:${fb.port}`, centralAppId: '12345678', centralAppSecret: 'c'.repeat(32), run: async () => ({ stdout: '', stderr: '' }),
  });
  t.after(() => { fb.server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const result = await provisioner.refreshCentralOAuthTokens();
  assert.deepStrictEqual(result, { checked: 1, renewed: 1, configured: true });
  const config = JSON.parse(fs.readFileSync(path.join(tenantDir, 'config.json'), 'utf8'));
  assert.strictEqual(config.profiles[0].accessToken, 'central-refreshed-token-0123456789');
  assert.ok(config.profiles[0].centralOAuthRefreshedAt);
  assert.ok(!fs.readFileSync(registryPath, 'utf8').includes('central-refreshed-token-0123456789'));
});
