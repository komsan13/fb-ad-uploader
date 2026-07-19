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
const freshWorld = (over = {}) => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
  ...over,
});

async function boot(t, { world = freshWorld(), config = baseConfig(), videos = 3, captions = 3 } = {}) {
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config, videos, captions });
  const srv = await startServer(dir, fb.port);
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
