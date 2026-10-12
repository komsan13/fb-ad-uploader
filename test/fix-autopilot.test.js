// เทสบั๊กของระบบอัตโนมัติที่รีวิว 12 ต.ค. 2026 ทำซ้ำได้จริงกับ FB ปลอม (ก่อนแก้ทุกเทสในไฟล์นี้พัง)
// รัน server.js จริงคุยกับ FB / Telegram / AI ปลอม แล้วยืนยันจากคำขอที่ FB ปลอมได้รับ + state บนดิสก์
// ห้ามยิงของจริง: FB_API_BASE / FX_API_URL ชี้ fake-fb (helpers), TG_API_BASE / ANTHROPIC_BASE_URL ชี้ตัวปลอมหรือพอร์ตตาย
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { makeFakeFb } = require('./fake-fb');
const { makeFakeTg, makeFakeAi } = require('./fake-tg');
const { tmpDir, seed, startServer, get, post, readState } = require('./helpers');

const ACCT = '111';
const CHAT = '555';
const DAY = 864e5;
const DEAD = 'http://127.0.0.1:9';   // พอร์ตตาย — เผื่อโค้ดหลุดไปเรียก Telegram/AI โดยไม่ได้ตั้งตัวปลอม

const baseConfig = (extra = {}) => ({
  profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', pageId: 'page1' }],
  activeProfileId: 'p1',
  launchDefaults: {
    objective: 'OUTCOME_SALES', conversionEvent: 'SUBSCRIBE', campaignBudget: '3333',
    link: 'https://example.com/', ruleCpr: '100', countries: 'TH', cta: 'LEARN_MORE',
  },
  autopilot: { enabled: true, minAds: 2 },
  ...extra,
});
const freshWorld = (over = {}) => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
  pages: [{ id: 'page1', name: 'เพจหลัก', is_published: true, promotion_eligible: true }],
  ...over,
});
// แอดโดนปฏิเสธพร้อมเหตุผลจริงใน ad_review_feedback (ตามรูปที่ FB ส่งมา)
const rejected = (id, cat = 'Misleading claims', over = {}) => ({
  id, acct: ACCT, name: `แอด ${id}`, effective_status: 'DISAPPROVED', adset_id: 'S' + id, campaign_id: 'C1', issues_info: [],
  ad_review_feedback: { global: { [cat]: 'เคลมเกินจริง' } },
  creative: { id: 'cr' + id, object_story_spec: { page_id: 'page1', video_data: { video_id: 'vid', message: 'ข้อความเดิมของแอด ' + id, title: 'หัวข้อ' } } },
  ...over,
});
const TEXT_FIX = { where: 'text', violation: 'เคลมเกินจริง', fixable: true, newMessage: 'ข้อความใหม่ที่แก้แล้วถูกนโยบายแน่นอน', newHeadline: null };
// ชุดเทสลงทะเบียนไว้ก่อน แล้วค่อยรันท้ายไฟล์ — ชุดปกติเรียงทีละชุด (มีเทสที่อิงจังหวะเวลา) ขนานกับชุดช้าชุดเดียว
const suites = [];
const suite = (name, fn) => suites.push([name, fn]);

