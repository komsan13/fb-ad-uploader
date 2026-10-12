// เทสบั๊กหน้า Landing / คลังวิดีโอ / คลังแคปชั่น จากรีวิว ต.ค. 2026 — ทุกตัวเคยทำให้พิกเซลหรือคลังหายเงียบๆ
// พิกเซลหายจากหน้า /lp = คอนเวอร์ชั่นเป็น 0 แล้วตัวปิดแอดขาดทุน/ตัวขยายงบตัดสินจากตัวเลขผิด
// ฝั่งเซิร์ฟเวอร์: รัน server.js จริงคุยกับ FB ปลอม ยืนยันจากไฟล์ที่บันทึกและหน้า /lp ที่เรนเดอร์จริง
// ฝั่งหน้าเว็บ: ดึงฟังก์ชันจริงจาก public/index.html มารันใน vm (DOM ปลอม) แล้วยิงเข้าเซิร์ฟเวอร์จริง
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get, post, readState } = require('./helpers');

// ห้ามเทสวิ่งไป Telegram/Anthropic จริง และไม่ให้รอบตรวจ token เริ่มเองระหว่างเทส
const SAFE_ENV = { ANTHROPIC_API_KEY: '', TG_API_BASE: 'http://127.0.0.1:9', WATCH_FIRST_DELAY_MS: '999999999' };

async function boot(t, { world = { accounts: [], pages: [] }, config = {}, landing, videos = 1, captions = 1, env = {} } = {}) {
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config, videos, captions });
  if (landing) fs.writeFileSync(path.join(dir, 'landing.json'), typeof landing === 'string' ? landing : JSON.stringify(landing));
  const srv = await startServer(dir, fb.port, { ...SAFE_ENV, ...env });
  t.after(() => { srv.stop(); fb.server.close(); });
  return { ...srv, dir, world };
}
const lpFile = (dir) => path.join(dir, 'landing.json');
const readLp = (dir) => JSON.parse(fs.readFileSync(lpFile(dir), 'utf8'));
const html = async (base, p = '/lp') => (await fetch(base + p)).text();
const postRaw = (base, p, body) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
// บันทึกแบบหน้าเว็บ: อ่าน rev + โปรไฟล์ล่าสุดก่อนแล้วค่อยส่ง
const save = async (base, body) => {
  const { rev, ws } = await get(base, '/api/landing');
  return post(base, '/api/landing', { ...body, rev, ws });
};
const count = (s, needle) => s.split(needle).length - 1;

