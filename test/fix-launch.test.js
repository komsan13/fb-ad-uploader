// หน้า "ขึ้นแอด" (/api/launch + โค้ดฝั่งหน้าเว็บ) — บั๊กที่วัดได้จริงกับ FB ปลอม (รอบรีวิว 12 ต.ค. 2026)
// ฝั่งเซิร์ฟเวอร์: รัน server.js จริงชี้ไป FB ปลอม แล้วยืนยันจาก request ที่ FB ได้รับ
// ฝั่งหน้าเว็บ: ดึงฟังก์ชันจริงจาก public/index.html มารันใน vm พร้อม DOM จำลองขั้นต่ำ
// (เทสสายหลุดแบบเต็มเส้น: launch() ของจริง → XHR จำลองที่ส่งเข้า server.js จริง → FB ปลอม)
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer } = require('./helpers');

const ACCT = '111';
const SAFE_ENV = { TG_API_BASE: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '' };   // ห้ามหลุดไปบริการจริง
const baseConfig = (extra = {}) => ({
  profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', pageId: 'page1' }],
  activeProfileId: 'p1',
  ...extra,
});
const freshWorld = (over = {}) => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
  pages: [{ id: 'page1', name: 'เพจหลัก', is_published: true, promotion_eligible: true }],
  ...over,
});

async function boot(t, { world = freshWorld(), config = baseConfig(), env = {}, fbPort } = {}) {
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config, videos: 3, captions: 1 });
  const srv = await startServer(dir, fbPort ? await fbPort(fb) : fb.port, { ...SAFE_ENV, ...env });
  t.after(() => { srv.stop(); fb.server.close(); });
  return { ...srv, dir, world, fb };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ad = (n, over = {}) => ({ mediaId: 'v1', name: `Ad-${n}`, message: 'ทดสอบ', link: 'https://example.com/', ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [], ...over });