async function boot(t, { world = freshWorld(), config = baseConfig(), videos = 3, captions = 3, env = {}, state = null, ai = null, files = {} } = {}) {
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config, videos, captions });
  if (state) fs.writeFileSync(path.join(dir, 'autopilot-state.json'), JSON.stringify(state));
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
  const aiEnv = ai ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}` } : { ANTHROPIC_BASE_URL: DEAD };
  const srvEnv = { ANTHROPIC_API_KEY: '', TG_API_BASE: DEAD, ...aiEnv, ...env };
  const srv = await startServer(dir, fb.port, srvEnv);
  t.after(() => { srv.stop(); fb.server.close(); if (ai) ai.server.close(); });
  // restart = ฆ่าโปรเซสแล้วเปิดใหม่บนโฟลเดอร์เดิม (จำลอง redeploy)
  const restart = async () => {
    const s2 = await startServer(dir, fb.port, srvEnv);
    t.after(() => s2.stop());
    return s2;
  };
  return { ...srv, dir, world, fb, restart };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, why = 'เงื่อนไขไม่เกิดในเวลา') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(50); }
  throw new Error(why);
}
const posts = (world, p) => world.calls.filter((c) => c.method === 'POST' && c.path === p);
const logText = (dir) => ((readState(dir) || {}).log || []).map((l) => l.msg).join('\n');

// อัปวิดีโอช้าเหมือนของจริง — เปิดช่องให้กดหยุด/ฆ่าโปรเซสระหว่างรอบตรวจ
function slowUpload(world, ms = 2000) {
  let vid = 7000;
  world.route = (m, p) => {
    if (m === 'POST' && p === `act_${ACCT}/advideos`) {
      const id = String(++vid);
      (world.videos = world.videos || []).push(id);
      return { id, delay: ms };
    }
    return null;
  };
}

// ---------- P0-1 คำสั่งหยุด/ค่าตั้งค่าใหม่ต้องมีผลกลางรอบ ----------
// เดิมเช็คหยุดฉุกเฉินแค่ตอนขึ้นบัญชีใหม่ + ใช้ค่าตั้งค่าที่อ่านตอนเริ่มรอบ — กดหยุดระหว่างเติมแอด
// ยังได้แคมเปญงบเต็ม 3,333 บาท/วัน เพิ่มอีก 3 ตัว แล้วตัวขยายงบยังขึ้นงบต่อ
suite('P0-1 กดหยุด/เปลี่ยนค่าระหว่างรอบตรวจ ต้องหยุดทันที', () => {
  test('กดหยุดฉุกเฉินระหว่างเติมแอด: ไม่มีแอด/แคมเปญเพิ่ม แคมเปญเปล่าที่เพิ่งสร้างถูกลบ และตัวขยายงบไม่ขยับ', async (t) => {
    const world = freshWorld({
      campaigns: [{ id: 'CW', acct: ACCT, name: 'Autopilot ตัวชนะ', status: 'ACTIVE', daily_budget: '100000', objective: 'OUTCOME_SALES' }],
      ads: [{ id: 'AW', acct: ACCT, name: 'ตัวชนะ', effective_status: 'ACTIVE', adset_id: 'SW', campaign_id: 'CW' }],
      // CW เป็นตัวชนะตามเกณฑ์ทุกข้อ (20 ผล ต้นทุน 50 < 70) — ถ้าตัวขยายงบได้วิ่ง งบจะขึ้นเป็น 120000
      insights: [
        { acct: ACCT, spend: '100' },
        { acct: ACCT, campaign_id: 'CW', ad_id: 'AW', spend: '1000', actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '20' }] },
      ],
    });
    slowUpload(world);
    const { base, dir } = await boot(t, {
      world,
      config: baseConfig({ autopilot: { enabled: true, minAds: 4, scaleMaxBudget: 5000 } }),
      state: { owned: ['CW'], baselined: { [ACCT]: Date.now() } },
    });
    const running = post(base, '/api/autopilot/run');
    await until(() => posts(world, `act_${ACCT}/campaigns`).length >= 1, 20000, 'รอบตรวจไม่เริ่มเติมแอด');
    await post(base, '/api/autopilot', { killSwitch: true });
    const at = world.calls.length;
    await running;

    const after = world.calls.slice(at).filter((c) => c.method === 'POST');
    assert.ok(!after.some((c) => c.path === `act_${ACCT}/campaigns`), 'กดหยุดแล้วยังสร้างแคมเปญงบเต็มเพิ่ม');
    assert.ok(!after.some((c) => c.path === `act_${ACCT}/ads`), 'กดหยุดแล้วยังขึ้นแอดเปิดยิง');
    assert.strictEqual(world.campaigns.find((c) => c.id === 'CW').daily_budget, '100000', 'กดหยุดแล้วตัวขยายงบยังขึ้นงบ');
    // แคมเปญที่สร้างก่อนกด (ยังไม่มีแอด) ต้องไม่ค้างงบไว้ในบัญชี
    for (const c of world.campaigns.filter((x) => x.id !== 'CW')) assert.strictEqual(c.status, 'DELETED', `แคมเปญ ${c.id} ค้างอยู่`);
    assert.match(logText(dir), /กดหยุดฉุกเฉินระหว่างรอบตรวจ — หยุดกลางคัน/);
  });

  test('ปิดระบบ / เปิดโหมดทดสอบ / ตั้ง minAds 0 / ลดงบต่อแอด กลางรอบ: รอบที่วิ่งอยู่ต้องไม่สร้างแคมเปญหรือแอดเพิ่ม', async (t) => {
    for (const [label, apply] of [
      ['ปิดระบบ', (base) => post(base, '/api/autopilot', { enabled: false })],
      ['เปิดโหมดทดสอบ', (base) => post(base, '/api/autopilot', { testMode: true })],
      ['minAds 0', (base) => post(base, '/api/autopilot', { minAds: 0 })],
      ['ลดงบต่อแอด', (base) => post(base, '/api/launch-defaults', { ...baseConfig().launchDefaults, campaignBudget: '500' })],
      ['ลดเพดานเติมแอด', (base) => post(base, '/api/autopilot', { limits: { maxNewAdsPerDay: 1 } })],
      ['ซ่อนบัญชี', (base) => post(base, '/api/hidden', { kind: 'account', id: ACCT, hidden: true })],
    ]) {
      const world = freshWorld();
      slowUpload(world);
      const { base, dir } = await boot(t, { world, config: baseConfig({ autopilot: { enabled: true, minAds: 4 } }) });
      const running = post(base, '/api/autopilot/run');
      await until(() => posts(world, `act_${ACCT}/campaigns`).length >= 1, 20000, `[${label}] รอบตรวจไม่เริ่มเติมแอด`);
      const r = await apply(base);
      assert.ok(!r.error, `[${label}] บันทึกค่าไม่สำเร็จ: ${r.error}`);
      const at = world.calls.length;
      await running;
      const after = world.calls.slice(at).filter((c) => c.method === 'POST');
      assert.ok(!after.some((c) => c.path === `act_${ACCT}/campaigns`), `[${label}] ยังสร้างแคมเปญงบเต็มต่อ`);
      assert.ok(!after.some((c) => c.path === `act_${ACCT}/ads`), `[${label}] ยังขึ้นแอดต่อ`);
      assert.ok(world.campaigns.every((c) => c.status === 'DELETED'), `[${label}] แคมเปญที่สร้างค้างงบอยู่`);
      assert.match(logText(dir), /หยุดกลางคัน/, `[${label}] ต้องจดว่าหยุดกลางคันเพราะอะไร`);
    }
  });

  test('กดหยุดฉุกเฉินระหว่างอัปคลิปของการสับคลิปแอดโดนปฏิเสธ: ต้องไม่ขึ้นแอดเปิดยิง (ทางนี้อัปคลิป+รอประมวลผลเป็นนาที)', async (t) => {
    const ai = await makeFakeAi({ where: 'video', violation: 'ภาพในคลิปผิดนโยบาย', fixable: false, newMessage: null, newHeadline: null });
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'แคมเปญเดิม', status: 'ACTIVE', daily_budget: '333300', objective: 'OUTCOME_SALES' }],
      ads: [rejected('A1', 'คุณภาพวิดีโอ')],
    });
    slowUpload(world);
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0, limits: { maxRelaunchPerAd: 2 } } }),
      state: { baselined: { [ACCT]: Date.now() } },
    });
    const running = post(base, '/api/autopilot/run');
    await until(() => posts(world, `act_${ACCT}/advideos`).length >= 1, 20000, 'ไม่เริ่มสับคลิป');
    await post(base, '/api/autopilot', { killSwitch: true });
    await running;
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 0, 'กดหยุดแล้วยังขึ้นแอดสับคลิปเปิดยิง');
    assert.ok(!readState(dir).handled.A1, 'ยังไม่ได้ยิงแอด = เคสต้องค้างไว้ให้รอบหน้า ไม่ใช่ปิดเคส/ค้าง "กำลังแก้"');
    assert.match(logText(dir), /กดหยุดฉุกเฉินระหว่างรอบตรวจ — หยุดกลางคัน/);
  });
});

// ---------- P0-2 โหมดทดสอบต้องไม่สร้างแอดที่ใช้เงิน ----------
suite('P0-2 โหมดทดสอบกับตัวแก้แอดโดนปฏิเสธ', () => {
  const userCampaign = { id: 'C1', acct: ACCT, name: 'แคมเปญของเจ้าของ', status: 'ACTIVE', daily_budget: '500000', objective: 'OUTCOME_SALES' };

  test('แก้ข้อความ: โหมดทดสอบต้องไม่ขึ้นแอดใหม่ (เดิมยิง ACTIVE) และไม่ปิดเคส — ปิดโหมดทดสอบแล้วรอบหน้าจัดการต่อ', async (t) => {
    const ai = await makeFakeAi(TEXT_FIX);
    const world = freshWorld({ campaigns: [userCampaign], ads: [rejected('A1')] });
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0, testMode: true } }),
      state: { baselined: { [ACCT]: Date.now() } },
    });
    await post(base, '/api/autopilot/run');
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 0, 'โหมดทดสอบห้ามขึ้นแอดใหม่ในชุดโฆษณาจริง');
    assert.strictEqual(ai.state.requests.length, 0, 'ไม่ขึ้นแอดก็ไม่ต้องเสียค่า AI');
    assert.ok(!readState(dir).handled.A1, 'ห้ามปิดเคส — ไม่งั้นปิดโหมดทดสอบแล้วแอดนี้ไม่มีวันถูกแก้');
    assert.match(logText(dir), /🧪.*โหมดทดสอบไม่แก้/);

    await post(base, '/api/autopilot', { testMode: false });
    await post(base, '/api/autopilot/run');
    const made = posts(world, `act_${ACCT}/ads`);
    assert.strictEqual(made.length, 1, 'ปิดโหมดทดสอบแล้วต้องกลับมาแก้ให้');
    assert.strictEqual((readState(dir).handled.A1 || {}).v, 'fixed');
  });

  test('สับคลิป (maxRelaunchPerAd 2): โหมดทดสอบต้องไม่อัปคลิป/ขึ้นแอดใหม่', async (t) => {
    const ai = await makeFakeAi({ where: 'video', violation: 'ภาพในคลิปผิดนโยบาย', fixable: false, newMessage: null, newHeadline: null });
    const world = freshWorld({ campaigns: [userCampaign], ads: [rejected('A1', 'คุณภาพวิดีโอ')] });
    const { base } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0, testMode: true, limits: { maxRelaunchPerAd: 2 } } }),
      state: { baselined: { [ACCT]: Date.now() } },
    });
    await post(base, '/api/autopilot/run');
    assert.strictEqual(posts(world, `act_${ACCT}/advideos`).length, 0);
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 0, 'โหมดทดสอบห้ามสับคลิปขึ้นแอดเปิดยิง');
  });
});

// ---------- P0-3 ประวัติหมดอายุ 60 วัน = แอดเก่าถูกนับเป็นของใหม่ ----------
suite('P0-3 ประวัติของแอดที่ยังค้างในบัญชีต้องไม่หมดอายุ', () => {
  test('state แบบ production (baseline 80 วัน ประวัติถูกลบหมดแล้ว): แอดที่โดนปฏิเสธค้างอยู่ถูกตั้งต้นใหม่ ไม่นับ ไม่ freeze ไม่แก้', async (t) => {
    const ai = await makeFakeAi(TEXT_FIX);
    const world = freshWorld({ ads: ['B1', 'B2', 'B3'].map((id) => rejected(id)) });
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0 } }),
      // วัดจาก production 12 ต.ค. 2026: handled/counted/retryOf/relaunch ว่าง แต่ baselined อายุ 76–85 วัน
      state: { baselined: { [ACCT]: Date.now() - 80 * DAY } },
    });
    await post(base, '/api/autopilot/run');
    let st = readState(dir);
    assert.deepStrictEqual(st.frozen, {}, 'แอดที่โดนปฏิเสธเมื่อหลายเดือนก่อนทำให้บัญชีถูกหยุด');
    assert.deepStrictEqual(st.noRotate, {}, 'แอดเก่าทำให้บัญชีถูกหยุดเติมแอด');
    assert.strictEqual((st.rejections[ACCT] || []).length, 0, 'แอดเก่าถูกนับเข้าตัวนับ freeze');
    for (const id of ['B1', 'B2', 'B3']) assert.strictEqual((st.handled[id] || {}).v, 'baseline', `${id} ต้องถูกตั้งต้นใหม่`);
    assert.strictEqual(ai.state.requests.length, 0, 'ห้ามไล่แก้ของเก่า');
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 0);
    assert.match(logText(dir), /กลับมาเฝ้า บัญชีเทส หลังไม่ได้เฝ้า 80 วัน/);
    assert.ok(Date.now() - st.watched[ACCT] < 60000, 'ต้องจำว่าเพิ่งเฝ้าบัญชีนี้');

    // ระบบต้องทำงานต่อปกติ: แอดที่โดนปฏิเสธหลังจากนี้ยังถูกนับและแก้ให้
    world.ads.push(rejected('B4', 'หมวดใหม่'));
    await post(base, '/api/autopilot/run');
    st = readState(dir);
    assert.strictEqual((st.rejections[ACCT] || []).length, 1, 'แอดที่เพิ่งโดนต้องถูกนับ');
    assert.strictEqual((st.handled.B4 || {}).v, 'fixed', 'แอดที่เพิ่งโดนต้องถูกแก้ตามปกติ');
  });

  test('ประวัติหายไปแล้ว (production): แอดที่เคยถูกแก้ (ชื่อมี "(แก้ข้อความ)") โดนปฏิเสธอีก = ตายถาวร ไม่แก้ซ้ำ', async (t) => {
    // รีวิวรอบสุดท้ายวัดจริง: relaunch/retryOf บน production ว่าง → แอดรุ่น 2 ที่ยังยิงอยู่ถูกนับเป็นรุ่นแรก แล้วโดนแก้ซ้ำ
    const ai = await makeFakeAi(TEXT_FIX);
    const world = freshWorld({ ads: [rejected('Z2', 'หมวดใหม่', { name: 'แอด Z (แก้ข้อความ)' }), rejected('N1', 'หมวดใหม่')] });
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0 } }),
      state: { baselined: { [ACCT]: Date.now() - 3600e3 }, watched: { [ACCT]: Date.now() - 600e3 } },   // เฝ้าอยู่ปกติ — สองตัวนี้คือ "เพิ่งโดน"
    });
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.strictEqual((st.handled.Z2 || {}).v, 'dead-after-retry', 'แอดรุ่น 2 ต้องตายถาวรตาม maxRelaunchPerAd=1');
    assert.strictEqual((st.handled.N1 || {}).v, 'fixed', 'แอดปกติยังถูกแก้ตามเดิม');
    const names = posts(world, `act_${ACCT}/ads`).map((c) => c.params.name);
    assert.deepStrictEqual(names, ['แอด N1 (แก้ข้อความ)'], 'ห้ามมี "(แก้ข้อความ) (แก้ข้อความ)"');
  });

  test('ประวัติของแอดที่ยังอยู่ต้องถูกต่ออายุ: สายที่ตายถาวรเมื่อ 61 วันก่อนห้ามถูกแก้ซ้ำ ส่วนแอดที่หายไปแล้วยังหมดอายุตามปกติ', async (t) => {
    const ai = await makeFakeAi(TEXT_FIX);
    const OLD = Date.now() - 61 * DAY;
    const mk = (v) => ({ v, ts: OLD });
    const world = freshWorld({ ads: [rejected('X2'), rejected('B1')] });
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0 } }),
      state: {
        baselined: { [ACCT]: OLD }, watched: { [ACCT]: Date.now() - 3600e3 },   // เฝ้าอยู่ตลอด ไม่ใช่เคสตั้งต้นใหม่
        handled: { X1: mk('fixed'), X2: mk('dead-after-retry'), B1: mk('baseline'), GONE: mk('fixed') },
        retryOf: { X2: mk('X1') }, relaunch: { X2: mk(1) }, counted: { X2: mk(1), B1: mk(1) },
      },
    });
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.strictEqual(ai.state.requests.length, 0, 'สายที่ตายถาวรถูกส่งให้ AI แก้ซ้ำ = เกราะ maxRelaunchPerAd รั่ว');
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 0);
    assert.deepStrictEqual(st.frozen, {});
    assert.strictEqual((st.rejections[ACCT] || []).length, 0, 'แอดเก่าถูกนับเป็นของใหม่');
    const fresh = (e) => e && Date.now() - e.ts < 60000;
    assert.strictEqual(st.handled.X2.v, 'dead-after-retry', 'ค่าเดิมต้องไม่ถูกทับ');
    for (const [bag, id] of [['handled', 'X2'], ['handled', 'B1'], ['relaunch', 'X2'], ['retryOf', 'X2'], ['counted', 'B1']]) {
      assert.ok(fresh(st[bag][id]), `${bag}.${id} ต้องถูกต่ออายุ (แอดยังอยู่ในบัญชี)`);
    }
    assert.ok(!st.handled.GONE, 'แอดที่ไม่อยู่ในบัญชีแล้วต้องหมดอายุตามเดิม ไม่งั้นไฟล์โตไม่มีเพดาน');
    assert.ok(!st.handled.X1, 'X1 ไม่อยู่ในรายการแล้วต้องหมดอายุ');
  });

  test('บัญชีที่ถูกหยุด (freeze) นานเกิน 60 วัน: รุ่นของแอดที่ยังยิงอยู่ต้องไม่หมดอายุ — ปลดล็อกแล้วโดนปฏิเสธต้องไม่ถูกแก้ซ้ำ', async (t) => {
    const ai = await makeFakeAi(TEXT_FIX);
    const OLD = Date.now() - 61 * DAY;
    // X2 = แอดที่ระบบขึ้นใหม่ไปแล้ว 1 ครั้ง (ครบเพดาน) ยังยิงอยู่ ระหว่างที่บัญชีถูกหยุดมา 61 วัน
    const world = freshWorld({ ads: [{ ...rejected('X2'), effective_status: 'ACTIVE' }] });
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0 } }),
      state: {
        frozen: { [ACCT]: { since: OLD, reason: 'เทส' } },
        baselined: { [ACCT]: OLD }, watched: { [ACCT]: OLD },
        relaunch: { X2: { v: 1, ts: OLD } }, retryOf: { X2: { v: 'X1', ts: OLD } },
      },
    });
    await post(base, '/api/autopilot/run');
    let st = readState(dir);
    assert.ok(st.relaunch.X2 && Date.now() - st.relaunch.X2.ts < 60000, 'บัญชีที่ถูกหยุดต้องถูกต่ออายุประวัติ (อ่านอย่างเดียว)');
    assert.strictEqual(st.watched[ACCT], OLD, 'อ่านเพื่อต่ออายุไม่นับว่า "ได้เฝ้า" — ปลดล็อกแล้วยังต้องตั้งต้นใหม่');
    assert.ok(!world.calls.some((c) => c.method === 'POST'), 'บัญชีที่ถูกหยุดห้ามถูกแตะ');

    await post(base, '/api/autopilot/unfreeze', { acctId: ACCT });
    await post(base, '/api/autopilot/run');                     // ตั้งต้นใหม่ (ห่างเกิน 59 วัน)
    world.ads[0].effective_status = 'DISAPPROVED';               // แล้ว X2 โดนปฏิเสธหลังจากนั้น
    await post(base, '/api/autopilot/run');
    st = readState(dir);
    assert.strictEqual(ai.state.requests.length, 0, 'สายที่ครบเพดานแล้วถูกส่งให้ AI แก้ซ้ำ');
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 0);
    assert.strictEqual(st.handled.X2.v, 'dead-after-retry');
  });

  test('state รุ่นก่อนที่ baseline ยังไม่เก่า (ไม่มี watched): ต้องไม่ตั้งต้นใหม่ — แอดที่เพิ่งโดนปฏิเสธยังถูกนับ', async (t) => {
    const world = freshWorld({ ads: [rejected('N1')] });
    const { base, dir } = await boot(t, {
      world, config: baseConfig({ autopilot: { enabled: true, minAds: 0 } }),
      state: { baselined: { [ACCT]: Date.now() - 30 * DAY } },
    });
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.strictEqual((st.rejections[ACCT] || []).length, 1, 'ประวัติยังครบอยู่ ไม่มีเหตุให้ตั้งต้นใหม่');
    assert.ok(!st.handled.N1, 'ไม่มี key ต้องค้างไว้รอ ไม่ใช่ถูกจดเป็น baseline');
    assert.doesNotMatch(logText(dir), /กลับมาเฝ้า/);
  });
});

// ---------- P0-4 โปรเซสตายกลางรอบ (redeploy) ----------
suite('P0-4 state ต้องรอดเมื่อโปรเซสถูกฆ่ากลางรอบ', () => {
  test('ฆ่าระหว่างเติมแอด: แคมเปญที่สร้างไปแล้วต้องอยู่ใน owned — รีสตาร์ทแล้วตัวปิดแอดขาดทุนต้องดูแลมันได้', async (t) => {
    const world = freshWorld();
    slowUpload(world);
    const config = baseConfig({
      launchDefaults: { ...baseConfig().launchDefaults, ruleOn: true, ruleCpr: '100' },
      autopilot: { enabled: true, minAds: 2 },
    });
    const h = await boot(t, { world, config });
    post(h.base, '/api/autopilot/run').catch(() => {});
    await until(() => posts(world, `act_${ACCT}/ads`).length >= 1, 20000, 'แอดแรกไม่ถูกสร้าง');
    // รอให้ถึงชุดโฆษณาของแอดที่สอง = แคมเปญที่สองถูกจดลงดิสก์ไปแล้ว (จดทันทีหลัง FB ตอบ ก่อนสร้างชุดโฆษณา)
    await until(() => posts(world, `act_${ACCT}/adsets`).length >= 2, 20000, 'แอดที่สองไม่ถูกเริ่ม');
    h.stop();                                   // redeploy ฆ่าโปรเซสระหว่างอัปคลิปของแอดที่สอง
    await sleep(500);
    const st = readState(h.dir);
    assert.ok(st, 'ต้องมี state บนดิสก์แล้ว ไม่ใช่รอจบรอบ');
    for (const c of world.campaigns) assert.ok((st.owned || []).includes(c.id), `แคมเปญ ${c.id} มีงบอยู่บน FB แต่ไม่อยู่ใน owned`);
    assert.strictEqual((st.created[ACCT] || []).length, 1, 'ตัวนับเพดานรายวันต้องรอด');

    // วันต่อมาแอดแรกขาดทุนชัด (3,000 บาท ไม่มีผล เป้า 100) — ต้องถูกปิด
    // FB ปลอมไม่ผูก campaign_id ให้แอด — แอดแรกอยู่ในแคมเปญแรกเสมอ (แอดละแคมเปญ)
    const ad1 = world.ads[0];
    world.insights = [{ acct: ACCT, spend: '3000' }, { acct: ACCT, ad_id: ad1.id, campaign_id: world.campaigns[0].id, spend: '3000', actions: [] }];
    world.route = null;
    const s2 = await h.restart();
    await post(s2.base, '/api/autopilot/run');
    assert.strictEqual(world.ads.find((x) => x.id === ad1.id).effective_status, 'PAUSED', 'แอดขาดทุนที่สร้างก่อนรีสตาร์ทไม่ถูกปิด = เผาเงินต่อ');
  });

  test('ฆ่าหลังแก้แอดโดนปฏิเสธไปแล้ว: รีสตาร์ทต้องไม่แก้ซ้ำ (เกราะแก้ครั้งเดียว)', async (t) => {
    const ai = await makeFakeAi(TEXT_FIX);
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot x', status: 'ACTIVE', daily_budget: '333300', objective: 'OUTCOME_SALES' }],
      ads: [rejected('A1')],
    });
    slowUpload(world);
    const h = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 2 } }),
      state: { owned: ['C1'], baselined: { [ACCT]: Date.now() } },
    });
    const fixes = () => posts(world, `act_${ACCT}/ads`).filter((c) => /แก้ข้อความ/.test(c.params.name));
    post(h.base, '/api/autopilot/run').catch(() => {});
    await until(() => fixes().length >= 1 && posts(world, `act_${ACCT}/advideos`).length >= 1, 20000);
    h.stop();                                   // ตายระหว่างเติมแอดที่ตามหลังการแก้
    await sleep(500);
    assert.strictEqual((readState(h.dir).handled.A1 || {}).v, 'fixed', 'แก้ไปแล้วต้องจดลงดิสก์ทันที');
    world.route = null;
    const s2 = await h.restart();
    await post(s2.base, '/api/autopilot/run');
    assert.strictEqual(fixes().length, 1, 'รีสตาร์ทแล้วแก้แอดเดิมซ้ำ');
    assert.strictEqual(readState(h.dir).fixes.length, 1, 'ตัวนับแก้รายวันต้องรอด');
  });

  test('ฆ่าระหว่างกำลังขึ้นแอดที่แก้แล้ว (FB สร้างแล้วแต่ยังไม่ตอบ): ไม่ลองซ้ำ บอกคน และแอดใหม่ต้องได้ประวัติรุ่น — โดนอีกห้ามแก้ซ้ำ', async (t) => {
    const ai = await makeFakeAi(TEXT_FIX);
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot x', status: 'ACTIVE', daily_budget: '333300', objective: 'OUTCOME_SALES' }],
      ads: [rejected('A1')],
    });
    // FB สร้างแอดแล้วแต่คำตอบยังไม่กลับ แล้วโปรเซสตาย — ฝั่งเราไม่รู้ว่าสำเร็จไหม และไม่รู้ id
    world.route = (m, p, params) => {
      if (m !== 'POST' || p !== `act_${ACCT}/ads`) return null;
      world.ads.push({ id: 'NEW1', acct: ACCT, name: params.name, adset_id: params.adset_id, campaign_id: 'C1', effective_status: 'PENDING_REVIEW' });
      return { id: 'NEW1', delay: 5000 };
    };
    const h = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0 } }),
      state: { owned: ['C1'], baselined: { [ACCT]: Date.now() } },
    });
    post(h.base, '/api/autopilot/run').catch(() => {});
    await until(() => posts(world, `act_${ACCT}/ads`).length >= 1, 20000);
    h.stop();
    await sleep(500);
    assert.strictEqual((readState(h.dir).handled.A1 || {}).v, 'fixing', 'ต้องจดว่า "กำลังแก้" ก่อนยิง');
    world.route = null;
    const s2 = await h.restart();
    await post(s2.base, '/api/autopilot/run');
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 1, 'ลองซ้ำ = เสี่ยงแอดซ้ำสองตัว');
    assert.strictEqual(ai.state.requests.length, 1);
    let st = readState(h.dir);
    assert.strictEqual(st.handled.A1.v, 'interrupted');
    assert.strictEqual((st.relaunch.NEW1 || {}).v, 1, 'แอดที่ FB สร้างไปแล้วต้องถูกจดเป็นรุ่นที่ 1');
    assert.strictEqual(st.fixes.length, 1, 'ไม่รู้ผลต้องนับเข้าเพดานแก้รายวันไว้ก่อน');
    assert.match(logText(h.dir), /ระบบถูกปิดระหว่างกำลังขึ้นแอดที่แก้แล้ว — เจอแอดใหม่/);

    // แอดใหม่โดนปฏิเสธด้วยเหตุผลอื่น — maxRelaunchPerAd=1 แปลว่าสายนี้จบแล้ว
    Object.assign(world.ads.find((x) => x.id === 'NEW1'), {
      effective_status: 'DISAPPROVED', issues_info: [], ad_review_feedback: { global: { 'หมวดอื่น': 'ผิด' } },
      creative: { id: 'crN', object_story_spec: { video_data: { video_id: 'v', message: 'ข้อความของแอดที่แก้แล้ว', title: 'h' } } },
    });
    await post(s2.base, '/api/autopilot/run');
    st = readState(h.dir);
    assert.strictEqual(posts(world, `act_${ACCT}/ads`).length, 1, 'สายที่ครบเพดานแล้วถูกแก้ซ้ำ = เกราะ maxRelaunchPerAd รั่ว');
    assert.strictEqual(st.handled.NEW1.v, 'dead-after-retry');
  });
});

// ---------- P2-6 โดน throttle ระหว่างแก้แอด ----------
const twoRejected = () => freshWorld({ ads: [rejected('R1', 'หมวด 1'), rejected('R2', 'หมวด 2')] });
suite('P2-6 ลิมิตของ Meta ระหว่างแก้แอดโดนปฏิเสธ', () => {
  test('สับคลิปแล้วโดน throttle: ไม่ตีตกถาวร ลองใหม่รอบหน้า หยุดทั้งบัญชี (ไม่เรียก AI ต่อ) และรอบถัดไปพักจริง', async (t) => {
    const ai = await makeFakeAi({ where: 'video', violation: 'ภาพในคลิปผิดนโยบาย', fixable: false, newMessage: null, newHeadline: null });
    const world = twoRejected();
    world.route = (m, p) => (m === 'POST' && p === `act_${ACCT}/advideos` ? { error: 'User request limit reached', errorCode: 17 } : null);
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0, limits: { maxRelaunchPerAd: 2, freezeRejections: 5 } } }),
      state: { baselined: { [ACCT]: Date.now() } },
    });
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.ok(!st.handled.R1, 'โดน throttle ชั่วคราวแล้วถูกตีตก "swap-failed" ถาวร');
    assert.strictEqual(st.retries.R1.v, 1, 'ต้องนับใช้โควตาลองใหม่ (เพดานเดียวกับตอน AI ล่ม)');
    assert.strictEqual(ai.state.requests.length, 1, 'Meta สั่งพักแล้วยังเรียก AI กับแอดตัวถัดไป');
    assert.ok(!st.handled.R2);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'fb-cooldown.json'), 'utf8')).coolHard, true);
    const r2 = await post(base, '/api/autopilot/run');
    assert.strictEqual(r2.paused, true, 'ช่วงพักต้องไม่ยิง FB ต่อ');
    assert.strictEqual(ai.state.requests.length, 1);
  });
});
// ทางจริงของ fb(): โค้ด 17 ลองซ้ำ 2 ครั้ง (รอ 20+40 วิ) ก่อนยอมแพ้ — เทสนี้จึงกินเวลา ~60 วิ
// แยกไปวิ่งขนานกับชุดอื่นทั้งไฟล์ (ท้ายไฟล์) ไม่ให้ต่อท้ายจนทั้งไฟล์ช้าเป็นนาทีครึ่ง
const slowSuite = ['P2-6 (ทางจริง ~60 วิ) แก้ข้อความแล้วโดน throttle', () => {
  test('แก้ข้อความแล้ว FB ตอบโค้ด 17 จนครบ: ไม่ตีตก "resubmit-failed" ถาวร และไม่ไล่แอดตัวถัดไปต่อ', async (t) => {
    const ai = await makeFakeAi(TEXT_FIX);
    const world = twoRejected();
    world.route = (m, p) => (m === 'POST' && p === `act_${ACCT}/adcreatives` ? { error: 'User request limit reached', errorCode: 17 } : null);
    const { base, dir } = await boot(t, {
      world, ai,
      config: baseConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0, limits: { freezeRejections: 5 } } }),
      state: { baselined: { [ACCT]: Date.now() } },
    });
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.ok(!st.handled.R1, 'โดน throttle ชั่วคราวแล้วถูกตีตก "resubmit-failed" ถาวร');
    assert.strictEqual(st.retries.R1.v, 1);
    assert.strictEqual(ai.state.requests.length, 1, 'Meta สั่งพักแล้วยังเรียก AI กับแอดตัวถัดไป');
    assert.strictEqual(posts(world, `act_${ACCT}/adcreatives`).length, 3, 'ยิงซ้ำระหว่างช่วงพัก (เดิม 6 ครั้ง)');
    assert.ok(!st.handled.R2);
  });
}];

// ---------- Telegram ----------
async function bootTg(t, { cfg, aiAnswer = 'ตอบ', fbWorld = freshWorld({ insights: [{ acct: ACCT, spend: '123.45', impressions: '678' }] }), files = {}, tg = null, env = {} } = {}) {
  const fb = await makeFakeFb(fbWorld);
  tg = tg || await makeFakeTg();
  const ai = await makeFakeAi(aiAnswer);
  const dir = tmpDir();
  seed(dir, { config: cfg, videos: 0, captions: 0 });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), typeof v === 'string' ? v : JSON.stringify(v));
  const srv = await startServer(dir, fb.port, {
    TG_API_BASE: `http://127.0.0.1:${tg.port}`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`, ANTHROPIC_API_KEY: '', ...env,
  });
  t.after(() => { srv.stop(); fb.server.close(); tg.server.close(); if (tg.server.closeAllConnections) tg.server.closeAllConnections(); ai.server.close(); });
  return { srv, tg, ai, fb, dir };
}
const tgConfig = (extra = {}) => baseConfig({ telegram: { botToken: 'bot-token', chatId: CHAT }, autopilot: { enabled: false, minAds: 2 }, ...extra });
const mkAct = (over) => ({ type: '', on: null, value: null, key: null, accountId: null, campaignId: null, profileId: null, status: null, ...over });
// Meta สั่งพักไว้แล้ว (ไฟล์ที่ fb() เขียนเองตอนโดน throttle) — เซิร์ฟเวอร์อ่านตอนบูต
const hardCoolFile = () => ({ 'fb-cooldown.json': { coolUntil: Date.now() + 30 * 3600e3, coolHard: true, appBlocks: {} } });

