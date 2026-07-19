// เทสพฤติกรรมจริง: รัน server.js จริง ชี้ FB ไปที่ตัวปลอม แล้วยืนยันจาก state + request ที่ FB ปลอมได้รับ
// เทสระดับนี้จับ regression ได้จริงเพราะเดินผ่านโค้ดทั้งเส้น ไม่ได้ stub ตรรกะทิ้ง
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get, post, readState } = require('./helpers');

const ACCT = '111';
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

// บัญชีเดียว สถานะใช้งานได้ ไม่มีอะไรค้าง
// pages: บัญชีจริงมีเพจที่ลงโฆษณาได้เสมอ — default ให้ 1 เพจ (id ตรงกับ pageId ใน baseConfig)
const freshWorld = (over = {}) => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
  pages: [{ id: 'page1', name: 'เพจหลัก', is_published: true, promotion_eligible: true }],
  ...over,
});

async function boot(t, { world = freshWorld(), config = baseConfig(), videos = 3, captions = 3, env = {} } = {}) {
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config, videos, captions });
  const srv = await startServer(dir, fb.port, env);
  t.after(() => { srv.stop(); fb.server.close(); });
  return { ...srv, dir, world, fb };
}

// รอบแรกของบัญชีจะ baseline แล้วข้าม — ต้องรันสองรอบถึงจะได้พฤติกรรมจริง
async function runTwice(base) {
  await post(base, '/api/autopilot/run');
  return post(base, '/api/autopilot/run');
}