const launchData = (over = {}) => ({
  profileId: 'p1', accountId: ACCT, pageId: 'page1',
  campaign: { name: 'เทสขึ้นแอด', objective: 'OUTCOME_TRAFFIC' },
  campaignBudget: 300, cta: 'LEARN_MORE', pixelId: '', active: true, ads: [ad(1)], ...over,
});
const lines = (txt) => txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));
async function launchPost(base, data) {
  const form = new FormData();
  form.append('data', JSON.stringify(data));
  return lines(await (await fetch(base + '/api/launch', { method: 'POST', body: form })).text());
}
// ส่ง /api/launch แบบคุมสายเอง — ตัดสายได้ตามเงื่อนไข (จำลองเน็ตหลุด/ปิดแท็บ)
function launchRaw(base, data, { cutWhen, cutAfterMs } = {}) {
  const b = '----fixlaunch' + Date.now();
  const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(data)}\r\n--${b}--\r\n`);
  return new Promise((resolve) => {
    let buf = '', tick;
    const req = http.request(base + '/api/launch', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${b}`, 'content-length': body.length } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { clearInterval(tick); resolve(buf); });
      if (cutAfterMs) setTimeout(() => { req.destroy(); resolve(buf); }, cutAfterMs);
    });
    if (cutWhen) tick = setInterval(() => { if (cutWhen()) { clearInterval(tick); req.destroy(); resolve(buf); } }, 10);
    req.on('error', () => { clearInterval(tick); resolve(buf); });
    req.end(body);
  });
}
const posts = (world, kind) => world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/${kind}`);
async function until(cond, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (cond()) return true; await sleep(25); }
  return false;
}

// ---------------------------------------------------------------- เซิร์ฟเวอร์ ----------------------------------------------------------------

describe('สายหลุดระหว่างขึ้นแอด ต้องไม่ได้แคมเปญซ้ำ/ไม่มีใครดู (P0-1)', () => {
  test('หลุดตอนเซิร์ฟเวอร์ยังอ่านสกุลเงินอยู่ (ก่อนเริ่มขึ้น) = ต้องไม่สร้างแคมเปญเลย', async (t) => {
    // เดิมผูก res.on('close') หลัง await สกุลเงิน/เรต — หลุดระหว่างนั้นไม่มีใครฟัง แอดขึ้นครบ 8 ตัวโดยไม่มีคนดู
    const world = freshWorld({
      route: (m, p, params) => (m === 'GET' && p === `act_${ACCT}` && params.fields === 'currency' ? { delay: 800, currency: 'THB' } : null),
    });
    const { base } = await boot(t, { world });
    await launchRaw(base, launchData({ ads: [1, 2, 3, 4, 5, 6].map((n) => ad(n)) }), { cutAfterMs: 200 });
    await sleep(2000);
    assert.strictEqual(posts(world, 'campaigns').length, 0, 'ไม่มีคนดูแล้ว ห้ามเริ่มใช้เงิน');
  });

  test('หลุดตอนกำลังอัปวิดีโอ = แอดที่กำลังเตรียมสื่อต้องไม่ไปสร้างแคมเปญต่อ', async (t) => {
    const world = freshWorld();
    world.route = (m, p) => {
      if (m !== 'POST' || p !== `act_${ACCT}/advideos`) return null;
      const id = String(9000 + (world.vseq = (world.vseq || 0) + 1));
      (world.videos = world.videos || []).push(id);
      return { delay: 800, id };
    };
    const { base } = await boot(t, { world });
    await launchRaw(base, launchData({ ads: [1, 2, 3, 4].map((n) => ad(n)) }), { cutWhen: () => posts(world, 'advideos').length >= 4 });
    await sleep(2500);
    assert.strictEqual(posts(world, 'campaigns').length, 0);
  });

  // ตั้งใจขึ้น 4 แอด สายหลุดตอน FB กำลังสร้างแอด แล้วหน้าเว็บส่งการ์ดที่ไม่ได้ผลกลับมาใหม่ด้วยกุญแจเดิม
  // เดิม: ได้ ACTIVE 7 แคมเปญ งบ 2,100 แทน 1,200 บาท/วัน
  for (const [label, waitFirst] of [['หลังรอบเดิมเสร็จไปแล้ว', true], ['ขณะรอบเดิมยังวิ่งอยู่', false]]) {
    test(`กดขึ้นซ้ำด้วย launchKey เดิม ${label} = ได้ผลเดิม ไม่สร้างแคมเปญซ้ำ`, async (t) => {
      const world = freshWorld({
        route: (m, p) => (m === 'POST' && p === `act_${ACCT}/ads` ? { delay: 700, id: 'AD' + crypto.randomBytes(3).toString('hex') } : null),
      });
      const { base } = await boot(t, { world });
      const cards = [1, 2, 3, 4].map((n) => ad(n, { launchKey: `card${n}-${crypto.randomBytes(4).toString('hex')}` }));
      const first = lines(await launchRaw(base, launchData({ ads: cards }), { cutWhen: () => posts(world, 'ads').length >= 1 }));
      const okIdx = new Set(first.filter((e) => e.type === 'result' && e.ok).map((e) => e.index));
      const started = new Set(first.filter((e) => e.type === 'status').map((e) => e.index));
      const inFlight = posts(world, 'campaigns').length;   // แคมเปญที่ FB สร้างไปแล้วตอนสายหลุด — ตัวพวกนี้ขึ้นต่อจนเสร็จ
      assert.ok(inFlight >= 1);
      if (waitFirst) await sleep(1500);   // ให้แอดที่ค้างอยู่ใน FB ตอบกลับครบ (FB ปลอมหน่วง 700ms)
      const retry = cards.map((c, i) => ({ ...c, resume: started.has(i) || undefined })).filter((_, i) => !okIdx.has(i));
      const again = await launchPost(base, launchData({ ads: retry }));
      const results = again.filter((e) => e.type === 'result');
      assert.strictEqual(results.length, retry.length);
      assert.ok(results.every((e) => e.ok), JSON.stringify(results));
      // ตัวที่สร้างแคมเปญไปแล้วต้องได้ผลเดิม (replayed) — ตัวที่ยังเตรียมสื่ออยู่ตอนหลุดถูกหยุดก่อนใช้เงิน แล้วขึ้นใหม่ในรอบนี้
      assert.ok(results.filter((e) => e.replayed).length >= inFlight - okIdx.size, JSON.stringify(results));
      assert.strictEqual(posts(world, 'campaigns').length, 4, 'แคมเปญต้องมี 4 เท่าที่ตั้งใจ');
      assert.strictEqual(world.campaigns.filter((c) => c.status === 'ACTIVE').length, 4);
      const done = again.find((e) => e.type === 'done');
      assert.strictEqual(done.campaignIds.length, retry.length, 'ลิงก์ Ads Manager ต้องชี้ถึงแคมเปญที่ขึ้นไปแล้วด้วย');
    });
  }

  test('หน้าเว็บบอกว่าไม่รู้ผล (resume) แต่เซิร์ฟเวอร์ไม่มีบันทึก (เช่น รีสตาร์ท) = ห้ามเดาว่ายังไม่ขึ้น', async (t) => {
    const { base, world } = await boot(t);
    const out = await launchPost(base, launchData({ ads: [ad(1, { launchKey: 'never-seen', resume: true })] }));
    const r = out.find((e) => e.type === 'result');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needsCheck, true);
    assert.match(r.error, /Ads Manager/);
    assert.strictEqual(posts(world, 'campaigns').length, 0);
  });

  test('รอบก่อนพังแบบไม่ทิ้งอะไรไว้บน FB = กดใหม่ด้วยกุญแจเดิมต้องขึ้นได้จริง (ไม่ตอบผลพังเดิมซ้ำ)', async (t) => {
    let failAds = true;
    const world = freshWorld({ route: (m, p) => (failAds && m === 'POST' && p === `act_${ACCT}/ads` ? { error: 'จำลองสร้างแอดไม่ผ่าน' } : null) });
    const { base } = await boot(t, { world });
    const card = ad(1, { launchKey: 'k-clean-fail' });
    const r1 = (await launchPost(base, launchData({ ads: [card] }))).find((e) => e.type === 'result');
    assert.strictEqual(r1.ok, false);
    assert.ok(!r1.needsCheck, 'ลบแคมเปญที่ค้างได้แล้ว = ไม่ต้องให้คนไปเช็ค');
    assert.strictEqual(world.campaigns[0].status, 'DELETED');
    failAds = false;
    const r2 = (await launchPost(base, launchData({ ads: [{ ...card, resume: true }] }))).find((e) => e.type === 'result');
    assert.strictEqual(r2.ok, true);
    assert.ok(!r2.replayed);
    assert.strictEqual(posts(world, 'campaigns').length, 2);
  });
});

describe('ลบแคมเปญค้างไม่สำเร็จ ต้องไม่ถูกกลืนเงียบ (P1-3)', () => {
  test('แอดพัง + ลบแคมเปญพัง = แจ้ง id แคมเปญที่ค้าง ห้ามขึ้นซ้ำ และกฎหยุดอัตโนมัติต้องครอบตัวนั้น', async (t) => {
    const world = freshWorld();
    world.route = (m, p, params) => {
      if (m === 'POST' && p === `act_${ACCT}/ads`) {
        // FB สร้างแอดไปแล้วแต่ตอบ error กลับมา (เจอในรีวิว) — แคมเปญจึงมีแอดยิงอยู่จริง
        world.ads.push({ id: 'AD1', acct: ACCT, ...params, effective_status: 'ACTIVE' });
        return { error: 'temporary', errorCode: 2 };
      }
      if (m === 'POST' && params.status === 'DELETED') return { error: 'Please reduce the amount of data', errorCode: 1 };
      return null;
    };
    const { base } = await boot(t, { world });
    const data = launchData({ autoRule: { cpr: 100, minSpend: 50 }, ads: [ad(1, { launchKey: 'k-leftover' })] });
    const out = await launchPost(base, data);
    const r = out.find((e) => e.type === 'result');
    const camp = world.campaigns[0];
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.needsCheck, true);
    assert.strictEqual(r.campaignId, camp.id);
    assert.ok(r.error.includes(camp.id) && /Ads Manager/.test(r.error), r.error);
    const rule = world.calls.find((c) => /adrules_library$/.test(c.path));
    assert.ok(rule, 'แคมเปญที่ค้างอาจยิงเงินอยู่ — กฎหยุดอัตโนมัติต้องครอบไว้');
    assert.deepStrictEqual(JSON.parse(rule.params.evaluation_spec).filters.find((f) => f.field === 'campaign.id').value, [camp.id]);
    // กดซ้ำการ์ดเดิมแบบไม่ดู = ได้ผลเดิม ไม่ใช่แคมเปญที่สอง
    const again = (await launchPost(base, data)).find((e) => e.type === 'result');
    assert.strictEqual(again.needsCheck, true);
    assert.strictEqual(posts(world, 'campaigns').length, 1);
  });
});

describe('ด่านก่อนยิง FB: งบ / กฎหยุดอัตโนมัติ / บัญชีที่ซ่อน', () => {
  for (const budget of [undefined, '', 0, -5]) {
    test(`งบต่อแอด = ${JSON.stringify(budget)} ต้องถูกปฏิเสธก่อนแตะ FB (เดิมได้ 300 บาทเงียบๆ) (P1-2)`, async (t) => {
      const { base, world } = await boot(t);
      const out = await launchPost(base, launchData({ campaignBudget: budget }));
      assert.ok(out.some((e) => e.type === 'fatal' && /งบ/.test(e.error)), JSON.stringify(out));
      assert.strictEqual(world.calls.length, 0, 'ต้องไม่ยิง FB เลย');
    });
  }

  test('เปิดกฎหยุดอัตโนมัติแต่ไม่มี CPA = ปฏิเสธ ไม่ขึ้นแอดแบบไม่มีตัวคุม (P2-7)', async (t) => {
    const { base, world } = await boot(t);
    const out = await launchPost(base, launchData({ autoRule: { cpr: 0, minSpend: 150 } }));
    assert.ok(out.some((e) => e.type === 'fatal' && /กฎหยุดอัตโนมัติ/.test(e.error)));
    assert.strictEqual(posts(world, 'campaigns').length, 0);
  });

  test('บัญชีที่ผู้ใช้ซ่อนไว้ = ขึ้นแอดเข้าไม่ได้', async (t) => {
    const { base, world } = await boot(t, { config: baseConfig({ hidden: { accounts: { [ACCT]: true } } }) });
    const out = await launchPost(base, launchData());
    assert.ok(out.some((e) => e.type === 'fatal' && /ซ่อน/.test(e.error)));
    assert.strictEqual(world.calls.length, 0);
  });
});

describe('อัปโหลดไฟล์ใหญ่ (P1-4, P2-6)', () => {
  test('เซิร์ฟเวอร์ต้องปิดเพดาน requestTimeout (อัปช้าเกิน 5 นาทีได้) แต่ headersTimeout ยังอยู่', async (t) => {
    // ดักค่าจริงของ http.Server ที่ server.js เปิดฟัง (preload ผ่าน NODE_OPTIONS) — รอ 5 นาทีจริงในเทสไม่ไหว
    const pre = path.join(tmpDir(), 'preload.js');
    fs.writeFileSync(pre, `const http = require('http'); const orig = http.Server.prototype.listen;