// Telegram ปลอมแบบ long poll ของจริง (ค้างคำขอจนมีข้อความหรือครบ timeout) — fake-tg ตอบทันทีจึงมองไม่เห็นบั๊กนี้
function longPollTg() {
  const st = { updates: [], sent: [], waiters: [], nextId: 1, polls: [] };
  const flush = () => {
    for (const w of st.waiters.splice(0)) {
      const out = st.updates.filter((u) => u.update_id >= w.offset);
      if (out.length) { clearTimeout(w.t); w.send(out); } else st.waiters.push(w);
    }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname.endsWith('/getUpdates')) {
        const offset = Number(u.searchParams.get('offset') || 0);
        st.polls.push({ offset, timeout: Number(u.searchParams.get('timeout') || 0) });
        const ready = st.updates.filter((x) => x.update_id >= offset);
        if (ready.length) return send({ ok: true, result: ready });
        const w = { offset, send: (r) => send({ ok: true, result: r }) };
        w.t = setTimeout(() => { st.waiters = st.waiters.filter((x) => x !== w); send({ ok: true, result: [] }); },
          Number(u.searchParams.get('timeout') || 0) * 1000);
        w.t.unref();
        st.waiters.push(w);
        return;
      }
      if (u.pathname.endsWith('/sendMessage')) { try { st.sent.push(JSON.parse(body)); } catch { /* ข้าม */ } return send({ ok: true, result: {} }); }
      send({ ok: true, result: [] });
    });
  });
  const push = (chat, text) => { st.updates.push({ update_id: st.nextId++, message: { chat: { id: chat }, text, date: Math.floor(Date.now() / 1000) } }); flush(); };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, state: st, push, port: server.address().port })));
}

