// เทสแก้บั๊กหลายโปรไฟล์/หน้าตั้งค่า: รัน hub.js จริง (ซึ่งสตาร์ท server.js ต่อโปรไฟล์) ชี้ FB/Telegram ไปตัวปลอม
// และไม่มี key ของ Anthropic — ยืนยันจากไฟล์บนดิสก์ + สิ่งที่ Telegram ปลอมได้รับ ไม่ใช่จากคำตอบของเซิร์ฟเวอร์อย่างเดียว
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer } = require('./helpers');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, why = 'เงื่อนไขไม่เกิดในเวลา') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(why);
}

// prep(dir) = เตรียมไฟล์ก่อนบูต (เช่น รายชื่อโปรไฟล์/config ของโปรไฟล์อื่น) • env = ทับ env ของตัวกลาง
async function bootHub(t, { prep, env = {}, config } = {}) {
  const fb = await makeFakeFb({ accounts: [], pages: [] });
  const dir = tmpDir();
  seed(dir, { config: config || { profiles: [{ id: 'p1', label: 'บัญชีของ TOP', accessToken: 'tok' }], activeProfileId: 'p1' } });
  if (prep) prep(dir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hub = spawn(process.execPath, [path.join(__dirname, '..', 'hub.js')], {
    env: {
      ...process.env, PORT: String(port), CONFIG_PATH: path.join(dir, 'config.json'),
      FB_API_BASE: `http://127.0.0.1:${fb.port}`, FX_API_URL: `http://127.0.0.1:${fb.port}/fx`, PUBLIC_URL: base,
      TG_API_BASE: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '', WATCH_FIRST_DELAY_MS: '999999999',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  hub.stdout.on('data', (d) => { log += d; });
  hub.stderr.on('data', (d) => { log += d; });
  t.after(() => { hub.kill(); fb.server.close(); });
  await until(async () => { try { return (await fetch(base + '/api/env')).status === 200; } catch { return false; } }, 30000, 'ตัวกลางไม่ขึ้น');
  // ทุกคำขอส่ง cookie ที่ตัวกลางตั้งให้กลับไป เหมือนเบราว์เซอร์ (ทุกหน้าต่างใช้ cookie ชุดเดียวกัน)
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text, headers: r.headers };
  };
  const reg = () => JSON.parse(fs.readFileSync(path.join(dir, 'workspaces.json'), 'utf8')).list.map((w) => w.id);
  return { base, dir, port, call, reg, getLog: () => log, getCookie: () => cookie };
}
const killSwitchOf = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).killSwitch; } catch { return undefined; } };

test('หน้าต่างที่ค้างโปรไฟล์เก่า (x-fbws-page ไม่ตรง cookie) ต้องได้ 409 และไม่มีโปรไฟล์ไหนโดนสั่ง', async (t) => {
  const h = await bootHub(t);
  const b = (await h.call('POST', '/hub/api/workspaces', { name: 'BRAND-B' })).json.id;
  // หน้าต่าง 1 เปิดที่ TOP แล้วหน้าต่าง 2 สลับไป BRAND-B (cookie ใช้ร่วมกัน)
  await h.call('POST', '/hub/api/select', { id: 'top' });
  await h.call('POST', '/hub/api/select', { id: b });
  const topState = path.join(h.dir, 'autopilot-state.json');
  const bState = path.join(h.dir, 'ws', b, 'autopilot-state.json');

  // หน้าต่าง 1 (จอ TOP) กดหยุดฉุกเฉิน — เดิมไปหยุด BRAND-B แทน
  const r = await h.call('POST', '/api/autopilot', { killSwitch: true }, { 'x-fbws-page': 'top' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.headers.get('x-fbws-mismatch'), b, 'หน้าเว็บต้องรู้ว่าตอนนี้ cookie ชี้โปรไฟล์ไหน');
  assert.match(r.json.error, /TOP.*BRAND-B/);
  assert.strictEqual(killSwitchOf(topState), undefined);
  assert.strictEqual(killSwitchOf(bState), undefined, 'โปรไฟล์ที่ผู้ใช้ไม่ได้ดูอยู่ต้องไม่โดนสั่ง');

  // หน้าต่างที่ตรงกับ cookie ทำงานปกติ
  assert.strictEqual((await h.call('POST', '/api/autopilot', { killSwitch: true }, { 'x-fbws-page': b })).status, 200);
  assert.strictEqual(killSwitchOf(bState), true);
  // ไม่มี header (โหลดหน้าแรก / ส่วนขยาย Chrome) = ตาม cookie เหมือนเดิม
  assert.strictEqual((await h.call('GET', '/api/profiles')).status, 200);
  // /w/<id>/... เจาะจงโปรไฟล์ทางลิงก์ ไม่สน cookie/header • หน้า Landing สาธารณะไม่มี header ไม่โดนอะไร
  assert.strictEqual((await h.call('GET', `/w/${b}/api/env`, undefined, { 'x-fbws-page': 'top' })).status, 200);
  assert.strictEqual((await fetch(h.base + '/lp')).status, 200);
  // หน้าเว็บต้องแนบ header ทั้งทาง fetch และ XMLHttpRequest (อัปโหลดคลิป/ขึ้นแอดใช้ XHR)
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /headers\.set\('x-fbws-page', wsPage\)/);
  assert.match(html, /setRequestHeader\('x-fbws-page', wsPage\)/);
});