const PROFILE = { profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok' }], activeProfileId: 'p1' };

// ---------- ฝั่งหน้าเว็บ: ฟังก์ชันจริงจาก index.html ----------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// ฟังก์ชันระดับบนสุดในไฟล์นี้จัดรูปแบบเหมือนกันทุกตัว: เริ่มที่ต้นบรรทัด จบที่ "}" ต้นบรรทัด
function fnSrc(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(SRC);
  assert.ok(m, `หา function ${name} ใน index.html ไม่เจอ`);
  const end = /\n\}\r?\n/g;
  end.lastIndex = m.index;
  const e = end.exec(SRC);
  const code = SRC.slice(m.index, e.index + 2);
  new vm.Script(code);   // ตัดผิดต้องพังตรงนี้ ไม่ใช่เทสผ่านแบบผิดๆ
  return code;
}
// failGets = จำนวน GET แรกๆ ที่ให้ตอบ 503 แบบที่ตัวกลาง (hub.js) ตอบตอนโปรไฟล์กำลังบูต
function frontend(base, { failGets = 0, confirm = () => true } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, focus() {} });
  const calls = [];
  const toasts = [];
  let fails = failGets;
  const ctx = vm.createContext({
    console, confirm,
    document: { getElementById: el, querySelectorAll: () => [] },
    setTimeout: () => 0,
    toast: (m) => toasts.push(String(m)),
    lpRenderBgs() {}, lpAvatarPreview() {}, renderLpLinks() {}, renderLpPixels() {}, closeLpPixelModal() {},
    renderLibrary() {}, renderCaptions() {},
    fetch: async (url, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && fails > 0) {
        fails--;
        return new Response(JSON.stringify({ error: 'โปรไฟล์นี้กำลังเริ่มทำงาน — ลองใหม่ในอีกสักครู่' }),
          { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return fetch(base + url, opts);
    },
  });
  vm.runInContext('var lpRev = null, lpLinksData = [], lpPixelsData = [], lpBg = "", lpPixelEditIdx = null, libItems = [], capItems = [];', ctx);
  for (const n of ['esc', 'apiJson', 'lpFixUrl', 'loadLanding', 'lpCollect', 'lpSave', 'saveLpPixelModal', 'fetchLib', 'loadLibrary', 'loadCaptions']) {
    vm.runInContext(fnSrc(n), ctx);
  }
  return { ctx, els, calls, toasts, run: (code) => vm.runInContext(code, ctx) };
}

const LANDING = {
  title: 'Real Shop', bio: 'b', rev: 3,
  pixels: [{ type: 'meta', id: '111111111111111', acct: '111' }, { type: 'meta', id: '222222222222222' }],
  links: [{ id: 'l0', label: 'LINE', url: 'https://line.me/x', icon: '', event: 'Lead' }],
};

describe('P0-1: บันทึกหน้า Landing ต้องไม่ทับพิกเซลที่ระบบเพิ่งฝังเพิ่ม (rev)', () => {
  const world = () => ({
    accounts: [{ name: 'A', account_id: '111', account_status: 1, adspixels: { data: [{ id: '700000000000001', name: 'ใหม่' }] } }],
    pages: [],
  });

  test('ระบบฝังพิกเซลระหว่างเปิดหน้า → บันทึกด้วยรายการเก่าได้ 409 พิกเซลใหม่ยังอยู่บน /lp', async (t) => {
    const { base, dir } = await boot(t, { world: world(), config: PROFILE });
    await save(base, { title: 'Shop', pixels: [{ type: 'meta', id: '600000000000001', acct: '999' }], links: [{ label: 'LINE', url: 'https://line.me/x' }] });
    const snap = await get(base, '/api/landing');   // ผู้ใช้เปิดหน้า Landing ค้างไว้

    // ระหว่างนั้นหน้าสุขภาพ (อีกแท็บ) ฝังพิกเซลของบัญชีให้ — ทางเดียวกับ autopilot เติมแอด/สร้างพิกเซล/ขึ้นแอด
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.deepStrictEqual(h.boundToLp, ['700000000000001']);
    assert.ok(readLp(dir).rev > snap.rev, 'ระบบฝังพิกเซลแล้วเลขรุ่นต้องขยับ');

    // ผู้ใช้แก้ชื่อแล้วกดบันทึก — หน้าเว็บส่งรายการพิกเซลชุดเก่าทั้งก้อน
    const r = await postRaw(base, '/api/landing', { ...snap, title: 'Shop v2' });
    assert.strictEqual(r.status, 409, 'rev เก่าต้องถูกปฏิเสธ');
    assert.match((await r.json()).error, /ถูกแก้จากที่อื่น/);
    assert.deepStrictEqual(readLp(dir).pixels.map((p) => p.id), ['600000000000001', '700000000000001'], 'พิกเซลที่ระบบฝังต้องยังอยู่');
    assert.ok((await html(base)).includes("fbq('init','700000000000001')"), 'หน้าจริงต้องยังยิงพิกเซลใหม่');

    // โหลดใหม่แล้วบันทึก = ผ่าน และพิกเซลครบ
    const fresh = await get(base, '/api/landing');
    const ok = await post(base, '/api/landing', { ...fresh, title: 'Shop v2' });
    assert.strictEqual(ok.landing.title, 'Shop v2');
    assert.strictEqual(ok.landing.rev, fresh.rev + 1, 'บันทึกแล้วเลขรุ่นต้องขยับ');
    assert.strictEqual(ok.landing.pixels.length, 2);
  });

  test('ไม่ส่ง rev มาเลย (ฟอร์มที่โหลดพัง / แท็บเก่าก่อนอัปเดต) ต้องถูกปฏิเสธ ไฟล์ไม่เปลี่ยนแม้แต่ไบต์เดียว', async (t) => {
    const { base, dir } = await boot(t, { landing: LANDING });
    const before = fs.readFileSync(lpFile(dir), 'utf8');
    // ฟอร์มว่างจากการโหลดที่ได้ 503 — ไม่มี rev ติดมา
    const r = await postRaw(base, '/api/landing', { title: '', bio: '', pixels: [{ type: 'meta', id: '900004' }], links: [] });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(fs.readFileSync(lpFile(dir), 'utf8'), before);
    const page = await html(base);
    assert.ok(page.includes("fbq('init','111111111111111')") && page.includes("fbq('init','222222222222222')"));
  });

  test('ฟอร์มที่โหลดมาจากโปรไฟล์อื่น (สลับโปรไฟล์ในอีกหน้าต่าง) บันทึกทับไม่ได้ แม้ rev จะบังเอิญตรงกัน', async (t) => {
    const { base, dir } = await boot(t, { landing: LANDING, env: { WS_ID: 'brand' } });
    const before = fs.readFileSync(lpFile(dir), 'utf8');
    const cur = await get(base, '/api/landing');
    assert.strictEqual(cur.ws, 'brand');
    const r = await postRaw(base, '/api/landing', { title: 'TOP shop', pixels: [{ type: 'meta', id: '999' }], links: [], rev: cur.rev, ws: 'top' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await r.json()).wrongProfile, true);
    assert.strictEqual(fs.readFileSync(lpFile(dir), 'utf8'), before, 'หน้าของโปรไฟล์นี้ต้องไม่ถูกทับ');
    const ok = await post(base, '/api/landing', { ...cur, title: 'BRAND v2' });
    assert.strictEqual(ok.landing.title, 'BRAND v2', 'โปรไฟล์ตรงกันต้องบันทึกได้ปกติ');
  });

  test('rev แปลกๆ ในไฟล์ (แก้มือ/ไฟล์รุ่นเก่า) ต้องไม่ล็อกการบันทึกถาวร', async (t) => {
    for (const odd of [-1, '3', 1.5, 2 ** 53, null]) {
      const { base } = await boot(t, { landing: { ...LANDING, rev: odd } });
      const cur = await get(base, '/api/landing');
      assert.strictEqual(cur.rev, 0, `rev=${JSON.stringify(odd)} ต้องอ่านได้เป็น 0`);
      const r = await post(base, '/api/landing', { ...cur, title: 'x' });
      assert.strictEqual(r.landing.rev, 1, `rev=${JSON.stringify(odd)} ต้องบันทึกได้`);
    }
  });

  test('หน้าเว็บ: เจอ 409 แล้วโหลดข้อมูลล่าสุด (พิกเซลที่ระบบฝังเข้ามาอยู่ในฟอร์ม) แล้วบันทึกรอบสองผ่าน', async (t) => {
    const { base, dir } = await boot(t, { world: world(), config: PROFILE, landing: LANDING });
    const fe = frontend(base);
    assert.strictEqual(await fe.ctx.loadLanding(), true);
    await get(base, '/api/health-overview?profile=p1');   // ระบบฝังพิกเซลแทรกเข้ามา

    fe.els.lpTitle.value = 'แก้ชื่อ';
    await fe.ctx.lpSave(fe.els.lpSaveBtn);
    assert.ok(fe.calls.includes('POST /api/landing'));
    assert.deepStrictEqual(readLp(dir).pixels.map((p) => p.id), ['111111111111111', '222222222222222', '700000000000001']);
    assert.deepStrictEqual(fe.run('lpPixelsData.map(p => p.id)'), ['111111111111111', '222222222222222', '700000000000001'],
      'ยืนยันโหลดใหม่แล้ว ฟอร์มต้องมีพิกเซลที่ระบบเพิ่งฝัง');

    await fe.ctx.lpSave(fe.els.lpSaveBtn);
    assert.strictEqual(readLp(dir).pixels.length, 3, 'บันทึกรอบสองต้องไม่ทำพิกเซลหาย');
  });
});

describe('P0-2: ล้างพิกเซลที่ไม่มีเจ้าของ', () => {
  function pruneWorld() {
    const w = {
      bOk: false,
      accounts: [], pages: [],
      route: (method, p, params) => {
        if (p !== 'me/adaccounts') return null;
        if (params.access_token === 'tokA') return { data: [{ account_id: '111', adspixels: { data: [{ id: '100000000000001' }] } }] };
        if (!w.bOk) return { error: 'Error validating access token: Session has expired', errorCode: 190 };
        return { data: [{ account_id: '222', adspixels: { data: [{ id: '200000000000002' }] } }] };
      },
    };
    return w;
  }
  const config = { profiles: [{ id: 'p1', label: 'A', accessToken: 'tokA' }, { id: 'p2', label: 'B', accessToken: 'tokB' }], activeProfileId: 'p1' };
  const landing = {
    title: 't', links: [], rev: 1,
    pixels: [{ type: 'meta', id: '100000000000001', acct: '111' }, { type: 'meta', id: '200000000000002', acct: '222' }, { type: 'meta', id: '300000000000003' }],
  };
  const backups = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('landing.json.bak-prune')).sort();

  test('มีโปรไฟล์หนึ่งอ่าน FB ไม่ได้ → ไม่ลบอะไรเลย (เดิมลบพิกเซลทุกตัวของโปรไฟล์นั้น)', async (t) => {
    const { base, dir } = await boot(t, { world: pruneWorld(), config, landing });
    const before = fs.readFileSync(lpFile(dir), 'utf8');
    const r = await postRaw(base, '/api/landing/prune-pixels', {});
    assert.strictEqual(r.status, 502);
    assert.match((await r.json()).error, /ไม่ครบทุกโปรไฟล์ — ยังไม่ลบอะไรทั้งนั้น.*B:/);
    assert.strictEqual(fs.readFileSync(lpFile(dir), 'utf8'), before, 'ไฟล์ต้องไม่ถูกแตะ');
    assert.ok((await html(base)).includes("fbq('init','200000000000002')"), 'พิกเซลของโปรไฟล์ที่อ่านไม่ได้ต้องยังอยู่บนหน้า');
  });

  test('อ่านได้ครบทุกโปรไฟล์ → ลบเฉพาะตัวไม่มีเจ้าของ และสำรองแยกไฟล์ทุกครั้ง (รอบสองไม่ทับสำเนารอบแรก)', async (t) => {
    const w = pruneWorld();
    w.bOk = true;
    const { base, dir } = await boot(t, { world: w, config, landing });
    const r1 = await post(base, '/api/landing/prune-pixels', {});
    assert.deepStrictEqual(r1.removed, ['300000000000003']);
    assert.deepStrictEqual(readLp(dir).pixels.map((p) => `${p.id}:${p.acct}`), ['100000000000001:111', '200000000000002:222']);
    const b1 = backups(dir);
    assert.strictEqual(b1.length, 1);
    const firstCopy = fs.readFileSync(path.join(dir, b1[0]), 'utf8');
    assert.strictEqual(JSON.parse(firstCopy).pixels.length, 3, 'สำเนาต้องเป็นของก่อนลบ');

    await new Promise((r) => setTimeout(r, 5));
    await post(base, '/api/landing/prune-pixels', {});
    const b2 = backups(dir);
    assert.strictEqual(b2.length, 2, 'กดซ้ำต้องได้สำเนาใหม่ ไม่ใช่เขียนทับ');
    assert.strictEqual(fs.readFileSync(path.join(dir, b1[0]), 'utf8'), firstCopy, 'สำเนารอบแรก (ตัวที่ยังมีพิกเซลครบ) ต้องไม่ถูกทับ');
  });
});