suite('P2-7 Telegram ทิ้งข้อความหลังรีสตาร์ท', () => {
  test('ข้อความที่พิมพ์ไม่กี่วินาทีหลังบูตต้องได้คำตอบ — รอบทิ้งของค้างต้องไม่ใช้ long poll', async (t) => {
    const tg = await longPollTg();
    const { srv } = await bootTg(t, { cfg: tgConfig(), tg, env: { WATCH_FIRST_DELAY_MS: '600000' } });
    await until(() => tg.state.polls.length >= 1, 20000, 'บอทไม่เคย poll');
    assert.strictEqual(tg.state.polls[0].timeout, 0, 'รอบทิ้งของค้างตอนบูตต้องไม่ค้างรอ');
    await sleep(1500);                      // เจ้าของพิมพ์เช็คทันทีหลัง redeploy
    tg.push(CHAT, 'สรุป');
    await until(() => tg.state.sent.length >= 2, 15000, 'ข้อความถูกทิ้งเงียบๆ ไม่มีคำตอบ');
    assert.match(tg.state.sent[1].text, /ใช้เงินวันนี้/);
    assert.ok(srv.base);
  });
});

suite('P2-8 ยืนยันผ่าน Telegram ต้องเตือนแบบเดียวกับหน้าเว็บ', () => {
  const askThenRead = async (t, action, cfg = tgConfig({ anthropicKey: 'sk-test' })) => {
    const { tg } = await bootTg(t, { cfg, aiAnswer: { answer: 'จัดการให้ครับ', action } });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ทำให้หน่อย');
    await until(() => tg.state.sent.length >= 2, 20000, 'ไม่ได้ข้อความยืนยัน');
    return { tg, text: tg.state.sent[1].text };
  };

  test('ขยับ maxRelaunchPerAd 1→2 (เปิดสับคลิปยิงซ้ำ) ต้องมีคำเตือนเกราะกันแบนก่อนยืนยัน', async (t) => {
    const { text } = await askThenRead(t, mkAct({ type: 'setLimit', key: 'maxRelaunchPerAd', value: 2 }));
    assert.match(text, /พิมพ์ "ยืนยัน"/);
    assert.match(text, /หย่อนเกราะกันบัญชีโดนแบน: 1 → 2/);
    assert.match(text, /ban evasion/, 'ต้องบอกว่าเป็นการยิงซ้ำหลังโดนปฏิเสธ — ข้อความเดียวกับหน้าเว็บ');
  });

  test('ตั้งค่าเข้มขึ้น (freezeRejections 3→2) ไม่ต้องเตือน', async (t) => {
    const { text } = await askThenRead(t, mkAct({ type: 'setLimit', key: 'freezeRejections', value: 2 }));
    assert.doesNotMatch(text, /หย่อนเกราะ/);
  });

  test('เปิดระบบ / ตั้ง minAds / ปิดโหมดทดสอบ: ต้องบอกงบรายวันจริง = minAds × บัญชี × งบต่อแอด', async (t) => {
    let r = await askThenRead(t, mkAct({ type: 'autopilotEnabled', on: true }));
    assert.match(r.text, /2 แอด × 1 บัญชี × 3,333 บาท = 6,666 บาท\/วัน/, r.text);
    r.tg.push(CHAT, 'ยืนยัน');
    await until(() => r.tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000);
    assert.match(r.tg.state.sent.find((m) => /ทำแล้ว/.test(m.text)).text, /6,666 บาท\/วัน/, 'ข้อความ "ทำแล้ว" ต้องทวนตัวเลขด้วย');

    r = await askThenRead(t, mkAct({ type: 'setMinAds', value: 5 }));
    assert.match(r.text, /5 แอด × 1 บัญชี × 3,333 บาท = 16,665 บาท\/วัน/, r.text);

    r = await askThenRead(t, mkAct({ type: 'testMode', on: false }),
      tgConfig({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 3, testMode: true } }));
    assert.match(r.text, /3 แอด × 1 บัญชี × 3,333 บาท = 9,999 บาท\/วัน/, r.text);
  });
});

