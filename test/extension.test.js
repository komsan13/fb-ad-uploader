// เทสส่วนขยาย Chrome ที่ดึง Ads Manager token — รันไฟล์จริงของส่วนขยาย ไม่ได้เขียนตรรกะจำลองขึ้นมาใหม่
// background.js เป็น service worker เลยรันใน vm พร้อม chrome API ปลอม แต่ตัว fetch ปลายทาง
// ยิงเข้า server.js จริง แล้วยืนยันจาก config.json ว่า token ถึงปลายทางจริง
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get } = require('./helpers');

const EXT = path.join(__dirname, '..', 'extension');
const { extractFbToken } = require('../extension/extract.js');
const TOKEN = 'EAA' + 'x'.repeat(120);

describe('ส่วนขยาย: การดึง token ออกจากหน้า Ads Manager', () => {
  test('เจอ token จากทุกรูปแบบที่ FB ฝังไว้ในหน้า', () => {
    assert.strictEqual(extractFbToken(`<script>window.__accessToken="${TOKEN}"</script>`), TOKEN);
    assert.strictEqual(extractFbToken(`{"access_token":"${TOKEN}"}`), TOKEN);
    assert.strictEqual(extractFbToken(`{"token":"${TOKEN}"}`), TOKEN);
    assert.strictEqual(extractFbToken(`<div data-x='${TOKEN}'>`), TOKEN);
  });

  test('หน้าที่ไม่มี token ต้องคืน null ไม่ใช่เดาเอาอะไรมาส่ง', () => {
    assert.strictEqual(extractFbToken('<html><body>Log into Facebook</body></html>'), null);
    assert.strictEqual(extractFbToken(''), null);
    assert.strictEqual(extractFbToken(null), null);
  });

  test('ค่าที่ไม่ใช่ token จริงต้องไม่ถูกส่งออกไป', () => {
    // FB ใส่ค่านี้แทน token เมื่อ session ไม่มีสิทธิ์ — ถ้าปล่อยผ่านจะได้ 190 รัวๆ โดยไม่รู้สาเหตุ
    assert.strictEqual(extractFbToken('window.__accessToken="NO"'), null);
  });
});

// โหลด background.js จริงเข้า vm พร้อมของปลอมเท่าที่ service worker ต้องใช้
// graph = สิ่งที่ Graph API ตอบกลับ (ปลอม) เพราะ Graph ตัวจริงต้องยิงจากเบราว์เซอร์ผู้ใช้เท่านั้น
function loadWorker({ fbHtml, store = {}, graph, graphCalls = [] }) {
  const ctx = {
    console,
    URL,
    URLSearchParams,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    // ให้ importScripts รัน extract.js ตัวจริงในคอนเท็กซ์เดียวกัน เหมือนที่ Chrome ทำ
    importScripts: (f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx),
    fetch: async (url, opts) => {
      if (String(url).startsWith('https://adsmanager.facebook.com')) {
        if (fbHtml === null) throw new Error('net::ERR_FAILED');
        return { ok: true, status: 200, text: async () => fbHtml };
      }
      if (String(url).startsWith('https://graph.facebook.com')) {
        graphCalls.push(String(url));
        return { ok: true, status: 200, json: async () => graph };
      }
      return globalThis.fetch(url, opts);   // ยิงเข้า server.js จริง
    },
    chrome: {
      runtime: { onInstalled: { addListener: (f) => f() }, onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} } },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
      action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]]).filter(([, v]) => v !== undefined)),
          set: async (o) => { Object.assign(store, o); },
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx);
  return { ctx, store };
}

async function bootApp(t) {
  const world = {
    accounts: [{ name: 'บัญชีเทส', account_id: '111', account_status: 1, currency: 'THB', adtrust_dsl: 1688.29 }],
    campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
    pages: [{ id: 'page1', name: 'เพจหลัก', is_published: true, promotion_eligible: true }],
  };
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', pageId: 'page1' }], activeProfileId: 'p1' } });
  const srv = await startServer(dir, fb.port);
  t.after(() => { srv.stop(); fb.server.close(); });
  return { ...srv, dir };
}

const readCfg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).profiles[0];
const GRAPH_OK = {
  data: [
    { account_id: '111', adtrust_dsl: 1688.29, adspaymentcycle: { data: [{ threshold_amount: '11500' }] } },
    { account_id: '999', adtrust_dsl: -1 },
  ],
};