test('ลบสองโปรไฟล์พร้อมกัน / สร้างระหว่างลบ — รายชื่อต้องไม่ฟื้นโปรไฟล์ที่ย้ายไปถังขยะแล้ว', async (t) => {
  const h = await bootHub(t);
  const x = (await h.call('POST', '/hub/api/workspaces', { name: 'X' })).json.id;
  const z = (await h.call('POST', '/hub/api/workspaces', { name: 'Z' })).json.id;
  const [dx, dz] = await Promise.all([
    h.call('POST', '/hub/api/workspaces/delete', { id: x }),
    h.call('POST', '/hub/api/workspaces/delete', { id: z }),
  ]);
  assert.deepStrictEqual([dx.status, dz.status], [200, 200]);
  assert.deepStrictEqual(h.reg(), ['top'], 'เดิมรายชื่อเหลือ X ที่ข้อมูลอยู่ในถังขยะแล้ว ตอบ 503 ไปตลอด');

  const y = (await h.call('POST', '/hub/api/workspaces', { name: 'Y' })).json.id;
  const pDel = h.call('POST', '/hub/api/workspaces/delete', { id: y });
  await sleep(15);
  const [d2, n2] = await Promise.all([pDel, h.call('POST', '/hub/api/workspaces', { name: 'NEW' })]);
  assert.strictEqual(d2.status, 200);
  assert.ok(n2.json.ok, JSON.stringify(n2.json));
  assert.deepStrictEqual(h.reg(), ['top', n2.json.id]);
  // ลบซ้ำตัวเดิมพร้อมกัน — ตัวหลังต้องได้ "ไม่พบ" ไม่ใช่ย้ายซ้ำ/เขียนรายชื่อทับ
  const w = (await h.call('POST', '/hub/api/workspaces', { name: 'W' })).json.id;
  const both = await Promise.all([1, 2].map(() => h.call('POST', '/hub/api/workspaces/delete', { id: w })));
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 404]);
  assert.deepStrictEqual(h.reg(), ['top', n2.json.id]);
});