suite('P2-9 ช่วงที่ Meta สั่งพัก: ยอดใช้จ่ายต้องไม่ยิง FB และต้องบอกตรงๆ', () => {
  const spendCalls = (fb) => fb.world.calls.filter((c) => /insights|campaigns|adaccounts/.test(c.path));

  test('ถาม "สรุป" (ไม่มี AI) ช่วงพัก: ไม่ยิง FB และไม่ตอบว่า "ยังไม่มีการใช้จ่าย"', async (t) => {
    const { tg, fb } = await bootTg(t, { cfg: tgConfig(), files: hardCoolFile() });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'สรุป');
    await until(() => tg.state.sent.length >= 2, 20000);
    assert.match(tg.state.sent[1].text, /Meta จำกัดการเข้า API/);
    assert.doesNotMatch(tg.state.sent[1].text, /ยังไม่มีการใช้จ่าย/, 'ไม่ได้ดึง ไม่ใช่ใช้ศูนย์บาท');
    assert.strictEqual(spendCalls(fb).length, 0, 'ช่วงพักยังยิง FB (เดิมบัญชีละ 3 ครั้ง × รอ 60 วิ)');
  });

  test('ถาม AI ช่วงพัก: ข้อมูลที่ส่งให้ AI ต้องบอกว่าดึงไม่ได้ และไม่ยิง FB', async (t) => {
    const { tg, ai, fb } = await bootTg(t, { cfg: tgConfig({ anthropicKey: 'sk-test' }), files: hardCoolFile() });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'วันนี้ใช้เงินเท่าไหร่');
    await until(() => ai.state.requests.length >= 1, 20000);
    assert.match(JSON.stringify(ai.state.requests[0]), /Meta จำกัดการเข้า API/);
    assert.strictEqual(spendCalls(fb).length, 0);
  });

  test('คำอธิบายในหน้าตั้งค่าต้องตรงกับรอบจริง (เดิมเขียน "ทุก 2 นาที" แต่เลนเร็ววิ่งทุก 10 นาที)', async (t) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /เฝ้าแอดทุก 2 นาที/);
    assert.doesNotMatch(html, /fastMins \|\| 2\b/);
    const { srv } = await bootTg(t, { cfg: tgConfig() });
    assert.strictEqual((await get(srv.base, '/api/autopilot')).fastMins, 10);
  });
});