describe('P0-2b: prune ระหว่างรอ FB', () => {
  test('พิกเซลที่ระบบผูกเข้ามาระหว่างที่ prune รอ FB ต้องไม่ถูกลบ (และ acct ของมันต้องอยู่)', async (t) => {
    let firstRead = false;
    const world = {
      accounts: [{ name: 'A', account_id: '111', account_status: 1 }], pages: [],
      route: (method, p, params) => {
        if (method !== 'GET' || p !== 'me/adaccounts') return null;
        if (params.access_token === 'tokA') { firstRead = true; return { data: [{ account_id: '111', adspixels: { data: [{ id: '100000000000001' }] } }] }; }
        return { delay: 800, data: [{ account_id: '222', adspixels: { data: [{ id: '200000000000002' }] } }] };   // โปรไฟล์ B ช้า
      },
    };
    const { base, dir } = await boot(t, {
      world,
      config: { profiles: [{ id: 'p1', label: 'A', accessToken: 'tokA' }, { id: 'p2', label: 'B', accessToken: 'tokB' }], activeProfileId: 'p1' },
      landing: { title: 't', rev: 1, links: [], pixels: [{ type: 'meta', id: '100000000000001', acct: '111' }, { type: 'meta', id: '200000000000002', acct: '222' }, { type: 'meta', id: '300000000000003' }] },
    });
    const pruning = post(base, '/api/landing/prune-pixels', {});
    while (!firstRead) await new Promise((r) => setTimeout(r, 20));
    // ผู้ใช้กดสร้างพิกเซลให้บัญชี 111 ระหว่างที่ prune ยังรอโปรไฟล์ B — ระบบผูกเข้าหน้า Landing ให้ทันที
    const cp = await post(base, '/api/create-pixel', { profile: 'p1', account: '111', name: 'ใหม่' });
    assert.strictEqual(cp.boundToLp, true);
    const r = await pruning;
    assert.deepStrictEqual(r.removed, ['300000000000003'], 'ลบได้เฉพาะตัวไม่มีเจ้าของที่อยู่ตั้งแต่ก่อนเริ่ม');
    const kept = readLp(dir).pixels.find((p) => p.id === String(cp.id));
    assert.ok(kept, 'พิกเซลที่เพิ่งผูกต้องยังอยู่');
    assert.strictEqual(kept.acct, '111', 'acct ของตัวที่เพิ่งผูกต้องไม่หาย');
    assert.ok((await html(base)).includes(`fbq('init','${cp.id}')`));
  });
});