describe('การกันรอบตรวจซ้อนกัน (P0-1)', () => {
  test('ยิงพร้อมกันสองครั้ง ต้องมีแค่ครั้งเดียวที่ได้ทำงาน อีกครั้งได้ 409', async (t) => {
    const { base } = await boot(t);
    const [a, b] = await Promise.all([
      fetch(base + '/api/autopilot/run', { method: 'POST' }),
      fetch(base + '/api/autopilot/run', { method: 'POST' }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepStrictEqual(codes, [200, 409], 'ต้องได้ 200 หนึ่ง 409 หนึ่ง');
  });
});

describe('การจัดการแคมเปญ (P0-3)', () => {
  test('บัญชีมีแคมเปญของระบบเปิดอยู่แล้ว ต้องรับมาใช้ ไม่สร้างซ้ำ', async (t) => {
    const world = freshWorld({
      campaigns: [{ id: 'C_EXIST', acct: ACCT, name: 'Autopilot 2026-07-01', status: 'ACTIVE', daily_budget: '333300' }],
    });
    const { base } = await boot(t, { world });
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(made.length, 0, 'ต้องไม่สร้างแคมเปญใหม่ทับของเดิม');
  });

  test('ไม่มีแคมเปญของระบบเลย ต้องสร้างให้', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(made.length, 1, 'ต้องสร้างแคมเปญ 1 ตัว');
  });

  test('กวาดหาแคมเปญไม่ได้ (FB สะดุด) ต้องไม่สร้างมั่ว', async (t) => {
    const world = freshWorld();
    world.route = (m, p) => (m === 'GET' && p === `act_${ACCT}/campaigns` ? { error: 'ล่มชั่วคราว' } : null);
    const { base } = await boot(t, { world });
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(made.length, 0, 'อ่านไม่ได้ต้องรอรอบหน้า ไม่ใช่เดาแล้วสร้างงบเพิ่มอีกก้อน');
  });
});

describe('ค่าเงิน (P2-10)', () => {
  test('บัญชี JPY ต้องส่งงบเป็นจำนวนเต็มของหน่วยหลัก ไม่คูณ 100', async (t) => {
    const world = freshWorld({
      accounts: [{ name: 'บัญชีเยน', account_id: ACCT, account_status: 1, currency: 'JPY' }],
    });
    const { base } = await boot(t, { world });
    await runTwice(base);
    const made = world.calls.find((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.ok(made, 'ต้องมีการสร้างแคมเปญ');
    assert.strictEqual(made.params.daily_budget, '3333', 'JPY ไม่มีหน่วยย่อย ต้องส่ง 3333 ไม่ใช่ 333300');
  });

  test('บัญชี THB ยังต้องคูณ 100 เหมือนเดิม', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    const made = world.calls.find((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(made.params.daily_budget, '333300');
  });
});

describe('ผู้ลงโฆษณา DSA', () => {
  test('ตั้ง beneficiary ไว้ ต้องถูกส่งไปกับชุดโฆษณา', async (t) => {
    const config = baseConfig({ beneficiaries: { [ACCT]: '999888' } });
    const { base, world } = await boot(t, { config });
    await runTwice(base);
    const as = world.calls.find((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`);
    assert.ok(as, 'ต้องมีการสร้างชุดโฆษณา');
    const rri = JSON.parse(as.params.regional_regulation_identities || '{}');
    assert.strictEqual(rri.universal_beneficiary, '999888');
    assert.strictEqual(rri.universal_payer, '999888');
  });

  test('ไม่ได้ตั้ง beneficiary ต้องไม่ส่งฟิลด์นี้ไปเลย (ไม่ใช่ส่งค่าว่าง)', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    const as = world.calls.find((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`);
    assert.ok(as);
    assert.ok(!('regional_regulation_identities' in as.params), 'ไม่มีค่าก็ไม่ควรส่งฟิลด์');
  });
});

describe('โหมดทดสอบ', () => {
  test('สร้างแอดจริงแต่ปิดไว้ และจำกัดบัญชีละ 1 ตัว', async (t) => {
    const config = baseConfig({ autopilot: { enabled: true, minAds: 5, testMode: true } });
    const { base, world, dir } = await boot(t, { config });
    await runTwice(base);
    await post(base, '/api/autopilot/run');   // รอบที่สาม ต้องไม่สร้างเพิ่ม

    const madeAds = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.strictEqual(madeAds.length, 1, 'โหมดทดสอบต้องสร้างแค่ 1 ตัวต่อบัญชีต่อวัน แม้ minAds=5');
    assert.strictEqual(madeAds[0].params.status, 'PAUSED', 'ต้องปิดไว้ ไม่ใช้เงิน');
    assert.match(madeAds[0].params.name, /^\[ทดสอบ\]/, 'ต้องติดป้ายให้แยกออกจากของจริง');
    assert.ok(readState(dir).tested[ACCT], 'ต้องจดไว้ว่าเทสบัญชีนี้แล้ว');
  });

  test('โหมดปกติต้องเปิดยิงและเติมจนครบเป้า', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    const madeAds = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.strictEqual(madeAds.length, 2, 'minAds=2 ต้องได้ 2 ตัว');
    assert.ok(madeAds.every((c) => c.params.status === 'ACTIVE'));
  });
});

describe('การนับแอดที่รอรีวิว (P1-5)', () => {
  test('แอดสถานะ PENDING_REVIEW ต้องถูกนับว่ามีอยู่แล้ว ไม่เติมซ้ำ', async (t) => {
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot เดิม', status: 'ACTIVE', daily_budget: '333300' }],
      ads: [
        { id: 'A1', acct: ACCT, name: 'รอรีวิว 1', effective_status: 'PENDING_REVIEW', adset_id: 'S1' },
        { id: 'A2', acct: ACCT, name: 'รอรีวิว 2', effective_status: 'PENDING_REVIEW', adset_id: 'S1' },
      ],
    });
    const { base } = await boot(t, { world });
    await runTwice(base);
    const madeAds = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.strictEqual(madeAds.length, 0, 'มี 2 ตัวรอรีวิวอยู่แล้ว เป้า 2 จึงไม่ต้องเติม');
  });
});

describe('การหยุดฉุกเฉินและการบันทึกสถานะ (P0-2, P1-4)', () => {
  test('กดหยุดฉุกเฉินแล้วรอบตรวจต้องไม่ทำอะไร', async (t) => {
    const { base, world } = await boot(t);
    await post(base, '/api/autopilot', { enabled: true, killSwitch: true, minAds: 2 });
    const before = world.calls.length;
    await post(base, '/api/autopilot/run');
    const created = world.calls.slice(before).filter((c) => c.method === 'POST' && /\/(ads|campaigns)$/.test(c.path));
    assert.strictEqual(created.length, 0, 'หยุดฉุกเฉินแล้วต้องไม่สร้างอะไรเลย');
  });

  test('ไฟล์สถานะต้องเป็น JSON ที่อ่านได้เสมอหลังรันหลายรอบ', async (t) => {
    const { base, dir } = await boot(t);
    await runTwice(base);
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.ok(st && typeof st === 'object', 'ต้อง parse ได้ ไม่ใช่ไฟล์เขียนค้างครึ่งทาง');
    assert.ok(st.baselined, 'ต้องจำได้ว่าเฝ้าบัญชีไหนแล้ว — ถ้าลืมจะ baseline ใหม่แล้วไม่เติมแอดตลอดกาล');
  });
});

describe('เพดานปิดแอดขาดทุน', () => {
  test('ปิดได้ไม่เกินเพดานต่อบัญชีต่อวัน แม้รันหลายรอบ', async (t) => {
    const ads = [], insights = [];
    for (let i = 1; i <= 14; i++) {
      ads.push({ id: `L${i}`, acct: ACCT, name: `แอดขาดทุน ${i}`, effective_status: 'ACTIVE', adset_id: 'S1' });
      insights.push({ acct: ACCT, ad_id: `L${i}`, campaign_id: 'C1', spend: '900', actions: [] });
    }
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot เดิม', status: 'ACTIVE', daily_budget: '333300' }],
      ads, insights,
    });
    // apPauseLosers ทำงานเฉพาะเมื่อเปิดสวิตช์กฎหยุดอัตโนมัติ
    const config = baseConfig();
    config.launchDefaults.ruleOn = true;
    config.autopilot = { enabled: true, minAds: 0 };
    const { base, dir } = await boot(t, { world, config });
    // s.campaign ต้องชี้ที่ C1 ก่อน apPauseLosers ถึงจะถือว่าเป็นของระบบ
    await post(base, '/api/autopilot/run');
    await post(base, '/api/autopilot/run');
    await post(base, '/api/autopilot/run');
    const paused = readState(dir).pausedLog || [];
    assert.ok(paused.length <= 10, `ปิดไปแล้ว ${paused.length} ตัว ต้องไม่เกินเพดาน 10 ตัว/บัญชี/วัน`);
  });

  test('ไม่เปิดสวิตช์กฎหยุดอัตโนมัติ ต้องไม่ปิดแอดใคร', async (t) => {
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot เดิม', status: 'ACTIVE', daily_budget: '333300' }],
      ads: [{ id: 'L1', acct: ACCT, name: 'แอดขาดทุน', effective_status: 'ACTIVE', adset_id: 'S1' }],
      insights: [{ acct: ACCT, ad_id: 'L1', campaign_id: 'C1', spend: '900', actions: [] }],
    });
    const config = baseConfig();
    config.autopilot = { enabled: true, minAds: 0 };   // ruleOn ไม่ได้เปิด
    const { base, dir } = await boot(t, { world, config });
    await runTwice(base);
    assert.strictEqual((readState(dir).pausedLog || []).length, 0,
      'หน้าเว็บบอกผู้ใช้ว่าปิดสวิตช์แล้วระบบจะไม่หยุดให้ ต้องทำตามนั้น');
  });
});