// ---------- สรุปเช้า 8 โมง: preload เลื่อนนาฬิกาของโปรเซสเซิร์ฟเวอร์เป็น 08:30 และย่อรอบเช็ค 5 นาทีเหลือ 0.4 วิ ----------
function eightAmPreload(dir, minute = 30) {
  const f = path.join(dir, 'preload-8am.js');
  fs.writeFileSync(f, `
const realNow = Date.now.bind(Date);
const d = new Date(realNow());
const off = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, ${minute}, 0) - realNow();   // 01:MM UTC = 08:MM ไทย
Date.now = () => realNow() + off;
const si = global.setInterval;
global.setInterval = function (fn, ms, ...rest) { return si(fn, ms === 5 * 60 * 1000 ? 400 : ms, ...rest); };
`);
  return { NODE_OPTIONS: `--require ${f.replace(/\\/g, '/')}` };
}

suite('สรุปเช้า (P2-5, P2-9)', () => {
  test('รอบเฝ้าระวังที่ค้างรอ FB ต้องไม่ลบวันที่ส่งสรุปทิ้ง — สรุปเช้าต้องมาข้อความเดียว', async (t) => {
    const world = freshWorld({ insights: [{ acct: ACCT, spend: '100', impressions: '10' }] });
    world.route = (m, p) => (m === 'GET' && p === 'me' ? { id: 'me', delay: 2500 } : null);   // รอบเฝ้าระวังรอ FB นาน
    const preDir = tmpDir();
    const { tg, dir } = await bootTg(t, { cfg: tgConfig(), fbWorld: world, env: { ...eightAmPreload(preDir), WATCH_FIRST_DELAY_MS: '100' } });
    await sleep(6000);
    const sums = tg.state.sent.filter((m) => String(m.text).startsWith('🌅'));
    assert.strictEqual(sums.length, 1, `ได้สรุปเช้า ${sums.length} ข้อความ (เดิมได้ 2)`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'watch-state.json'), 'utf8')).lastSummaryDay);
  });

  test('สรุปเช้าช่วงที่ Meta สั่งพัก: รอในชั่วโมงนั้นก่อน ถึง 08:50 ยังพักค่อยส่งแบบบอกว่าดึงไม่ได้ (ไม่ใช่ "ไม่มีการใช้จ่าย") และไม่ยิง FB', async (t) => {
    // 08:30 ยังพักอยู่ = ยังไม่ส่ง และยังไม่จดวันที่ (จดตอนนี้ = สรุปจริงของวันนั้นไม่มีวันมา)
    const early = await bootTg(t, { cfg: tgConfig(), files: hardCoolFile(), env: eightAmPreload(tmpDir(), 30) });
    await sleep(2500);
    assert.ok(!early.tg.state.sent.some((m) => String(m.text).startsWith('🌅')), 'ส่งสรุปตอนดึงยอดไม่ได้ทั้งที่ยังรอได้');
    let ws = {};
    try { ws = JSON.parse(fs.readFileSync(path.join(early.dir, 'watch-state.json'), 'utf8')); } catch { /* ยังไม่มีไฟล์ */ }
    assert.ok(!ws.lastSummaryDay, 'จดวันที่ส่งแล้วทั้งที่ยังไม่ได้ส่ง');

    const { tg, fb } = await bootTg(t, { cfg: tgConfig(), files: hardCoolFile(), env: eightAmPreload(tmpDir(), 55) });
    await until(() => tg.state.sent.some((m) => String(m.text).startsWith('🌅')), 15000, 'ไม่ส่งสรุปเช้า');
    const sum = tg.state.sent.find((m) => String(m.text).startsWith('🌅')).text;
    assert.match(sum, /Meta จำกัดการเข้า API/);
    assert.doesNotMatch(sum, /ไม่มีการใช้จ่าย/);
    assert.strictEqual(fb.world.calls.filter((c) => /insights/.test(c.path)).length, 0);
  });
});

