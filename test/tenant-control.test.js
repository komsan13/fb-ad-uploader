const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createProvisioner, tenantInput } = require('../tenant-provisioner');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer } = require('./helpers');

const token = 'a'.repeat(64);
const listen = (server, target) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(target, () => { server.off('error', reject); resolve(); });
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const unixSocket = (name) => process.platform === 'win32'
  ? `\\\\.\\pipe\\${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  : path.join(tmpDir(), `${name}.sock`);

test('วันหมดอายุต้องเป็นวันที่จริง ไม่ใช่แค่รูปแบบที่ดูเหมือนถูก', () => {
  assert.throws(() => tenantInput({ displayName: 'ร้าน', ownerName: 'คนดูแล', ownerEmail: 'owner@example.com', expiresAt: '2026-02-30' }), /วันที่จริง/);
});

describe('tenant provisioner', () => {
  test('สร้าง/ระงับ/archive/restore โดยไม่เก็บรหัสผ่านหรือข้อมูล Docker ไว้ในแอดมินหลัก', async (t) => {
    const root = tmpDir();
    const deployScript = path.join(root, 'tenant-deploy.sh');
    fs.writeFileSync(deployScript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
    assert.throws(() => createProvisioner({ token, deployScript, image: 'fbad:latest' }), /image digest/);
    const calls = [];
    const networks = new Set();
    const containers = new Set();
    let failRestore = false;
    let failStart = false;
    let failRm = false;
    const provisioner = createProvisioner({
      token, socketPath: unixSocket('provisioner'), deployScript,
      registryPath: path.join(root, 'registry.json'), auditPath: path.join(root, 'audit.jsonl'),
      dataRoot: path.join(root, 'data'), archiveRoot: path.join(root, 'archive'),
      image: 'sha256:' + 'b'.repeat(64),
      run: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (!networks.has(args[2])) throw new Error('network not found');
          return { stdout: args.includes('--format') ? '{}' : '', stderr: '' };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'create') networks.add(args[2]);
        if (command === 'docker' && args[0] === 'network' && args[1] === 'rm') networks.delete(args[2]);
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          if (!containers.has(args[2])) throw new Error('container not found');
        }
        if (command === 'docker' && args[0] === 'rm' && failRm) throw new Error('container remove failed');
        if (command === 'docker' && args[0] === 'rm') containers.delete(args.at(-1));
        if (command === 'docker' && args[0] === 'start' && failStart) throw new Error('container start failed');
        if (command === 'bash' && failRestore && options.env.ACTION === 'restore') throw new Error('deploy restore failed');
        if (command === 'bash') containers.add(`fbad-tenant-${options.env.PROFILE_CODE}`);
        return { stdout: '', stderr: '' };
      },
    });
    await listen(provisioner.server, 0);
    const port = provisioner.server.address().port;
    const req = async (url, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
      return { status: response.status, body: await response.json() };
    };
    t.after(async () => { await close(provisioner.server); fs.rmSync(root, { recursive: true, force: true }); });

    const created = await req('/v1/tenants', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        displayName: 'ร้านทดสอบ', ownerName: 'เจ้าของร้าน', ownerEmail: 'owner@example.com', plan: 'Pro',
        username: 'shop-owner', password: 'secret-password-123',
      }),
    });
    assert.strictEqual(created.status, 201);
    const tenant = created.body.tenant;
    assert.match(tenant.code, /^[a-f0-9]{32}$/);
    assert.strictEqual(tenant.status, 'active');
    assert.ok(calls.some((call) => call.command === 'docker' && call.args.join(' ') === `network create fbad-tenant-net-${tenant.code}`));
    const deploy = calls.find((call) => call.command === 'bash');
    assert.strictEqual(deploy.options.env.SKIP_BUILD, '1');
    assert.strictEqual(deploy.options.env.NETWORK, `fbad-tenant-net-${tenant.code}`);
    assert.strictEqual(deploy.options.env.TENANT_PASS_STDIN, '1');
    assert.strictEqual(deploy.options.input, 'secret-password-123\n');
    const stored = fs.readFileSync(path.join(root, 'registry.json'), 'utf8');
    assert.ok(!stored.includes('secret-password-123') && !stored.includes('shop-owner'));

    const suspended = await req(`/v1/tenants/${tenant.code}/actions/suspend-access`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: tenant.revision, confirm: 'SUSPEND_ACCESS' }),
    });
    assert.strictEqual(suspended.status, 200);
    assert.strictEqual(suspended.body.tenant.status, 'access_suspended');
    assert.ok(!fs.readFileSync(path.join(root, 'registry.json'), 'utf8').includes('suspended-'));

    fs.mkdirSync(path.join(root, 'data', tenant.code), { recursive: true });
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (from === path.join(root, 'data', tenant.code) && to === path.join(root, 'archive', tenant.code)) {
        const error = new Error('disk full'); error.code = 'ENOSPC'; throw error;
      }
      return originalRename(from, to);
    };
    const failedArchive = await req(`/v1/tenants/${tenant.code}/actions/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: suspended.body.tenant.revision, confirm: 'ARCHIVE_TENANT' }),
    });
    fs.renameSync = originalRename;
    assert.strictEqual(failedArchive.status, 500);
    assert.ok(fs.existsSync(path.join(root, 'data', tenant.code)), 'archive ย้าย data ไม่สำเร็จต้องคง data เดิม');
    assert.ok(calls.some((call) => call.command === 'docker' && call.args.join(' ') === `start fbad-tenant-${tenant.code}`), 'archive ย้าย data ไม่สำเร็จต้อง start container เดิมกลับ');

    failStart = true;
    fs.renameSync = (from, to) => {
      if (from === path.join(root, 'data', tenant.code) && to === path.join(root, 'archive', tenant.code)) {
        const error = new Error('disk full'); error.code = 'ENOSPC'; throw error;
      }
      return originalRename(from, to);
    };
    const rollbackFailed = await req(`/v1/tenants/${tenant.code}/actions/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: suspended.body.tenant.revision, confirm: 'ARCHIVE_TENANT' }),
    });
    fs.renameSync = originalRename;
    assert.strictEqual(rollbackFailed.status, 502);
    const recovery = await req(`/v1/tenants/${tenant.code}`);
    assert.strictEqual(recovery.body.tenant.status, 'archive_recovery', 'rollback start ล้มเหลวต้องไม่คงสถานะ active หลอกตา');
    failStart = false;
    const recovered = await req(`/v1/tenants/${tenant.code}/actions/recover-archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: recovery.body.tenant.revision }),
    });
    assert.strictEqual(recovered.body.tenant.status, 'active');

    failRm = true; failStart = true;
    fs.renameSync = (from, to) => {
      if (from === path.join(root, 'archive', tenant.code) && to === path.join(root, 'data', tenant.code)) {
        const error = new Error('reverse move failed'); error.code = 'EACCES'; throw error;
      }
      return originalRename(from, to);
    };
    const removeRollbackFailed = await req(`/v1/tenants/${tenant.code}/actions/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: recovered.body.tenant.revision, confirm: 'ARCHIVE_TENANT' }),
    });
    fs.renameSync = originalRename;
    assert.strictEqual(removeRollbackFailed.status, 502);
    const removeRecovery = await req(`/v1/tenants/${tenant.code}`);
    assert.strictEqual(removeRecovery.body.tenant.status, 'archive_recovery', 'docker rm + start rollback ล้มเหลวต้องไม่คง active');
    assert.ok(fs.existsSync(path.join(root, 'archive', tenant.code)) && !fs.existsSync(path.join(root, 'data', tenant.code)), 'reverse move ล้มเหลวต้องคง data ใน archive ไว้ชัดเจน');
    failRm = false; failStart = false;
    const recoveredAgain = await req(`/v1/tenants/${tenant.code}/actions/recover-archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: removeRecovery.body.tenant.revision }),
    });
    assert.strictEqual(recoveredAgain.body.tenant.status, 'active');
    assert.ok(fs.existsSync(path.join(root, 'data', tenant.code)) && !fs.existsSync(path.join(root, 'archive', tenant.code)), 'recover ต้องย้าย data กลับก่อนประกาศ active');

    const archived = await req(`/v1/tenants/${tenant.code}/actions/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: recoveredAgain.body.tenant.revision, confirm: 'ARCHIVE_TENANT' }),
    });
    assert.strictEqual(archived.status, 200);
    assert.strictEqual(archived.body.tenant.status, 'archived');
    assert.ok(fs.existsSync(path.join(root, 'archive', tenant.code)));

    failRestore = true;
    const failedRestore = await req(`/v1/tenants/${tenant.code}/actions/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        revision: archived.body.tenant.revision, username: 'shop-owner', password: 'fresh-password-123',
      }),
    });
    assert.strictEqual(failedRestore.status, 500);
    assert.ok(fs.existsSync(path.join(root, 'archive', tenant.code)), 'restore ที่ล้มเหลวต้องย้าย data กลับ archive ให้ retry ได้');
    assert.ok(!fs.existsSync(path.join(root, 'data', tenant.code)));

    failRestore = false;
    const restored = await req(`/v1/tenants/${tenant.code}/actions/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        revision: archived.body.tenant.revision, username: 'shop-owner', password: 'fresh-password-123',
      }),
    });
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(restored.body.tenant.status, 'restored_hold');
    assert.strictEqual(calls.filter((call) => call.command === 'bash').at(-1).options.env.AUTOPILOT_HOLD, '1');

    const badRelease = await req(`/v1/tenants/${tenant.code}/actions/release-hold`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: restored.body.tenant.revision, confirm: 'no' }),
    });
    assert.strictEqual(badRelease.status, 400);
    const released = await req(`/v1/tenants/${tenant.code}/actions/release-hold`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: restored.body.tenant.revision, confirm: 'ENABLE_AUTOPILOT' }),
    });
    assert.strictEqual(released.status, 200);
    assert.strictEqual(released.body.tenant.status, 'active');
    assert.strictEqual(calls.filter((call) => call.command === 'bash').at(-1).options.env.AUTOPILOT_HOLD, '0');
  });

  test('สร้างครั้งแรกสะดุดแล้ว retry ด้วย profile code เดิมได้โดยไม่ลบ data', async (t) => {
    const root = tmpDir(); const deployScript = path.join(root, 'tenant-deploy.sh');
    fs.writeFileSync(deployScript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
    const calls = []; const networks = new Set(); let failCreate = true;
    const provisioner = createProvisioner({
      token, socketPath: unixSocket('retry-provision'), deployScript, image: 'sha256:' + 'c'.repeat(64),
      registryPath: path.join(root, 'registry.json'), auditPath: path.join(root, 'audit.jsonl'),
      dataRoot: path.join(root, 'data'), archiveRoot: path.join(root, 'archive'),
      run: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (!networks.has(args[2])) throw new Error('network not found');
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'create') networks.add(args[2]);
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') throw new Error('container not found');
        if (command === 'bash' && options.env.ACTION === 'create' && failCreate) {
          fs.mkdirSync(path.join(root, 'data', options.env.PROFILE_CODE), { recursive: true });
          throw new Error('docker run failed');
        }
        return { stdout: '', stderr: '' };
      },
    });
    await listen(provisioner.server, 0);
    const port = provisioner.server.address().port;
    const req = async (url, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
      return { status: response.status, body: await response.json() };
    };
    t.after(async () => { await close(provisioner.server); fs.rmSync(root, { recursive: true, force: true }); });

    const failed = await req('/v1/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      displayName: 'ร้าน retry', ownerName: 'เจ้าของ', ownerEmail: 'retry@example.com', username: 'retry-owner', password: 'retry-password-123',
    }) });
    assert.strictEqual(failed.status, 500);
    const listed = await req('/v1/tenants');
    const tenant = listed.body.tenants[0];
    assert.strictEqual(tenant.status, 'failed');
    assert.ok(fs.existsSync(path.join(root, 'data', tenant.code)));

    failCreate = false;
    const retried = await req(`/v1/tenants/${tenant.code}/actions/retry-provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      revision: tenant.revision, username: 'retry-owner', password: 'retry-password-new-123',
    }) });
    assert.strictEqual(retried.status, 200);
    assert.strictEqual(retried.body.tenant.status, 'active');
    assert.strictEqual(calls.filter((call) => call.command === 'bash').at(-1).options.env.ACTION, 'retry-create');
  });

  test('ลบถาวรได้เฉพาะรายการ failed หลังยืนยัน profile code และเก็บกวาด resource ที่ค้าง', async (t) => {
    const root = tmpDir(); const deployScript = path.join(root, 'tenant-deploy.sh');
    fs.writeFileSync(deployScript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
    const calls = []; const networks = new Set(); const containers = new Set();
    const provisioner = createProvisioner({
      token, socketPath: unixSocket('delete-failed'), deployScript, image: 'sha256:' + 'd'.repeat(64),
      registryPath: path.join(root, 'registry.json'), auditPath: path.join(root, 'audit.jsonl'),
      dataRoot: path.join(root, 'data'), archiveRoot: path.join(root, 'archive'),
      run: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (!networks.has(args[2])) throw new Error('network not found');
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'create') networks.add(args[2]);
        if (command === 'docker' && args[0] === 'network' && args[1] === 'rm') networks.delete(args[2]);
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          if (!containers.has(args[2])) throw new Error('container not found');
        }
        if (command === 'docker' && args[0] === 'rm') containers.delete(args.at(-1));
        if (command === 'bash' && options.env.ACTION === 'create') {
          fs.mkdirSync(path.join(root, 'data', options.env.PROFILE_CODE), { recursive: true });
          containers.add(`fbad-tenant-${options.env.PROFILE_CODE}`);
          throw new Error('docker run failed');
        }
        return { stdout: '', stderr: '' };
      },
    });
    await listen(provisioner.server, 0);
    const port = provisioner.server.address().port;
    const req = async (url, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
      return { status: response.status, body: await response.json() };
    };
    t.after(async () => { await close(provisioner.server); fs.rmSync(root, { recursive: true, force: true }); });

    const create = await req('/v1/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      displayName: 'ร้านลบทดสอบ', ownerName: 'เจ้าของ', ownerEmail: 'delete@example.com', username: 'delete-owner', password: 'delete-password-123',
    }) });
    assert.strictEqual(create.status, 500);
    const listed = await req('/v1/tenants'); const failed = listed.body.tenants[0];
    assert.strictEqual(failed.status, 'failed');
    assert.ok(fs.existsSync(path.join(root, 'data', failed.code)));
    fs.mkdirSync(path.join(root, 'archive', failed.code), { recursive: true });
    fs.writeFileSync(path.join(root, 'archive', failed.code, 'leftover.txt'), 'leftover');

    const wrongConfirm = await req(`/v1/tenants/${failed.code}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: failed.revision, confirm: 'wrong-code' }) });
    assert.strictEqual(wrongConfirm.status, 400);
    assert.ok(fs.existsSync(path.join(root, 'data', failed.code)), 'ยืนยันผิดต้องไม่แตะ data');

    const deleted = await req(`/v1/tenants/${failed.code}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: failed.revision, confirm: failed.code }) });
    assert.strictEqual(deleted.status, 200);
    assert.deepStrictEqual(deleted.body, { deleted: true, code: failed.code });
    assert.ok(!fs.existsSync(path.join(root, 'data', failed.code)), 'ลบสำเร็จต้องล้าง data ที่ค้าง');
    assert.ok(!fs.existsSync(path.join(root, 'archive', failed.code)), 'ลบสำเร็จต้องล้าง archive data ที่ค้าง');
    assert.ok(calls.some((call) => call.command === 'docker' && call.args.join(' ') === `rm -f fbad-tenant-${failed.code}`));
    assert.ok(calls.some((call) => call.command === 'docker' && call.args.join(' ') === `network disconnect -f fbad-tenant-net-${failed.code} traefik-traefik-1`));
    assert.ok(calls.some((call) => call.command === 'docker' && call.args.join(' ') === `network rm fbad-tenant-net-${failed.code}`));
    assert.deepStrictEqual((await req('/v1/tenants')).body.tenants, []);
    assert.match(fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8'), /"action":"delete-failed"/);
  });

  test('ปฏิเสธการลบถาวรของสมาชิกที่ไม่ได้อยู่สถานะ failed', async (t) => {
    const root = tmpDir(); const code = 'e'.repeat(32); const registryPath = path.join(root, 'registry.json');
    const deployScript = path.join(root, 'tenant-deploy.sh');
    fs.writeFileSync(deployScript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(registryPath, JSON.stringify({ tenants: [{
      code, displayName: 'ร้านที่ใช้งาน', ownerName: 'เจ้าของ', ownerEmail: 'active@example.com', plan: '', expiresAt: null,
      status: 'active', adminUrl: 'https://ad.senball.com/p/' + code + '/', landingUrl: 'https://ad.senball.com/p/' + code + '/lp',
      createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z', revision: 1,
    }] }));
    const provisioner = createProvisioner({
      token, socketPath: unixSocket('delete-active'), deployScript, image: 'sha256:' + 'e'.repeat(64),
      registryPath, auditPath: path.join(root, 'audit.jsonl'), dataRoot: path.join(root, 'data'), archiveRoot: path.join(root, 'archive'),
      run: async () => ({ stdout: '', stderr: '' }),
    });
    await listen(provisioner.server, 0);
    const port = provisioner.server.address().port;
    t.after(async () => { await close(provisioner.server); fs.rmSync(root, { recursive: true, force: true }); });
    const response = await fetch(`http://127.0.0.1:${port}/v1/tenants/${code}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 1, confirm: code }),
    });
    assert.strictEqual(response.status, 409);
    assert.ok(fs.readFileSync(registryPath, 'utf8').includes(code), 'รายการ active ต้องอยู่ครบ');
  });
});

describe('master tenant-control API', () => {
  test('proxy ส่งเฉพาะ request ที่ whitelist ไป provisioner และ tenant instance ใช้ไม่ได้', async (t) => {
    const socket = unixSocket('master-proxy');
    const upstreamCalls = [];
    const upstream = http.createServer(async (req, res) => {
      let raw = ''; for await (const part of req) raw += part;
      upstreamCalls.push({ url: req.url, method: req.method, auth: req.headers.authorization, raw });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/tenants' && req.method === 'GET') return res.end(JSON.stringify({ tenants: [{ code: 'a'.repeat(32), status: 'active' }] }));
      if (req.url === '/v1/tenants' && req.method === 'POST') return res.statusCode = 201, res.end(JSON.stringify({ tenant: { code: 'b'.repeat(32), status: 'active' } }));
      if (req.url === `/v1/tenants/${'b'.repeat(32)}` && req.method === 'DELETE') return res.end(JSON.stringify({ deleted: true, code: 'b'.repeat(32) }));
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    });
    await listen(upstream, socket);
    const fb = await makeFakeFb({}); const masterDir = tmpDir(); const tenantDir = tmpDir();
    seed(masterDir, { config: {} }); seed(tenantDir, { config: {} });
    const master = await startServer(masterDir, fb.port, { TENANT_PROVISIONER_SOCKET: socket, TENANT_PROVISIONER_TOKEN: token });
    const tenant = await startServer(tenantDir, fb.port, { MAX_PROFILES: '1', TENANT_PROVISIONER_SOCKET: socket, TENANT_PROVISIONER_TOKEN: token });
    t.after(async () => { master.stop(); tenant.stop(); await close(upstream); fb.server.close(); if (process.platform !== 'win32') fs.rmSync(socket, { force: true }); });

    const controlResponse = await fetch(master.base + '/api/tenant-control');
    const control = await controlResponse.json();
    const csrfCookie = controlResponse.headers.get('set-cookie').split(';')[0];
    assert.strictEqual(control.enabled, true);
    assert.match(control.csrfToken, /^[a-f0-9]{64}$/);
    const memberPage = await fetch(master.base + '/members');
    assert.strictEqual(memberPage.status, 200, 'master ต้องเปิดลิงก์ตรง /members ได้');
    assert.match(await memberPage.text(), /id="page-members"/, 'ลิงก์ตรงต้องคืนหน้าแอดมินหลัก');
    const memberHeaders = { 'content-type': 'application/json', origin: master.base, cookie: csrfCookie, 'x-tenant-control-csrf': control.csrfToken };
    const listed = await (await fetch(master.base + '/api/tenants')).json();
    assert.strictEqual(listed.tenants[0].code, 'a'.repeat(32));
    const crossSite = await fetch(master.base + '/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify({ displayName: 'ร้านใหม่' }) });
    assert.strictEqual(crossSite.status, 403);
    const formPost = await fetch(master.base + '/api/tenants', { method: 'POST', headers: { origin: master.base }, body: 'displayName=ร้านใหม่' });
    assert.strictEqual(formPost.status, 415);
    const created = await fetch(master.base + '/api/tenants', { method: 'POST', headers: memberHeaders, body: JSON.stringify({ displayName: 'ร้านใหม่' }) });
    assert.strictEqual(created.status, 201);
    const deleted = await fetch(master.base + `/api/tenants/${'b'.repeat(32)}`, { method: 'DELETE', headers: memberHeaders, body: JSON.stringify({ revision: 7, confirm: 'b'.repeat(32) }) });
    assert.strictEqual(deleted.status, 200);
    assert.deepStrictEqual(upstreamCalls.map((call) => [call.method, call.url]), [['GET', '/v1/tenants'], ['POST', '/v1/tenants'], ['DELETE', `/v1/tenants/${'b'.repeat(32)}`]]);
    assert.ok(upstreamCalls.every((call) => call.auth === `Bearer ${token}`));
    assert.match(upstreamCalls[1].raw, /ร้านใหม่/);
    const tenantControl = await (await fetch(tenant.base + '/api/tenant-control')).json();
    assert.deepStrictEqual(tenantControl, { enabled: false, csrfToken: null });
    assert.strictEqual((await fetch(tenant.base + '/members')).status, 404, 'tenant instance ห้ามมี route จัดการสมาชิก');
    const tenantDenied = await fetch(tenant.base + '/api/tenants');
    assert.strictEqual(tenantDenied.status, 503);
    assert.strictEqual(upstreamCalls.length, 3, 'tenant instance ห้ามส่ง request ไป provisioner แม้มี socket env');
  });
});

test('instance ที่ restore แล้วต้อง hold autopilot จนกว่าจะปลดผ่าน control plane', async (t) => {
  const fb = await makeFakeFb({}); const dir = tmpDir();
  seed(dir, { config: { autopilot: { enabled: true } } });
  const srv = await startServer(dir, fb.port, { MAX_PROFILES: '1', AUTOPILOT_HOLD: '1' });
  t.after(() => { srv.stop(); fb.server.close(); });
  const state = await (await fetch(srv.base + '/api/autopilot')).json();
  assert.strictEqual(state.serviceHold, true);
  const enable = await fetch(srv.base + '/api/autopilot', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.strictEqual(enable.status, 423);
  const run = await fetch(srv.base + '/api/autopilot/run', { method: 'POST' });
  assert.strictEqual(run.status, 423);
});