describe('P0-3: ฟอร์มที่โหลดไม่สำเร็จต้องบันทึกทับของจริงไม่ได้', () => {
  test('ตัวกลางตอบ 503 ตอนโปรไฟล์บูต → โชว์ error ปิดปุ่มบันทึก กดบันทึกก็ไม่ยิง • โหลดใหม่ได้แล้วกลับมาใช้ได้', async (t) => {
    const { base, dir } = await boot(t, { landing: LANDING });
    const before = fs.readFileSync(lpFile(dir), 'utf8');
    const fe = frontend(base, { failGets: 1 });

    assert.strictEqual(await fe.ctx.loadLanding(), false);
    assert.strictEqual(fe.els.lpSaveBtn.disabled, true, 'ปุ่มบันทึกต้องปิด');
    assert.strictEqual(fe.run('lpRev'), null);
    assert.match(fe.els.lpMsg.innerHTML, /โหลดข้อมูลหน้า Landing ไม่สำเร็จ: โปรไฟล์นี้กำลังเริ่มทำงาน/);

    // ผู้ใช้เพิ่มปุ่มแล้วกดบันทึก (เรียกตรงข้ามปุ่มที่ปิด) — ต้องไม่มี POST และไฟล์ไม่เปลี่ยน
    fe.run("lpLinksData.push({ icon: '', label: 'Call', url: 'tel:021234567', event: '' })");
    await fe.ctx.lpSave(fe.els.lpSaveBtn);
    assert.ok(!fe.calls.some((c) => c.startsWith('POST')), 'ห้ามยิงบันทึก');
    assert.ok(fe.toasts.some((m) => /ยังโหลดข้อมูลหน้า Landing ไม่สำเร็จ/.test(m)));
    assert.strictEqual(fs.readFileSync(lpFile(dir), 'utf8'), before);

    assert.strictEqual(await fe.ctx.loadLanding(), true);
    assert.strictEqual(fe.els.lpSaveBtn.disabled, false);
    assert.strictEqual(fe.els.lpTitle.value, 'Real Shop');
    assert.strictEqual(fe.run('lpRev'), 3);
    await fe.ctx.lpSave(fe.els.lpSaveBtn);
    const after = readLp(dir);
    assert.strictEqual(after.pixels.length, 2, 'บันทึกหลังโหลดสำเร็จต้องได้พิกเซลครบ');
    assert.strictEqual(after.pixels[0].acct, '111', 'acct ต้องรอดผ่านหน้าเว็บ');
    assert.strictEqual(after.rev, 4);
  });
});

