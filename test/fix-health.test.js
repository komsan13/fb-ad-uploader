// เทสชุดแก้บั๊กหน้าสุขภาพบัญชี + ส่วนขยาย Chrome (รีวิว 12 ต.ค. 2026)
// รันของจริงทุกชั้น: background.js/popup.js/shared.js ตัวจริงใน vm (btoa ตัวจริงตามสเปก เหมือน Chrome),
// server.js/hub.js ตัวจริงคุยกับ FB ปลอม, และ <script> ตัวจริงของ public/index.html บน DOM จำลอง
// ไม่มีอะไรวิ่งออกเน็ตจริง: FB/เรต → fake-fb, Telegram → พอร์ตตาย, ไม่มี key ของ Anthropic
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const vm = require('vm');
const { spawn } = require('child_process');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get, post } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const TOKEN = 'EAA' + 'x'.repeat(120);
const SAFE_ENV = { TG_API_BASE: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '' };
const readExt = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ส่วนขยาย: background.js ใน vm ----------
// graph = สิ่งที่ Graph ตอบ (ฟังก์ชันของ URL ได้) • app = ตัวรับคำขอที่ไปหน้าเว็บของเรา
function loadWorker({ store = {}, graph = { data: [] }, app, storageGet } = {}) {
  const calls = { graph: [], app: [], badge: [] };
  let onMessage = null;
  const ctx = {
    console, URL, URLSearchParams, TextEncoder, btoa,
    importScripts: (...files) => files.forEach((f) => vm.runInContext(readExt(f), ctx)),
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('https://adsmanager.facebook.com')) {
        return { ok: true, status: 200, text: async () => `<script>window.__accessToken="${TOKEN}"</script>` };
      }
      if (u.startsWith('https://graph.facebook.com')) {
        calls.graph.push(u);
        const body = typeof graph === 'function' ? graph(u) : graph;
        return { ok: true, status: 200, json: async () => body };
      }
      calls.app.push({ url: u, opts });
      return app(u, opts);
    },
    chrome: {
      runtime: { onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, onMessage: { addListener: (f) => { onMessage = f; } } },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
      action: { setBadgeText: (o) => calls.badge.push(o.text), setBadgeBackgroundColor: () => {} },
      storage: {
        local: {
          get: storageGet || (async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]]).filter(([, v]) => v !== undefined))),
          set: async (o) => { Object.assign(store, o); },
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(readExt('background.js'), ctx);
  // ส่งข้อความแบบที่ป๊อปอัป/content script ส่ง — รอ reply จริง (ถ้าไม่มีวัน reply เทสจะ timeout ให้เห็น)
  const send = (msg) => new Promise((resolve, reject) => {
    const keep = onMessage(msg, {}, resolve);
    if (keep !== true) resolve(undefined);
    setTimeout(() => reject(new Error('ส่วนขยายไม่ตอบกลับภายใน 5 วิ (ป๊อปอัปจะค้าง)')), 5000).unref();
  });
  return { ctx, store, calls, send };
}
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const htmlRes = (status) => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' });
// หน้าเว็บปลอมแบบไม่มีตัวกลาง: /hub/api ไม่มี (404 HTML), รับ am-limits แล้วตอบจำนวนที่ได้
const plainApp = (profiles = [{ id: 'p1', label: 'บัญชีหนึ่ง' }]) => async (u, opts) => {
  if (u.endsWith('/hub/api/workspaces')) return htmlRes(404);
  if (u.endsWith('/api/profiles')) return jsonRes({ profiles });
  if (u.endsWith('/api/am-limits')) return jsonRes({ ok: true, saved: JSON.parse(opts.body).limits.length });
  return htmlRes(404);
};

describe('P1-1 รหัสผ่านเว็บภาษาไทย (btoa ตัวจริง)', () => {
  test('ส่งได้ และ Authorization เป็น UTF-8 แบบที่เบราว์เซอร์ส่งเอง', async () => {
    const { ctx, store, calls } = loadWorker({
      store: { appUrl: 'http://app.test', workspace: '', profile: 'p1', user: 'แอดมิน', pass: 'ลับมาก' },
      graph: { data: [{ account_id: '111', adtrust_dsl: 500 }] }, app: plainApp(),
    });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, true, s.text);
    assert.strictEqual(store.status.ok, true);
    const auth = calls.app.find((c) => c.url.endsWith('/api/am-limits')).opts.headers.Authorization;
    assert.strictEqual(auth, 'Basic ' + Buffer.from('แอดมิน:ลับมาก', 'utf8').toString('base64'));
  });

  test('พังแบบไม่คาดคิด ป๊อปอัปต้องได้คำตอบเสมอ และป้าย ✓ เก่าต้องไม่ค้าง', async () => {
    const store = { status: { text: 'ส่งวงเงิน 3 บัญชีแล้ว', ok: true, at: 1 } };
    const { send, calls } = loadWorker({
      store, app: plainApp(), graph: { data: [{ account_id: '111', adtrust_dsl: 1 }] },
      // อ่านค่าตั้งค่าไม่ได้ (storage พัง) = refresh throw — เคสเดียวกับ btoa throw ในรุ่นเก่า
      storageGet: async (keys) => { if (keys.includes('appUrl')) throw new Error('storage พัง'); return {}; },
    });
    const s = await send({ type: 'pull' });
    assert.strictEqual(s.ok, false);
    assert.match(s.text, /storage พัง/);
    assert.strictEqual(store.status.ok, false, 'สถานะต้องไม่ค้าง "สำเร็จ" ของรอบก่อน');
    assert.strictEqual(calls.badge.at(-1), '!');
  });
});