http.Server.prototype.listen = function (...a) { this.once('listening', () => console.log('TIMEOUTS ' + JSON.stringify({ r: this.requestTimeout, h: this.headersTimeout }))); return orig.apply(this, a); };`);
    const { getLog } = await boot(t, { env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require "${pre.replace(/\\/g, '/')}"`].filter(Boolean).join(' ') } });
    const m = getLog().match(/TIMEOUTS (\{.*\})/);
    assert.ok(m, getLog());
    const v = JSON.parse(m[1]);
    assert.strictEqual(v.r, 0, 'ค่าตั้งต้นของ Node ตัดที่ 300 วิ = วิดีโอใหญ่บนเน็ตช้าอัปไม่ผ่าน');
    assert.ok(v.h > 0, 'header ยังต้องมีเพดานเวลา');
  });

  test('วิดีโอจากคลังต้องถึง FB ครบทุกไบต์ (ส่งแบบสตรีมจากดิสก์)', async (t) => {
    const bytes = crypto.randomBytes(3 * 1024 * 1024);
    let got = null;
    let world;
    // ตัวกลางหน้า FB ปลอม: เก็บ body ดิบของ advideos (FB ปลอมอ่าน body เป็นข้อความ ไบนารีเพี้ยน) ที่เหลือส่งต่อ
    const fbPort = async (fb) => {
      world = fb.world;
      const px = http.createServer((req, res) => {
        if (req.method === 'POST' && /\/advideos$/.test(req.url)) {
          const chunks = [];
          req.on('data', (d) => chunks.push(d));
          return req.on('end', () => {
            got = Buffer.concat(chunks);
            const id = '777001';
            (world.videos = world.videos || []).push(id);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id }));
          });
        }
        const p = http.request({ host: '127.0.0.1', port: fb.port, method: req.method, path: req.url, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
        req.pipe(p);
      });
      await new Promise((r) => px.listen(0, '127.0.0.1', r));
      t.after(() => px.close());
      return px.address().port;
    };
    const { base, dir } = await boot(t, { fbPort });
    fs.writeFileSync(path.join(dir, 'media-library', 'v1.bin'), bytes);
    const out = await launchPost(base, launchData());
    assert.ok(out.find((e) => e.type === 'result').ok, JSON.stringify(out));
    assert.ok(got && got.indexOf(bytes) !== -1, 'ไฟล์ที่ FB ได้ต้องตรงกับไฟล์ในคลังทุกไบต์');
  });
});