describe('ส่วนขยาย: อ่านวงเงินในเบราว์เซอร์แล้วส่งเข้าหน้าเว็บจริง', () => {
  test('อ่าน Graph เองแล้วส่งแค่ตัวเลข — ต้องลงถึง config จริงและหน้าสุขภาพเห็นเลย', async (t) => {
    const app = await bootApp(t);
    const graphCalls = [];
    const { ctx, store } = loadWorker({
      fbHtml: `<script>window.__accessToken="${TOKEN}"</script>`,
      store: { appUrl: app.base, profile: 'p1' }, graph: GRAPH_OK, graphCalls,
    });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, true, 'ต้องรายงานว่าสำเร็จ: ' + s.text);
    assert.strictEqual(store.status.ok, true, 'สถานะล่าสุดต้องถูกเก็บไว้ให้ป๊อปอัปอ่าน');
    assert.match(graphCalls[0] || '', /me\/adaccounts\?.*adtrust_dsl/, 'ต้องยิง Graph เองจากในเบราว์เซอร์');
    const h = await get(app.base, '/api/health-overview?profile=p1');
    assert.strictEqual(h.accounts[0].dsl, 1688.29, 'วงเงิน/วันต้องขึ้นบนหน้าสุขภาพ');
    assert.strictEqual(h.accounts[0].threshold, 11500);
    assert.ok(h.limitsAt > 0, 'ต้องบอกได้ว่าอัปเดตเมื่อไหร่ ไม่ให้เข้าใจผิดว่าเป็นค่าสด');
  });

  test('token ต้องไม่ถูกส่งออกไปไหนเลย — ทั้งใน request และใน config', async (t) => {
    const app = await bootApp(t);
    const bodies = [];
    const { ctx } = loadWorker({
      fbHtml: `<script>window.__accessToken="${TOKEN}"</script>`,
      store: { appUrl: app.base, profile: 'p1' }, graph: GRAPH_OK,
    });
    const realFetch = ctx.fetch;
    ctx.fetch = async (url, opts) => {
      if (String(url).startsWith(app.base)) bodies.push(String((opts || {}).body || ''));
      return realFetch(url, opts);
    };
    await ctx.refresh('เทส');
    assert.ok(bodies.length, 'ต้องมีการยิงเข้าหน้าเว็บ');
    for (const b of bodies) assert.ok(!b.includes(TOKEN), 'ห้ามมี token อยู่ใน request ที่ส่งออกจากเบราว์เซอร์');
    assert.ok(!JSON.stringify(readCfg(app.dir)).includes(TOKEN), 'ห้ามมี token ค้างใน config ของเซิร์ฟเวอร์');
  });

  test('ยังไม่ได้ตั้งค่า = ต้องไม่ยิงอะไรออกไป และบอกให้ไปตั้งค่า', async (t) => {
    const app = await bootApp(t);
    const { ctx } = loadWorker({
      fbHtml: `<script>window.__accessToken="${TOKEN}"</script>`, store: {}, graph: GRAPH_OK,
    });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, false);
    assert.match(s.text, /ตั้งค่า/);
    assert.strictEqual(readCfg(app.dir).amLimits, undefined, 'ต้องไม่มีอะไรถูกเขียนลง config');
  });

  test('ล็อกเอาต์อยู่ (หน้าไม่มี token) ต้องบอกให้ล็อกอิน ไม่ใช่ส่งของว่างไปทับของเดิม', async (t) => {
    const app = await bootApp(t);
    const { ctx } = loadWorker({
      fbHtml: '<html><body>Log into Facebook</body></html>',
      store: { appUrl: app.base, profile: 'p1' }, graph: GRAPH_OK,
    });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, false);
    assert.match(s.text, /ล็อกอิน/);
    assert.strictEqual(readCfg(app.dir).amLimits, undefined, 'หา token ไม่เจอต้องไม่ไปแตะของเดิมเลย');
  });

  test('Graph ตอบ error ต้องรายงานสาเหตุ และไม่ส่งของว่างไปทับตัวเลขเดิม', async (t) => {
    const app = await bootApp(t);
    const { ctx } = loadWorker({
      fbHtml: `<script>window.__accessToken="${TOKEN}"</script>`,
      store: { appUrl: app.base, profile: 'p1' },
      graph: { error: { message: 'Session has expired', code: 190 } },
    });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, false);
    assert.match(s.text, /Session has expired/);
    assert.strictEqual(readCfg(app.dir).amLimits, undefined);
  });

  test('ต่อเน็ตไม่ได้ ต้องรายงานสาเหตุ ไม่ใช่เงียบ', async (t) => {
    const app = await bootApp(t);
    const { ctx } = loadWorker({ fbHtml: null, store: { appUrl: app.base, profile: 'p1' }, graph: GRAPH_OK });
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, false);
    assert.match(s.text, /เปิดหน้า Ads Manager ไม่ได้/);
  });

  test('ตั้งชื่อผู้ใช้/รหัสไว้ ต้องแนบ Authorization ไปด้วย (หน้าเว็บจริงอยู่หลัง basic auth)', async (t) => {
    const app = await bootApp(t);
    let seenAuth = null;
    const { ctx } = loadWorker({
      fbHtml: `{"access_token":"${TOKEN}"}`,
      store: { appUrl: app.base, profile: 'p1', user: 'admin', pass: 'ลับ' }, graph: GRAPH_OK,
    });
    const realFetch = ctx.fetch;
    ctx.fetch = async (url, opts) => {
      if (String(url).startsWith(app.base)) seenAuth = (opts.headers || {}).Authorization;
      return realFetch(url, opts);
    };
    const s = await ctx.refresh('เทส');
    assert.strictEqual(s.ok, true, s.text);
    assert.strictEqual(seenAuth, 'Basic ' + Buffer.from('admin:ลับ', 'binary').toString('base64'));
  });
});