test('/hub/api รับเฉพาะ JSON (กัน <form> ข้ามเว็บ) และจำกัดจำนวนโปรไฟล์', async (t) => {
  const h = await bootHub(t);
  // <form enctype="text/plain"> จากเว็บอื่นส่งแบบนี้ได้โดยไม่ต้องขออนุญาต
  const made = await h.call('POST', '/hub/api/workspaces', '{"name":"CSRF","x":"="}', { 'content-type': 'text/plain' });
  assert.strictEqual(made.status, 415);
  const sel = await h.call('POST', '/hub/api/select', '{"id":"top"}', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(sel.status, 415);
  assert.strictEqual(sel.headers.get('set-cookie'), null);
  assert.deepStrictEqual(h.reg(), ['top'], 'ห้ามสร้างโปรไฟล์ (= โปรเซสใหม่) จากคำขอแบบนี้');

  // ครบ 20 โปรไฟล์แล้วสร้างเพิ่มไม่ได้ (เขียนรายชื่อตรงๆ — ไม่ต้องบูต 20 โปรเซสจริง)
  const list = [{ id: 'top', name: 'TOP' }];
  for (let i = 1; i < 20; i++) list.push({ id: `pfull${i}`, name: `เต็ม ${i}` });
  fs.writeFileSync(path.join(h.dir, 'workspaces.json'), JSON.stringify({ list }));
  const over = await h.call('POST', '/hub/api/workspaces', { name: 'ตัวที่ 21' });
  assert.strictEqual(over.status, 400);
  assert.match(over.json.error, /20/);
  assert.strictEqual(h.reg().length, 20);
});

test('หน้า Landing ตอนโปรไฟล์ยังไม่พร้อม = หน้า HTML ภาษาไทยที่รีเฟรชเอง • /api ยังตอบ JSON', async (t) => {
  const h = await bootHub(t);
  // โปรไฟล์ที่อยู่ในรายชื่อแต่โปรเซสยังไม่ขึ้น (เหมือนช่วงบูตหลัง deploy)
  fs.writeFileSync(path.join(h.dir, 'workspaces.json'), JSON.stringify({ list: [{ id: 'top', name: 'TOP' }, { id: 'pboot', name: 'กำลังบูต' }] }));
  const lp = await fetch(`${h.base}/w/pboot/lp?utm=1`);
  assert.strictEqual(lp.status, 503);
  assert.match(lp.headers.get('content-type'), /text\/html/);
  assert.strictEqual(lp.headers.get('retry-after'), '3');
  const body = await lp.text();
  assert.ok(body.includes('กำลังโหลด กรุณารีเฟรช'));
  assert.match(body, /http-equiv="refresh"/);
  // หน้าแอดมินมี #page เสมอ — meta refresh ไปที่อยู่เดิม + # ไม่โหลดใหม่ (วัดในเบราว์เซอร์จริง) ต้องมี reload ด้วย JS
  assert.match(body, /location\.reload\(\)/);
  const api = await fetch(`${h.base}/w/pboot/api/landing`, { headers: { accept: 'text/html' } });
  assert.strictEqual(api.status, 503);
  assert.match(api.headers.get('content-type'), /application\/json/);
  assert.ok((await api.json()).error);
});

test('npm start ไม่ตั้ง PUBLIC_URL — redirect URI ต้องเป็นพอร์ตของตัวกลาง ไม่ใช่พอร์ตภายในของโปรไฟล์', async (t) => {
  const h = await bootHub(t, { env: { PUBLIC_URL: '' } });
  const env = (await h.call('GET', '/api/env')).json;
  assert.strictEqual(env.redirectUri, `http://localhost:${h.port}/auth/callback`);
});

// Telegram ปลอมที่ทำตามกติกาจริงของ getUpdates: ข้อความที่ถูกยืนยันแล้ว (offset > update_id) หายไปสำหรับทุกคน
function faithfulTg() {
  const st = { updates: [], sent: [], nextId: 1, polls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname.endsWith('/getUpdates')) {
        st.polls++;
        const off = Number(u.searchParams.get('offset') || 0);
        st.updates = st.updates.filter((x) => x.update_id >= off);
        return send({ ok: true, result: st.updates.slice() });
      }
      if (u.pathname.endsWith('/sendMessage')) { try { st.sent.push(JSON.parse(body)); } catch { /* ข้าม */ } return send({ ok: true, result: { message_id: 1 } }); }
      send({ ok: true, result: [] });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, st, port: server.address().port })));
}