describe('P2-7 อ่านวงเงินทุกหน้า (paging)', () => {
  test('ไล่ตาม cursors.after จนครบ และ token ไปที่ graph.facebook.com เท่านั้น', async () => {
    const pushed = [];
    const app = async (u, opts) => { if (u.endsWith('/api/am-limits')) pushed.push(JSON.parse(opts.body)); return plainApp()(u, opts); };
    const { ctx, calls } = loadWorker({
      store: { appUrl: 'http://app.test', workspace: '', profile: 'p1' }, app,
      graph: (u) => (new URL(u).searchParams.get('after') === 'C1'
        ? { data: [{ account_id: '222', adtrust_dsl: 2000 }] }
        // next ชี้ไปที่อื่น — ห้ามเดินตาม (มี token ติดไปด้วย) ต้องประกอบ URL เองจาก cursor
        : { data: [{ account_id: '111', adtrust_dsl: 1000 }], paging: { next: `https://evil.test/?access_token=${TOKEN}`, cursors: { after: 'C1' } } }),
    });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, true, s.text);
    assert.deepStrictEqual(pushed[0].limits.map((l) => l.id), ['111', '222'], 'บัญชีหน้าที่สองต้องถูกส่งด้วย');
    assert.strictEqual(calls.graph.length, 2);
    for (const u of calls.graph) assert.ok(u.startsWith('https://graph.facebook.com/v23.0/me/adaccounts?'));
    for (const c of calls.app) {
      assert.ok(!c.url.includes(TOKEN) && !String(c.opts.body || '').includes(TOKEN), 'token ห้ามออกไปที่อื่น: ' + c.url);
    }
  });

  test('Graph ตอบ next วนไม่จบ ต้องหยุดที่เพดาน', async () => {
    const { ctx, calls } = loadWorker({
      store: { appUrl: 'http://app.test', workspace: '', profile: 'p1' }, app: plainApp(),
      graph: (u) => ({ data: [{ account_id: String(calls.graph.length), adtrust_dsl: 1 }], paging: { next: u, cursors: { after: 'X' + calls.graph.length } } }),
    });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, true, s.text);
    assert.strictEqual(calls.graph.length, 25);
  });
});

describe('P2-8 เปิดหน้า Ads Manager ถี่ๆ ต้องไม่ยิงทุกครั้ง', () => {
  const setup = (lastOkMinutesAgo, lastProfile = 'p1') => {
    const at = Date.now() - lastOkMinutesAgo * 60000;
    return loadWorker({
      store: {
        appUrl: 'http://app.test', workspace: '', profile: 'p1',
        status: { text: 'ส่งแล้ว', ok: true, at }, lastOk: { at, workspace: '', profile: lastProfile },
      },
      graph: { data: [{ account_id: '111', adtrust_dsl: 1 }] }, app: plainApp(),
    });
  };

  test('เพิ่งส่งสำเร็จไม่ถึง 10 นาที = ข้าม ไม่ยิง Graph ไม่ส่งเข้าหน้าเว็บ', async () => {
    const w = setup(1);
    const s = await w.send({ type: 'token', token: TOKEN });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(w.calls.graph.length, 0);
    assert.strictEqual(w.calls.app.length, 0);
  });

  test('เกิน 10 นาทีแล้ว = ยิงตามปกติ • หลายแท็บโหลดพร้อมกันได้รอบเดียว', async () => {
    const w = setup(11);
    await Promise.all([w.send({ type: 'token', token: TOKEN }), w.send({ type: 'token', token: TOKEN })]);
    assert.strictEqual(w.calls.graph.length, 1);
  });

  test('ปุ่ม "ส่งเดี๋ยวนี้" ในป๊อปอัปไม่ติดเงื่อนไขนี้', async () => {
    const w = setup(1);
    const s = await w.send({ type: 'pull' });
    assert.strictEqual(s.ok, true, s.text);
    assert.strictEqual(w.calls.graph.length, 1);
  });

  test('เพิ่งเปลี่ยนบัญชีในป๊อปอัป = ส่งรอบใหม่ได้ทันที ไม่ต้องรอ 10 นาที', async () => {
    const w = setup(1, 'p0');
    const s = await w.send({ type: 'token', token: TOKEN });
    assert.strictEqual(s.ok, true, s.text);
    assert.strictEqual(w.calls.graph.length, 1);
    assert.strictEqual(w.store.lastOk.profile, 'p1', 'ต้องจำว่ารอบที่สำเร็จส่งเข้าบัญชีไหน');
  });
});