describe('P1-3: ไฟล์คลังเสียต้องไม่ถูกตีความเป็นคลังว่างแล้วเขียนทับ', () => {
  test('index.json / captions.json ถูกตัดครึ่ง → API ตอบ error เก็บสำเนา และไม่มีการเขียนทับ ไม่มีไฟล์วิดีโอค้าง', async (t) => {
    const { base, dir } = await boot(t, { videos: 3, captions: 3 });
    const idx = path.join(dir, 'media-library', 'index.json');
    const cap = path.join(dir, 'captions.json');
    const idxCut = fs.readFileSync(idx, 'utf8').slice(0, 40);
    const capCut = fs.readFileSync(cap, 'utf8').slice(0, 40);
    fs.writeFileSync(idx, idxCut);
    fs.writeFileSync(cap, capCut);

    const gl = await fetch(base + '/api/library');
    assert.strictEqual(gl.status, 500);
    assert.match((await gl.json()).error, /ไฟล์คลังวิดีโอเสีย/);
    const gc = await fetch(base + '/api/captions');
    assert.strictEqual(gc.status, 500);

    const fd = new FormData();
    fd.append('name', 'ใหม่');
    fd.append('file', new Blob([Buffer.alloc(10, 1)], { type: 'video/mp4' }), 'n.mp4');
    const up = await fetch(base + '/api/library', { method: 'POST', body: fd });
    assert.strictEqual(up.status, 500);
    assert.match((await up.json()).error, /ไม่บันทึกทับ/);
    for (const [p, body] of [['/api/captions', { message: 'ใหม่' }], ['/api/captions/auto', { count: 3 }],
      ['/api/captions/update', { id: 'c1', message: 'x' }], ['/api/captions/delete', { id: 'c1' }],
      ['/api/library/rename', { id: 'v1', name: 'x' }], ['/api/library/delete', { id: 'v1' }]]) {
      const r = await postRaw(base, p, body);
      assert.strictEqual(r.status, 500, `${p} ต้องปฏิเสธ`);
      assert.ok((await r.json()).error, `${p} ต้องตอบ JSON ที่มีเหตุผล`);
    }

    assert.strictEqual(fs.readFileSync(idx, 'utf8'), idxCut, 'index.json ต้องไม่ถูกเขียนทับ');
    assert.strictEqual(fs.readFileSync(cap, 'utf8'), capCut, 'captions.json ต้องไม่ถูกเขียนทับ');
    const libFiles = fs.readdirSync(path.join(dir, 'media-library'));
    assert.strictEqual(libFiles.filter((f) => f.endsWith('.bin')).length, 3, 'คลิปที่อัปแต่ลงรายการไม่ได้ต้องถูกลบ ไม่ค้าง (v1 ต้องไม่ถูกลบด้วย)');
    assert.ok(libFiles.some((f) => f.startsWith('index.json.corrupt-')), 'ต้องเก็บสำเนาไฟล์เสียไว้');
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('captions.json.corrupt-')));
  });

  test('ไม่มีไฟล์คลัง = คลังว่างจริง ใช้งานได้ปกติ และเขียนแบบ tmp+rename (ไม่มีไฟล์ .tmp ค้าง)', async (t) => {
    const { base, dir } = await boot(t);
    fs.rmSync(path.join(dir, 'media-library', 'index.json'));
    fs.rmSync(path.join(dir, 'captions.json'));
    assert.deepStrictEqual(await get(base, '/api/library'), []);
    assert.deepStrictEqual(await get(base, '/api/captions'), []);
    const c = await post(base, '/api/captions', { message: 'แคปชั่นแรก' });
    assert.ok(c.id);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'captions.json'), 'utf8')).length, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'captions.json.tmp')));
  });

  test('autopilot เจอ index.json เสีย ต้องทำรอบตรวจจนจบและบันทึก state ได้ โดยไม่แตะคลัง', async (t) => {
    const world = {
      accounts: [{ name: 'บัญชีเทส', account_id: '111', account_status: 1, currency: 'THB' }],
      campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
      pages: [{ id: 'page1', name: 'เพจหลัก', is_published: true, promotion_eligible: true }],
    };
    const config = {
      profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', pageId: 'page1' }], activeProfileId: 'p1',
      launchDefaults: { objective: 'OUTCOME_SALES', conversionEvent: 'SUBSCRIBE', campaignBudget: '3333', link: 'https://example.com/', ruleCpr: '100', countries: 'TH', cta: 'LEARN_MORE' },
      autopilot: { enabled: true, minAds: 2, testMode: true },
    };
    const { base, dir } = await boot(t, { world, config, videos: 3 });
    const idx = path.join(dir, 'media-library', 'index.json');
    const cut = fs.readFileSync(idx, 'utf8').slice(0, 30);
    fs.writeFileSync(idx, cut);

    const r = await postRaw(base, '/api/autopilot/run', {});
    assert.strictEqual(r.status, 200, 'รอบตรวจต้องไม่ล้ม');
    assert.strictEqual((await r.json()).ok, true);
    assert.ok(readState(dir), 'state ต้องถูกบันทึก');
    assert.ok(!world.calls.some((c) => c.method === 'POST' && c.path === 'act_111/ads'), 'ไม่มีคลิปให้ใช้ = ต้องไม่สร้างแอด');
    assert.strictEqual(fs.readFileSync(idx, 'utf8'), cut, 'autopilot ต้องไม่เขียนทับคลังที่เสีย');
  });
});