// ---------- P1 หน้าเว็บ: บล็อกระบบอัตโนมัติ ----------
// รันโค้ดจริงจาก index.html ใน vm (แบบเดียวกับ extension.test.js) กับ DOM/fetch ปลอม
function apUi() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const cut = (from, to) => {
    const a = html.indexOf(from), b = html.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `หาโค้ด "${from}" ไม่เจอ`);
    return html.slice(a, b);
  };
  // ตัดเฉพาะ apiJson — ถัดจากมันคือตัวห่อ fetch/XHR ของหลายโปรไฟล์ (hub.js) ซึ่งต้องมี window จริง ไม่เกี่ยวกับเทสนี้
  const code = cut('async function apiJson(', '// ---------- ผูกหน้าต่างนี้กับโปรไฟล์') + cut('const AP_LEVEL = {', 'async function apRunNow(');
  const els = {};
  // value ของ input จริงเป็น string เสมอ (โค้ดเรียก .trim()) — จำลองให้ตรง
  const el = (id) => {
    if (!els[id]) {
      let v = '';
      els[id] = { id, checked: false, textContent: '', innerHTML: '', hidden: false, querySelector: () => null,
        get value() { return v; }, set value(x) { v = String(x); } };
    }
    return els[id];
  };
  const toasts = [];
  const net = { next: [] };   // คิวคำตอบของ fetch ตามลำดับ
  const ctx = {
    document: { getElementById: el, querySelectorAll: () => Object.values(els).filter((e) => e.id.startsWith('apLim_')), activeElement: null },
    fetch: async () => { const r = net.next.shift(); if (!r) throw new Error('ไม่มีคำตอบเตรียมไว้'); return r(); },
    toast: (m) => toasts.push(String(m)), confirm: () => true,
    esc: (s) => String(s), jsStr: (s) => JSON.stringify(String(s)), ic: () => '',
    EventSource: Object.assign(class { close() {} }, { CLOSED: 2 }),
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const ok = (data) => () => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  const htmlPage = (status) => () => new Response('<html>Bad Gateway</html>', { status });
  return { ctx, el, toasts, net, ok, htmlPage };
}
const apState = (over = {}) => ({
  enabled: true, testMode: false, autoLinkPixel: true, minAds: 3, scaleMaxBudget: 0, killSwitch: false,
  frozen: {}, noRotate: {}, fixesToday: 1, maxPerDay: 10, maxNewPerAcct: 6, createdToday: 2, scaledToday: 0, pausedToday: 0,
  limits: { maxFixPerDay: 10 }, limitSpec: { maxFixPerDay: { def: 10, min: 1, max: 100, int: true, group: 'safety', rail: true, label: 'x', hint: 'y' } },
  fastMins: 10, fullMins: 20, log: [], ...over,
});