test('ตั้งค่ารุ่นเก่า + ตัวกลางตอบ 502 ชั่วคราว = ไม่จำว่า "ไม่มีตัวกลาง" ถาวร และไม่ส่งตาม cookie', async () => {
  const { ctx, store, calls } = loadWorker({
    store: { appUrl: 'http://app.test', profile: 'p1' },
    graph: { data: [{ account_id: '111', adtrust_dsl: 1 }] },
    app: async (u) => (u.endsWith('/hub/api/workspaces') ? htmlRes(502) : jsonRes({ ok: true, saved: 1 })),
  });
  const s = await ctx.refresh('เทส');
  assert.strictEqual(s.ok, false);
  assert.match(s.text, /HTTP 502/);
  assert.strictEqual(store.workspace, undefined, 'ต้องหาใหม่รอบหน้า ไม่ใช่จำค่าที่เดาไว้');
  assert.ok(!calls.app.some((c) => c.url.endsWith('/api/am-limits')), 'ห้ามส่งวงเงินไปตาม cookie');
});

// ---------- ส่วนขยาย: ป๊อปอัป ----------
// <select> จำลองตามสเปก: ยังไม่มีตัวไหนถูกเลือก = ตัวแรกที่ไม่ disabled ถูกเลือกเอง (ต้นเหตุของ P2-6)
class El {
  constructor(tag) { this.tagName = tag; this.kids = []; this._text = ''; this.disabled = false; this.listeners = {}; this.label = ''; this.className = ''; }
  appendChild(c) { this.kids.push(c); this.none = false; return c; }
  set textContent(t) { this.kids = []; this._text = String(t); this.none = false; }
  get textContent() { return this._text; }
  addEventListener(ev, f) { this.listeners[ev] = f; }
}
class Select extends El {
  options() { return this.kids.flatMap((k) => (k.tagName === 'optgroup' ? k.kids : [k])); }
  get value() {
    const o = this.options();
    const s = o.find((x) => x.selected) || (this.none ? null : o.find((x) => !x.disabled));
    return s ? s.value : '';
  }
  set value(v) {
    let hit = false;
    for (const x of this.options()) { x.selected = !hit && x.value === v; hit = hit || x.selected; }
    this.none = !hit;
  }
}
async function loadPopup({ store = {}, app }) {
  const els = {};
  const document = {
    getElementById: (id) => els[id] || (els[id] = id === 'profile' ? new Select('select') : new El('div')),
    createElement: (t) => new El(t),
  };
  const ctx = {
    console, URL, URLSearchParams, TextEncoder, btoa, document, fetch: app,
    chrome: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]]).filter(([, v]) => v !== undefined)),
          set: async (o) => { Object.assign(store, o); },
        },
      },
      permissions: { request: async () => true },
      runtime: { sendMessage: async () => ({}) },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(readExt('shared.js'), ctx);
  const src = readExt('popup.js');
  const patched = src.replace(/\ninit\(\);\s*$/, '\nglobalThis.__ready = init();');
  assert.notStrictEqual(patched, src, 'popup.js ต้องจบด้วย init(); — ให้เทสรอมันเสร็จได้');
  vm.runInContext(patched, ctx);
  await ctx.__ready;
  return { els, store };
}
const TWO = [{ id: 'p1', label: 'บัญชีหนึ่ง' }, { id: 'p2', label: 'บัญชีสอง' }];

describe('P2-6 ป๊อปอัปต้องให้เลือกเองเมื่อมีหลายบัญชี', () => {
  test('หลายบัญชีและยังไม่เคยเลือก = ไม่บันทึกตัวแรกให้เอง', async () => {
    const { els, store } = await loadPopup({ app: plainApp(TWO) });
    assert.strictEqual(store.profile, undefined, 'ห้ามเดาเลือกบัญชีแรกให้');
    assert.strictEqual(els.profile.value, '', 'ช่องต้องว่างรอให้เลือก');
    // กดบันทึกโดยยังไม่เลือก = บอกให้เลือก ไม่บันทึกบัญชีไหนเอง
    await els.save.listeners.click();
    assert.strictEqual(store.profile, undefined);
    assert.match(els.status.textContent, /เลือกบัญชี/);
    // ผู้ใช้เลือกเอง = จำทั้งโปรไฟล์และบัญชี
    els.profile.value = '|p2';
    await els.profile.listeners.change();
    assert.deepStrictEqual([store.workspace, store.profile], ['', 'p2']);
  });

  test('มีบัญชีเดียว = ตั้งให้เลย', async () => {
    const { store } = await loadPopup({ app: plainApp() });
    assert.deepStrictEqual([store.workspace, store.profile], ['', 'p1']);
  });

  test('ตั้งค่ารุ่นเก่า (จำแค่บัญชี) = หาโปรไฟล์ให้แล้วจำเพิ่ม ไม่เปลี่ยนบัญชีที่ผู้ใช้เลือกไว้', async () => {
    const { els, store } = await loadPopup({ store: { profile: 'p2' }, app: plainApp(TWO) });
    assert.deepStrictEqual([store.workspace, store.profile], ['', 'p2']);
    assert.strictEqual(els.profile.value, '|p2');
  });

  test('หลายโปรไฟล์ (ตัวกลาง) = แยกกลุ่มตามโปรไฟล์ และไม่เลือกให้เอง', async () => {
    const app = async (u) => {
      if (u.endsWith('/hub/api/workspaces')) return jsonRes({ current: 'pb', list: [{ id: 'top', name: 'TOP' }, { id: 'pb', name: 'B' }] });
      if (u.endsWith('/w/top/api/profiles')) return jsonRes({ profiles: [{ id: 'p1', label: 'ของ TOP' }] });
      if (u.endsWith('/w/pb/api/profiles')) return jsonRes({ profiles: [{ id: 'p9', label: 'ของ B' }] });
      return htmlRes(404);
    };
    const { els, store } = await loadPopup({ app });
    assert.strictEqual(store.profile, undefined);
    assert.deepStrictEqual(els.profile.kids.filter((k) => k.tagName === 'optgroup').map((g) => g.label), ['โปรไฟล์ TOP', 'โปรไฟล์ B']);
    assert.deepStrictEqual(els.profile.options().map((o) => o.value), ['', 'top|p1', 'pb|p9']);
  });
});

