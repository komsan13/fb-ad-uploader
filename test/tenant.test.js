// การเปิดเช่าแยก instance: จำกัด 1 FB profile ต่อ instance และ data directory หนึ่งต้องไม่เห็น Landing ของอีก instance
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get, post } = require('./helpers');

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
function runTenantDeploy(values) {
  const vars = Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  return spawnSync('bash', ['-lc', `${vars} bash tenant-deploy.sh`], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  });
}

describe('instance ผู้เช่า', () => {
  test('thumbnail ใน tenant ต้องเรียกผ่าน profile path เสมอ', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.strictEqual((ui.match(/tenantUrl\(['"]\/api\/library\/thumb\//g) || []).length, 4,
      'thumbnail ทุกจุดต้องผ่าน tenantUrl เพื่อไม่หลุดไป instance หลัก');
    assert.doesNotMatch(ui, /(?:src|\.src)\s*=\s*['"`]\/api\/library\/thumb\//,
      'ห้ามมี thumbnail URL ที่ขึ้นต้นจาก root โดยไม่เติม profile code');
  });

  test('create ต้องปฏิเสธ data directory เดิมก่อนแตะ docker หรือขอรหัส', (t) => {
    const relativeRoot = 'test';
    const root = path.join(__dirname, '..', relativeRoot);
    const code = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const oldData = path.join(root, code);
    t.after(() => fs.rmSync(oldData, { recursive: true, force: true }));
    fs.mkdirSync(oldData, { recursive: true });
    fs.writeFileSync(path.join(oldData, 'config.json'), '{"profiles":[{"accessToken":"old-token"}]}');
    const run = runTenantDeploy({ ACTION: 'create', PROFILE_CODE: code, DATA_ROOT: relativeRoot, TENANT_USER: 'shop-a' });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /data directory .*มีอยู่แล้ว/);
  });

  test('restore ต้องยืนยัน profile code เดิมก่อนแตะ docker', (t) => {
    const relativeRoot = 'test';
    const root = path.join(__dirname, '..', relativeRoot);
    const code = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
    const oldData = path.join(root, code);
    t.after(() => fs.rmSync(oldData, { recursive: true, force: true }));
    fs.mkdirSync(oldData, { recursive: true });
    fs.writeFileSync(path.join(oldData, 'config.json'), '{}');
    const run = runTenantDeploy({ ACTION: 'restore', PROFILE_CODE: code, DATA_ROOT: relativeRoot, TENANT_USER: 'shop-a' });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /RESTORE_CONFIRM/);
  });

  test('restore ที่ยืนยันแล้วต้องใช้ data เดิมและตั้ง Basic Auth ใหม่ผ่าน stdin', (t) => {
    const code = '0123456789abcdef0123456789abcdef';
    const relativeRoot = 'test/.tenant-restore-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const root = path.join(__dirname, '..', relativeRoot);
    const dataRoot = path.join(root, 'data');
    const dataDir = path.join(dataRoot, code);
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'commands.log');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"profiles":[{"accessToken":"old-token"}]}');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
{ printf 'docker'; printf ' <%s>' "$@"; printf '\\n'; } >> "$TEST_LOG"
case "\${1:-}:\${2:-}" in
  container:inspect) exit 1 ;;
  build:*|run:*|exec:*) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'htpasswd'), `#!/usr/bin/env bash
{ printf 'htpasswd'; printf ' <%s>' "$@"; printf '\\n'; } >> "$TEST_LOG"
IFS= read -r password
printf 'shop-a:fakehash\\n'
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const run = runTenantDeploy({
      ACTION: 'restore', PROFILE_CODE: code, RESTORE_CONFIRM: code,
      DATA_ROOT: relativeRoot + '/data', TENANT_USER: 'shop-a', TENANT_PASS: 'not-in-process-list-12345',
      TEST_LOG: relativeRoot + '/commands.log', PATH: relativeRoot + '/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    const commands = fs.readFileSync(log, 'utf8');
    assert.match(commands, /htpasswd <-i> <-nB> <shop-a>/);
    assert.doesNotMatch(commands, /not-in-process-list-12345/);
    assert.match(commands, new RegExp(`<PUBLIC_URL=https://ad\\.senball\\.com/p/${code}>`));
    assert.match(commands, new RegExp(`<${relativeRoot}/data/${code}:/data>`));
    assert.match(commands, new RegExp(`<traefik\\.http\\.routers\\.fbad-tenant-${code}\\.rule=`));
    assert.match(commands, /<traefik\.http\.middlewares\.fbad-tenant-.*\.basicauth\.users=shop-a:fakehash>/);
  });

  test('MAX_PROFILES=1 ป้องกันไม่ให้ผู้เช่าเพิ่ม profile FB ที่สอง', async (t) => {
    const fb = await makeFakeFb({});
    const dir = tmpDir();
    seed(dir, { config: {} });
    const srv = await startServer(dir, fb.port, { MAX_PROFILES: '1' });
    t.after(() => { srv.stop(); fb.server.close(); });

    const first = await post(srv.base, '/api/profiles', { label: 'ร้าน A' });
    assert.ok(first.id, 'ต้องเพิ่ม profile แรกได้');
    const second = await fetch(srv.base + '/api/profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'ร้าน B' }),
    });
    assert.strictEqual(second.status, 403, 'ผู้เช่าห้ามเพิ่ม profile ที่สอง');
    assert.match((await second.json()).error, /รองรับได้ 1 โปรไฟล์/);
  });

  test('data directory คนละตัวต้องมี Landing ของตัวเอง', async (t) => {
    const fb = await makeFakeFb({});
    const aDir = tmpDir(); const bDir = tmpDir();
    seed(aDir, { config: {} }); seed(bDir, { config: {} });
    const a = await startServer(aDir, fb.port);
    const b = await startServer(bDir, fb.port);
    t.after(() => { a.stop(); b.stop(); fb.server.close(); });

    await post(a.base, '/api/landing', { title: 'Landing ร้าน A' });
    await post(b.base, '/api/landing', { title: 'Landing ร้าน B' });
    const [aPage, bPage] = await Promise.all([
      fetch(a.base + '/lp').then((r) => r.text()), fetch(b.base + '/lp').then((r) => r.text()),
    ]);
    assert.ok(aPage.includes('Landing ร้าน A') && !aPage.includes('Landing ร้าน B'));
    assert.ok(bPage.includes('Landing ร้าน B') && !bPage.includes('Landing ร้าน A'));
    assert.strictEqual((await get(a.base, '/api/env')).publicUrl, a.base);
  });

  test('profile path ต้องเป็นฐานของ OAuth callback และ URL สาธารณะ', async (t) => {
    const fb = await makeFakeFb({});
    const dir = tmpDir();
    const code = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    seed(dir, { config: {} });
    const srv = await startServer(dir, fb.port, { PUBLIC_URL_PATH: '/p/' + code });
    t.after(() => { srv.stop(); fb.server.close(); });

    assert.strictEqual((await get(srv.base, '/api/env')).publicUrl, srv.base + '/p/' + code);
    const page = await (await fetch(srv.base + '/auth/callback?error=cancelled')).text();
    assert.ok(page.includes(`location.href="/p/${code}/"`), 'OAuth ที่เปิดตรงๆ ต้องกลับ instance เดิม ไม่ใช่ root');
  });
});
