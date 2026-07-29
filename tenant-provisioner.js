// Root-only control plane สำหรับ tenant instances
// เว็บแอดมินคุยผ่าน Unix socket + bearer token เท่านั้น และไม่มีสิทธิ์ Docker/socket โดยตรง
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CODE_RE = /^[a-f0-9]{32}$/;
const USER_RE = /^[A-Za-z0-9._-]{3,64}$/;
const ACTIONS = new Set(['suspend-access', 'resume-access', 'reset-password', 'archive', 'restore', 'release-hold', 'retry-provision', 'recover-archive']);

function safeText(value, field, max, required = false) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) throw Object.assign(new Error(`${field} จำเป็นต้องระบุ`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${field} ยาวเกิน ${max} ตัวอักษร`), { status: 400 });
  return text;
}
function validExpiry(value) {
  const text = String(value == null ? '' : value).trim();
  if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw Object.assign(new Error('วันหมดอายุต้องเป็น YYYY-MM-DD'), { status: 400 });
  if (text) {
    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw Object.assign(new Error('วันหมดอายุไม่ใช่วันที่จริง'), { status: 400 });
  }
  return text || null;
}
function credentials(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USER_RE.test(username)) throw Object.assign(new Error('username ใช้ A-Z, a-z, 0-9, ., _, - และยาว 3-64 ตัว'), { status: 400 });
  if (password.length < 12) throw Object.assign(new Error('รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร'), { status: 400 });
  return { username, password };
}
function tenantInput(body) {
  const ownerEmail = safeText(body.ownerEmail, 'อีเมลผู้ดูแล', 254, true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw Object.assign(new Error('อีเมลผู้ดูแลไม่ถูกต้อง'), { status: 400 });
  return {
    displayName: safeText(body.displayName, 'ชื่อร้าน/สมาชิก', 120, true),
    ownerName: safeText(body.ownerName, 'ชื่อผู้ดูแล', 120, true),
    ownerEmail,
    plan: safeText(body.plan, 'แพ็กเกจ', 80),
    expiresAt: validExpiry(body.expiresAt),
  };
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; let raw = '';
    req.setEncoding('utf8');
    req.on('data', (part) => {
      size += Buffer.byteLength(part);
      if (size > 32 * 1024) return reject(Object.assign(new Error('request ใหญ่เกินกำหนด'), { status: 413 }));
      raw += part;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('JSON ไม่ถูกต้อง'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.on('data', (part) => { stderr += part; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${command} ${args[0] || ''} ล้มเหลว${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`);
      error.status = 502;
      reject(error);
    });
    if (options.input != null) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