// ---------------------------------------------------------------- หน้าเว็บ ----------------------------------------------------------------

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
// ฟังก์ชันระดับบนสุดในไฟล์นี้ปิดด้วย "}" ที่คอลัมน์แรกเสมอ
function grab(name) {
  const m = HTML.match(new RegExp(`\\n((?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n)`));
  assert.ok(m, `ไม่พบฟังก์ชัน ${name} ใน index.html`);
  return m[1];
}
function grabLine(start) {
  const i = HTML.indexOf('\n' + start);
  assert.ok(i >= 0, `ไม่พบบรรทัด ${start}`);
  return HTML.slice(i + 1, HTML.indexOf('\n', i + 1));
}

// DOM จำลองเท่าที่โค้ดขึ้นแอดแตะจริง
const el = (p = {}) => ({ value: '', checked: false, disabled: false, dataset: {}, style: {}, innerHTML: '', textContent: '', className: '', files: [], classList: { add() {}, remove() {} }, addEventListener() {}, ...p });
function fakeCard(id, over = {}) {
  const sub = {
    '.f-name': el({ value: `แอด ${id}` }), '.f-message': el({ value: 'ข้อความ' }), '.f-link': el({ value: 'https://example.com/' }),
    '.f-headline': el(), '.f-agemin': el({ value: '20' }), '.f-agemax': el({ value: '55' }), '.f-gender': el({ value: 'all' }),
    '.f-countries': el({ value: 'TH' }), '.f-image': el({ files: [] }), '.ad-err-msg': el(), '.badge': el(),
  };
  return el({ dataset: { id: String(id), mediaId: 'v1', launchKey: `ui${id}-${crypto.randomBytes(4).toString('hex')}`, ...over }, querySelector: (s) => sub[s], querySelectorAll: () => [] });
}
let CODE;   // ดึงตอนใช้ครั้งแรก — หาฟังก์ชันไม่เจอให้พังเฉพาะเทสหน้าเว็บ ไม่ลากเทสเซิร์ฟเวอร์ไปด้วย
const pageCode = () => CODE || (CODE = [
  grab('esc'), grab('jsStr'), grabLine('const cardResults'), grabLine('let mediaUploadsInFlight'), grabLine('let launchBusy'),
  grab('updateLaunchGate'), grab('getRes'), grab('relaunchHere'), grabLine('const relaunchBtn'), grab('runAutoPlan'),
  grab('markRes'), grab('cardNote'), grab('setBadge'), grab('aggregateBadge'),
  grabLine('const LAUNCH_BUSY_MSG'), grabLine('const RULE_NO_CPR_MSG'), grabLine('const ruleMissingCpr'),
  grab('launch'), grab('launchRun'), grab('autoLaunch'), grab('autoLaunchRun'),
  grabLine('let uploadSeq'), grab('abortCardUpload'), grab('uploadMedia'), grab('duplicateAd'),
  grab('apiJson'), grabLine('let ldTimer'), grab('saveLaunchDefaultsSoon'), grab('loadLaunchDefaults'),
].join('\n'));