describe('P2-6/P1-2 pickTarget: เลือกให้เฉพาะตอนชัดเจนทางเดียว', () => {
  const ctx = { TextEncoder, btoa };
  vm.createContext(ctx);
  vm.runInContext(readExt('shared.js'), ctx);
  const groups = [
    { ws: 'top', profiles: [{ id: 'p1' }, { id: 'p2' }] },
    { ws: 'pb', profiles: [{ id: 'p3' }, { id: 'p1' }] },
  ];
  const pick = (g, saved) => JSON.parse(JSON.stringify(ctx.pickTarget(g, saved)));
  test('ไม่เคยเลือก: หลายตัว = null, ตัวเดียว = ตัวนั้น', () => {
    assert.strictEqual(pick(groups, {}), null);
    assert.deepStrictEqual(pick([{ ws: '', profiles: [{ id: 'p1' }] }], {}), { ws: '', profile: 'p1' });
  });
  test('เคยเลือก: ต้องตรงทั้งโปรไฟล์และบัญชี • บัญชีที่หายไปแล้วห้ามเดาตัวอื่นแทน', () => {
    assert.deepStrictEqual(pick(groups, { workspace: 'pb', profile: 'p1' }), { ws: 'pb', profile: 'p1' });
    assert.strictEqual(pick(groups, { workspace: 'top', profile: 'p3' }), null);
    assert.strictEqual(pick([{ ws: '', profiles: [{ id: 'p1' }] }], { workspace: '', profile: 'ลบไปแล้ว' }), null);
  });
  test('ตั้งค่ารุ่นเก่า (ไม่มีโปรไฟล์): เจอตัวเดียว = ตัวนั้น • ซ้ำหลายโปรไฟล์ = ให้ผู้ใช้เลือก', () => {
    assert.deepStrictEqual(pick(groups, { profile: 'p3' }), { ws: 'pb', profile: 'p3' });
    assert.strictEqual(pick(groups, { profile: 'p1' }), null);
  });
});