test('บอท Telegram ตัวเดียวกันสองโปรไฟล์: รับคำสั่งแค่โปรไฟล์แรก • บันทึกบอทของโปรไฟล์อื่นไม่ได้', async (t) => {
  const tg = await faithfulTg();
  t.after(() => tg.server.close());
  const BOT = 'SAME-BOT-123:secret';
  // แยกว่าใครตอบ: TOP เก็บ chatId เป็นตัวเลข BRAND-B เป็นข้อความ (ผ่านตัวกรองแชทเหมือนกันทั้งคู่)
  const h = await bootHub(t, {
    config: { profiles: [], activeProfileId: null, telegram: { botToken: BOT, chatId: 111 } },
    env: { TG_API_BASE: `http://127.0.0.1:${tg.port}` },
    prep: (dir) => {
      fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ list: [{ id: 'top', name: 'TOP' }, { id: 'pb1', name: 'BRAND-B' }, { id: 'pc1', name: 'BRAND-C' }] }));
      for (const id of ['pb1', 'pc1']) fs.mkdirSync(path.join(dir, 'ws', id), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ws', 'pb1', 'config.json'), JSON.stringify({ profiles: [], activeProfileId: null, telegram: { botToken: BOT, chatId: '111' } }));
      fs.writeFileSync(path.join(dir, 'ws', 'pc1', 'config.json'), JSON.stringify({ profiles: [], activeProfileId: null }));
    },
  });
  for (const id of ['pb1', 'pc1']) {
    await until(async () => { try { return (await fetch(`${h.base}/w/${id}/api/env`)).status === 200; } catch { return false; } }, 30000, `โปรไฟล์ ${id} ไม่ขึ้น`);
  }
  await until(() => tg.st.polls >= 2, 20000, 'บอทไม่เคย poll');   // ผ่านรอบทิ้งข้อความค้างตอนบูตก่อน
  await sleep(1500);

  // "ยกเลิก" ตอบทันทีโดยไม่ผ่าน AI — นับว่าแต่ละข้อความถูกตอบจากโปรไฟล์ไหนบ้าง (เดิม: ทั้งสองโปรไฟล์ทุกข้อความ)
  for (let i = 0; i < 3; i++) {
    const before = tg.st.sent.length;
    tg.st.updates.push({ update_id: tg.st.nextId++, message: { chat: { id: 111 }, text: 'ยกเลิก', date: Math.floor(Date.now() / 1000) } });
    await until(() => tg.st.sent.length > before, 20000, 'ไม่มีโปรไฟล์ไหนตอบเลย — ต้องมีหนึ่งตัวรับคำสั่ง');
    await sleep(2500);   // เผื่อเวลาให้อีกโปรไฟล์ (ถ้ายังดึงอยู่) ตอบซ้ำ
    const who = tg.st.sent.slice(before).map((m) => (typeof m.chat_id === 'number' ? 'TOP' : 'BRAND-B'));
    assert.deepStrictEqual(who, ['TOP'], `ข้อความที่ ${i + 1} ต้องถูกทำโดย TOP ตัวเดียว ได้ ${who.join('+')}`);
  }

  // หน้าตั้งค่าบอกได้ว่าใครรับคำสั่ง / ใครถูกปิด • log บอกโปรไฟล์ที่ถูกปิด และห้ามมีค่า token
  const tB = (await h.call('GET', '/w/pb1/api/telegram')).json;
  assert.deepStrictEqual(tB.pollOwner, { id: 'top', name: 'TOP', sameChat: true });
  const tTop = (await h.call('GET', '/api/telegram')).json;
  assert.strictEqual(tTop.pollOwner, null);
  assert.deepStrictEqual(tTop.sharedWith, { id: 'pb1', name: 'BRAND-B' });
  assert.match(h.getLog(), /\[pb1\] \[telegram\].*TOP/);
  assert.ok(!h.getLog().includes(BOT), 'ห้ามพิมพ์ token ของบอทลง log');

  // โปรไฟล์อื่นบันทึกบอทตัวนี้ไม่ได้ • บอทของตัวเองบันทึกได้
  const dup = await h.call('POST', '/w/pc1/api/telegram', { botToken: BOT, chatId: '111' });
  assert.strictEqual(dup.status, 400);
  assert.match(dup.json.error, /TOP/);
  assert.ok(!dup.text.includes(BOT));
  const cfgC = () => JSON.parse(fs.readFileSync(path.join(h.dir, 'ws', 'pc1', 'config.json'), 'utf8'));
  assert.strictEqual((cfgC().telegram || {}).botToken, undefined, 'ต้องไม่ถูกบันทึกลงไฟล์');
  assert.ok((await h.call('POST', '/w/pc1/api/telegram', { botToken: 'OWN-BOT:x', chatId: '9' })).json.ok);
  assert.strictEqual(cfgC().telegram.botToken, 'OWN-BOT:x');
  // ของเดิมที่ซ้ำอยู่แล้ว: โปรไฟล์ที่รับคำสั่งอยู่ยังแก้ค่าของตัวเองได้ (ช่อง token โชว์ masked = ไม่เปลี่ยน)
  assert.ok((await h.call('POST', '/api/telegram', { botToken: tTop.botTokenMasked, chatId: '222' })).json.ok);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8')).telegram.chatId, '222');
  // คนละแชทแล้ว: แชทของ BRAND-B ไม่มีใครตอบ — หน้าตั้งค่าต้องบอกตามจริง ไม่ใช่บอกว่า "คำสั่งไปที่ TOP"
  assert.strictEqual((await h.call('GET', '/w/pb1/api/telegram')).json.pollOwner.sameChat, false);
});