// XHR จำลอง: ส่งเข้าเซิร์ฟเวอร์จริง (X.base) หรือให้เทสตอบเอง (X.respond) • X.dropIf = ตัดสายเมื่อเงื่อนไขจริง
function makePage({ cards = [], accounts = ['p1:111'], ids = {} } = {}) {
  const X = { list: [], base: null, respond: null, dropIf: null };
  class FakeXHR {
    constructor() { this.upload = {}; this.responseText = ''; this.status = 0; X.list.push(this); }
    open(method, url) { this.url = url; }
    abort() { this.aborted = true; if (this.req) this.req.destroy(); if (this.onabort) this.onabort(); }
    send(form) {
      this.form = form;
      if (X.respond) return X.respond(this);
      if (!X.base) return;   // เทสที่แค่อยากเห็นว่าส่งอะไรออกไป
      (async () => {
        const r = new Request('http://x/', { method: 'POST', body: form });
        const body = Buffer.from(await r.arrayBuffer());
        let gone = false, tick;
        const lose = () => { if (gone) return; gone = true; clearInterval(tick); req.destroy(); this.onerror(); };
        const req = http.request(X.base + this.url, { method: 'POST', headers: { 'content-type': r.headers.get('content-type'), 'content-length': body.length } }, (res) => {
          this.status = res.statusCode;
          res.setEncoding('utf8');
          res.on('data', (d) => { if (gone) return; this.responseText += d; if (this.onprogress) this.onprogress(); });
          res.on('end', () => { if (gone) return; gone = true; clearInterval(tick); this.onload(); });
        });
        this.req = req;
        tick = setInterval(() => { if (X.dropIf && X.dropIf()) lose(); }, 10);
        req.on('error', lose);
        req.end(body);
      })();
    }
  }
  const byId = {
    campaignName: el({ value: 'เทสหน้าเว็บ' }), objective: el({ value: 'OUTCOME_TRAFFIC', selectedOptions: [{ textContent: 'Traffic' }] }),
    campaignBudget: el({ value: '300' }), cta: el({ value: 'LEARN_MORE' }), conversionEvent: el({ value: '' }), lifecycleStrategy: el({ value: '100' }),
    ruleOn: el({ checked: false }), ruleCpr: el({ value: '' }), ruleSpend: el({ value: '' }), activeNow: el({ checked: true }),
    launchBtn: el(), autoLaunchBtn: el(), doneBanner: el(), progressWrap: el(), progressFill: el(), progressText: el(),
    ldSaved: el(), 'tpl-link': el({ value: 'https://example.com/' }), planPerAccount: el({ value: '1' }), ...ids,
  };
  const toasts = [], confirms = [];
  const page = {
    X, byId, toasts, confirms, cards, confirmAnswer: true,
    ctx: vm.createContext({
      document: {
        getElementById: (id) => byId[id] || null,
        querySelectorAll: (s) => (s === '.ad-card' ? cards : s === '#launchAccounts input:checked' ? accounts.map((value) => ({ value })) : []),
        querySelector: (s) => cards.find((c) => s === `.ad-card[data-id="${c.dataset.id}"]`) || null,
      },
      launchAccounts: [{ pid: 'p1', acctId: '111', name: 'บัญชีเทส', chosenPage: 'page1', chosenPixel: '', currency: 'THB' },
        { pid: 'p1', acctId: '222', name: 'บัญชีสอง', chosenPage: 'page1', chosenPixel: '', currency: 'THB' }],
      toast: (m) => toasts.push(m), confirm: (m) => { confirms.push(m); return page.confirmAnswer; },
      ic: () => '', bustCaches() {}, loadCampaigns() {}, updateStats() {},
      XMLHttpRequest: FakeXHR, FormData, Request, Response, Blob, setTimeout, clearTimeout, setInterval, clearInterval, console,
    }),
  };
  vm.runInContext(pageCode(), page.ctx);
  page.run = (js) => vm.runInContext(js, page.ctx);
  page.res = (card, key = 'p1:111') => {
    const r = page.run(`getRes(document.querySelector('.ad-card[data-id="${card.dataset.id}"]'))`);
    return r.ok.has(key) ? 'ok' : r.unk.has(key) ? 'unk' : r.check.has(key) ? 'check' : r.fail.has(key) ? 'fail' : 'none';
  };
  return page;
}
const sentData = (xhr) => JSON.parse(xhr.form.get('data'));
const ndjson = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const reply = (xhr, status, body) => { xhr.status = status; xhr.responseText = body; xhr.onload(); };
const okReply = (xhr) => {
  const d = sentData(xhr);
  reply(xhr, 200, ndjson(...d.ads.flatMap((_, i) => [{ type: 'status', index: i }, { type: 'result', index: i, ok: true, campaignId: 'C' + i }]), { type: 'done', campaignIds: [], account: d.accountId }));
};

describe('หน้าเว็บ: สายหลุดระหว่างขึ้นแอด → ไม่รู้ผล → กดซ้ำต้องไม่ได้แคมเปญซ้ำ (P0-1, เต็มเส้น)', () => {
  test('การ์ดที่กำลังขึ้นตอนหลุดต้องเป็น "ไม่รู้ผล" ไม่ใช่สำเร็จ และกดซ้ำแล้ว FB ได้แคมเปญครบ 4 ไม่เกิน', async (t) => {
    const world = freshWorld({
      route: (m, p) => (m === 'POST' && p === `act_${ACCT}/ads` ? { delay: 700, id: 'AD' + crypto.randomBytes(3).toString('hex') } : null),
    });
    const { base } = await boot(t, { world });
    const page = makePage({ cards: [1, 2, 3, 4].map((n) => fakeCard(n)) });
    page.X.base = base;
    page.X.dropIf = () => posts(world, 'ads').length >= 1;
    await page.run('launch()');
    const states = page.cards.map((c) => page.res(c));
    assert.ok(states.includes('unk'), `ต้องมีการ์ดที่ไม่รู้ผล: ${states}`);
    assert.ok(!page.byId.doneBanner.innerHTML.includes('สำเร็จทั้งหมด'), page.byId.doneBanner.innerHTML);
    assert.match(page.byId.doneBanner.innerHTML, /ไม่รู้ผล/);
    assert.strictEqual(page.run('launchBusy'), false);

    await sleep(1500);   // แอดที่ FB รับไปแล้วตอนหลุดขึ้นต่อจนเสร็จ (FB ปลอมหน่วง 700ms)
    page.X.dropIf = null;
    await page.run('launch()');
    assert.ok(page.confirms.some((m) => m.includes('ไม่รู้ผลจากรอบก่อน')), 'ต้องเตือนก่อนกดซ้ำการ์ดที่ไม่รู้ผล');
    assert.strictEqual(posts(world, 'campaigns').length, 4, 'แคมเปญต้องมี 4 เท่าที่ตั้งใจ ไม่ใช่ 7');
    assert.deepStrictEqual(page.cards.map((c) => page.res(c)), ['ok', 'ok', 'ok', 'ok']);
    assert.match(page.byId.doneBanner.innerHTML, /สำเร็จทั้งหมด 4/);
  });
});