// ---------- P1-2 ส่วนขยาย + ตัวกลางหลายโปรไฟล์ (hub.js ตัวจริง) ----------
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('P1-2 หน้าเว็บสลับไปโปรไฟล์อื่นแล้ว วงเงินยังต้องลงโปรไฟล์ที่ส่วนขยายเลือกไว้', async (t) => {
  const fb = await makeFakeFb({ accounts: [{ name: 'A', account_id: '111', account_status: 1, currency: 'THB' }], pages: [] });
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'บัญชีของ TOP', accessToken: 'tok' }], activeProfileId: 'p1' } });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hub = spawn(process.execPath, [path.join(ROOT, 'hub.js')], {
    env: {
      ...process.env, ...SAFE_ENV, PORT: String(port), CONFIG_PATH: path.join(dir, 'config.json'),
      FB_API_BASE: `http://127.0.0.1:${fb.port}`, FX_API_URL: `http://127.0.0.1:${fb.port}/fx`, PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { hub.kill(); fb.server.close(); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/env')).status === 200) break; } catch { /* ยังไม่ขึ้น */ }
    await sleep(200);
  }
  const call = async (method, p, body, cookie) => (await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  // ผู้ใช้สร้างโปรไฟล์ B บนหน้าเว็บแล้วสลับไป — เบราว์เซอร์ถือ cookie ของ B (ส่วนขยายแนบ cookie นี้ไปด้วย)
  const made = await (await call('POST', '/hub/api/workspaces', { name: 'B' })).json();
  assert.ok(made.ok, JSON.stringify(made));
  const cookie = (await call('POST', '/hub/api/select', { id: made.id })).headers.get('set-cookie').split(';')[0];
  const pB = await (await call('POST', '/api/profiles', { label: 'บัญชีของ B', accessToken: 'tokB' }, cookie)).json();
  const browserApp = (u, opts) => globalThis.fetch(u, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  const graph = { data: [{ account_id: '111', adtrust_dsl: 1234, adspaymentcycle: { data: [{ threshold_amount: '5000' }] } }] };
  const cfgOf = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const topCfg = path.join(dir, 'config.json');
  const bCfg = path.join(dir, 'ws', made.id, 'config.json');

  // ตั้งไว้ที่ TOP — ต้องลง TOP แม้ cookie ชี้ B (เดิมได้ 404 "ไม่พบบัญชีนี้")
  const w1 = loadWorker({ store: { appUrl: base, workspace: 'top', profile: 'p1' }, graph, app: browserApp });
  const s1 = await w1.ctx.refresh('เทส');
  assert.strictEqual(s1.ok, true, s1.text);
  assert.strictEqual(cfgOf(topCfg).profiles[0].amLimits.byAcct['111'].dsl, 1234);
  assert.strictEqual(cfgOf(bCfg).profiles[0].amLimits, undefined, 'โปรไฟล์ B ต้องไม่โดนแตะ');
  assert.ok(w1.calls.app.every((c) => c.url.startsWith(`${base}/w/top/`)), 'ต้องระบุโปรไฟล์ทาง /w/<id> ทุกคำขอ');

  // ตั้งค่ารุ่นเก่า (จำแค่ p1) — ต้องหาเจอว่าอยู่ TOP แล้วจำไว้ ไม่ตามโปรไฟล์ที่หน้าเว็บเลือกค้างไว้
  const w2 = loadWorker({ store: { appUrl: base, profile: 'p1' }, graph, app: browserApp });
  const s2 = await w2.ctx.refresh('เทส');
  assert.strictEqual(s2.ok, true, s2.text);
  assert.strictEqual(w2.store.workspace, 'top');

  // ป๊อปอัปต้องเห็นบัญชีของทุกโปรไฟล์ ไม่ใช่เฉพาะโปรไฟล์ที่หน้าเว็บเลือกอยู่
  const groups = JSON.parse(JSON.stringify(await w1.ctx.listTargets({ appUrl: base })));
  assert.deepStrictEqual(groups.map((g) => [g.ws, g.profiles.map((p) => p.id)]), [['top', ['p1']], [made.id, [pB.id]]]);
});

// ---------- เซิร์ฟเวอร์: server.js ตัวจริง + FB ปลอม ----------
async function bootServer(t) {
  const world = {
    accounts: [
      { name: 'A1', account_id: '111', account_status: 1, currency: 'THB' },
      { name: 'A2', account_id: '222', account_status: 1, currency: 'THB' },
    ],
    pages: [{ id: '9001', name: 'เพจ', is_published: true, promotion_eligible: true }],
  };
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'หนึ่ง', accessToken: 'tok1' }, { id: 'p2', label: 'สอง', accessToken: 'tok2' }], activeProfileId: 'p1' } });
  const srv = await startServer(dir, fb.port, SAFE_ENV);
  t.after(() => { srv.stop(); fb.server.close(); });
  const cfg = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const postRaw = async (body) => {
    const r = await fetch(srv.base + '/api/am-limits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { base: srv.base, world, cfg, postRaw };
}

describe('P2-5 /api/am-limits รับเฉพาะของที่ถูกต้อง', () => {
  test('id เพี้ยนถูกทิ้ง • ค่าเพี้ยนเป็น null ไม่ใช่ตัวเลขปลอม • ไม่เก็บ token', async (t) => {
    const { cfg, postRaw } = await bootServer(t);
    const r = await postRaw({
      profile: 'p1', token: 'EAA' + 'z'.repeat(100), amToken: 'EAA' + 'y'.repeat(100),
      limits: [
        { id: 'act_12a34', dsl: 5 },             // id มีตัวอักษรปน — เดิมกลายเป็นบัญชี 1234
        { id: 'act_111', dsl: [], threshold: ' ' }, // เดิมได้ 0 กับ 0
        { id: '222', dsl: true, threshold: '0x10' }, // เดิมได้ 1 กับ 16
        { id: 333, dsl: '1500.5', threshold: '1e3' },
        { id: '444', dsl: -1, threshold: -5 },
        { id: '555', dsl: -2, threshold: '11500' },
        null, 'x', { id: { $ne: 1 } },
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.saved, 5);
    assert.strictEqual(r.body.skipped, 4);
    assert.deepStrictEqual(cfg().profiles[0].amLimits.byAcct, {
      111: { dsl: null, threshold: null },
      222: { dsl: null, threshold: null },
      333: { dsl: 1500.5, threshold: null },
      444: { dsl: -1, threshold: null },
      555: { dsl: null, threshold: 11500 },
    });
    assert.ok(!JSON.stringify(cfg()).includes('EAA'), 'ห้ามมี token ค้างใน config');
  });

  test('ไม่ระบุบัญชี / บัญชีไม่มีจริง / ไม่มีรายการที่ใช้ได้ = ปฏิเสธ และไม่เขียนทับของเดิม', async (t) => {
    const { cfg, postRaw } = await bootServer(t);
    assert.strictEqual((await postRaw({ profile: 'p1', limits: [{ id: '111', dsl: 100 }] })).status, 200);
    const before = JSON.stringify(cfg());
    for (const [body, code] of [
      [{ limits: [{ id: '111', dsl: 5 }] }, 400],                 // เดิมเขียนใส่บัญชีที่ใช้งานอยู่เงียบๆ
      [{ profile: ['p1'], limits: [{ id: '111', dsl: 5 }] }, 400],
      [{ profile: 'ไม่มีจริง', limits: [{ id: '111', dsl: 5 }] }, 404],
      [{ profile: 'p1', limits: [{ id: 'act_x' }, null] }, 400],    // ของเพี้ยนล้วน — ห้ามล้างตัวเลขเดิม
      [{ profile: 'p1', limits: [] }, 400],
      [{ profile: 'p1', limits: 'ไม่ใช่ array' }, 400],
    ]) {
      const r = await postRaw(body);
      assert.strictEqual(r.status, code, JSON.stringify(body) + ' → ' + JSON.stringify(r.body));
      assert.ok(r.body.error);
    }
    assert.strictEqual(JSON.stringify(cfg()), before, 'config ต้องเหมือนเดิมทุกตัวอักษร');
  });
});

describe('P2-4 วงเงินต้องเห็นได้จากทุกบัญชี FB ที่มีบัญชีโฆษณานั้น', () => {
  test('ส่งเข้าบัญชีหนึ่ง อีกบัญชีก็เห็น • มีหลายชุดเอาชุดที่ใหม่สุด', async (t) => {
    const { base } = await bootServer(t);
    await post(base, '/api/am-limits', { profile: 'p1', limits: [{ id: '111', dsl: 1000 }, { id: '222', dsl: 2000 }] });
    const h2 = await get(base, '/api/health-overview?profile=p2');
    assert.deepStrictEqual(h2.accounts.map((a) => [a.id, a.dsl]), [['111', 1000], ['222', 2000]]);
    assert.ok(h2.limitsAt > 0, 'ต้องบอกเวลาของตัวเลข ไม่ใช่ "ยังไม่เคยได้ตัวเลข"');
    assert.ok(h2.accounts[0].limitsAt > 0, 'แต่ละบัญชีต้องบอกเวลาของตัวเลขตัวเอง');
    await sleep(5);
    await post(base, '/api/am-limits', { profile: 'p2', limits: [{ id: '111', dsl: 1500 }] });
    const h1 = await get(base, '/api/health-overview?profile=p1');
    assert.deepStrictEqual(h1.accounts.map((a) => [a.id, a.dsl]), [['111', 1500], ['222', 2000]]);
    assert.ok(h1.accounts[0].limitsAt > h1.accounts[1].limitsAt);
  });

  test('ชุดใหม่กว่าที่อ่านค่าไม่ได้ (null) ต้องไม่ลบตัวเลขจริงของอีกบัญชี', async (t) => {
    const { base } = await bootServer(t);
    await post(base, '/api/am-limits', { profile: 'p1', limits: [{ id: '111', dsl: 1000, threshold: '5000' }] });
    await sleep(5);
    await post(base, '/api/am-limits', { profile: 'p2', limits: [{ id: '111' }] });
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.deepStrictEqual([h.accounts[0].dsl, h.accounts[0].threshold], [1000, 5000]);
  });
});

describe('P2-3 อ่านเพจพลาดต้องไม่ลบตารางบัญชีโฆษณา', () => {
  test('health-overview และ /api/accounts ยังได้บัญชีโฆษณา พร้อมบอกสาเหตุของเพจ', async (t) => {
    const { base, world } = await bootServer(t);
    world.route = (m, p) => (p === 'me/accounts' ? { error: '(#10) Requires pages_show_list permission', errorCode: 10 } : null);
    const hr = await fetch(base + '/api/health-overview?profile=p1');
    const h = await hr.json();
    assert.strictEqual(hr.status, 200, JSON.stringify(h));
    assert.deepStrictEqual(h.accounts.map((a) => a.id), ['111', '222']);
    assert.deepStrictEqual(h.pages, []);
    assert.match(h.pagesError, /pages_show_list/);
    const ar = await fetch(base + '/api/accounts?profile=p1');
    const a = await ar.json();
    assert.strictEqual(ar.status, 200, JSON.stringify(a));
    assert.deepStrictEqual(a.adAccounts.map((x) => x.account_id), ['111', '222']);
    assert.match(a.pagesError, /pages_show_list/);
    // ?full=1 = หน้าต่างขึ้นแอด (เงินจริง) — ยังต้องพังทั้งก้อนเหมือนเดิม ห้ามได้บัญชีที่ไม่รู้ว่าลงเพจไหนได้
    const fr = await fetch(base + '/api/accounts?full=1&profile=p1');
    const f = await fr.json();
    assert.strictEqual(fr.status, 400);
    assert.match(f.error, /pages_show_list/);
    // บัญชีโฆษณาพังเอง ยังต้องเป็น error เหมือนเดิม (ไม่ใช่ตารางว่างเงียบๆ)
    world.route = (m, p) => (p === 'me/adaccounts' ? { error: 'บัญชีพัง', errorCode: 10 } : null);
    assert.strictEqual((await fetch(base + '/api/health-overview?profile=p1')).status, 400);
  });

  test('ปกติ pagesError เป็น null', async (t) => {
    const { base } = await bootServer(t);
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.strictEqual(h.pagesError, null);
    assert.strictEqual(h.pages.length, 1);
  });
});

// ---------- หน้าเว็บ: <script> ตัวจริงของ public/index.html บน DOM จำลอง ----------
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', disabled: false, checked: false, hidden: false,
    style: {}, dataset: {}, options: [], selectedIndex: -1,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {},
    appendChild() {}, setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; },
    closest: () => null, focus() {}, click() {}, remove() {}, scrollIntoView() {},
  };
}
// routes: prefix → ฟังก์ชันคืน {status, json} หรือ {status, html} หรือ throw (เน็ตหลุด)
// ระหว่างโหลดสคริปต์ fetch ทุกตัวค้างไว้ (init ไม่วิ่งต่อ) — เทสเรียกฟังก์ชันที่ต้องการเองทีหลัง
function loadPage() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const src = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const els = {};
  const calls = [];
  const toasts = [];
  let armed = false;
  const routes = {};
  const fetch = async (url, opts = {}) => {
    if (!armed) return new Promise(() => {});
    const u = String(url);
    calls.push({ url: u, opts });
    const key = Object.keys(routes).find((k) => u.startsWith(k));
    if (!key) throw new Error('ไม่มี route ในเทส: ' + u);
    const r = routes[key](u, opts);
    const status = r.status || 200;
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => { if (r.html) throw new SyntaxError('Unexpected token <'); return JSON.parse(JSON.stringify(r.json)); },
      text: async () => r.html || JSON.stringify(r.json),
    };
  };
  const document = {
    readyState: 'complete', hidden: false,
    getElementById: (id) => (els[id] = els[id] || makeEl(id)),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: (t) => makeEl('new-' + t), body: makeEl('body'),
  };
  const ctx = {
    console, document, fetch, URL, URLSearchParams, JSON, Math, Date, Promise, Set, Map, Object, Array, String, Number,
    window: { addEventListener() {}, scrollTo() {}, open: () => null, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    location: { hash: '', replace() {}, reload() {}, pathname: '/', search: '', origin: 'http://x' },
    history: { pushState() {}, replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, clear() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    MutationObserver: class { observe() {} disconnect() {} },
    EventSource: class { close() {} addEventListener() {} },
    alert: () => {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: () => 0,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'index.html-script' });
  ctx.toast = (m) => toasts.push(String(m));   // toast จริงต้องใช้ DOM เต็ม — เก็บข้อความไว้ตรวจแทน
  armed = true;
  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, els, calls, toasts, routes, run };
}
const healthAcct = (id, status, extra = {}) => ({
  id, name: 'บัญชี' + id, status, currency: 'THB', minor: 100, business: null,
  pixels: [{ id: 'px' + id, name: 'px', onLp: true }], funding: 'Visa *1', hidden: false, ...extra,
});
const rowOf = (html, id) => html.split('<tr').find((r) => r.includes(`data-id="${id}"`)) || '';
const GREEN_CHECK = '<path d="m9 12 2 2 4-4"/>';