suite('P1 หน้าตั้งค่า: โหลด/บันทึกพังต้องไม่ทำให้จอโกหก', () => {
  test('โหลดสถานะได้ {error} หรือหน้า 502/503: ต้องคงหน้าจอเดิมไว้ ไม่ใช่โชว์ว่าระบบปิด และต้องบอกว่าโหลดไม่ได้', async () => {
    const ui = apUi();
    ui.net.next.push(ui.ok(apState()));
    await ui.ctx.loadAutopilot();
    assert.strictEqual(ui.el('apEnabled').checked, true);
    assert.strictEqual(ui.el('apMinAds').value, '3');
    assert.strictEqual(String(ui.el('apFastMins').textContent), '10');

    for (const bad of [ui.htmlPage(503), ui.ok({ error: 'อ่าน state ไม่ได้' })]) {
      ui.net.next.push(bad);
      await ui.ctx.loadAutopilot();
      assert.strictEqual(ui.el('apEnabled').checked, true, 'ระบบยังทำงานอยู่แต่สวิตช์บนจอกลายเป็นปิด');
      assert.strictEqual(ui.el('apMinAds').value, '3', 'minAds บนจอกลายเป็น 0');
      assert.match(ui.el('apStatus').innerHTML, /โหลดสถานะไม่สำเร็จ/);
      assert.match(ui.el('apStatus').innerHTML, /ทำงานอยู่/, 'สถานะล่าสุดที่รู้ต้องยังอยู่');
      assert.doesNotMatch(ui.el('apStatus').innerHTML, /undefined/);
    }
  });

  test('บันทึกไม่ถึงเซิร์ฟเวอร์: สวิตช์/ช่องที่เพิ่งเปลี่ยนต้องกลับเป็นค่าเดิม แม้โหลดซ้ำก็พัง', async () => {
    const ui = apUi();
    ui.net.next.push(ui.ok(apState()));
    await ui.ctx.loadAutopilot();
    ui.el('apEnabled').checked = false;            // ผู้ใช้กดปิดระบบ
    ui.el('apMinAds').value = '0';
    ui.net.next.push(ui.htmlPage(502), ui.htmlPage(502));   // POST พัง แล้ว GET ที่ตามมาก็พัง (ตัวกลางรีสตาร์ท)
    await ui.ctx.saveAutopilot();
    assert.strictEqual(ui.el('apEnabled').checked, true, 'จอโชว์ว่าปิดระบบแล้ว ทั้งที่ไม่มีอะไรถูกบันทึก');
    assert.strictEqual(ui.el('apMinAds').value, '3');
    assert.ok(ui.toasts.some((m) => /บันทึกไม่สำเร็จ/.test(m)));
  });

  test('หยุดฉุกเฉินแล้วได้หน้า HTML 200 กลับมา (หน้าใส่รหัส): ต้องนับว่าไม่สำเร็จและคืนสวิตช์', async () => {
    const ui = apUi();
    ui.net.next.push(ui.ok(apState()));
    await ui.ctx.loadAutopilot();
    const kill = ui.el('apKill');
    kill.checked = true;
    ui.net.next.push(ui.htmlPage(200), ui.htmlPage(503));
    await ui.ctx.apSetKill(kill);
    assert.strictEqual(kill.checked, false, 'สวิตช์ค้างว่า "หยุด" ทั้งที่เซิร์ฟเวอร์ไม่ได้รับ');
    assert.ok(ui.toasts.some((m) => /หยุดฉุกเฉินไม่สำเร็จ/.test(m)));
  });
});

// ---------- รันทั้งหมด: ชุดช้าวิ่งขนานกับชุดปกติ (ชุดปกติยังเรียงทีละชุดเหมือนเดิม) ----------
describe('autopilot: บั๊กจากรีวิว 12 ต.ค. 2026', { concurrency: true }, () => {
  describe(slowSuite[0], slowSuite[1]);
  // concurrency ส่งต่อลงไปถึงชุดลูก — ต้องตั้ง 1 เอง ไม่งั้นทุกชุดวิ่งพร้อมกันแล้วเทสที่อิงจังหวะเวลาเปราะ
  describe('ชุดปกติ', { concurrency: 1 }, () => { for (const [name, fn] of suites) describe(name, { concurrency: 1 }, fn); });
});