describe('หน้าเว็บ: ผลที่ไม่ใช่ 200 / สตรีมขาด ห้ามขึ้น "สำเร็จทั้งหมด" (P1-5)', () => {
  for (const [label, status, body] of [
    ['ตัวกลางตอบ 503 (โปรไฟล์กำลังรีสตาร์ท)', 503, '{"error":"โปรไฟล์นี้กำลังเริ่มทำงาน — ลองใหม่ในอีกสักครู่"}'],
    ['ใส่รหัสเข้าเว็บใหม่ (401 หน้า HTML)', 401, '<html>401 Authorization Required</html>'],
    ['multer ปฏิเสธไฟล์ (500 หน้า HTML)', 500, '<pre>Error: Field value too long</pre>'],
    ['สตรีมขาดก่อนบรรทัดจบ', 200, ndjson({ type: 'status', index: 0 }, { type: 'result', index: 0, ok: true, campaignId: 'C0' }, { type: 'status', index: 1 })],
  ]) {
    test(label, async () => {
      const page = makePage({ cards: [fakeCard(1), fakeCard(2)] });
      page.X.respond = (xhr) => setTimeout(() => reply(xhr, status, body), 5);
      await page.run('launch()');
      const banner = page.byId.doneBanner.innerHTML;
      assert.ok(!banner.includes('สำเร็จทั้งหมด'), banner);
      assert.ok(banner.includes(status === 200 ? 'ขาดกลางทาง' : `เซิร์ฟเวอร์ตอบ ${status}`), banner);
      if (status === 503) assert.ok(banner.includes('กำลังเริ่มทำงาน'), 'ต้องเห็นข้อความจากตัวกลาง');
      const st = page.cards.map((c) => page.res(c));
      if (status === 200) assert.deepStrictEqual(st, ['ok', 'unk'], 'ตัวที่เริ่มแล้วแต่ไม่ได้ผล = ไม่รู้ผล');
      else assert.deepStrictEqual(st, ['fail', 'fail'], 'ยังไม่เริ่มเลย = กดขึ้นใหม่ได้');
    });
  }

  test('ตอบครบปกติ = สำเร็จทั้งหมด (คุมว่าไม่ได้เตือนพร่ำเพรื่อ)', async () => {
    const page = makePage({ cards: [fakeCard(1), fakeCard(2)] });
    page.X.respond = (xhr) => setTimeout(() => okReply(xhr), 5);
    await page.run('launch()');
    assert.match(page.byId.doneBanner.innerHTML, /สำเร็จทั้งหมด 2/);
  });
});

describe('หน้าเว็บ: ตรวจก่อนกดขึ้น', () => {
  test('ช่องงบว่าง/0 = ไม่ส่งอะไรออกไป (เดิมเติม 300 ให้เงียบๆ) (P1-2)', async () => {
    for (const v of ['', '0']) {
      const page = makePage({ cards: [fakeCard(1)], ids: { campaignBudget: el({ value: v }) } });
      await page.run('launch()');
      assert.strictEqual(page.X.list.length, 0);
      assert.match(page.toasts.join(), /งบ/);
    }
  });

  test('เปิดกฎหยุดอัตโนมัติแต่ช่อง CPA ว่าง = ไม่ส่ง ทั้งปุ่มขึ้นแอดและปุ่มขึ้นอัตโนมัติ (P2-7)', async () => {
    const page = makePage({ cards: [fakeCard(1)], ids: { ruleOn: el({ checked: true }), ruleCpr: el({ value: '' }) } });
    await page.run('launch()');
    await page.run('autoLaunch(document.getElementById("autoLaunchBtn"))');
    assert.strictEqual(page.X.list.length, 0);
    assert.strictEqual(page.toasts.filter((m) => m.includes('กฎหยุดอัตโนมัติ')).length, 2);
  });

  test('ค่าที่ส่งทุกบัญชีต้องเป็นชุดเดียวกับตอนกด แม้ผู้ใช้แก้ระหว่างรอบ (P2-10)', async () => {
    const card = fakeCard(1);
    const page = makePage({ cards: [card], accounts: ['p1:111', 'p1:222'] });
    page.X.respond = (xhr) => setTimeout(() => {
      if (page.X.list.length === 1) {   // ระหว่างรอบบัญชีแรก ผู้ใช้แก้งบ/สถานะ/กฎ/ข้อความการ์ด
        page.byId.campaignBudget.value = '9999';
        page.byId.activeNow.checked = false;
        page.byId.ruleOn.checked = true;
        page.byId.ruleCpr.value = '1';
        card.querySelector('.f-message').value = 'แก้แล้ว';
      }
      okReply(xhr);
    }, 5);
    await page.run('launch()');
    const [a, b] = page.X.list.map(sentData);
    assert.strictEqual(page.X.list.length, 2);
    for (const k of ['campaignBudget', 'active', 'autoRule', 'cta']) assert.deepStrictEqual(b[k], a[k], k);
    assert.strictEqual(b.campaignBudget, 300);
    assert.strictEqual(b.ads[0].message, 'ข้อความ');
    assert.strictEqual(b.ads[0].launchKey, card.dataset.launchKey, 'ส่งกุญแจประจำการ์ดไปด้วย');
  });
});