describe('การเชื่อม Pixel ตอนขึ้นแอด', () => {
  const withLp = () => {
    const c = baseConfig();
    c.launchDefaults.link = 'http://127.0.0.1:9/lp';   // host จะถูกแทนที่ตอนบูตด้วย PUBLIC_URL จริง
    return c;
  };

  test('บัญชีไม่มี Pixel ต้องสร้างให้เอง แทนที่จะข้ามไปเฉยๆ', async (t) => {
    const world = freshWorld({ pixels: [] });
    const { base } = await boot(t, { world });
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adspixels`);
    assert.strictEqual(made.length, 1, 'ต้องสร้าง Pixel ให้ 1 ตัว');
    assert.match(made[0].params.name, /^Autopilot /);
    const ads = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.ok(ads.length > 0, 'สร้าง Pixel แล้วต้องเติมแอดต่อได้ ไม่ใช่หยุด');
  });

  test('มี Pixel อยู่แล้วต้องไม่สร้างซ้ำ', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adspixels`);
    assert.strictEqual(made.length, 0);
  });

  test('อ่านรายการ Pixel ไม่ได้ ต้องไม่เดาแล้วสร้างใหม่', async (t) => {
    const world = freshWorld();
    world.route = (m, p) => (m === 'GET' && p === `act_${ACCT}/adspixels` ? { error: 'ล่มชั่วคราว' } : null);
    const { base } = await boot(t, { world });
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adspixels`);
    assert.strictEqual(made.length, 0, 'อ่านไม่ได้ = ไม่รู้ว่ามีอยู่แล้วไหม สร้างตอนนี้เสี่ยงได้พิกเซลซ้ำ');
  });

  test('ลิงก์ชี้มาหน้า Landing ของเรา ต้องฝัง Pixel ของบัญชีนั้นให้อัตโนมัติ', async (t) => {
    const world = freshWorld({ pixels: [{ id: '9911223344' }] });
    const cfg = baseConfig();
    const { base } = await boot(t, { world, config: cfg });
    // ตั้งลิงก์ให้ชี้มาหน้า /lp ของเซิร์ฟเวอร์ตัวเองที่กำลังรันอยู่
    await post(base, '/api/launch-defaults', { ...cfg.launchDefaults, link: base + '/lp' });
    await runTwice(base);
    const lp = await get(base, '/api/landing');
    assert.ok(lp.pixels.some((p) => p.id === '9911223344'),
      'พิกเซลของบัญชีที่ยิงแอดต้องอยู่บนหน้า ไม่งั้นแคมเปญนั้นเห็นผลลัพธ์เป็นศูนย์ตลอด');
  });

  test('ลิงก์ไปเว็บอื่น ต้องไม่ไปยุ่งกับหน้า Landing ของเรา', async (t) => {
    const world = freshWorld({ pixels: [{ id: '8877665544' }] });
    const { base } = await boot(t, { world });   // baseConfig ใช้ link เป็น example.com
    await runTwice(base);
    const lp = await get(base, '/api/landing');
    assert.ok(!lp.pixels.some((p) => p.id === '8877665544'),
      'ลิงก์ไม่ได้ชี้มาหน้าเรา การฝังพิกเซลบนหน้าเราก็ไม่มีประโยชน์');
  });
});

describe('การอ่านเหตุผลปฏิเสธ', () => {
  test('เหตุผลอยู่ใน ad_review_feedback ต้องไม่ถูกมองข้าม และหมวดเดิมซ้ำต้องหยุดเติมแอด', async (t) => {
    const reject = (id) => ({
      id, acct: ACCT, name: `แอด ${id}`, effective_status: 'DISAPPROVED', adset_id: 'S1',
      issues_info: [],
      ad_review_feedback: { global: { 'เกมและการพนันออนไลน์': 'เนื้อหาไม่ได้รับอนุญาต' } },
      creative: { id: 'cr1', object_story_spec: { video_data: { message: 'ข้อความเดิม', title: 'หัวข้อ' } } },
    });
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot เดิม', status: 'ACTIVE', daily_budget: '333300' }],
    });
    // ไม่มี Anthropic key = ไม่วินิจฉัย แต่ตัวนับเหตุผลต้องยังทำงาน
    const { base, dir } = await boot(t, { world });
    // รอบแรกของบัญชี = baseline ของที่ค้างอยู่ก่อน จะไม่แตะ — แอดที่จะทดสอบต้องโผล่ "หลัง" รอบนั้น
    await post(base, '/api/autopilot/run');
    world.ads.push(reject('A1'), reject('A2'));
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.ok(st.noRotate && st.noRotate[ACCT], 'หมวดเดิมซ้ำ 2 ครั้ง ต้องหยุดเติมแอดให้บัญชีนี้');
    assert.match(st.noRotate[ACCT].cat, /พนัน/, 'ต้องจับหมวดจาก ad_review_feedback ได้');
  });
});

describe('เพดานที่ตั้งได้จากหน้าเว็บ', () => {
  test('เพดานเติมแอดที่ตั้งไว้ต้องมีผลจริง ไม่ใช่แค่เก็บลง config', async (t) => {
    // minAds=5 แต่เพดานเติม 2 ตัว/วัน → ต้องได้ 2 ไม่ใช่ 5
    const config = baseConfig({
      autopilot: { enabled: true, minAds: 5, limits: { maxNewAdsPerDay: 2 } },
    });
    const { base, world } = await boot(t, { config, videos: 9, captions: 9 });
    await runTwice(base);
    await post(base, '/api/autopilot/run');

    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.strictEqual(made.length, 2, `เพดาน 2 ตัว/วัน แต่สร้างไป ${made.length} ตัว`);
  });

  test('ตั้งเพดานนอกกรอบผ่าน API ต้องถูกบีบกลับ และอ่านค่าที่ถูกบีบแล้วออกมา', async (t) => {
    const { base } = await boot(t);
    // ปลดเกราะกันแบน = สิ่งที่ต้องกันให้ได้ที่ทางเข้า
    const r = await post(base, '/api/autopilot', {
      enabled: true, limits: { freezeRejections: 999, scaleStep: 50, maxNewAdsPerDay: 0 },
    });
    assert.strictEqual(r.limits.freezeRejections, 5);
    assert.strictEqual(r.limits.scaleStep, 2);
    assert.strictEqual(r.limits.maxNewAdsPerDay, 1);

    const st = await get(base, '/api/autopilot');
    assert.strictEqual(st.limits.freezeRejections, 5, 'อ่านกลับต้องได้ค่าที่บีบแล้ว');
    assert.strictEqual(st.maxNewPerAcct, 1, 'ตัวเลขที่หน้าเว็บโชว์ต้องตรงกับเพดานจริง');
  });

  test('แก้เพดานต้องถูกจดไว้ใน log — เกราะกันแบนขยับเงียบๆ ไม่ได้', async (t) => {
    const { base, dir } = await boot(t);
    await post(base, '/api/autopilot', { enabled: true, limits: { freezeRejections: 5 } });
    const entry = readState(dir).log.find((l) => /แก้เพดาน/.test(l.msg));
    assert.ok(entry, 'ต้องมีบรรทัด log ตอนเพดานเปลี่ยน');
    assert.match(entry.msg, /3 → 5/, 'ต้องบอกว่าเปลี่ยนจากอะไรเป็นอะไร');
  });

  test('บันทึกค่าอื่นโดยไม่ส่ง limits มา ต้องไม่ล้างเพดานที่ตั้งไว้', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/autopilot', { enabled: true, limits: { freezeRejections: 5 } });
    await post(base, '/api/autopilot', { enabled: true, minAds: 3 });   // ไม่ส่ง limits
    const st = await get(base, '/api/autopilot');
    assert.strictEqual(st.limits.freezeRejections, 5, 'เพดานที่ตั้งไว้ต้องอยู่');
  });
});

describe('เพดาน: บั๊กที่รีวิว adversarial เจอ', () => {
  test('ค่าที่อ่านไม่ออกต้องไม่เขียนทับค่าที่ผู้ใช้ตั้งเข้มกว่าค่าตั้งต้น', async (t) => {
    const { base } = await boot(t);
    // ตั้ง 2 = เข้มกว่าค่าตั้งต้น 3 (หยุดบัญชีเร็วกว่า)
    await post(base, '/api/autopilot', { enabled: true, limits: { freezeRejections: 2 } });

    // ช่องว่างเพราะพิมพ์ "2,5" แล้ว input type=number คืน '' — ต้องไม่กลายเป็น 3
    for (const bad of ['', null, false, 'abc', [], {}]) {
      await post(base, '/api/autopilot', { enabled: true, limits: { freezeRejections: bad } });
      const st = await get(base, '/api/autopilot');
      assert.strictEqual(st.limits.freezeRejections, 2,
        `ค่า ${JSON.stringify(bad)} ทำให้เพดานหลวมขึ้นเป็น ${st.limits.freezeRejections}`);
    }
  });

  test('resetLimits ต้องลบคีย์ทิ้ง ไม่ใช่ตรึงตัวเลขของวันนี้ไว้บนดิสก์', async (t) => {
    const { base, dir } = await boot(t);
    await post(base, '/api/autopilot', { enabled: true, limits: { freezeRejections: 5 } });
    await post(base, '/api/autopilot', { enabled: true, resetLimits: true });

    const cfg = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.autopilot.limits, undefined,
      'ต้องไม่เหลือคีย์ limits — ไม่งั้นวันหน้ารัดค่าตั้งต้นให้แน่นขึ้น เครื่องนี้จะไม่ได้รับผล');
    const st = await get(base, '/api/autopilot');
    assert.strictEqual(st.limits.freezeRejections, 3, 'อ่านกลับต้องได้ค่าตั้งต้น');
  });

  test('แก้เพดานอย่างเดียวต้องไม่จด "เปิดระบบอัตโนมัติ" มากลบร่องรอย', async (t) => {
    const { base, dir } = await boot(t);
    // config ตั้งต้นเปิดอยู่แล้ว — ปิดแล้วเปิดใหม่ = สวิตช์เปลี่ยนจริงสองครั้ง
    await post(base, '/api/autopilot', { enabled: false });
    await post(base, '/api/autopilot', { enabled: true });
    for (const v of [4, 5, 2]) {
      await post(base, '/api/autopilot', { enabled: true, limits: { freezeRejections: v } });
    }
    const log = readState(dir).log;
    const toggles = log.filter((l) => /เปิดระบบอัตโนมัติ|ปิดระบบอัตโนมัติ/.test(l.msg));
    assert.strictEqual(toggles.length, 2, `สวิตช์เปลี่ยนจริง 2 ครั้ง แต่จดไป ${toggles.length} ครั้ง`);
    assert.strictEqual(log.filter((l) => /แก้เพดาน/.test(l.msg)).length, 3, 'ต้องจดการแก้เพดานครบ 3 ครั้ง');
  });

  test('prototype pollution ต้องไม่หลุดเข้ามาเป็นเพดาน', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/autopilot', {
      enabled: true,
      limits: { __proto__: { polluted: 1 }, constructor: 99, freezeRejections: 4 },
    });
    assert.strictEqual({}.polluted, undefined, 'Object.prototype ต้องไม่ถูกแตะ');
    const st = await get(base, '/api/autopilot');
    assert.strictEqual(st.limits.freezeRejections, 4, 'คีย์ปกติต้องยังทำงาน');
    for (const [k, v] of Object.entries(st.limits)) {
      assert.ok(Number.isFinite(v), `${k} ได้ค่าที่ไม่ใช่ตัวเลข: ${v}`);
    }
  });
});

// ---------- P0 จากรีวิว 19 ก.ค. 2026: เกราะกันแบนต้องทำงานข้าม tick ----------
describe('เกราะกันแบนข้าม tick', () => {
  const reject = (id, cat) => ({
    id, acct: ACCT, name: `แอด ${id}`, effective_status: 'DISAPPROVED', adset_id: 'S1',
    issues_info: [], ad_review_feedback: { global: { [cat]: 'ผิดนโยบาย' } },
    creative: { id: 'cr' + id, object_story_spec: { video_data: { message: 'ข้อความยาวพอสมควรของแอด', title: 'หัวข้อ' } } },
  });

  test('โดนปฏิเสธทีละตัวคนละรอบ ครบเกณฑ์ต้อง freeze — และแอดค้างห้ามฆ่า tick', async (t) => {
    // FB รีวิวแอดกระจายเวลากันเป็นชั่วโมง ไม่ใช่พร้อมกันใน 2 นาที — เทสเดิมทั้งหมด push
    // แอดรวดเดียวใน tick เดียว จึงมองไม่เห็นว่าตัวนับโดนทับหายตอน save (P0)
    // ไม่มี Anthropic key = แอดค้างสถานะ "นับแล้วแต่ยังไม่ปิดเคส" ข้ามรอบ ซึ่งคือ
    // เงื่อนไขที่เคยทำให้ tick ตายถาวรด้วย TypeError (P0 อีกตัว) — เทสนี้จับทั้งคู่
    const { base, dir, world } = await boot(t, { env: { ANTHROPIC_API_KEY: '' } });
    const runs = [await post(base, '/api/autopilot/run')];   // รอบ baseline
    for (const [i, cat] of [['A1', 'หมวดหนึ่ง'], ['A2', 'หมวดสอง'], ['A3', 'หมวดสาม']].entries()) {
      world.ads.push(reject(cat[0], cat[1]));
      runs.push(await post(base, '/api/autopilot/run'));
    }
    runs.forEach((r, i) => assert.ok(!r.error, `รอบ ${i + 1} พัง: ${r.error}`));

    const st = readState(dir);
    assert.strictEqual((st.rejections[ACCT] || []).length, 3, 'ตัวนับต้องสะสมข้ามรอบเป็น 3');
    assert.ok(st.frozen[ACCT], 'ครบ 3 ตัวใน 24 ชม. ต้องหยุดทั้งบัญชี — เกราะที่ CLAUDE.md บอกว่าห้ามถอด');
  });

  test('state ที่มี mark นับแล้วแต่ตัวนับหาย ต้องไม่ฆ่า tick (regression TypeError)', async (t) => {
    const world = freshWorld({ ads: [reject('AX', 'หมวดค้าง')] });
    const { base, dir } = await boot(t, { world, env: { ANTHROPIC_API_KEY: '' } });
    // สภาพจริงที่เคยฆ่า tick: counted มี mark แต่ rejections ไม่มีคีย์ (เกิดจาก merge เวอร์ชันเก่า)
    require('node:fs').writeFileSync(require('node:path').join(dir, 'autopilot-state.json'),
      JSON.stringify({ baselined: { [ACCT]: Date.now() }, counted: { AX: { v: 1, ts: Date.now() } } }));

    const r = await post(base, '/api/autopilot/run');
    assert.ok(!r.error, 'tick ต้องไม่พัง: ' + r.error);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.ok(made.length >= 1, 'งานส่วนอื่นของรอบ (เติมแอด) ต้องเดินต่อ ไม่ใช่ตายไปกับแอดค้าง');
  });

  test('แคมเปญที่รับมาใช้ (ชื่อ Autopilot แต่ไม่ได้สร้างเอง) ต้องไม่ถูกขยายงบ', async (t) => {
    const world = freshWorld({
      campaigns: [{ id: 'C9', acct: ACCT, name: 'Autopilot เก่าของเจ้าของ', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '333300' }],
      insights: [{ acct: ACCT, campaign_id: 'C9', spend: '300', actions: [{ action_type: 'omni_purchase', value: '10' }] }],
    });
    const config = baseConfig({ autopilot: { enabled: true, minAds: 1, scaleMaxBudget: 100000 } });
    const { base, world: w } = await boot(t, { world, config, env: { ANTHROPIC_API_KEY: '' } });
    await runTwice(base);
    // C9 เป็นตัวชนะตามเกณฑ์ทุกข้อ (cpa 30 < 70, ผลลัพธ์ 10) — สิ่งเดียวที่ต้องกันคือมันไม่ใช่ของเรา
    const scaled = w.calls.filter((c) => c.method === 'POST' && c.path === 'C9' && c.params.daily_budget);
    assert.strictEqual(scaled.length, 0, 'แคมเปญรับมาใช้โดนขยายงบ — ผิดสัญญาที่ apGetCampaign ให้ไว้');
  });
});

describe('unfreeze ต้องไม่กระทบบัญชีอื่น (P2 จากรีวิวรอบยืนยัน)', () => {
  test('ปลดล็อกบัญชี A แล้วแอดค้างในบัญชี B ต้องไม่ถูกนับซ้ำ', async (t) => {
    const world = freshWorld({
      accounts: [
        { name: 'บัญชี A', account_id: '111', account_status: 1, currency: 'THB' },
        { name: 'บัญชี B', account_id: '222', account_status: 1, currency: 'THB' },
      ],
    });
    const { base, dir } = await boot(t, { world, env: { ANTHROPIC_API_KEY: '' } });
    await post(base, '/api/autopilot/run');   // baseline ทั้งสองบัญชี
    // แอดค้างในบัญชี B (nokey = นับแล้วแต่ปิดเคสไม่ได้ วนกลับมาทุกรอบ)
    world.ads.push({
      id: 'B1', acct: '222', name: 'แอดค้าง', effective_status: 'DISAPPROVED', adset_id: 'S1',
      issues_info: [], ad_review_feedback: { global: { 'หมวดเดียว': 'ผิดนโยบาย' } },
      creative: { id: 'crB1', object_story_spec: { video_data: { message: 'ข้อความของแอดตัวนี้', title: 'หัว' } } },
    });
    await post(base, '/api/autopilot/run');   // B1 ถูกนับครั้งแรก

    // freeze บัญชี A ไว้ (จำลองสภาพจริงก่อนกดปลด) แล้วกดปลดล็อก A
    const fs = require('node:fs'), path = require('node:path');
    const sp = path.join(dir, 'autopilot-state.json');
    const st0 = JSON.parse(fs.readFileSync(sp, 'utf8'));
    st0.frozen['111'] = { since: Date.now(), reason: 'เทส' };
    fs.writeFileSync(sp, JSON.stringify(st0));
    await post(base, '/api/autopilot/unfreeze', { acctId: '111' });

    await post(base, '/api/autopilot/run');   // ถ้า mark ของ B โดนล้าง B1 จะถูกนับซ้ำตรงนี้
    const st = readState(dir);
    assert.strictEqual((st.reasons['222|หมวดเดียว'] || []).length, 1,
      'B1 โดนปฏิเสธจริงครั้งเดียว ตัวนับต้องเป็น 1 — นับซ้ำแปลว่า unfreeze บัญชี A ไปล้าง mark ของ B');
    assert.ok(!st.noRotate['222'], 'บัญชี B ต้องไม่โดนหยุดเติมแอดจาก false alarm');
  });
});

// ---------- เกราะ rate limit: ทำตามคำแนะนำทางการของ Meta "หยุดยิงก่อนชนลิมิต" ----------
describe('เกราะ rate limit ของ Meta', () => {
  test('header โควตาแตะ 90% → รอบถัดไปต้องพัก ไม่ยิง FB สักคำขอ', async (t) => {
    const world = freshWorld();
    world.headers = { 'x-app-usage': '{"call_count":95,"total_time":10,"total_cputime":10}' };
    const { base } = await boot(t, { world });
    await post(base, '/api/autopilot/run');           // รอบแรกยิงปกติ แล้วเห็น header ระหว่างรอบ
    const before = world.calls.length;
    assert.ok(before > 0, 'รอบแรกต้องยิง FB ตามปกติ');
    await post(base, '/api/autopilot/run');
    assert.strictEqual(world.calls.length, before, 'รอบสองต้องพักตามสัญญาณโควตา ไม่ยิง FB เลย');
  });

  test('Meta บอกเวลาที่จะปลดกั้น (estimated_time_to_regain_access) → ต้องพักตามนั้น', async (t) => {
    const world = freshWorld();
    world.headers = {
      'x-business-use-case-usage':
        '{"9999":[{"type":"ads_management","call_count":10,"total_time":5,"total_cputime":5,"estimated_time_to_regain_access":5}]}',
    };
    const { base } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const before = world.calls.length;
    await post(base, '/api/autopilot/run');
    assert.strictEqual(world.calls.length, before, 'Meta สั่งพักผ่าน BUC header ต้องหยุดยิงทันที');
  });

  test('โควตายังเหลือเยอะ ระบบต้องทำงานปกติ ไม่พักมั่ว', async (t) => {
    const world = freshWorld();
    world.headers = { 'x-app-usage': '{"call_count":28,"total_time":10,"total_cputime":10}' };
    const { base } = await boot(t, { world });
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(made.length, 1, 'โควตาปกติ รอบเต็มต้องเดินงานตามเดิม (สร้างแคมเปญได้)');
  });
});

// ---------- บาลานซ์เพจ round-robin + กันเพจแตกขึ้นแอด ----------
describe('บาลานซ์เพจ + กันเพจแตก', () => {
  const pagesWorld = () => freshWorld({
    pages: [
      { id: 'PG_A', name: 'เพจ A', is_published: true, promotion_eligible: true },
      { id: 'PG_B', name: 'เพจ B', is_published: true, promotion_eligible: true },
      { id: 'PG_DEAD', name: 'เพจบิน', is_published: true, promotion_eligible: false },
    ],
  });
  const pageIdsOf = (world) => world.calls
    .filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adcreatives`)
    .map((c) => JSON.parse(c.params.object_story_spec).page_id);

  test('สร้างหลายแอด ต้องหมุนใช้ทั้งเพจ A/B และไม่แตะเพจบินเลย', async (t) => {
    const cfg = baseConfig({ autopilot: { enabled: true, minAds: 3 } });
    const { base, world } = await boot(t, { world: pagesWorld(), config: cfg });
    await runTwice(base);
    const ids = pageIdsOf(world);
    assert.ok(ids.length >= 3, 'ต้องสร้างแอดอย่างน้อย 3 ตัว: ได้ ' + ids.length);
    assert.ok(!ids.includes('PG_DEAD'), 'ห้ามใช้เพจบิน (promotion_eligible=false) ขึ้นแอดเด็ดขาด');
    assert.deepStrictEqual([...new Set(ids)].sort(), ['PG_A', 'PG_B'], 'ต้องหมุนใช้ทั้งเพจ A และ B ไม่ใช่เพจเดียวรวด');
  });

  test('ตรวจรายชื่อเพจไม่ได้ (FB สะดุด) ต้องข้ามการเติม ไม่ถอยไปขึ้นแอดบนเพจที่ตั้งเอง', async (t) => {
    // เพจที่ตั้งเอง (pageId) มักเป็นตัวที่บินอยู่พอดี — ขึ้นแอดบนมันจะโดนปฏิเสธแล้วดันตัวนับ freeze ฟรี
    const world = freshWorld();
    world.route = (m, p) => (m === 'GET' && p === 'me/accounts' ? { error: 'ล่มชั่วคราว' } : null);
    const cfg = baseConfig({ autopilot: { enabled: true, minAds: 3 } });
    const { base } = await boot(t, { world, config: cfg });
    await runTwice(base);
    assert.strictEqual(pageIdsOf(world).length, 0, 'ตรวจเพจไม่ได้ = ต้องไม่สร้างแอดสักตัว รอบหน้าค่อยลองใหม่');
  });

  test('เพจบินหมดทุกเพจ ต้องไม่เติมแอด (ไม่ถอยไปใช้เพจที่ตั้งเองซึ่งอาจบินอยู่)', async (t) => {
    const world = freshWorld({
      pages: [{ id: 'PG_DEAD', name: 'เพจบิน', is_published: true, promotion_eligible: false }],
    });
    const cfg = baseConfig({ autopilot: { enabled: true, minAds: 3 } });
    const { base } = await boot(t, { world, config: cfg });
    await runTwice(base);
    assert.strictEqual(pageIdsOf(world).length, 0, 'ไม่มีเพจที่ลงโฆษณาได้ = ต้องไม่สร้างแอดสักตัว');
  });

  test('/api/accounts ต้องไม่คืนเพจแตกให้ dropdown เลือก', async (t) => {
    const { base } = await boot(t, { world: pagesWorld() });
    const r = await get(base, '/api/accounts?profile=p1');
    const ids = (r.pages || []).map((p) => p.id);
    assert.deepStrictEqual(ids.sort(), ['PG_A', 'PG_B'], 'dropdown ต้องเห็นเฉพาะเพจที่ลงโฆษณาได้');
  });
});