// ---------- ตัวห่อ fetch/XHR ในหน้าเว็บ — รันโค้ดจริงจาก index.html ใน vm ด้วย fetch/XHR ปลอม ----------
function loadPageWrapper({ xhr409 = false } = {}) {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const src = html.slice(html.indexOf('// ---------- ผูกหน้าต่างนี้กับโปรไฟล์'), html.indexOf('// ---------- ไอคอน SVG'));
  assert.ok(src.length > 1000, 'หาโค้ดตัวห่อใน index.html ไม่เจอ');
  const st = { sent: [], xhr: [], confirm: [], post: [], reload: 0, reply: () => ({ status: 200 }) };
  const list = [{ id: 'top', name: 'TOP' }, { id: 'pb', name: 'BRAND-B' }];
  const fakeFetch = async (url, init = {}) => {
    const h = new Headers(init.headers);
    st.sent.push({ url: String(url), page: h.get('x-fbws-page'), ct: h.get('content-type') });
    if (String(url).startsWith('/hub/api/workspaces')) return new Response(JSON.stringify({ current: 'top', list }), { status: 200 });
    const r = st.reply(String(url));
    return new Response(JSON.stringify(r.body || {}), { status: r.status, headers: r.headers || {} });
  };
  class FakeXHR extends EventTarget {
    open(m, u) { this.u = u; this.hdr = {}; }
    setRequestHeader(k, v) { this.hdr[k.toLowerCase()] = v; }
    getResponseHeader(k) { return (this.resp || {})[k.toLowerCase()] || null; }
    send() {
      st.xhr.push({ url: this.u, page: this.hdr['x-fbws-page'] });
      if (xhr409) { this.readyState = 2; this.status = 409; this.resp = { 'x-fbws-mismatch': 'pb' }; this.dispatchEvent(new Event('readystatechange')); }
    }
  }
  const store = new Map();
  const ctx = vm.createContext({
    window: { fetch: fakeFetch }, location: { href: 'http://hub.test/', origin: 'http://hub.test' },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), clear: () => store.clear() },
    XMLHttpRequest: FakeXHR, ProgressEvent: class extends Event {}, Headers, URL, Promise, Error,
    setTimeout: (f, ms) => { const tm = setTimeout(f, ms); tm.unref(); return tm; },
    confirm: (m) => { st.confirm.push(m); return true; },
    wsFetch: async () => ({ current: 'pb', list }),
    wsPost: async (u, b) => { st.post.push([u, b]); return { ok: true }; },
    wsReload: () => { st.reload++; },
  });
  vm.runInContext(src, ctx);
  return { ctx, st, store, FakeXHR, val: (expr) => vm.runInContext(expr, ctx) };
}