describe('หน้าเว็บ: ขึ้นได้ทีละรอบ (P2-8)', () => {
  test('กดขึ้นแอดซ้อนระหว่างรอบแรกยังวิ่ง = ไม่ส่งรอบที่สอง และปุ่มต้องปิดจนรอบแรกจบ', async () => {
    const page = makePage({ cards: [fakeCard(1)] });
    let release;
    page.X.respond = (xhr) => { release = () => okReply(xhr); };
    const first = page.run('launch()');
    await sleep(10);
    await page.run('launch()');
    assert.strictEqual(page.X.list.length, 1);
    assert.ok(page.toasts.includes(page.run('LAUNCH_BUSY_MSG')));
    assert.strictEqual(page.byId.launchBtn.disabled, true);
    assert.strictEqual(page.byId.autoLaunchBtn.disabled, true);
    release();
    await first;
    assert.strictEqual(page.byId.launchBtn.disabled, false);
    assert.strictEqual(page.byId.autoLaunchBtn.disabled, false);
  });

  test('ระหว่าง "ขึ้นอัตโนมัติทั้งหมด" กำลังจัดแผน กดปุ่มขึ้นแอดต้องไม่ได้ (เดิม runAutoPlan ปลดปุ่มก่อน launch)', async () => {
    const page = makePage({ cards: [fakeCard(1)] });
    let planDone;
    // runAutoPlan ของจริงเปิดปุ่มที่กดคืนเองใน finally — จำลองพฤติกรรมนั้นด้วย
    page.ctx.runAutoPlan = (btn) => new Promise((r) => { planDone = (v) => { btn.disabled = false; r(v); }; });
    const auto = page.run('autoLaunch(document.getElementById("autoLaunchBtn"))');
    await sleep(10);
    await page.run('launch()');
    assert.strictEqual(page.X.list.length, 0);
    assert.ok(page.toasts.includes(page.run('LAUNCH_BUSY_MSG')));
    assert.strictEqual(page.byId.launchBtn.disabled, true);
    page.confirmAnswer = false;   // ผู้ใช้กดยกเลิกที่หน้ายืนยันยอดเงิน
    let disabledAtConfirm;
    page.ctx.confirm = () => { disabledAtConfirm = page.byId.autoLaunchBtn.disabled; return false; };
    planDone({ plan: [{ ads: [{}] }], warnings: [], total: 1, link: 'https://example.com/' });
    await auto;
    assert.strictEqual(disabledAtConfirm, true, 'ระหว่างยังถือล็อก ปุ่มขึ้นอัตโนมัติต้องปิดอยู่');
    assert.strictEqual(page.X.list.length, 0, 'ยกเลิกที่หน้ายืนยัน = ไม่ส่งอะไร');
    assert.strictEqual(page.run('launchBusy'), false, 'ยกเลิกแล้วต้องปล่อยล็อก');
    assert.strictEqual(page.byId.autoLaunchBtn.disabled, false);
  });
});

describe('หน้าเว็บ: การ์ดที่ไม่รู้ผล/ต้องเช็คใน Ads Manager (ตามรีวิว)', () => {
  test('เช็คแล้วสั่งขึ้นใหม่ = ส่งเฉพาะบัญชีนั้นด้วยกุญแจรุ่นใหม่ บัญชีที่สำเร็จแล้วไม่โดนซ้ำ', async () => {
    // เดิมแนะนำให้ก๊อปการ์ด — ตัวก๊อปขึ้นทุกบัญชีที่ติ๊ก = แคมเปญซ้ำงบเต็มในบัญชีที่การ์ดเดิมขึ้นสำเร็จไปแล้ว
    const card = fakeCard(1);
    const page = makePage({ cards: [card], accounts: ['p1:111', 'p1:222'] });
    page.X.respond = (xhr) => setTimeout(() => okReply(xhr), 5);
    page.run(`const r = getRes(document.querySelector('.ad-card[data-id="1"]'));
      markRes(r, 'p1:111', 'check', 'ลบแคมเปญค้างไม่สำเร็จ'); markRes(r, 'p1:222', 'ok');`);
    await page.run('launch()');
    assert.strictEqual(page.X.list.length, 0, 'ยังไม่เช็ค = ห้ามส่ง');
    assert.match(page.toasts.join(), /เช็คใน Ads Manager/);
    page.run('relaunchHere("1", "p1:111")');
    await page.run('launch()');
    assert.strictEqual(page.X.list.length, 1);
    const d = sentData(page.X.list[0]);
    assert.strictEqual(d.accountId, '111');
    assert.strictEqual(d.ads[0].launchKey, `${card.dataset.launchKey}.1`);
    assert.strictEqual(page.res(card, 'p1:111'), 'ok');
  });

  test('จัดแผนใหม่ทับการ์ดที่ไม่รู้ผล ต้องเตือนชัด (ลบแล้วกันซ้ำไม่ได้) และกดยกเลิกต้องไม่แตะอะไร', async () => {
    const card = fakeCard(1);
    const page = makePage({ cards: [card] });
    let fetched = 0;
    page.ctx.fetch = async () => { fetched++; return Response.json({ plan: [], warnings: [] }); };
    page.ctx.readyAccounts = () => [{ pid: 'p1', acctId: '111', name: 'บัญชีเทส' }];
    page.run(`markRes(getRes(document.querySelector('.ad-card[data-id="1"]')), 'p1:111', 'unk', 'สายหลุด')`);
    page.confirmAnswer = false;
    const r = await page.run('runAutoPlan(document.getElementById("autoLaunchBtn"))');
    assert.strictEqual(r, null);
    assert.strictEqual(fetched, 0);
    assert.match(page.confirms[0], /ไม่รู้ผล/);
    assert.strictEqual(page.res(card), 'unk', 'การ์ดเดิมต้องอยู่ครบ');
  });

  test('ขึ้นอัตโนมัติ: หน้ายืนยันต้องโชว์งบเดียวกับที่ส่งจริง แม้แก้ช่องงบระหว่างรอจัดแผน', async () => {
    const page = makePage({ cards: [fakeCard(1)] });
    page.X.respond = (xhr) => setTimeout(() => okReply(xhr), 5);
    page.ctx.runAutoPlan = async () => {
      page.byId.campaignBudget.value = '777';   // ผู้ใช้แก้ระหว่างรอเซิร์ฟเวอร์จัดแผน
      return { plan: [{ ads: [{}] }], warnings: [], total: 1, link: 'https://example.com/' };
    };
    await page.run('autoLaunch(document.getElementById("autoLaunchBtn"))');
    assert.match(page.confirms[0], /งบแอดละ 777 บาท/);
    assert.strictEqual(sentData(page.X.list[0]).campaignBudget, 777);
  });
});