describe('landing.json เสีย ต้องไม่ถูกตีความเป็นหน้าว่าง', () => {
  test('หลังบ้านโหลด/บันทึก/prune ไม่ได้พร้อมเหตุผล เก็บสำเนาไฟล์เสีย หน้า /lp ยังเปิดได้', async (t) => {
    const cut = JSON.stringify(LANDING).slice(0, 60);
    const { base, dir } = await boot(t, { landing: cut, config: PROFILE });
    const g = await fetch(base + '/api/landing');
    assert.strictEqual(g.status, 500);
    assert.match((await g.json()).error, /ไฟล์หน้า Landing เสีย/);
    const p = await postRaw(base, '/api/landing', { title: 'x', pixels: [], links: [], rev: 0, ws: '' });
    assert.strictEqual(p.status, 500, 'ห้ามบันทึกฟอร์มทับไฟล์ที่เสีย');
    assert.strictEqual((await postRaw(base, '/api/landing/prune-pixels', {})).status, 500);
    assert.strictEqual(fs.readFileSync(lpFile(dir), 'utf8'), cut, 'ไฟล์ต้องไม่ถูกแตะ');
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('landing.json.corrupt-')), 'ต้องเก็บสำเนาไฟล์เสีย');
    assert.strictEqual((await fetch(base + '/lp')).status, 200, 'หน้าสาธารณะต้องยังเปิดได้');
    const fe = frontend(base);
    assert.strictEqual(await fe.ctx.loadLanding(), false);
    assert.strictEqual(fe.els.lpSaveBtn.disabled, true, 'ฟอร์มว่างจากไฟล์เสียต้องกดบันทึกไม่ได้');
  });
});