function readRegistry(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value.tenants) ? value : { tenants: [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { tenants: [] };
    throw error;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function publicTenant(tenant) {
  return {
    code: tenant.code,
    displayName: tenant.displayName,
    ownerName: tenant.ownerName,
    ownerEmail: tenant.ownerEmail,
    plan: tenant.plan || '',
    expiresAt: tenant.expiresAt || null,
    status: tenant.status,
    adminUrl: tenant.adminUrl,
    landingUrl: tenant.landingUrl,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    revision: tenant.revision,
  };
}

function createProvisioner(overrides = {}) {
  const cfg = {
    socketPath: overrides.socketPath || process.env.PROVISIONER_SOCKET || '/run/fbad-provisioner.sock',
    token: overrides.token || process.env.PROVISIONER_TOKEN || '',
    registryPath: overrides.registryPath || process.env.PROVISIONER_REGISTRY || '/opt/fbad-provisioner/tenants.json',
    auditPath: overrides.auditPath || process.env.PROVISIONER_AUDIT || '/opt/fbad-provisioner/audit.jsonl',
    deployScript: overrides.deployScript || process.env.TENANT_DEPLOY_SCRIPT || path.join(__dirname, 'tenant-deploy.sh'),
    domain: overrides.domain || process.env.TENANT_DOMAIN || 'ad.senball.com',
    dataRoot: overrides.dataRoot || process.env.TENANT_DATA_ROOT || '/opt/fbad-tenants',
    archiveRoot: overrides.archiveRoot || process.env.TENANT_ARCHIVE_ROOT || '/opt/fbad-tenants-archive',
    image: overrides.image || process.env.TENANT_IMAGE || 'fbad:latest',
    traefikContainer: overrides.traefikContainer || process.env.TRAEFIK_CONTAINER || 'traefik-traefik-1',
    run: overrides.run || run,
  };
  if (!cfg.token || cfg.token.length < 32) throw new Error('PROVISIONER_TOKEN ต้องมีอย่างน้อย 32 ตัวอักษร');
  if (!fs.existsSync(cfg.deployScript)) throw new Error(`ไม่พบ TENANT_DEPLOY_SCRIPT: ${cfg.deployScript}`);
  if (!/^(?:[A-Za-z0-9._/-]+@)?sha256:[a-f0-9]{64}$/i.test(cfg.image)) {
    throw new Error('TENANT_IMAGE ต้องเป็น image digest ที่ตรึงแล้ว เช่น sha256:<64-hex> หรือ registry/app@sha256:<64-hex>');
  }
  let registry = readRegistry(cfg.registryPath);
  const locks = new Set();

  const save = () => writeJson(cfg.registryPath, registry);
  const audit = (action, tenant, extra = {}) => {
    fs.mkdirSync(path.dirname(cfg.auditPath), { recursive: true, mode: 0o700 });
    const entry = { at: new Date().toISOString(), action, code: tenant.code, status: tenant.status, ...extra };
    fs.appendFileSync(cfg.auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  };
  const markArchiveRecovery = (tenant, message) => {
    tenant.status = 'archive_recovery';
    tenant.updatedAt = new Date().toISOString();
    tenant.revision += 1;
    save();
    audit('archive:rollback-failed', tenant, { message: String(message || '').slice(0, 300) });
  };
  const find = (code) => registry.tenants.find((tenant) => tenant.code === code);
  const mutate = async (tenant, action, fn) => {
    if (locks.has(tenant.code)) throw Object.assign(new Error('กำลังดำเนินการกับสมาชิกนี้อยู่'), { status: 409 });
    locks.add(tenant.code);
    try {
      const result = await fn();
      tenant.updatedAt = new Date().toISOString();
      tenant.revision += 1;
      save();
      audit(action, tenant);
      return result;
    } catch (error) {
      audit(`${action}:failed`, tenant, { message: String(error.message || '').slice(0, 300) });
      throw error;
    } finally {
      locks.delete(tenant.code);
    }
  };
  const network = (code) => `fbad-tenant-net-${code}`;
  const container = (code) => `fbad-tenant-${code}`;
  const tenantDataPath = (root, code) => {
    const base = path.resolve(root);
    const target = path.resolve(base, code);
    if (path.dirname(target) !== base) throw Object.assign(new Error('เส้นทางข้อมูลผู้เช่าไม่ปลอดภัย'), { status: 500 });
    return target;
  };
  const tenantEnv = (tenant, action, auth, hold = false) => ({
    ...process.env,
    ACTION: action,
    PROFILE_CODE: tenant.code,
    DOMAIN: cfg.domain,
    NETWORK: network(tenant.code),
    DATA_ROOT: cfg.dataRoot,
    TENANT_IMAGE: cfg.image,
    SKIP_BUILD: '1',
    AUTOPILOT_HOLD: hold ? '1' : '0',
    RESTORE_CONFIRM: action === 'restore' ? tenant.code : '',
    TENANT_USER: auth.username,
    TENANT_PASS_STDIN: '1',
  });
  const deploy = (tenant, action, auth, hold = false) => cfg.run('bash', [cfg.deployScript], {
    env: tenantEnv(tenant, action, auth, hold), input: `${auth.password}\n`,
  });
  const docker = (args) => cfg.run('docker', args);
  const createNetwork = async (tenant) => {
    const net = network(tenant.code);
    try { await docker(['network', 'inspect', net]); }
    catch { await docker(['network', 'create', net]); }
    try { await docker(['network', 'connect', net, cfg.traefikContainer]); }
    catch (error) {
      // retry หลัง process ตายระหว่าง restore: connect ซ้ำจะ error แต่ inspect ยืนยันว่า Traefik อยู่ใน network แล้วได้
      const inspected = await docker(['network', 'inspect', net, '--format', '{{json .Containers}}']);
      let attached = false;
      try { attached = Object.values(JSON.parse(inspected.stdout || '{}')).some((item) => item && item.Name === cfg.traefikContainer); } catch { /* ใช้ error เดิม */ }
      if (!attached) throw error;
    }
  };
  const containerExists = async (tenant) => {
    try { await docker(['container', 'inspect', container(tenant.code)]); return true; }
    catch { return false; }
  };
  const networkExists = async (tenant) => {
    try { await docker(['network', 'inspect', network(tenant.code)]); return true; }
    catch { return false; }
  };
  const bestEffort = async (args) => { try { await docker(args); } catch { /* cleanup failure must not hide recoverable data */ } };

  const handler = async (req, res) => {
    try {
      const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(supplied); const b = Buffer.from(cfg.token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 401, { error: 'ไม่ได้รับอนุญาต' });
      const url = new URL(req.url, 'http://provisioner.local');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/v1/tenants') {
        return json(res, 200, { tenants: registry.tenants.map(publicTenant).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
      }
      if (parts[0] !== 'v1' || parts[1] !== 'tenants') return json(res, 404, { error: 'ไม่พบ endpoint' });
      if (req.method === 'POST' && parts.length === 2) {
        const body = await readBody(req);
        const info = tenantInput(body); const auth = credentials(body);
        const code = crypto.randomBytes(16).toString('hex');
        const now = new Date().toISOString();
        const tenant = {
          ...info, code, status: 'provisioning', createdAt: now, updatedAt: now, revision: 1,
          adminUrl: `https://${cfg.domain}/p/${code}/`, landingUrl: `https://${cfg.domain}/p/${code}/lp`,
        };
        registry.tenants.push(tenant); save(); audit('create:started', tenant);
        try {
          await mutate(tenant, 'create', async () => {
            await createNetwork(tenant);
            await deploy(tenant, 'create', auth);
            tenant.status = 'active';
          });
        } catch (error) {
          tenant.status = 'failed'; tenant.updatedAt = new Date().toISOString(); tenant.revision += 1; save();
          throw error;
        }
        return json(res, 201, { tenant: publicTenant(tenant) });
      }
      const code = parts[2] || '';
      if (!CODE_RE.test(code)) return json(res, 400, { error: 'profile code ไม่ถูกต้อง' });
      const tenant = find(code);
      if (!tenant) return json(res, 404, { error: 'ไม่พบสมาชิกนี้' });
      if (req.method === 'GET' && parts.length === 3) return json(res, 200, { tenant: publicTenant(tenant) });
      if (req.method === 'PATCH' && parts.length === 3) {
        const body = await readBody(req);
        if (body.revision != null && Number(body.revision) !== tenant.revision) return json(res, 409, { error: 'ข้อมูลถูกแก้จากที่อื่นแล้ว กรุณารีเฟรช' });
        await mutate(tenant, 'update', async () => Object.assign(tenant, tenantInput({ ...tenant, ...body })));
        return json(res, 200, { tenant: publicTenant(tenant) });
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const body = await readBody(req);
        if (body.revision != null && Number(body.revision) !== tenant.revision) return json(res, 409, { error: 'ข้อมูลถูกแก้จากที่อื่นแล้ว กรุณารีเฟรช' });
        if (tenant.status !== 'failed') return json(res, 409, { error: 'ลบถาวรได้เฉพาะรายการที่สร้างไม่สำเร็จ' });
        if (String(body.confirm || '') !== tenant.code) return json(res, 400, { error: 'ต้องพิมพ์ Profile code ให้ตรงก่อนลบถาวร' });
        await mutate(tenant, 'delete-failed', async () => {
          // ชื่อ container/network และ data path มาจาก profile code ที่ validate แล้วเท่านั้น
          // ทำ cleanup ให้สำเร็จก่อนค่อยลบ registry เพื่อให้ retry ได้เมื่อ Docker หรือ disk มีปัญหา
          if (await containerExists(tenant)) await docker(['rm', '-f', container(tenant.code)]);
          if (await networkExists(tenant)) {
            try { await docker(['network', 'disconnect', '-f', network(tenant.code), cfg.traefikContainer]); } catch { /* ไม่มี traefik ต่ออยู่ก็ลบ network ต่อได้ */ }
            await docker(['network', 'rm', network(tenant.code)]);
          }
          for (const root of [cfg.dataRoot, cfg.archiveRoot]) {
            const dataPath = tenantDataPath(root, tenant.code);
            if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
          }
          registry.tenants = registry.tenants.filter((entry) => entry.code !== tenant.code);
        });
        return json(res, 200, { deleted: true, code: tenant.code });
      }
      if (req.method !== 'POST' || parts.length !== 5 || parts[3] !== 'actions' || !ACTIONS.has(parts[4])) return json(res, 404, { error: 'ไม่พบ action' });
      const action = parts[4]; const body = await readBody(req);
      if (body.revision != null && Number(body.revision) !== tenant.revision) return json(res, 409, { error: 'ข้อมูลถูกแก้จากที่อื่นแล้ว กรุณารีเฟรช' });
      if (action === 'suspend-access') {
        if (tenant.status !== 'active') throw Object.assign(new Error('ระงับได้เฉพาะสมาชิกที่ active'), { status: 409 });
        if (body.confirm !== 'SUSPEND_ACCESS') throw Object.assign(new Error('ต้องยืนยัน SUSPEND_ACCESS เพื่อระงับการเข้าใช้'), { status: 400 });
        await mutate(tenant, action, async () => {
          await deploy(tenant, 'reset-password', { username: `suspended-${tenant.code.slice(0, 12)}`, password: crypto.randomBytes(30).toString('base64url') });
          tenant.status = 'access_suspended';
        });
      } else if (action === 'resume-access' || action === 'reset-password') {
        if (!['active', 'access_suspended'].includes(tenant.status)) throw Object.assign(new Error('สถานะนี้เปลี่ยนรหัสไม่ได้'), { status: 409 });
        const auth = credentials(body);
        await mutate(tenant, action, async () => {
          await deploy(tenant, 'reset-password', auth);
          tenant.status = 'active';
        });
      } else if (action === 'retry-provision') {
        if (tenant.status !== 'failed') throw Object.assign(new Error('retry ได้เฉพาะสมาชิกที่สร้างไม่สำเร็จ'), { status: 409 });
        const auth = credentials(body);
        await mutate(tenant, action, async () => {
          const currentData = path.join(cfg.dataRoot, tenant.code);
          await createNetwork(tenant);
          if (await containerExists(tenant)) {
            await deploy(tenant, 'reset-password', auth);
          } else if (fs.existsSync(path.join(currentData, 'config.json'))) {
            await deploy(tenant, 'restore', auth);
          } else if (fs.existsSync(currentData)) {
            await deploy(tenant, 'retry-create', auth);
          } else {
            await deploy(tenant, 'create', auth);
          }
          tenant.status = 'active';
        });
      } else if (action === 'recover-archive') {
        if (tenant.status !== 'archive_recovery') throw Object.assign(new Error('กู้ archive ได้เฉพาะ instance ที่ rollback ไม่สำเร็จ'), { status: 409 });
        await mutate(tenant, action, async () => {
          const currentData = path.join(cfg.dataRoot, tenant.code);
          const archiveData = tenant.archiveData || path.join(cfg.archiveRoot, tenant.code);
          if (!fs.existsSync(currentData) && fs.existsSync(archiveData)) {
            fs.mkdirSync(cfg.dataRoot, { recursive: true, mode: 0o700 });
            fs.renameSync(archiveData, currentData);
          }
          if (!fs.existsSync(currentData)) throw Object.assign(new Error('ไม่พบ data สำหรับกู้ archive'), { status: 502 });
          if (fs.existsSync(archiveData)) throw Object.assign(new Error('พบ data ทั้ง live และ archive — หยุดเพื่อไม่เลือกข้อมูลผิดชุด'), { status: 409 });
          if (!await containerExists(tenant)) throw Object.assign(new Error('ไม่พบ container เดิม — ตรวจสอบ data บน host ก่อนกู้คืน'), { status: 502 });
          await docker(['start', container(tenant.code)]);
          await docker(['exec', container(tenant.code), 'wget', '-qO', '/dev/null', 'http://localhost:4000/']);
          delete tenant.archiveData;
          tenant.status = 'active';
        });
      } else if (action === 'archive') {
        if (!['active', 'access_suspended'].includes(tenant.status)) throw Object.assign(new Error('archive ได้เฉพาะสมาชิกที่กำลังใช้งาน'), { status: 409 });
        if (body.confirm !== 'ARCHIVE_TENANT') throw Object.assign(new Error('ต้องยืนยัน ARCHIVE_TENANT เพื่อเก็บ instance'), { status: 400 });
        await mutate(tenant, action, async () => {
          const currentData = path.join(cfg.dataRoot, tenant.code);
          const archiveData = path.join(cfg.archiveRoot, tenant.code);
          // ย้าย data ก่อนลบ container เพื่อให้ rollback กลับ instance เดิมได้ถ้า docker rm ล้มเหลว
          if (fs.existsSync(currentData) && !fs.existsSync(archiveData)) {
            let stopped = false;
            try {
              if (await containerExists(tenant)) { await docker(['stop', container(tenant.code)]); stopped = true; }
              fs.mkdirSync(cfg.archiveRoot, { recursive: true, mode: 0o700 });
              fs.renameSync(currentData, archiveData);
            } catch (error) {
              // ENOSPC/permission ตอนย้าย data ต้องไม่ทิ้ง instance สถานะ active แต่ container หยุดอยู่
              if (stopped) {
                try { await docker(['start', container(tenant.code)]); }
                catch (rollbackError) {
                  markArchiveRecovery(tenant, rollbackError.message);
                  throw Object.assign(new Error(`archive ล้มเหลวและเปิด instance เดิมกลับไม่ได้: ${rollbackError.message}`), { status: 502 });
                }
              }
              throw error;
            }
          }
          if (!fs.existsSync(archiveData)) throw Object.assign(new Error('ไม่พบข้อมูลผู้เช่าบน host'), { status: 502 });
          try {
            if (await containerExists(tenant)) await docker(['rm', container(tenant.code)]);
          } catch (error) {
            // container ยังอยู่ จึงย้าย data กลับแล้วเปิด instance เดิมไว้ ไม่ปล่อยให้สถานะ active แต่เข้าไม่ได้
            let reverseError = null;
            try {
              if (fs.existsSync(archiveData) && !fs.existsSync(currentData)) fs.renameSync(archiveData, currentData);
            } catch (moveError) { reverseError = moveError; }
            let startError = null;
            try { await docker(['start', container(tenant.code)]); }
            catch (rollbackError) { startError = rollbackError; }
            if (reverseError || startError) {
              markArchiveRecovery(tenant, (startError || reverseError).message);
              throw Object.assign(new Error(`archive ล้มเหลวและ rollback ไม่สมบูรณ์: ${(startError || reverseError).message}`), { status: 502 });
            }
            throw error;
          }
          // หลัง container หายแล้ว network ที่ค้างไม่กระทบข้อมูลหรือ route; เก็บกวาดแบบ retry-safe
          await bestEffort(['network', 'disconnect', network(tenant.code), cfg.traefikContainer]);
          await bestEffort(['network', 'rm', network(tenant.code)]);
          tenant.archiveData = archiveData;
          tenant.status = 'archived';
        });
      } else if (action === 'restore') {
        if (tenant.status !== 'archived') throw Object.assign(new Error('restore ได้เฉพาะสมาชิกที่ archive แล้ว'), { status: 409 });
        const auth = credentials(body);
        await mutate(tenant, action, async () => {
          const currentData = path.join(cfg.dataRoot, tenant.code);
          const archiveData = tenant.archiveData || path.join(cfg.archiveRoot, tenant.code);
          if (fs.existsSync(archiveData) && !fs.existsSync(currentData)) {
            fs.mkdirSync(cfg.dataRoot, { recursive: true, mode: 0o700 });
            fs.renameSync(archiveData, currentData);
          }
          if (!fs.existsSync(currentData)) throw Object.assign(new Error('ไม่พบข้อมูล archive บน host'), { status: 502 });
          try {
            await createNetwork(tenant);
            if (await containerExists(tenant)) {
              await docker(['exec', container(tenant.code), 'wget', '-qO', '/dev/null', 'http://localhost:4000/']);
            } else {
              await deploy(tenant, 'restore', auth, true);
            }
          } catch (error) {
            await bestEffort(['rm', '-f', container(tenant.code)]);
            await bestEffort(['network', 'disconnect', network(tenant.code), cfg.traefikContainer]);
            await bestEffort(['network', 'rm', network(tenant.code)]);
            if (fs.existsSync(currentData) && !fs.existsSync(archiveData)) fs.renameSync(currentData, archiveData);
            throw error;
          }
          delete tenant.archiveData;
          tenant.status = 'restored_hold';
        });
      } else if (action === 'release-hold') {
        if (tenant.status !== 'restored_hold') throw Object.assign(new Error('ปลด hold ได้เฉพาะ instance ที่กู้คืนแล้ว'), { status: 409 });
        if (body.confirm !== 'ENABLE_AUTOPILOT') throw Object.assign(new Error('ต้องพิมพ์ ENABLE_AUTOPILOT เพื่อยืนยัน'), { status: 400 });
        await mutate(tenant, action, async () => {
          // redeploy อ่าน Basic Auth hash เดิมจาก container เอง จึงไม่ต้องเก็บ credential ของสมาชิกไว้ใน registry
          await deploy(tenant, 'redeploy', { username: 'unused', password: 'unused-password' }, false);
          tenant.status = 'active';
        });
      }
      return json(res, 200, { tenant: publicTenant(tenant) });
    } catch (error) {
      return json(res, error.status || 500, { error: String(error.message || 'เกิดข้อผิดพลาด') });
    }
  };
  const server = http.createServer(handler);
  return { cfg, server, handler };
}

if (require.main === module) {
  const provisioner = createProvisioner();
  const socketDir = path.dirname(provisioner.cfg.socketPath);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
  if (fs.existsSync(provisioner.cfg.socketPath)) fs.unlinkSync(provisioner.cfg.socketPath);
  provisioner.server.listen(provisioner.cfg.socketPath, () => {
    fs.chmodSync(provisioner.cfg.socketPath, 0o660);
    console.log(`tenant provisioner listening on ${provisioner.cfg.socketPath}`);
  });
}

module.exports = { createProvisioner, credentials, tenantInput, publicTenant };