describe('หน้าเว็บ: การ์ด', () => {
  test('ก๊อปการ์ดที่ล็อกบัญชีเดียว ตัวก๊อปต้องล็อกบัญชีเดิม (P2-9)', () => {
    const src = fakeCard(1, { onlyAcct: 'p1:222', onlyAcctName: 'บัญชีสอง' });
    const copy = fakeCard(2);
    const page = makePage({ cards: [src] });
    page.ctx.addAd = () => copy;
    page.run('duplicateAd(1)');
    assert.strictEqual(copy.dataset.onlyAcct, 'p1:222');
    assert.strictEqual(copy.dataset.onlyAcctName, 'บัญชีสอง');
  });

  test('เปลี่ยนไฟล์ระหว่างอัปค้าง = ยกเลิกตัวเก่า ตัวนับคืนถูก ผลใช้ของตัวใหม่ (P2-11)', () => {
    const card = fakeCard(1);
    const page = makePage({ cards: [card] });
    page.run('uploadMedia(document.querySelector(\'.ad-card[data-id="1"]\'), new Blob(["a"]))');
    page.run('uploadMedia(document.querySelector(\'.ad-card[data-id="1"]\'), new Blob(["b"]))');
    const [x1, x2] = page.X.list;
    assert.strictEqual(x1.aborted, true, 'ตัวเก่าต้องถูกยกเลิก');
    assert.strictEqual(page.run('mediaUploadsInFlight'), 1);
    reply(x2, 200, '{"id":"m2"}');
    assert.strictEqual(card.dataset.mediaId, 'm2');
    assert.strictEqual(page.run('mediaUploadsInFlight'), 0);
    assert.strictEqual(page.byId.launchBtn.disabled, false);
  });
});

describe('หน้าเว็บ: ค่าตั้งต้นที่จำไว้ต้องไม่ถูกทับด้วยค่าใน HTML', () => {
  function ldPage(getRes, postRes) {
    const page = makePage();
    const calls = [];
    page.ctx.fetch = async (url, opts) => { calls.push((opts && opts.method) || 'GET'); return (opts && opts.method === 'POST' ? postRes : getRes)(); };
    page.ctx.applyLaunchDefaults = () => {};
    page.ctx.collectLaunchDefaults = () => ({ campaignBudget: '300', ruleOn: false, link: '' });
    page.run('var LD_FIELDS = [], LD_TOGGLES = [];');
    return { page, calls };
  }
  for (const [label, res] of [
    ['401 หน้า HTML', () => new Response('<html>401</html>', { status: 401 })],
    ['502 ตอนรีสตาร์ท', () => new Response('Bad Gateway', { status: 502 })],
    ['{error}', () => Response.json({ error: 'ยังไม่ได้เชื่อมต่อ' })],
  ]) {
    test(`โหลดไม่สำเร็จ (${label}) = ห้ามบันทึกทับ`, async () => {
      const { page, calls } = ldPage(res, () => Response.json({ ok: true }));
      await page.run('loadLaunchDefaults()');
      assert.strictEqual(page.run('ldLoaded'), false);
      page.run('saveLaunchDefaultsSoon()');
      await sleep(900);
      assert.deepStrictEqual(calls, ['GET'], 'ต้องไม่มี POST ทับค่าจริง');
      assert.match(page.byId.ldSaved.textContent, /โหลดค่าที่จำไว้ไม่สำเร็จ/);
    });
  }

  test('โหลดสำเร็จ (ยังไม่เคยจำอะไร = {}) = บันทึกได้ และบันทึกพังต้องไม่ขึ้น "✓ จำค่าไว้แล้ว"', async () => {
    const { page, calls } = ldPage(() => Response.json({}), () => new Response('Bad Gateway', { status: 502 }));
    await page.run('loadLaunchDefaults()');
    assert.strictEqual(page.run('ldLoaded'), true);
    page.run('saveLaunchDefaultsSoon()');
    await sleep(900);
    assert.deepStrictEqual(calls, ['GET', 'POST']);
    assert.match(page.byId.ldSaved.textContent, /จำค่าไม่สำเร็จ/);
  });
});
