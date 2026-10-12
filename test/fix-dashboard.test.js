// แดชบอร์ด/หน้าแคมเปญ: บั๊กที่รีวิวเวอร์ทำซ้ำได้จริง (12 ต.ค. 2026) — ฝั่งเซิร์ฟเวอร์รัน server.js จริงคุยกับ FB ปลอม
// ฝั่งหน้าเว็บดึงฟังก์ชันจริงออกมาจาก public/index.html รันใน vm กับ DOM/fetch จำลองเท่าที่ฟังก์ชันนั้นใช้
// (ไม่ copy โค้ดมาเทส — แก้ index.html แล้วเทสนี้วิ่งกับโค้ดชุดใหม่ทันที)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get, post } = require('./helpers');

// ---------------------------------------------------------------- ฝั่งเซิร์ฟเวอร์

const ACCT = '111';
const camp = (id, extra = {}) => ({ id, acct: ACCT, name: 'แคมเปญ ' + id, objective: 'OUTCOME_TRAFFIC', status: 'ACTIVE', effective_status: 'ACTIVE', created_time: '2026-10-01T00:00:00+0000', ...extra });

async function boot(t, world, { config = {}, cooldown, env = {} } = {}) {
  const fb = await makeFakeFb({ accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }], campaigns: [], ads: [], adsets: [], insights: [], ...world });
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', adAccountId: ACCT, pageId: 'page1' }], activeProfileId: 'p1', ...config } });
  if (cooldown) fs.writeFileSync(path.join(dir, 'fb-cooldown.json'), JSON.stringify(cooldown));
  const srv = await startServer(dir, fb.port, { WATCH_FIRST_DELAY_MS: String(10 * 3600 * 1000), TG_API_BASE: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '', ...env });
  t.after(() => { srv.stop(); fb.server.close(); });
  const calls = () => fb.world.calls.filter((c) => c.path !== 'fx');
  return { base: srv.base, srv, world: fb.world, dir, calls };
}
const getRaw = async (base, p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test('insights พลาด → บัญชีนั้นต้องได้ error ไม่ใช่ใช้จ่าย ฿0 แบบเงียบๆ', async (t) => {
  let fail = false;
  const { base } = await boot(t, {
    campaigns: [camp('9001', { daily_budget: '333300' })],
    insights: [{ acct: ACCT, campaign_id: '9001', spend: '2500.00', impressions: '10000', reach: '8000' }],
    route: (m, p) => (fail && p === `act_${ACCT}/insights` ? { error: 'An unknown error has occurred.', errorCode: 1 } : null),
  });
  const ok = await get(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  assert.strictEqual(ok.campaigns[0].spend, 2500);
  fail = true;
  const r = await getRaw(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  assert.notStrictEqual(r.status, 200);
  assert.match(r.body.error, /สถิติ/);
  assert.strictEqual(r.body.campaigns, undefined, 'ห้ามส่งแถวที่ใช้จ่าย 0 ปลอมๆ มาด้วย');
});

test('ดึงสถานะแอดพลาด → ต้องเป็น error ไม่ใช่ป้าย "โดนปฏิเสธ" หายเงียบ', async (t) => {
  const { base } = await boot(t, {
    campaigns: [camp('9001')],
    ads: [{ id: 'a1', acct: ACCT, campaign_id: '9001', effective_status: 'DISAPPROVED' }],
    route: (m, p) => (p === `act_${ACCT}/ads` ? { error: 'Service temporarily unavailable', errorCode: 2 } : null),
  });
  const r = await getRaw(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  assert.notStrictEqual(r.status, 200);
  assert.match(r.body.error, /สถานะแอด/);
});

test('ระหว่าง Meta สั่งพัก (hard): แดชบอร์ด/รายละเอียดไม่ยิง FB และไม่ต่อเวลาพัก — แต่ปุ่มหยุดแคมเปญยังใช้ได้', async (t) => {
  const coolUntil = Date.now() + 20 * 60000;
  const { base, calls, dir, world } = await boot(t, { campaigns: [camp('9001')] }, { cooldown: { coolUntil, coolHard: true, appBlocks: {} } });
  const r1 = await getRaw(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  const r2 = await getRaw(base, '/api/campaign-detail?profile=p1&id=9001&date=today');
  for (const r of [r1, r2]) {
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.cooling, true);
    assert.match(r.body.error, /พัก/);
  }
  assert.strictEqual(calls().length, 0, 'ดูข้อมูลตอนโดนพักต้องไม่ยิง FB เลย (เดิมยิง 7 ครั้ง)');
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'fb-cooldown.json'), 'utf8'));
  assert.strictEqual(after.coolUntil, coolUntil, 'ช่วงพักต้องไม่ถูกต่อเวลา');
  // หยุดแคมเปญที่กำลังใช้เงิน = งานที่ผู้ใช้กดเอง ต้องไม่ถูกกั้น
  const s = await post(base, '/api/campaign-status', { profile: 'p1', id: '9001', status: 'PAUSED' });
  assert.deepStrictEqual(s, { ok: true });
  assert.strictEqual(world.campaigns[0].status, 'PAUSED');
});

test('FB สั่งพักกลางคำขอ (header regain) → หยุดยิงขั้นที่เหลือทันที', async (t) => {
  const { base, calls } = await boot(t, {
    campaigns: [camp('9001')],
    headers: { 'x-business-use-case-usage': JSON.stringify({ [ACCT]: [{ type: 'ads_insights', call_count: 100, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 5 }] }) },
  });
  const r = await getRaw(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.cooling, true);
  assert.strictEqual(calls().length, 1, 'คำตอบแรกสั่งพักแล้ว ขั้นถัดไปต้องไม่ยิง');
});

test('ยอดรวมใช้ insights ระดับบัญชี (รวมแคมเปญที่ลบแล้ว) ส่วนแถวรายแคมเปญคงเดิม', async (t) => {
  // เอกสาร Meta: แคมเปญ DELETED ไม่โผล่ทั้งใน /campaigns และ insights?level=campaign แต่ยังรวมอยู่ใน /act/insights
  const { base, world } = await boot(t, {
    campaigns: [camp('9001')],
    route: (m, p, params) => {
      if (p !== `act_${ACCT}/insights`) return null;
      if (params.level === 'campaign') return { data: [{ campaign_id: '9001', spend: '100.00', impressions: '1000', reach: '900' }] };
      return { data: [{ spend: '350.00', impressions: '4000', reach: '3000' }] };   // + แคมเปญที่ลบไปแล้ว 250
    },
  });
  const r = await get(base, `/api/campaigns?profile=p1&account=${ACCT}&date=yesterday`);
  assert.strictEqual(r.campaigns.length, 1);
  assert.strictEqual(r.campaigns[0].spend, 100);
  assert.deepStrictEqual(r.totals, { spend: 350, impressions: 4000, reach: 3000 });
  const acctCall = world.calls.find((c) => c.path === `act_${ACCT}/insights` && !c.params.level);
  assert.ok(acctCall, 'ต้องขอ insights ระดับบัญชี (ไม่ระบุ level)');
  assert.strictEqual(acctCall.params.date_preset, 'yesterday');
});

test('งบ/วัน จากชุดโฆษณา: ไม่บวกงบของชุดที่หยุดไว้', async (t) => {
  const { base } = await boot(t, {
    campaigns: [camp('9001')],   // ไม่มี daily_budget ที่แคมเปญ = งบอยู่ที่ชุดโฆษณา
    adsets: [
      { id: 's1', acct: ACCT, campaign_id: '9001', status: 'ACTIVE', daily_budget: '100000' },
      { id: 's2', acct: ACCT, campaign_id: '9001', status: 'PAUSED', daily_budget: '500000' },
    ],
  });
  const r = await get(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  assert.strictEqual(r.campaigns[0].dailyBudget, 1000);
});

test('บัญชีที่แคมเปญเกิน 25 หน้า → ต้องติดธง truncated ไม่ใช่ตัดเงียบ (บัญชีปกติไม่มีธง)', async (t) => {
  const TOTAL = 2600;
  const all = Array.from({ length: TOTAL }, (_, i) => camp(String(100000 + i)));
  let big = true;
  const { base } = await boot(t, {
    route: (m, p, params) => {
      if (m !== 'GET' || p !== `act_${ACCT}/campaigns`) return null;
      if (!big) return { data: all.slice(0, 3) };
      const lim = Number(params.limit) || 25;
      const start = Number(params.after || 0);
      const next = start + lim < TOTAL ? String(start + lim) : null;
      return { data: all.slice(start, start + lim), paging: next ? { cursors: { after: next }, next: 'http://x/next' } : { cursors: {} } };
    },
  });
  const r = await get(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.campaigns.length < TOTAL);
  big = false;
  const small = await get(base, `/api/campaigns?profile=p1&account=${ACCT}&date=today`);
  assert.strictEqual(small.truncated, undefined);
});

test('เปิด/ปิด/ลบแคมเปญ: id เป็น object ({"toString":1}) ต้องตอบ 400 ไม่ใช่ทำเซิร์ฟเวอร์ตาย', async (t) => {
  const { base, srv, calls } = await boot(t, { campaigns: [camp('9001')] });
  let exited = null;
  srv.child.on('exit', (c) => { exited = c; });
  for (const ep of ['/api/campaign-status', '/api/campaign-delete']) {
    const r = await fetch(base + ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'p1', status: 'PAUSED', id: { toString: 1 } }) });
    assert.strictEqual(r.status, 400, ep);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(exited, null, 'เซิร์ฟเวอร์ต้องไม่ตาย (autopilot อยู่ในโปรเซสเดียวกัน)');
  assert.strictEqual(calls().length, 0);
  assert.deepStrictEqual(await post(base, '/api/campaign-status', { profile: 'p1', id: '9001', status: 'PAUSED' }), { ok: true });
});