describe('P2-2: พิกเซลซ้ำ', () => {
  test('บันทึกพิกเซล/GA ซ้ำ → เหลือตัวเดียว (ยืม acct จากตัวซ้ำ) และหน้า /lp init/ยิงครั้งเดียว', async (t) => {
    const { base, dir } = await boot(t);
    const r = await save(base, {
      pixels: [{ type: 'meta', id: '123456789012345' }, { type: 'meta', id: '123456789012345', acct: '111' },
        { type: 'ga', id: 'G-ABC' }, { type: 'ga', id: 'G-ABC' }],
      links: [{ label: 'LINE', url: 'https://line.me/x', event: 'Lead' }],
    });
    assert.deepStrictEqual(r.landing.pixels, [{ type: 'meta', id: '123456789012345', acct: '111' }, { type: 'ga', id: 'G-ABC' }]);
    assert.deepStrictEqual(readLp(dir).pixels.length, 2);
    const page = await html(base);
    assert.strictEqual(count(page, "fbq('init','123456789012345')"), 1);
    assert.strictEqual(count(page, "fbq('trackSingle','123456789012345','PageView')"), 1);
    assert.ok(page.includes('window.__lpPixels = ["123456789012345"];'), 'คลิกปุ่มต้องยิง Lead ครั้งเดียว');
    assert.strictEqual(count(page, 'gtag/js?id=G-ABC'), 1, 'gtag.js ต้องไม่โหลดซ้ำ');
  });

  test('ไฟล์เก่าที่มีพิกเซลซ้ำอยู่แล้ว → หน้า /lp ต้องไม่ยิงซ้ำ', async (t) => {
    const { base } = await boot(t, {
      landing: { title: 't', links: [], pixels: [{ type: 'meta', id: '555' }, { type: 'meta', id: '555', acct: '1' }, { type: 'meta', id: '666' }] },
    });
    const page = await html(base);
    assert.strictEqual(count(page, "fbq('init','555')"), 1);
    assert.strictEqual(count(page, "fbq('trackSingle','555','PageView')"), 1);
    assert.ok(page.includes('window.__lpPixels = ["555","666"];'));
  });

  test('สองบัญชีใช้พิกเซลเดียวกัน → ระบบฝังให้ครั้งเดียว', async (t) => {
    const { base, dir } = await boot(t, {
      config: PROFILE,
      world: {
        accounts: [
          { name: 'A', account_id: '111', account_status: 1, adspixels: { data: [{ id: 'pxS', name: 'S' }] } },
          { name: 'B', account_id: '222', account_status: 1, adspixels: { data: [{ id: 'pxS', name: 'S' }] } },
        ],
        pages: [],
      },
    });
    const d = await get(base, '/api/health-overview?profile=p1');
    assert.deepStrictEqual(d.boundToLp, ['pxS']);
    assert.deepStrictEqual(readLp(dir).pixels.map((p) => p.id), ['pxS']);
  });
});

describe('P2-3 / P2-4: ข้อความและแถวพิกเซลในหน้าเว็บ', () => {
  test('ข้อความหน้าพิกเซลต้องไม่บอกว่า /lp?a= โหลดเฉพาะพิกเซลของบัญชีนั้น (หน้าจริงยิงทุกตัว)', () => {
    const sec = SRC.slice(SRC.indexOf('id="page-landing"'), SRC.indexOf('id="page-settings"'));
    assert.ok(!/เฉพาะพิกเซลของบัญชี/.test(sec), 'หัวข้อ/คำอธิบายยังพูดถึงการกรองตามบัญชีอยู่');
    assert.ok(!/จะยิงเฉพาะตอนเปิด/.test(fnSrc('renderLpPixels')), 'tooltip "ไม่ทราบ" ยังบอกว่ายิงเฉพาะบางกรณี');
  });

  test('กดแก้แถวแล้วตกลง acct ต้องอยู่ • เปลี่ยน ID แล้วต้องไม่ติดเจ้าของเดิม • ID ซ้ำต้องไม่ถูกเพิ่ม', () => {
    const fe = frontend('http://127.0.0.1:9');
    fe.run("lpPixelsData = [{ type: 'meta', id: '900001', acct: '111' }, { type: 'meta', id: '900002', acct: '222' }]");
    fe.els.lpPixelModalType = { value: 'meta' };
    fe.els.lpPixelModalId = { value: '900001' };
    fe.run('lpPixelEditIdx = 0; saveLpPixelModal()');
    assert.strictEqual(fe.run('lpPixelsData[0].acct'), '111', 'แก้โดยไม่เปลี่ยนพิกเซล acct ต้องอยู่');

    fe.els.lpPixelModalId.value = '900003';
    fe.run('lpPixelEditIdx = 1; saveLpPixelModal()');
    assert.deepStrictEqual(fe.run('JSON.stringify(lpPixelsData[1])'), '{"type":"meta","id":"900003"}');

    fe.els.lpPixelModalId.value = '900001';
    fe.run('lpPixelEditIdx = null; saveLpPixelModal()');
    assert.strictEqual(fe.run('lpPixelsData.length'), 2, 'ID ซ้ำต้องไม่ถูกเพิ่ม');
    assert.ok(fe.toasts.some((m) => /มีอยู่ในรายการแล้ว/.test(m)));
  });
});