test('หน้าเว็บ: ทุก fetch/XHR แนบโปรไฟล์ของหน้า • เจอ 409 ถามครั้งเดียว แล้วไม่ส่งคำขอสั่งงานอีกเลยจนโหลดใหม่', async () => {
  const p = loadPageWrapper();
  const { ctx, st } = p;
  await ctx.window.fetch('/api/profiles');
  assert.strictEqual(p.val('wsPage'), 'top');
  assert.strictEqual(st.sent.at(-1).page, 'top');
  assert.strictEqual(p.store.get('fbadWs'), 'top', 'แคชในแท็บต้องผูกกับโปรไฟล์');
  await ctx.window.fetch('https://graph.facebook.com/v23.0/me');
  assert.strictEqual(st.sent.at(-1).page, null, 'ข้ามเว็บห้ามแนบ (จะโดน CORS preflight)');
  const x = new p.FakeXHR(); x.open('POST', '/api/launch'); x.send();
  assert.strictEqual(st.xhr.at(-1).page, 'top', 'XHR อัปโหลด/ขึ้นแอดต้องแนบด้วย');

  // cookie ถูกหน้าต่างอื่นสลับไป BRAND-B แล้ว
  st.reply = () => ({ status: 409, headers: { 'x-fbws-mismatch': 'pb' }, body: { error: 'ไม่ตรง' } });
  const r = await ctx.window.fetch('/api/autopilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(st.sent.at(-1).ct, 'application/json', 'header เดิมของผู้เรียกต้องอยู่ครบ');
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(st.confirm.length, 1);
  assert.match(st.confirm[0], /TOP[\s\S]*BRAND-B/);
  assert.strictEqual(JSON.stringify(st.post), JSON.stringify([['/hub/api/select', { id: 'top' }]]), 'ตกลง = สลับกลับโปรไฟล์ของหน้านี้');
  assert.strictEqual(st.reload, 1);

  // หลังจากนี้คำขอสั่งงานต้องไม่ถูกส่งเลย (เดิมลูปขึ้นแอดส่งบัญชีถัดไปต่อ แล้วผ่านทันทีที่ cookie กลับมาตรง)
  const before = st.sent.length;
  await assert.rejects(ctx.window.fetch('/api/launch', { method: 'POST' }));
  assert.strictEqual(st.sent.length, before);
  const xb = new p.FakeXHR(); let errored = false;
  xb.addEventListener('error', () => { errored = true; });
  xb.open('POST', '/api/launch'); xb.send();
  await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(st.xhr.length, 1, 'XHR ต้องไม่ถูกส่ง');
  assert.ok(errored, 'ต้องแจ้ง error ให้โค้ดที่รอ XHR อยู่หยุด ไม่ค้าง');
  await ctx.window.fetch('/hub/api/workspaces');   // ตัวสลับโปรไฟล์ยังใช้ได้
  assert.strictEqual(st.confirm.length, 1, 'ถามครั้งเดียว');
});

test('หน้าเว็บ: XHR (ขึ้นแอด) ได้ 409 = หยุดทั้งหน้าตั้งแต่ได้ header ก่อน onload ของผู้เรียก', async () => {
  const p = loadPageWrapper({ xhr409: true });
  await p.ctx.window.fetch('/api/env');
  const x = new p.FakeXHR(); x.open('POST', '/api/launch'); x.send();
  assert.strictEqual(p.val('wsLeaving'), true, 'ต้องหยุดทันทีตอน readyState 2 — ลูปขึ้นแอดจะได้ไม่ส่งบัญชีถัดไป');
  await assert.rejects(p.ctx.window.fetch('/api/autopilot', { method: 'POST' }));
});

// ---------- เฉพาะ server.js ----------
test('OAuth state ต้องเป็นค่าสุ่มใช้ครั้งเดียว — state = id บัญชี (login CSRF) ต้องไม่ทับ token', async (t) => {
  const world = { route: (m, p) => (p === 'oauth/access_token' ? { access_token: 'long-tok' } : null) };
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'เทส', accessToken: 'old-tok', appId: 'app1', appSecret: 'sec1' }], activeProfileId: 'p1' } });
  const srv = await startServer(dir, fb.port, { TG_API_BASE: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '', WATCH_FIRST_DELAY_MS: '999999999' });
  t.after(() => { srv.stop(); fb.server.close(); });
  const token = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).profiles[0].accessToken;

  // แบบเดิม: เว็บอื่นยิง callback ด้วย code ของเขา + state = id บัญชีเรา
  const forged = await (await fetch(`${srv.base}/auth/callback?code=attacker-code&state=p1`)).text();
  assert.match(forged, /state ไม่ตรง/);
  assert.strictEqual(token(), 'old-tok');
  assert.strictEqual(world.calls.filter((c) => c.path === 'oauth/access_token').length, 0, 'ต้องไม่แลก code ของคนอื่นเลย');

  const login = await fetch(`${srv.base}/auth/login?profile=p1`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  assert.match(state, /^[0-9a-f]{32}$/);
  const ok = await (await fetch(`${srv.base}/auth/callback?code=real-code&state=${state}`)).text();
  assert.match(ok, /เชื่อมต่อสำเร็จ/);
  assert.strictEqual(token(), 'long-tok');
  // ใช้ซ้ำไม่ได้
  const again = await (await fetch(`${srv.base}/auth/callback?code=real-code&state=${state}`)).text();
  assert.match(again, /state ไม่ตรง/);
});

test('backup ของ config ต้องไม่มี token ของ Ads Manager (amToken) ติดไปด้วย', async (t) => {
  const fb = await makeFakeFb({ accounts: [], pages: [] });
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'x', accessToken: 'tok-keep', amToken: 'EAAB-ADS-MANAGER-SESSION' }], activeProfileId: 'p1' } });
  const srv = await startServer(dir, fb.port, { TG_API_BASE: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '', WATCH_FIRST_DELAY_MS: '999999999' });
  t.after(() => { srv.stop(); fb.server.close(); });
  await fetch(srv.base + '/api/profiles');
  assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('EAAB-ADS-MANAGER-SESSION'));
  const bdir = path.join(dir, 'config-backups');
  const baks = fs.readdirSync(bdir);
  assert.ok(baks.length >= 1, 'ต้องมี backup (บันทึกครั้งแรกของวัน)');
  for (const f of baks) {
    const text = fs.readFileSync(path.join(bdir, f), 'utf8');
    assert.ok(!text.includes('EAAB-ADS-MANAGER-SESSION'), `${f} ยังมี amToken`);
    assert.ok(text.includes('tok-keep'), 'backup ต้องยังกู้ token ปกติได้');
  }
});