// Anthropic ปลอม — จับว่าเซิร์ฟเวอร์ส่งอะไรให้ AI โดยไม่ต้องวิ่งออกเน็ต
async function fakeAnthropic(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push(JSON.parse(b || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: JSON.stringify({ summary: 'ok', actions: [] }) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('ai-advice: แถวขยะ ({"campaigns":[null]} / toString แปลก) ต้องไม่ทำเซิร์ฟเวอร์ล่ม', async (t) => {
  const ai = await fakeAnthropic(t);
  const { base, srv } = await boot(t, {}, { config: { anthropicKey: 'sk-ant-test-not-real' }, env: { ANTHROPIC_BASE_URL: ai.url } });
  let exited = null;
  srv.child.on('exit', (c) => { exited = c; });
  const send = (body) => fetch(base + '/api/ai-advice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r1 = await send({ campaigns: [null] });
  assert.strictEqual(r1.status, 400);
  const r2 = await send({ campaigns: [null, 5, 'x', [1], { id: { toString: 1 }, name: { toString: 1 }, spend: { valueOf: 1 } }], datePreset: { toString: 1 } });
  assert.ok([200, 502].includes(r2.status), `ต้องตอบเป็นคำขอปกติ (ได้ ${r2.status})`);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(exited, null, 'เซิร์ฟเวอร์ต้องไม่ตาย');
  const alive = await get(base, '/api/autopilot');
  assert.ok(alive && typeof alive === 'object');
});

test('ai-advice: สกุลเงินและชื่อบัญชีไปกับทุกแถว — หลายสกุลต้องบอก AI ว่าห้ามเทียบข้ามสกุล', async (t) => {
  const ai = await fakeAnthropic(t);
  const { base } = await boot(t, {}, { config: { anthropicKey: 'sk-ant-test-not-real' }, env: { ANTHROPIC_BASE_URL: ai.url } });
  const r = await post(base, '/api/ai-advice', {
    datePreset: 'last_7d',
    campaigns: [
      { id: '1', name: 'บาท', accountName: 'ร้าน A', currency: 'THB', spend: 630, results: 10 },
      { id: '2', name: 'ดอง', accountName: 'ร้าน B', currency: 'VND', spend: 76800, results: 5 },
    ],
  });
  assert.strictEqual(r.error, undefined, r.error);
  assert.strictEqual(ai.seen.length, 1);
  const content = ai.seen[0].messages[0].content;
  const json = JSON.parse(content.slice(content.indexOf('[')));
  assert.deepStrictEqual(json.map((c) => [c.บัญชี, c.สกุลเงิน]), [['ร้าน A', 'THB'], ['ร้าน B', 'VND']]);
  assert.match(content, /last_7d/);
  assert.match(content, /หลายสกุลเงิน/);
});

// ---------------------------------------------------------------- ฝั่งหน้าเว็บ (โค้ดจริงจาก index.html)

const HTML_LINES = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split(/\r?\n/);
// ตั้งแต่บรรทัดที่ตรง start ถึงวงเล็บปิดระดับบนสุด (บรรทัดที่ขึ้นต้นด้วย "}") ตัวแรกหลังจากนั้น
function block(start, endBefore) {
  const i = HTML_LINES.findIndex((l) => start.test(l));
  assert.ok(i >= 0, `ไม่พบ ${start} ใน index.html`);
  let j;
  if (endBefore) j = HTML_LINES.findIndex((l, k) => k > i && endBefore.test(l)) - 1;
  else j = HTML_LINES.findIndex((l, k) => k > i && /^}/.test(l));
  assert.ok(j >= i, `หาจุดจบของ ${start} ไม่เจอ`);
  return HTML_LINES.slice(i, j + 1).join('\n');
}
const fn = (name) => block(new RegExp(`^(async )?function ${name}\\(`));
function load(ctx, ...srcs) {
  vm.createContext(ctx);
  for (const s of srcs) vm.runInContext(s, ctx);
  return ctx;
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- DOM จำลองขั้นต่ำ: พอให้ตารางทำงานจริง + MutationObserver ส่งผลแบบ microtask ตามสเปก
function makeDom() {
  const mos = [];
  class MO {
    constructor(cb) { this.cb = cb; this.q = []; this.deliveries = 0; mos.push(this); }
    observe(target) { target._obs.push(this); }
    _enqueue(rec) {
      this.q.push(rec);
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (!this.q.length) return;
        // โค้ดเดิมวนไม่รู้จบ (tblApply ย้ายแถว → observer → tblApply ...) — ตัดไว้ที่ 50 ไม่ให้เทสค้าง
        if (++this.deliveries > 50) return;
        const recs = this.q; this.q = [];
        this.cb(recs, this);
      });
    }
    takeRecords() { const r = this.q; this.q = []; return r; }
  }
  class Text { constructor(s) { this.textContent = s; } }
  class El {
    constructor(tag, cls = [], kids = []) {
      this.tagName = tag; this.childNodes = []; this.parentNode = null; this._obs = []; this.style = { display: '' };
      this._cls = new Set(cls); this.id = ''; this.listeners = {};
      const self = this;
      this.classList = {
        add: (...c) => c.forEach((x) => self._cls.add(x)), remove: (...c) => c.forEach((x) => self._cls.delete(x)),
        contains: (c) => self._cls.has(c), toggle: (c, on) => { if (on === undefined ? !self._cls.has(c) : on) self._cls.add(c); else self._cls.delete(c); },
      };
      for (const k of kids) this.appendChild(typeof k === 'string' ? new Text(k) : k);
      this._obs = [];
    }
    get children() { return this.childNodes.filter((n) => n instanceof El); }
    get rows() { return this.children.filter((n) => n.tagName === 'tr'); }
    get cells() { return this.children.filter((n) => n.tagName === 'td' || n.tagName === 'th'); }
    appendChild(n) {
      if (n.parentNode) n.parentNode._remove(n);
      this.childNodes.push(n); n.parentNode = this;
      this._obs.forEach((o) => o._enqueue({ type: 'childList' }));
      return n;
    }
    _remove(n) {
      this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null;
      this._obs.forEach((o) => o._enqueue({ type: 'childList' }));
    }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
    get innerText() { return this.childNodes.map((n) => (n instanceof El && n.tagName === 'div' ? '\n' : '') + (n instanceof El ? n.innerText : n.textContent)).join(''); }
    querySelector(sel) {
      const alts = sel.split(',').map((s) => s.trim());
      const hit = (n) => alts.some((a) => (a[0] === '.' ? n._cls.has(a.slice(1)) : n.tagName === a));
      const walk = (n) => { for (const c of n.children) { if (hit(c)) return c; const d = walk(c); if (d) return d; } return null; };
      return walk(this);
    }
    addEventListener(type, f) { (this.listeners[type] = this.listeners[type] || []).push(f); }
    click() { (this.listeners.click || []).forEach((f) => f()); }
  }
  // แถบค้นหา/แบ่งหน้าที่ tblEnhance สร้าง — ใช้แค่ให้มีที่เขียนค่า
  const loose = () => { const kids = {}; return { classList: { toggle() {}, add() {} }, set innerHTML(v) {}, querySelector: (s) => (kids[s] = kids[s] || loose()), addEventListener() {}, textContent: '', disabled: false }; };
  const document = { createElement: () => loose() };
  return { El, MO, mos, document };
}
function makeTable(dom, head, rows) {
  const { El } = dom;
  const wrap = { parentNode: { insertBefore() {} }, nextSibling: null };
  const tbody = new El('tbody');
  tbody.id = 'x';
  for (const r of rows) tbody.appendChild(r);
  const t = new El('table');
  t.tHead = { rows: [new El('tr', [], head.map((h) => new El('th', [], [h])))] };
  t.tBodies = [tbody];
  t.closest = () => wrap;
  return t;
}
const resCell = (dom, n, label) => new dom.El('td', [], [String(n), new dom.El('div', ['res-label'], [label])]);
const plainCell = (dom, s) => new dom.El('td', [], [s]);

function tableCtx() {
  const dom = makeDom();
  const ctx = load({ document: dom.document, MutationObserver: dom.MO, campSelChanged() {} }, block(/^const TBL_PAGE = /, /^function tblEnhanceAll/));
  return { dom, ctx };
}

test('tblCellVal: ช่องที่มีป้ายย่อย (.res-label) ต้องได้ตัวเลข — ผลลัพธ์/งบ/สกุลอื่น เรียงแบบตัวเลข', () => {
  const { dom, ctx } = tableCtx();
  const val = (td) => ctx.tblCellVal(new dom.El('tr', [], [td]), 0);
  assert.strictEqual(val(resCell(dom, 9, 'คลิกลิงก์')), 9);
  assert.strictEqual(val(resCell(dom, 100, 'คลิกลิงก์')), 100);
  assert.strictEqual(val(resCell(dom, '฿3,333.00', 'ต่อวัน')), 3333);
  assert.strictEqual(val(plainCell(dom, 'USD 50.00')), 50);
  assert.strictEqual(val(plainCell(dom, 'VND 76,800.00')), 76800);
  assert.strictEqual(val(plainCell(dom, '12%')), 12);
  // ไม่ใช่ตัวเลขทั้งก้อน = ยังเป็นข้อความ (วันที่ / สัดส่วน / ขีด)
  assert.strictEqual(typeof val(plainCell(dom, '12 ต.ค. 2569')), 'string');
  assert.strictEqual(typeof val(new dom.El('td', [], ['5/10 ', new dom.El('span', ['res-label'], ['เปิดอยู่'])])), 'string');
  assert.strictEqual(typeof val(plainCell(dom, '—')), 'string');
});

test('กดหัวคอลัมน์เรียง: ต้องไม่วน observer ↔ tblApply ไม่รู้จบ (เดิมแท็บค้าง) และเรียงตัวเลขถูก', async () => {
  const { dom, ctx } = tableCtx();
  const row = (name, n, budget) => new dom.El('tr', [], [plainCell(dom, name), resCell(dom, n, 'คลิกลิงก์'), resCell(dom, budget, 'ต่อวัน')]);
  const t = makeTable(dom, ['แคมเปญ', 'ผลลัพธ์', 'งบ/วัน'], [row('A', 9, '฿500.00'), row('B', 100, '฿3,333.00'), row('C', 12, '฿900.00')]);
  ctx.tblEnhance(t);
  await tick();
  const mo = dom.mos[0];
  assert.ok(mo, 'tblEnhance ต้องผูก MutationObserver กับ tbody');
  const names = () => t.tBodies[0].rows.map((r) => r.cells[0].textContent);

  t.tHead.rows[0].cells[1].click();   // ผลลัพธ์ น้อย → มาก
  await tick(); await tick();
  assert.strictEqual(mo.deliveries, 0, `การเรียงของเราเองต้องไม่ปลุก observer ซ้ำ (ส่งไป ${mo.deliveries} รอบ)`);
  assert.deepStrictEqual(names(), ['A', 'C', 'B']);

  t.tHead.rows[0].cells[2].click();   // งบ/วัน น้อย → มาก
  await tick();
  assert.deepStrictEqual(names(), ['A', 'C', 'B']);
  t.tHead.rows[0].cells[2].click();   // มาก → น้อย
  await tick();
  assert.deepStrictEqual(names(), ['B', 'C', 'A']);
  assert.strictEqual(mo.deliveries, 0);

  // ตัว render เขียนแถวใหม่ทั้งชุด → observer ต้องยังจัดเรียงให้ (ครั้งเดียว ไม่วน)
  const body = t.tBodies[0];
  for (const r of body.rows) body._remove(r);
  for (const r of [row('D', 5, '฿1.00'), row('E', 50, '฿2.00'), row('F', 7, '฿3.00')]) body.appendChild(r);
  await tick(); await tick();
  assert.strictEqual(mo.deliveries, 1);
  assert.deepStrictEqual(names(), ['F', 'E', 'D'], 'แถวชุดใหม่ต้องถูกเรียงตามคอลัมน์ที่เลือกไว้ (งบ มาก → น้อย)');
});

test('ผลลัพธ์ต่างชนิด (คลิก/ซื้อ) ห้ามบวกรวม • อันดับใช้จ่ายข้ามสกุลเทียบเป็นบาท', () => {
  const ctx = load({ fxRates: { VND: 768, USD: 0.03 } }, fn('resultsAgg'), fn('thbEq'), fn('bySpendThbDesc'));
  assert.deepStrictEqual({ ...ctx.resultsAgg([{ results: 100, resultLabel: 'คลิกลิงก์', spend: 600 }, { results: 3, resultLabel: 'คลิกลิงก์', spend: 400 }, { results: null, resultLabel: 'การซื้อ', spend: 5000 }]) },
    { n: 103, label: 'คลิกลิงก์', spend: 1000 }, 'ต้นทุน/คลิกต้องหารด้วยเงินของแคมเปญคลิกเท่านั้น ไม่ใช่รวมเงินแคมเปญขายที่ยังไม่มียอด');
  const mixed = ctx.resultsAgg([{ results: 100, resultLabel: 'คลิกลิงก์' }, { results: 3, resultLabel: 'การซื้อ' }]);
  assert.deepStrictEqual([...mixed.mixed], ['คลิกลิงก์', 'การซื้อ']);
  assert.strictEqual(mixed.n, null);
  // VND 76,800 ≈ ฿100 • USD 50 ≈ ฿1,667 • ฿630 • สกุลที่ไม่มีเรต (JPY) ไปท้าย
  const items = [
    { name: 'vnd', currency: 'VND', spend: 76800 }, { name: 'thb', currency: 'THB', spend: 630 },
    { name: 'jpy', currency: 'JPY', spend: 999999 }, { name: 'usd', currency: 'USD', spend: 50 },
  ];
  assert.deepStrictEqual(items.slice().sort(ctx.bySpendThbDesc).map((x) => x.name), ['usd', 'thb', 'vnd', 'jpy']);
});

// fetch จำลองที่คุมลำดับการตอบได้: ทุกคำขอค้างไว้จนกว่าเทสจะสั่ง resolve
function controlledFetch() {
  const pending = [];
  const f = (url, opts) => new Promise((resolve) => pending.push({ url, opts, resolve }));
  const reply = (p, status, body) => p.resolve({
    ok: status >= 200 && status < 300, status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  });
  return { f, pending, reply };
}

test('สวิตช์เปิด/ปิดแคมเปญ: คำขอพัง (502 หน้า HTML) → สวิตช์ดีดกลับ + แจ้ง + โหลดสถานะจริงใหม่', async () => {
  const net = controlledFetch();
  const toasts = [];
  const reloads = [];
  const ctx = load({
    fetch: net.f, toast: (m) => toasts.push(m), confirm: () => true, bustCaches() {},
    loadCampaigns: (force) => reloads.push(force),
  }, fn('apiJson'), fn('toggleCampaign'));
  const el = { checked: false, disabled: false };   // ผู้ใช้เพิ่งกดปิด (เดิม ACTIVE)
  const p = ctx.toggleCampaign('9001', 'ACTIVE', 'p1', el);
  await tick();
  net.reply(net.pending[0], 502, '<html>502 Bad Gateway</html>');
  await p;
  assert.strictEqual(el.checked, true, 'สวิตช์ต้องกลับไปตำแหน่ง "เปิด" ตามสถานะจริง');
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /ไม่สำเร็จ/);
  assert.deepStrictEqual(reloads, [true]);
});

test('รายละเอียดแคมเปญ: ผลของแคมเปญก่อนหน้าที่กลับมาช้าห้ามวาดทับ • ตอบไม่ใช่ JSON ต้องไม่หมุนค้าง', async () => {
  const net = controlledFetch();
  const body = { innerHTML: '' };
  const els = { detailBody: body, 'page-dashboard': { classList: { contains: () => false } }, campDate: { value: 'today' } };
  const ctx = load({ fetch: net.f, document: { getElementById: (id) => els[id] }, dashDate: 'today' },
    fn('esc'), fn('jsStr'), fn('apiJson'), block(/^const OBJ_TH = /), block(/^const EFF_TH = /), fn('detailStatusPill'),
    'var detailCtx = null; var detailSeq = 0;', fn('renderCampaignDetail'));
  const detail = (name) => ({ name, objective: 'OUTCOME_TRAFFIC', resultLabel: null, datePreset: 'today', ads: [],
    adsets: [{ id: name + '9', name: 'AdSet of ' + name, status: 'ACTIVE', effective_status: 'ACTIVE', dailyBudget: 10, spend: 0, impressions: 0, results: null, nAds: 0 }] });

  ctx.detailCtx = { pid: 'p1', id: '1001', cur: 'THB' };
  const pa = ctx.renderCampaignDetail();
  ctx.detailCtx = { pid: 'p1', id: '1002', cur: 'THB' };
  const pb = ctx.renderCampaignDetail();
  await tick();
  assert.match(net.pending[0].url, /id=1001/);
  net.reply(net.pending[1], 200, detail('B'));
  await pb;
  net.reply(net.pending[0], 200, detail('A'));   // ตัวช้า (แคมเปญ A) กลับมาทีหลัง
  await pa;
  assert.match(body.innerHTML, /AdSet of B/);
  assert.doesNotMatch(body.innerHTML, /AdSet of A/);

  const pc = ctx.renderCampaignDetail();
  await tick();
  net.reply(net.pending[2], 401, '401 Unauthorized');
  await pc;
  assert.doesNotMatch(body.innerHTML, /spin/);
  assert.match(body.innerHTML, /โหลดไม่สำเร็จ/);
});

test('หน้าแคมเปญ: refresh รอบเก่าที่จบช้า ห้ามเอาแคมเปญที่เพิ่งลบกลับมา (ทั้งจอและแคช)', async () => {
  const net = controlledFetch();
  const renders = [];
  const el = (v) => ({ value: v, textContent: '', innerHTML: '', dataset: {}, disabled: false });
  const els = { campDate: el('today'), campaignRows: el(), campSummary: el(), aiBtn: el() };
  const ctx = load({
    fetch: net.f, saveCaches() {}, setCampKpis() {}, campSelChanged() {}, renderCampaignRows: (results) => renderCampaigns(results),
    document: { getElementById: (id) => els[id], querySelectorAll: () => [{ value: 'p1:111' }] },
  }, fn('apiJson'), fn('pooled'), 'var lastCampRows = []; var campGen = 0;', block(/^const campCache = /, /^function renderCampaignRows/));
  function renderCampaigns(results) { renders.push(results[0].campaigns.map((c) => c.id)); }
  const campCache = vm.runInContext('campCache', ctx);
  const key = 'p1:111|today';
  campCache[key] = { ts: 0, results: [{ pid: 'p1', acct: '111', campaigns: [{ id: 'X' }, { id: 'Y' }] }] };   // แคชเก่า → refresh เบื้องหลัง

  const p1 = ctx.loadCampaigns();          // refresh เบื้องหลัง (ยังเห็น X)
  await tick();
  // ผู้ใช้ลบ X: deleteCampaign → bustCaches → loadCampaigns(true)
  Object.keys(campCache).forEach((k) => delete campCache[k]);
  ctx.campGen++;
  const p2 = ctx.loadCampaigns(true);
  await tick();
  assert.strictEqual(net.pending.length, 2);
  net.reply(net.pending[1], 200, { campaigns: [{ id: 'Y' }], currency: 'THB' });   // รอบใหม่ (ไม่มี X) จบก่อน
  await p2;
  net.reply(net.pending[0], 200, { campaigns: [{ id: 'X' }, { id: 'Y' }], currency: 'THB' });   // รอบเก่าจบทีหลัง
  await p1;
  assert.deepStrictEqual([...renders[renders.length - 1]], ['Y'], 'จอต้องไม่เห็น X อีก');
  assert.deepStrictEqual(Array.from(campCache[key].results[0].campaigns, (c) => c.id), ['Y'], 'แคชต้องไม่มี X');
  assert.strictEqual(vm.runInContext('campLoading', ctx), false, 'จบแล้วปุ่ม AI ต้องกดได้');
});

test('แดชบอร์ด: โปรไฟล์ที่โหลดรายชื่อบัญชีไม่ได้ต้องขึ้นเป็นแถว error และห้ามแคชว่าสด', async () => {
  const net = controlledFetch();
  let shown = null;
  const el = () => ({ innerHTML: '' });
  const els = { dashAcctRows: el(), dashTopRows: el() };
  const ctx = load({
    fetch: net.f, saveCaches() {}, renderDashboard: (r) => { shown = r; },
    document: { getElementById: (id) => els[id] },
    profiles: [{ id: 'p1', label: 'ร้านหลัก', hasToken: true }, { id: 'p2', label: 'ร้านสอง', hasToken: true }],
    accountCache: { p1: { adAccounts: [{ account_id: '111', name: 'บัญชีหนึ่ง', currency: 'THB', account_status: 1 }] } },
    accountErr: {},
    fetchProfAccounts: async (pid) => { ctx.accountErr[pid] = 'token หมดอายุ'; },
    dashCache: {}, dashDate: 'today', dashGen: 0, dashSeq: 0, DASH_CACHE_MS: 300000,
  }, fn('apiJson'), fn('pooled'), fn('loadDashboard'));
  const p = ctx.loadDashboard();
  await tick(); await tick();
  net.reply(net.pending[0], 200, { campaigns: [], currency: 'THB', totals: { spend: 5, impressions: 1, reach: 1 } });
  await p;
  const err = shown.find((r) => r.pid === 'p2');
  assert.ok(err, 'โปรไฟล์ที่พังต้องอยู่ในผลลัพธ์ ไม่ใช่หายเงียบ');
  assert.match(err.error, /token หมดอายุ/);
  assert.strictEqual(err.name, 'ร้านสอง');
  assert.strictEqual(ctx.dashCache.today.ts, 0, 'มี error = แคชต้องหมดอายุทันที');
  assert.strictEqual(shown.find((r) => r.pid === 'p1').totals.spend, 5);
});

test('แคชใน sessionStorage ติดป้ายโปรไฟล์: สลับโปรไฟล์แล้วห้ามดึงแคชของโปรไฟล์เก่า', () => {
  const store = {};
  const sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const page = (ws) => load({ sessionStorage, wsPage: ws, dashCache: {}, campCache: {}, healthCache: {} }, fn('saveCaches'), fn('restoreCaches'));
  const top = page('top');
  top.dashCache.today = { ts: Date.now(), results: ['ของ TOP'] };
  top.saveCaches();   // เช่น คำขอที่จบช้าหลัง wsReload ล้าง storage ไปแล้ว
  const b = page('brandB');
  b.restoreCaches();
  assert.deepStrictEqual({ ...b.dashCache }, {}, 'โปรไฟล์ใหม่ต้องไม่เห็นแดชบอร์ดของ TOP');
  const again = page('top');
  again.restoreCaches();
  assert.deepStrictEqual([...again.dashCache.today.results], ['ของ TOP'], 'โปรไฟล์เดิมยังได้แคชตัวเองตามปกติ');
});