describe('P2-5: อัปโหลดเกินขนาด / ฟอร์มผิด', () => {
  test('ตอบ JSON พร้อมเหตุผล (413) ไม่ใช่หน้า HTML 500 และไม่มีไฟล์ค้าง — ครอบทั้ง landing, คลังวิดีโอ, /api/media', async (t) => {
    const { base, dir } = await boot(t, { videos: 0 });
    const big = new FormData();
    big.append('file', new Blob([Buffer.alloc(9 * 1024 * 1024, 1)], { type: 'image/png' }), 'big.png');
    const r1 = await fetch(base + '/api/landing/upload', { method: 'POST', body: big });
    assert.strictEqual(r1.status, 413);
    assert.match(r1.headers.get('content-type'), /application\/json/);
    assert.match((await r1.json()).error, /ใหญ่เกิน 8MB/);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'landing-assets')), [], 'ไฟล์ที่อัปค้างครึ่งทางต้องถูกลบ');
    const big2 = new FormData();
    big2.append('file', new Blob([Buffer.alloc(9 * 1024 * 1024, 1)], { type: 'image/png' }), 'big.png');
    const r1b = await fetch(base + '/api/landing/upload/', { method: 'POST', body: big2 });
    assert.match((await r1b.json()).error, /ใหญ่เกิน 8MB/, 'มี / ท้ายก็ต้องบอกเพดานที่ถูก');

    for (const p of ['/api/library', '/api/media']) {
      const fd = new FormData();
      fd.append('thumb', 'data:image/jpeg;base64,' + 'A'.repeat(1100000));   // เกิน fieldSize ตั้งต้นของ multer (1MB)
      fd.append('file', new Blob([Buffer.alloc(1000, 1)], { type: 'video/mp4' }), 'a.mp4');
      const r = await fetch(base + p, { method: 'POST', body: fd });
      assert.strictEqual(r.status, 413, `${p} ต้องได้ 413`);
      assert.ok((await r.json()).error, `${p} ต้องตอบ JSON ที่มีเหตุผล`);
    }
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'media-library')).filter((f) => f.endsWith('.bin')), []);
  });

  test('หน้าเว็บกันไฟล์เกิน 512MB ตั้งแต่ตอนเลือก', () => {
    const code = fnSrc('libFilesPicked');
    assert.match(code, /LIB_MAX_BYTES/);
    assert.match(SRC, /const LIB_MAX_BYTES = 512 \* 1024 \* 1024;/);
  });
});

describe('P2: คลังตอบ error ต้องโชว์ error ไม่ใช่ "ยังไม่มี..."', () => {
  test('โปรไฟล์กำลังบูต (503) และไฟล์คลังเสีย (500) → ตารางโชว์เหตุผล', async (t) => {
    const { base, dir } = await boot(t);
    const fe = frontend(base, { failGets: 2 });
    await fe.ctx.loadLibrary();
    assert.match(fe.els.libRows.innerHTML, /โหลดคลังไม่สำเร็จ: โปรไฟล์นี้กำลังเริ่มทำงาน/);
    await fe.ctx.loadCaptions();
    assert.match(fe.els.capRows.innerHTML, /โหลดคลังแคปชั่นไม่สำเร็จ: โปรไฟล์นี้กำลังเริ่มทำงาน/);

    fs.writeFileSync(path.join(dir, 'media-library', 'index.json'), '[{"id":"v1","na');
    await fe.ctx.loadLibrary();
    assert.match(fe.els.libRows.innerHTML, /ไฟล์คลังวิดีโอเสีย/);
  });
});

describe('og:image', () => {
  test('รูปที่อัปเองต้องเป็นลิงก์เต็มใน og:image (ตัวดึงพรีวิวอยู่นอกเว็บเรา)', async (t) => {
    const { base } = await boot(t);
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(64, 3)], { type: 'image/png' }), 'a.png');
    const up = await (await fetch(base + '/api/landing/upload', { method: 'POST', body: fd })).json();
    await save(base, { avatar: up.url });
    assert.ok((await html(base)).includes(`<meta property="og:image" content="${base}${up.url}">`));
  });
});