describe('P2-1 บัญชีค้างชำระ/รอตรวจความเสี่ยง ต้องเป็น "ต้องแก้" ไม่ใช่เครื่องหมายถูกสีเขียว', () => {
  test('ทุกบัญชีที่ไม่ถูกซ่อนต้องอยู่ในช่องสรุปช่องใดช่องหนึ่ง', () => {
    const P = loadPage();
    P.ctx.renderHealthPage([{ p: { id: 'p1', label: 'หนึ่ง' }, accounts: [healthAcct('1', 1), healthAcct('3', 3), healthAcct('7', 7), healthAcct('2', 2)], pages: [], limitsAt: null }]);
    const t = (id) => String(P.els[id].textContent);
    assert.deepStrictEqual([t('hReady'), t('hFix'), t('hDead')], ['1', '2', '1'], 'พร้อม 1 / ต้องแก้ 2 (ค้างชำระ+รอตรวจ) / ตาย 1');
    const html = P.els.healthAcctRows.innerHTML;
    assert.ok(rowOf(html, '1').includes(GREEN_CHECK), 'บัญชีใช้ได้ยังได้เครื่องหมายถูก');
    for (const id of ['3', '7']) {
      assert.ok(!rowOf(html, id).includes(GREEN_CHECK), `สถานะ ${id} ห้ามได้เครื่องหมายถูกสีเขียว`);
      assert.match(rowOf(html, id), /row-warn/);
    }
  });
});

describe('P2-3 (หน้าเว็บ) อ่านเพจพลาด', () => {
  test('ตารางบัญชียังขึ้นครบ ส่วนตารางเพจบอกสาเหตุ', () => {
    const P = loadPage();
    P.ctx.renderHealthPage([{ p: { id: 'p1', label: 'หนึ่ง' }, accounts: [healthAcct('1', 1)], pages: [], pagesError: '(#10) Requires pages_show_list permission', limitsAt: null }]);
    assert.ok(rowOf(P.els.healthAcctRows.innerHTML, '1'));
    assert.match(P.els.healthPageRows.innerHTML, /โหลดเพจไม่ได้ — \(#10\) Requires pages_show_list/);
    assert.doesNotMatch(P.els.healthPageRows.innerHTML, /ไม่พบเพจ/);
  });
});

describe('P1-3 ซ่อนบัญชีแล้วต้องหายจากหน้าต่างขึ้นแอดด้วย', () => {
  test('ล้างคลังเต็มชุดของหน้าขึ้นแอด และรายการที่สร้างค้างไว้', async () => {
    const P = loadPage();
    let hidden = false;
    P.routes['/api/hidden'] = () => { hidden = true; return { json: { ok: true } }; };
    P.routes['/api/health-overview'] = () => ({ json: { accounts: [], pages: [], limitsAt: null } });
    P.routes['/api/accounts?full=1'] = () => ({ json: { name: 'me', pages: [], adAccounts: hidden ? [] : [{ name: 'จะซ่อน', account_id: '111', account_status: 1, currency: 'THB', pixels: [] }] } });
    P.run("profiles = [{ id: 'p1', label: 'หนึ่ง', hasToken: true }]");
    const ids = (list) => JSON.parse(JSON.stringify(list.map((a) => a.acctId)));   // array จาก vm คนละ realm
    assert.deepStrictEqual(ids(await P.ctx.loadFullAccounts()), ['111']);
    P.run('launchAccountsBuilt = true');
    await P.ctx.toggleHidden('account', '111', true, { disabled: false });
    assert.strictEqual(P.run('Object.keys(fullAccountCache).length'), 0, 'คลังเต็มชุดต้องถูกล้าง');
    assert.strictEqual(P.run('launchAccountsBuilt'), false, 'หน้าขึ้นแอดต้องสร้างรายการใหม่');
    assert.deepStrictEqual(ids(await P.ctx.loadFullAccounts()), [], 'บัญชีที่ซ่อนต้องไม่โผล่อีก');
  });
});

describe('P2-2 หน้าต่าง "ตรวจบัตร/Pixel" และปุ่มสร้าง Pixel ต้องไม่ค้าง', () => {
  const openModal = (P, reply) => {
    P.routes['/api/account-health'] = reply;
    P.run("healthCtx = { pid: 'p1', acct: '555' }");
    P.els.healthBody = makeEl('healthBody');
    P.els.healthBody.innerHTML = 'SPINNER';
    return P.ctx.renderHealth().then(() => P.els.healthBody.innerHTML);
  };
  const health = (accountStatus) => () => ({ json: { accountId: '555', currency: 'THB', accountStatus, hasPayment: true, paymentText: 'Visa *1', pixels: [{ id: 'px9', name: 'px' }] } });

  test('บัญชีถูกปิดใช้งาน = บอกสถานะ ไม่ขึ้น "เชื่อมบัตรแล้ว"', async () => {
    const body = await openModal(loadPage(), health(2));
    assert.match(body, /ถูกปิดใช้งาน/);
    assert.doesNotMatch(body, /เชื่อมบัตรแล้ว/);
  });

  test('ค้างชำระ = เตือนสถานะ และยังโชว์บัตร/Pixel • ใช้ได้ = เหมือนเดิม', async () => {
    const warn = await openModal(loadPage(), health(3));
    assert.match(warn, /ค้างชำระ/);
    assert.match(warn, /เชื่อมบัตรแล้ว/);
    const ok = await openModal(loadPage(), health(1));
    assert.match(ok, /เชื่อมบัตรแล้ว/);
  });

  test('เน็ตหลุด / ได้หน้า HTML = บอกในหน้าต่าง ไม่ใช่สปินเนอร์ค้าง', async () => {
    const net1 = await openModal(loadPage(), () => { throw new TypeError('Failed to fetch'); });
    assert.match(net1, /ตรวจไม่สำเร็จ: Failed to fetch/);
    const html = await openModal(loadPage(), () => ({ status: 502, html: '<html>Bad Gateway</html>' }));
    assert.match(html, /ตรวจไม่สำเร็จ: เซิร์ฟเวอร์ตอบ 502/);
  });

  test('สร้าง Pixel ได้หน้า HTML / เน็ตหลุด = ปุ่มกลับมากดได้ และบอกสาเหตุ', async () => {
    const P = loadPage();
    P.routes['/api/create-pixel'] = () => ({ status: 401, html: '<html>401</html>' });
    const btn = { disabled: false, textContent: '' };
    await P.ctx.createPixelHealth('p1', '555', btn);
    assert.deepStrictEqual([btn.disabled, btn.textContent], [false, '+ สร้าง Pixel เลย']);
    assert.match(P.toasts.at(-1), /ไม่สำเร็จ: เซิร์ฟเวอร์ตอบ 401/);

    P.routes['/api/create-pixel'] = () => { throw new TypeError('Failed to fetch'); };
    P.run("healthCtx = { pid: 'p1', acct: '555' }");
    P.els.newPixelName = makeEl('newPixelName');
    P.els.newPixelName.value = 'ad1';
    const btn2 = { disabled: false, textContent: '' };
    await P.ctx.createPixel(btn2);
    assert.deepStrictEqual([btn2.disabled, btn2.textContent], [false, '+ สร้าง Pixel']);
    assert.match(P.toasts.at(-1), /สร้างไม่สำเร็จ: Failed to fetch/);
  });

  test('โหลดหน้าสุขภาพได้หน้าใส่รหัส (401) = บอกสาเหตุที่อ่านรู้เรื่อง', async () => {
    const P = loadPage();
    P.routes['/api/health-overview'] = () => ({ status: 401, html: '<html>401</html>' });
    P.run("profiles = [{ id: 'p1', label: 'หนึ่ง', hasToken: true }]");
    await P.ctx.loadHealthPage(true);
    assert.match(P.els.healthAcctRows.innerHTML, /หนึ่ง: เซิร์ฟเวอร์ตอบ 401/);
  });
});
