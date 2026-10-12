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

// รอบแรกของบัญชีจะ baseline แอดที่โดนปฏิเสธอยู่ก่อน (ไม่แตะ) — เทสส่วนใหญ่รันสองรอบให้ได้พฤติกรรมของรอบปกติ
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

describe('รอบแรกหลังเปิดระบบ', () => {
  test('บัญชีที่ยังไม่มีแอด ต้องเติมแอดตั้งแต่รอบแรก — รอบ baseline ข้ามแค่แอดที่โดนปฏิเสธอยู่ก่อน', async (t) => {
    // เดิมรอบแรกข้ามทั้งบัญชี เปิดระบบแล้วไม่มีอะไรขึ้นจนรอบถัดไป (20 นาที) ผู้ใช้เจอจริง 12 ต.ค. 2026
    const world = freshWorld({
      ads: [{ id: 'OLD', acct: ACCT, name: 'แอดเก่าโดนปฏิเสธ', effective_status: 'DISAPPROVED', adset_id: 'S0', issues_info: [] }],
    });
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.strictEqual(made.length, 2, 'minAds=2 ต้องเติมครบตั้งแต่รอบแรก');
    assert.strictEqual((readState(dir).handled.OLD || {}).v, 'baseline', 'แอดที่โดนปฏิเสธอยู่ก่อนต้องจดไว้เฉยๆ ไม่แตะ');
    assert.ok(!world.calls.some((c) => c.method === 'POST' && c.path === 'OLD'), 'ห้ามแตะแอดเก่า');
  });
});

describe('แอดละแคมเปญ (ผู้ใช้สั่ง 12 ต.ค. 2026)', () => {
  const campPosts = (world) => world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
  test('เติมแอด 2 ตัว = 2 แคมเปญ งบเต็มแคมเปญละ campaignBudget แต่ละแคมเปญมีชุดโฆษณาของตัวเอง', async (t) => {
    // เดิม 1 บัญชี = 1 แคมเปญงบ CBO ก้อนเดียว FB เทงบไปแอดตัวเดียว (วัดจริง 802 vs 73 บาท)
    const { base, world, dir } = await boot(t);
    await post(base, '/api/autopilot/run');
    const camps = campPosts(world);
    assert.strictEqual(camps.length, 2);
    assert.ok(camps.every((c) => c.params.daily_budget === '333300'), 'แต่ละแคมเปญต้องได้งบ 3,333 บาทเต็ม');
    const sets = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`);
    assert.strictEqual(new Set(sets.map((c) => c.params.campaign_id)).size, 2, 'ชุดโฆษณาต้องอยู่คนละแคมเปญ');
    const owned = readState(dir).owned;
    assert.ok(world.campaigns.every((c) => owned.includes(c.id)), 'ทุกแคมเปญต้องเป็นของระบบ (ขยายงบ/ปิดแอดขาดทุนได้)');
  });

  test('มีแคมเปญ Autopilot แบบเก่า (CBO รวม) เปิดอยู่แต่ไม่มีแอดยิง ต้องไม่ใส่แอดเพิ่มเข้าไป — สร้างแคมเปญใหม่ต่อแอด', async (t) => {
    const world = freshWorld({
      campaigns: [{ id: 'C_EXIST', acct: ACCT, name: 'Autopilot 2026-07-01', status: 'ACTIVE', daily_budget: '333300' }],
    });
    const { base } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const sets = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`);
    assert.ok(sets.length > 0 && sets.every((c) => c.params.campaign_id !== 'C_EXIST'));
    assert.ok(!world.calls.some((c) => c.method === 'POST' && c.path === 'C_EXIST'), 'ห้ามแตะแคมเปญเดิม');
  });

  test('แคมเปญที่ยังมีแอดยิงอยู่ครบเป้า ต้องไม่สร้างเพิ่ม (งบรวมคุมด้วยจำนวนแอดที่ยิงอยู่)', async (t) => {
    const world = freshWorld({
      ads: [
        { id: 'A1', acct: ACCT, name: 'ยิงอยู่ 1', effective_status: 'ACTIVE', adset_id: 'S1' },
        { id: 'A2', acct: ACCT, name: 'ยิงอยู่ 2', effective_status: 'ACTIVE', adset_id: 'S2' },
      ],
    });
    const { base } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    assert.strictEqual(campPosts(world).length, 0);
  });

  test('แอดพังหลังสร้างแคมเปญแล้ว ต้องลบแคมเปญทิ้ง (ไม่ค้างแคมเปญเปล่าที่มีงบ)', async (t) => {
    const world = freshWorld({
      route: (m, p) => (m === 'POST' && p === `act_${ACCT}/ads` ? { error: 'จำลองสร้างแอดไม่ผ่าน' } : null),
    });
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    assert.strictEqual(campPosts(world).length, 1, 'พลาดแล้วหยุดรอบนี้ ไม่รัวสร้างต่อ');
    assert.ok(world.campaigns.every((c) => c.status === 'DELETED'), 'แคมเปญที่สร้างค้างต้องถูกลบ');
    assert.ok(!(readState(dir).owned || []).includes(world.campaigns[0].id), 'ลบแล้วต้องเอาออกจากรายการของระบบด้วย');
  });
});

// งบในค่าตั้งต้นกรอกเป็นบาทเสมอ — บัญชีสกุลอื่นต้องแปลงด้วยเรตจริง (fake-fb: 1 บาท = 0.03 USD / 4.5 JPY / 768 VND)
// เดิมเอาเลขบาทไปใช้ตรงๆ: บัญชี USD งบ 3,333 บาท กลายเป็น 3,333 ดอลลาร์/วัน (~30 เท่า)
describe('ค่าเงิน (P2-10)', () => {
  const madeBudget = (world, acct = ACCT) => {
    const made = world.calls.find((c) => c.method === 'POST' && c.path === `act_${acct}/campaigns`);
    return made && made.params.daily_budget;
  };
  const acctIn = (currency, id = ACCT) => ({ name: `บัญชี ${currency}`, account_id: id, account_status: 1, currency });

  test('บัญชี JPY: แปลงบาทเป็นเยนแล้วส่งเป็นจำนวนเต็ม (เยนไม่มีหน่วยย่อย)', async (t) => {
    const { base, world } = await boot(t, { world: freshWorld({ accounts: [acctIn('JPY')] }) });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '14999', '3,333 บาท × 4.5 = 14,998.5 เยน → 14,999 (ไม่คูณ 100)');
  });

  test('บัญชี USD: 3,333 บาท ต้องเป็น 99.99 ดอลลาร์ ไม่ใช่ 3,333 ดอลลาร์', async (t) => {
    const { base, world } = await boot(t, { world: freshWorld({ accounts: [acctIn('USD')] }) });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '9999', '3,333 × 0.03 = 99.99 ดอลลาร์ = 9,999 เซนต์');
  });

  test('บัญชี VND: แปลงเป็นดองจำนวนเต็ม', async (t) => {
    const { base, world } = await boot(t, { world: freshWorld({ accounts: [acctIn('VND')] }) });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '2559744', '3,333 × 768 = 2,559,744 ดอง');
  });

  test('บัญชี THB ยังต้องคูณ 100 เหมือนเดิม และไม่ต้องไปขอเรต', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '333300');
    assert.ok(!world.calls.some((c) => c.path === 'fx'), 'บัญชีบาทไม่ต้องพึ่งแหล่งเรต');
  });

  test('ดึงเรตไม่ได้: บัญชี USD ต้องไม่ถูกสร้างแคมเปญ (ไม่เดาเรต) แต่บัญชีบาทในรอบเดียวกันยังเดินต่อ', async (t) => {
    const world = freshWorld({ fxDown: true, accounts: [acctIn('USD', '111'), acctIn('THB', '222')] });
    const { base, dir } = await boot(t, { world });
    await runTwice(base);
    assert.strictEqual(madeBudget(world, '111'), undefined, 'ไม่มีเรตแล้วสร้างแคมเปญ = เสี่ยงงบผิดหลายสิบเท่า');
    assert.strictEqual(madeBudget(world, '222'), '333300');
    const log = JSON.stringify(readState(dir).log || []);
    assert.ok(log.includes('อัตราแลกเปลี่ยน'), 'ต้องเตือนว่าทำไมบัญชีนั้นไม่ถูกเติมแอด');
  });

  test('ขยายงบบัญชี USD: เพดานกับเกณฑ์ต้นทุนเป็นบาท ต้องแปลงก่อนเทียบ', async (t) => {
    // งบเดิม 10 ดอลลาร์ • เพดาน 1,000 บาท = 30 ดอลลาร์ • เกณฑ์ 100 บาท = 3 ดอลลาร์/ผล
    // ใช้ไป 7 ดอลลาร์ ได้ 10 ผล = 0.7 ดอลลาร์/ผล (ถูกกว่า 70% ของ 3) → ชนะ → 10 × 1.2 = 12 ดอลลาร์
    const world = freshWorld({
      accounts: [acctIn('USD')],
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot เดิม', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '1000' }],
      insights: [{ acct: ACCT, campaign_id: 'C1', spend: '7', actions: [{ action_type: 'omni_purchase', value: '10' }] }],
    });
    const config = baseConfig({ autopilot: { enabled: true, minAds: 0, scaleMaxBudget: 1000 } });
    config.launchDefaults.ruleCpr = '100';
    const { base, dir } = await boot(t, { world, config, env: { ANTHROPIC_API_KEY: '' } });
    require('node:fs').writeFileSync(require('node:path').join(dir, 'autopilot-state.json'),
      JSON.stringify({ baselined: { [ACCT]: Date.now() }, owned: ['C1'], campaign: { [ACCT]: 'C1' } }));
    await post(base, '/api/autopilot/run');
    const up = world.calls.find((c) => c.method === 'POST' && c.path === 'C1' && c.params.daily_budget);
    assert.ok(up, 'ตัวชนะตามเกณฑ์ที่แปลงแล้วต้องถูกขยายงบ (เดิมเทียบ 0.7 ดอลลาร์กับ 100 "บาท" ตรงๆ)');
    assert.strictEqual(up.params.daily_budget, '1200');
  });

  test('ขึ้นแอดเองบัญชี USD: งบและกฎหยุดอัตโนมัติต้องแปลงเป็นดอลลาร์', async (t) => {
    const { base, world } = await boot(t, { world: freshWorld({ accounts: [acctIn('USD')] }) });
    const form = new FormData();
    form.append('data', JSON.stringify({
      profileId: 'p1', accountId: ACCT, pageId: 'page1',
      campaign: { name: 'เทสสกุลเงิน', objective: 'OUTCOME_SALES' },
      campaignBudget: 300, cta: 'LEARN_MORE', pixelId: 'px1', conversionEvent: 'SUBSCRIBE', active: false,
      autoRule: { cpr: 100, minSpend: 150 },
      ads: [{ mediaId: 'v1', name: 'Ad-1', message: 'ทดสอบ', link: 'https://example.com/', ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [] }],
    }));
    const out = await (await fetch(base + '/api/launch', { method: 'POST', body: form })).text();
    assert.strictEqual(madeBudget(world), '900', '300 บาท = 9 ดอลลาร์ = 900 เซนต์');
    const rule = world.calls.find((c) => c.method === 'POST' && /adrules_library$/.test(c.path));
    const filters = JSON.parse(rule.params.evaluation_spec).filters;
    assert.strictEqual(filters.find((f) => f.field === 'cpa').value, 300, 'CPA 100 บาท = 3 ดอลลาร์');
    assert.strictEqual(filters.find((f) => f.field === 'spent').value, 450, 'ใช้เกิน 150 บาท = 4.5 ดอลลาร์');
    assert.ok(out.includes('1 บาท = 0.03 USD'), 'ต้องบอกผู้ใช้ว่าแปลงด้วยเรตเท่าไหร่');
  });

  test('ขึ้นแอดเองบัญชี USD ตอนดึงเรตไม่ได้: ต้องไม่สร้างแคมเปญ และบอกเหตุผล', async (t) => {
    const { base, world } = await boot(t, { world: freshWorld({ fxDown: true, accounts: [acctIn('USD')] }) });
    const form = new FormData();
    form.append('data', JSON.stringify({
      profileId: 'p1', accountId: ACCT, pageId: 'page1',
      campaign: { name: 'เทสเรตล่ม', objective: 'OUTCOME_SALES' },
      campaignBudget: 300, cta: 'LEARN_MORE', pixelId: 'px1', conversionEvent: 'SUBSCRIBE', active: false,
      ads: [{ mediaId: 'v1', name: 'Ad-1', message: 'ทดสอบ', link: 'https://example.com/', ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [] }],
    }));
    const out = await (await fetch(base + '/api/launch', { method: 'POST', body: form })).text();
    assert.strictEqual(madeBudget(world), undefined);
    assert.ok(out.includes('"fatal"') && out.includes('อัตราแลกเปลี่ยน'));
  });

  // ---- รอบรีวิว 12 ต.ค. 2026 ----
  const fs = require('node:fs');
  const path = require('node:path');
  const writeFx = (dir, cache) => fs.writeFileSync(path.join(dir, 'fx-rates.json'), JSON.stringify(cache));
  const logText = (dir) => JSON.stringify((readState(dir) || {}).log || []);
  const launchForm = (over = {}) => {
    const form = new FormData();
    form.append('data', JSON.stringify({
      profileId: 'p1', accountId: ACCT, pageId: 'page1',
      campaign: { name: 'เทสขึ้นแอด', objective: 'OUTCOME_SALES' },
      campaignBudget: 300, cta: 'LEARN_MORE', pixelId: 'px1', conversionEvent: 'SUBSCRIBE', active: false,
      ads: [{ mediaId: 'v1', name: 'Ad-1', message: 'ทดสอบ', link: 'https://example.com/', ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [] }],
      ...over,
    }));
    return form;
  };

  test('บัญชี IDR: รูเปียห์ไม่มีหน่วยย่อยตามตารางของ Meta ต้องไม่คูณ 100', async (t) => {
    // เดิมใช้รายชื่อของ Stripe ซึ่งไม่มี IDR → 3,333 บาท × 480 × 100 = เกินจริง 100 เท่า (~333,300 บาท/วัน)
    const world = freshWorld({ accounts: [acctIn('IDR')], fx: { THB: 1, USD: 0.03, IDR: 480 } });
    const { base } = await boot(t, { world });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '1599840', '3,333 × 480 = 1,599,840 รูเปียห์ (ไม่ใช่ 159,984,000)');
  });

  test('แหล่งเรตส่งเรตที่ไม่ใช่ฐานบาทมา ต้องไม่เอาไปคูณ (เดิมบัญชี VND ได้งบเกิน ~33 เท่า)', async (t) => {
    const world = freshWorld({
      accounts: [acctIn('VND')],
      route: (m, p) => (p === 'fx' ? { result: 'success', base_code: 'USD', rates: { USD: 1, THB: 33.5, VND: 25800 } } : null),
    });
    const { base, dir } = await boot(t, { world });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), undefined, 'เรตฐานผิดต้องไม่ถูกใช้สร้างแคมเปญ');
    assert.ok(logText(dir).includes('ฐานบาท'), 'ต้องบอกว่าทำไมไม่สร้าง');
  });

  test('เรตบนดิสก์เก่าเกิน 3 วันและดึงใหม่ไม่ได้ ต้องหยุดแปลงพร้อมเตือน ไม่ใช้เรตเก่าไปเรื่อยๆ', async (t) => {
    const world = freshWorld({ fxDown: true, accounts: [acctIn('USD')] });
    const { base, dir } = await boot(t, { world });
    const old = Date.now() - 5 * 864e5;
    writeFx(dir, { ts: old, updated: old, rates: { THB: 1, USD: 0.05 } });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), undefined, 'เรตเก่า 5 วัน ห้ามใช้ตั้งงบ');
    assert.ok(logText(dir).includes('เก่าเกิน 3 วัน'));
  });

  // คำตอบจากแหล่งเรตแบบกำหนดเวลาอัปเดตเองได้ (fake ปกติไม่ส่ง time_last_update_unix)
  const fxReply = (rates, updatedMs = Date.now()) => (m, p) => (p === 'fx'
    ? { result: 'success', base_code: 'THB', time_last_update_unix: Math.floor(updatedMs / 1000), rates } : null);
  const t13h = () => Date.now() - 13 * 3600e3;   // เกินรอบดึงใหม่ 12 ชม. แต่ยังไม่เก่าเกิน 3 วัน

  test('เรตสกุลที่ใช้กระโดดผิดปกติจากรอบก่อน ต้องพักการแปลงพร้อมเตือน ไม่เอาไปตั้งงบ', async (t) => {
    const world = freshWorld({ accounts: [acctIn('USD')], fx: { THB: 1, USD: 0.05 } });   // 0.03 → 0.05 = +66%
    const { base, dir } = await boot(t, { world });
    writeFx(dir, { ts: t13h(), updated: t13h(), rates: { THB: 1, USD: 0.03 } });
    await runTwice(base);
    assert.ok(world.calls.some((c) => c.path === 'fx'), 'ต้องลองดึงชุดใหม่');
    assert.strictEqual(madeBudget(world), undefined, 'เรตกระโดด 66% ห้ามใช้ตั้งงบ');
    assert.ok(logText(dir).includes('เปลี่ยนผิดปกติ'));
  });

  test('ตรวจกระโดดรายสกุล: VND เพี้ยน 100 เท่าโดย USD เท่าเดิม ต้องโดนจับ และบัญชี USD ยังเดินต่อได้', async (t) => {
    // เดิมเทียบแค่ USD — VND 768 → 76800 หลุดผ่าน ส่งงบ 255,974,400 ดอง (เกิน 100 เท่า) โดยไม่มีคนยืนยัน
    const world = freshWorld({ accounts: [acctIn('VND', '111'), acctIn('USD', '222')], fx: { THB: 1, USD: 0.03, VND: 76800 } });
    const { base, dir } = await boot(t, { world });
    writeFx(dir, { ts: t13h(), updated: t13h(), rates: { THB: 1, USD: 0.03, VND: 768 } });
    await runTwice(base);
    assert.strictEqual(madeBudget(world, '111'), undefined, 'VND เพี้ยนต้องไม่ถูกใช้');
    assert.strictEqual(madeBudget(world, '222'), '9999', 'สกุลที่ปกติต้องไม่โดนลากหยุดไปด้วย');
  });

  test('กระโดดจริงแล้วผู้ให้บริการอัปเดตรอบถัดไป ต้องปลดเอง (ไม่ล็อกถาวร)', async (t) => {
    const world = freshWorld({ accounts: [acctIn('USD')], route: fxReply({ THB: 1, USD: 0.05 }) });
    const { base, dir } = await boot(t, { world });
    // ชุดปัจจุบันคือชุดที่กระโดดแล้ว (0.03 → 0.05) • รอบนี้ผู้ให้บริการอัปเดตใหม่ยังเป็น 0.05 = ค่าจริง
    writeFx(dir, { ts: t13h(), updated: Date.now() - 864e5, rates: { THB: 1, USD: 0.05 }, prev: { THB: 1, USD: 0.03 }, prevUpdated: Date.now() - 2 * 864e5 });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '16665', '3,333 × 0.05 = 166.65 ดอลลาร์');
  });

  test('แหล่งเรตล่มนานจนแคชเก่า แล้วกลับมาพร้อมค่าที่ขยับจริงเกิน 20% ต้องรับได้ทันที (ไม่ล็อกตัวเอง)', async (t) => {
    // เดิมเทียบกับแคชอายุ 10 วัน → ปฏิเสธเรตจริงทุกรอบ ไฟล์อยู่ข้าม redeploy = ล็อกถาวร
    const world = freshWorld({ accounts: [acctIn('USD')], route: fxReply({ THB: 1, USD: 0.0275 }) });
    const { base, dir } = await boot(t, { world });
    const d10 = Date.now() - 10 * 864e5;
    writeFx(dir, { ts: d10, updated: d10, rates: { THB: 1, USD: 0.0334 } });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '9166', '3,333 × 0.0275 = 91.66 ดอลลาร์');
  });

  test('เรตชุดแรก (ยังไม่มีแคม) ที่ผิดสเกลทั้งชุด ต้องโดนกรอบ 10–100 บาท/ดอลลาร์', async (t) => {
    const world = freshWorld({ accounts: [acctIn('USD')], fx: { THB: 1, USD: 0.3 } });
    const { base, dir } = await boot(t, { world });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), undefined);
    assert.ok(logText(dir).includes('USD ผิดปกติ'));
  });

  test('แหล่งเรตส่งข้อมูลเก่ากว่าแคมที่มี ต้องไม่ทับ และแคชไม่มีเวลา (ไฟล์เสีย) ต้องถูกทิ้ง', async (t) => {
    const world = freshWorld({ accounts: [acctIn('USD')], route: fxReply({ THB: 1, USD: 0.02 }, Date.now() - 5 * 864e5) });
    const { base, dir } = await boot(t, { world });
    writeFx(dir, { ts: t13h(), updated: t13h(), rates: { THB: 1, USD: 0.03 } });
    await runTwice(base);
    assert.strictEqual(madeBudget(world), '9999', 'ต้องใช้ชุดที่ใหม่กว่า (0.03) ไม่ใช่ 0.02 ที่เก่ากว่า');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'fx-rates.json'), 'utf8'));
    assert.strictEqual(saved.rates.USD, 0.03);

    const w2 = freshWorld({ accounts: [acctIn('USD')], fx: { THB: 1, USD: 0.03 } });
    const b2 = await boot(t, { world: w2 });
    writeFx(b2.dir, { rates: { THB: 1, USD: 0.05 } });   // ไม่มี ts — เดิมใช้ตลอดไปไม่ดึงใหม่
    await runTwice(b2.base);
    assert.ok(w2.calls.some((c) => c.path === 'fx'), 'ต้องดึงใหม่');
    assert.strictEqual(madeBudget(w2), '9999');
  });

  test('ขยายงบบัญชี USD: เพดานที่มีเศษต้องปัดลงเป็นเซนต์ ถึงเพดานแล้วต้องไม่ยิงงบเดิมซ้ำทุกวัน', async (t) => {
    // เพดาน 3,000 บาท × 0.0304677 = 91.4031 ดอลลาร์ → 9140 เซนต์ • งบตอนนี้ 9140 = ถึงเพดานแล้ว
    // เดิมเทียบ 91.4 < 91.4031 → "ยังไม่ถึง" → POST 9140 ซ้ำ + แจ้ง "ขยายงบ 91.4 → 91.4 USD" ทุกวัน
    const world = freshWorld({
      accounts: [acctIn('USD')], fx: { THB: 1, USD: 0.0304677 },
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot เดิม', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '9140' }],
      insights: [{ acct: ACCT, campaign_id: 'C1', spend: '20', actions: [{ action_type: 'omni_purchase', value: '30' }] }],
    });
    const config = baseConfig({ autopilot: { enabled: true, minAds: 0, scaleMaxBudget: 3000 } });
    const { base, dir } = await boot(t, { world, config, env: { ANTHROPIC_API_KEY: '' } });
    fs.writeFileSync(path.join(dir, 'autopilot-state.json'),
      JSON.stringify({ baselined: { [ACCT]: Date.now() }, owned: ['C1'], campaign: { [ACCT]: 'C1' } }));
    await post(base, '/api/autopilot/run');
    assert.ok(!world.calls.some((c) => c.method === 'POST' && c.path === 'C1'), 'ถึงเพดานแล้วต้องไม่แตะงบ');
    assert.ok(!logText(dir).includes('ขยายงบ'), 'ต้องไม่แจ้งว่าขยายงบ');
  });

  test('ดึงเรตไม่ได้: ตัวปิดแอดขาดทุนต้องเตือน ไม่ใช่หยุดเงียบ (แอดขาดทุนจะเผาเงินต่อโดยไม่มีใครรู้)', async (t) => {
    const config = baseConfig({ autopilot: { enabled: true, minAds: 0 } });
    config.launchDefaults.ruleOn = true;
    const { base, dir } = await boot(t, { world: freshWorld({ fxDown: true, accounts: [acctIn('USD')] }), config });
    await runTwice(base);
    assert.ok(logText(dir).includes('ไม่ปิดแอดขาดทุน'), 'ต้องบอกว่าระหว่างนี้ระบบไม่ปิดแอดขาดทุนให้');
  });

  test('บัญชี USD ใช้งบวันนี้ครบ ข้อความต้องติดป้าย USD ไม่ใช่ "บาท"', async (t) => {
    const world = freshWorld({
      accounts: [acctIn('USD')],
      campaigns: [{ id: 'C_EXIST', acct: ACCT, name: 'Autopilot 2026-10-01', status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '10000' }],
      insights: [{ acct: ACCT, spend: '99' }],
    });
    const { base, dir } = await boot(t, { world });
    await runTwice(base);
    const line = ((readState(dir) || {}).log || []).map((l) => l.msg).find((m) => m.includes('ใช้งบวันนี้ครบแล้ว'));
    assert.ok(line, 'ต้องมีข้อความงบเต็ม');
    assert.ok(line.includes('99/100 USD') && !line.includes('บาท'), line);
  });

  test('ขึ้นแอดเอง 2 แอด = 2 แคมเปญ งบแคมเปญละเต็ม และกฎหยุดอัตโนมัติกฎเดียวครอบทั้งสองแคมเปญ', async (t) => {
    const { base, world } = await boot(t, { world: freshWorld({ accounts: [acctIn('USD')] }) });
    const ad = (n) => ({ mediaId: 'v1', name: `Ad-${n}`, message: 'ทดสอบ', link: 'https://example.com/', ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [] });
    const out = await (await fetch(base + '/api/launch', { method: 'POST', body: launchForm({ autoRule: { cpr: 100, minSpend: 150 }, ads: [ad(1), ad(2)] }) })).text();
    const camps = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(camps.length, 2);
    assert.ok(camps.every((c) => c.params.daily_budget === '900'), '300 บาท = 9 ดอลลาร์ ต่อแคมเปญ');
    assert.deepStrictEqual(camps.map((c) => c.params.name).sort(), ['เทสขึ้นแอด - Ad-1', 'เทสขึ้นแอด - Ad-2']);
    const rules = world.calls.filter((c) => c.method === 'POST' && /adrules_library$/.test(c.path));
    assert.strictEqual(rules.length, 1);
    const ids = JSON.parse(rules[0].params.evaluation_spec).filters.find((f) => f.field === 'campaign.id').value;
    assert.strictEqual(ids.length, 2);
    const done = out.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'done');
    assert.strictEqual(done.campaignIds.length, 2);
  });

  test('ขึ้นแอดเอง: แอดตัวไหนพังหลังสร้างแคมเปญ ต้องลบแคมเปญของตัวนั้นทิ้ง', async (t) => {
    const world = freshWorld({
      route: (m, p) => (m === 'POST' && p === `act_${ACCT}/ads` ? { error: 'จำลองสร้างแอดไม่ผ่าน' } : null),
    });
    const { base } = await boot(t, { world });
    await (await fetch(base + '/api/launch', { method: 'POST', body: launchForm() })).text();
    assert.strictEqual(world.campaigns.length, 1);
    assert.strictEqual(world.campaigns[0].status, 'DELETED');
  });

  test('ขึ้นแอดเองตอนอ่านสกุลเงินจาก FB ไม่ได้ ต้องใช้สกุลจากรายชื่อบัญชีที่หน้าเว็บส่งมา (บัญชีบาทไม่ควรติด)', async (t) => {
    const world = freshWorld({
      route: (m, p, params) => (m === 'GET' && p === `act_${ACCT}` && params.fields === 'currency' ? { error: 'ล่มชั่วคราว' } : null),
    });
    const { base } = await boot(t, { world });
    const out = await (await fetch(base + '/api/launch', { method: 'POST', body: launchForm({ currency: 'THB' }) })).text();
    assert.strictEqual(madeBudget(world), '30000', '300 บาท = 30,000 สตางค์');
    assert.ok(out.includes('ใช้ THB จากรายชื่อบัญชีแทน'));
    // ไม่มีสกุลจากหน้าเว็บ = ไม่รู้จริงๆ ต้องไม่เดา
    const out2 = await (await fetch(base + '/api/launch', { method: 'POST', body: launchForm({ campaign: { name: 'อีกอัน', objective: 'OUTCOME_SALES' } }) })).text();
    assert.ok(out2.includes('"fatal"') && out2.includes('สกุลเงิน'));
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

  // หน้าขึ้นแอดเอง: ช่อง "ผู้ลงโฆษณา" ไม่บังคับ — ไม่มีให้เลือก/ไม่เลือก ต้องขึ้นแอดต่อได้
  const launchWith = async (base, beneficiaryId) => {
    const form = new FormData();
    form.append('data', JSON.stringify({
      profileId: 'p1', accountId: ACCT, pageId: 'page1', beneficiaryId,
      campaign: { name: 'เทสผู้ลงโฆษณา', objective: 'OUTCOME_SALES' },
      campaignBudget: 300, cta: 'LEARN_MORE', pixelId: 'px1', conversionEvent: 'SUBSCRIBE', active: false,
      ads: [{ mediaId: 'v1', name: 'Ad-1', message: 'ทดสอบ', link: 'https://example.com/', ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [] }],
    }));
    return (await fetch(base + '/api/launch', { method: 'POST', body: form })).text();
  };
  const adsetCalls = (world) => world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`);
  const adCreated = (world) => world.calls.some((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);

  test('ขึ้นแอดเองโดยไม่เลือกผู้ลงโฆษณา ต้องข้ามฟิลด์นี้แล้วขึ้นแอดได้ตามปกติ', async (t) => {
    const { base, world } = await boot(t);
    await launchWith(base, '');
    const [as] = adsetCalls(world);
    assert.ok(as, 'ต้องสร้างชุดโฆษณา');
    assert.ok(!('regional_regulation_identities' in as.params), 'ไม่เลือก = ไม่ส่งฟิลด์');
    assert.ok(adCreated(world), 'ต้องสร้างแอดต่อได้');
  });

  test('ขึ้นแอดเองแล้วเลือกผู้ลงโฆษณา ต้องส่งไปกับชุดโฆษณา', async (t) => {
    const { base, world } = await boot(t);
    await launchWith(base, '999888');
    const rri = JSON.parse(adsetCalls(world)[0].params.regional_regulation_identities || '{}');
    assert.strictEqual(rri.universal_beneficiary, '999888');
    assert.strictEqual(rri.universal_payer, '999888');
  });

  test('FB ไม่รับผู้ลงโฆษณาที่เลือก ต้องเตือนแล้วขึ้นต่อโดยไม่ระบุ ไม่ล้มทั้งแอด', async (t) => {
    const world = freshWorld({
      route: (m, path, params) => (m === 'POST' && path === `act_${ACCT}/adsets` && params.regional_regulation_identities
        ? { error: 'Invalid parameter: regional_regulation_identities' } : null),
    });
    const { base } = await boot(t, { world });
    const out = await launchWith(base, '999888');
    const calls = adsetCalls(world);
    assert.strictEqual(calls.length, 2, 'ครั้งแรกโดนปฏิเสธ ครั้งที่สองต้องลองใหม่โดยไม่มีฟิลด์นี้');
    assert.ok(!('regional_regulation_identities' in calls[1].params));
    assert.ok(out.includes('ขึ้นต่อโดยไม่ระบุ'), 'ต้องบอกผู้ใช้ในสตรีม');
    assert.ok(adCreated(world), 'ต้องสร้างแอดต่อได้');
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

// ---------- ขึ้นแอดเอง (/api/launch): พิกเซลต้องถูกฝังบนหน้า Landing ก่อนขึ้น ----------
describe('ขึ้นแอดเองแล้วลิงก์ชี้มาหน้า Landing', () => {
  const launch = async (base, link, pixelId) => {
    const form = new FormData();
    form.append('data', JSON.stringify({
      profileId: 'p1', accountId: ACCT, pageId: 'page1',
      campaign: { name: 'เทสฝังพิกเซล', objective: 'OUTCOME_SALES' },
      campaignBudget: 300, cta: 'LEARN_MORE', pixelId, conversionEvent: 'SUBSCRIBE', active: false,
      ads: [{ mediaId: 'v1', name: 'Ad-1', message: 'ทดสอบ', link, ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [] }],
    }));
    const r = await fetch(base + '/api/launch', { method: 'POST', body: form });
    return r.text();   // สตรีม ndjson — อ่านจนจบถือว่ารอบขึ้นแอดเสร็จ
  };

  test('พิกเซลยังไม่อยู่บนหน้า ต้องฝังให้เองก่อนขึ้น', async (t) => {
    const world = freshWorld({ pixels: [{ id: 'px777' }] });
    const { base } = await boot(t, { world });
    const out = await launch(base, base + '/lp', 'px777');
    const lp = await get(base, '/api/landing');
    assert.ok(lp.pixels.some((p) => p.id === 'px777'),
      'ลิงก์ชี้มาหน้า /lp ของเรา = ต้องฝัง Pixel ให้เอง ไม่งั้นคอนเวอร์ชั่นเป็นศูนย์ตลอด');
    assert.ok(out.includes('ฝัง Pixel'), 'ต้องบอกผู้ใช้ในสตรีมด้วยว่าฝังให้แล้ว');
  });

  test('พิกเซลอยู่บนหน้าแล้ว ต้องไม่เพิ่มซ้ำ', async (t) => {
    const { base, dir } = await boot(t);
    const fs2 = require('node:fs'), path2 = require('node:path');
    fs2.writeFileSync(path2.join(dir, 'landing.json'), JSON.stringify({ pixels: [{ type: 'meta', id: 'px1' }], links: [] }));
    await launch(base, base + '/lp', 'px1');
    const lp = await get(base, '/api/landing');
    assert.strictEqual(lp.pixels.filter((p) => p.id === 'px1').length, 1, 'มีอยู่แล้วต้องไม่ซ้ำ');
  });

  test('ลิงก์ไปเว็บอื่น ต้องไม่แตะหน้า Landing', async (t) => {
    const { base } = await boot(t);
    await launch(base, 'https://example.com/', 'px1');
    const lp = await get(base, '/api/landing');
    assert.ok(!(lp.pixels || []).some((p) => p.id === 'px1'), 'ลิงก์ไม่ได้ชี้มาหน้าเรา ห้ามฝังพิกเซลมั่ว');
  });
});

// ---------- สวิตช์ "เชื่อมพิกเซลกับหน้า Landing ให้อัตโนมัติ" ----------
// ปิดไว้ = ผู้ใช้ไปเชื่อมพิกเซลเองที่ปลายทางอื่น (เช่น heylink) ระบบต้องไม่ไปยุ่งกับหน้า /lp
// แต่ต้องยังสร้าง Pixel ให้บัญชีที่ยังไม่มี ไม่งั้นแคมเปญ Sales/Leads ขึ้นไม่ได้เลย
describe('สวิตช์เชื่อมพิกเซลอัตโนมัติ', () => {
  const noAutoLink = () => baseConfig({ autopilot: { enabled: true, minAds: 2, autoLinkPixel: false } });

  test('ค่าตั้งต้นคือเปิด และเซฟ/อ่านกลับได้', async (t) => {
    const { base } = await boot(t);
    assert.strictEqual((await get(base, '/api/autopilot')).autoLinkPixel, true,
      'ไม่ได้ตั้งอะไร = ต้องเป็นพฤติกรรมเดิม (เชื่อมให้อัตโนมัติ)');
    await post(base, '/api/autopilot', { enabled: true, autoLinkPixel: false });
    assert.strictEqual((await get(base, '/api/autopilot')).autoLinkPixel, false);
    await post(base, '/api/autopilot', { enabled: true, autoLinkPixel: true });
    assert.strictEqual((await get(base, '/api/autopilot')).autoLinkPixel, true);
  });

  test('ปิดไว้ autopilot ต้องไม่ฝังพิกเซลลงหน้า Landing แม้ลิงก์จะชี้มาหน้าเรา', async (t) => {
    const world = freshWorld({ pixels: [{ id: '5566778899' }] });
    const cfg = noAutoLink();
    const { base } = await boot(t, { world, config: cfg });
    await post(base, '/api/launch-defaults', { ...cfg.launchDefaults, link: base + '/lp' });
    await runTwice(base);
    const lp = await get(base, '/api/landing');
    assert.ok(!(lp.pixels || []).some((p) => p.id === '5566778899'),
      'ผู้ใช้บอกว่าจะไปเชื่อมเอง ระบบต้องไม่ฝังให้');
  });

  test('ปิดไว้แต่ลิงก์ดันชี้กลับมาหน้า /lp ต้องเตือน ไม่ใช่เงียบแล้วปล่อยคอนเวอร์ชั่นเป็นศูนย์', async (t) => {
    const world = freshWorld({ pixels: [{ id: '5566778899' }] });
    const cfg = noAutoLink();
    const { base, dir } = await boot(t, { world, config: cfg });
    await post(base, '/api/launch-defaults', { ...cfg.launchDefaults, link: base + '/lp' });
    await runTwice(base);
    const log = (readState(dir).log || []).map((x) => x.msg || '').join('\n');
    assert.match(log, /ยังไม่อยู่บนหน้า/, 'เงียบไว้ = ตัวขยายงบกับตัวปิดแอดขาดทุนจะตัดสินจากตัวเลขที่ผิด');
  });

  test('ปิดไว้แล้วลิงก์ไปเว็บอื่น (heylink) ต้องไม่เตือนซ้ำ — นั่นคือเหตุผลที่ปิด', async (t) => {
    const { base, dir } = await boot(t, { config: noAutoLink() });   // baseConfig ใช้ link เป็น example.com
    await runTwice(base);
    const log = (readState(dir).log || []).map((x) => x.msg || '').join('\n');
    assert.ok(!/ต้องไปฝัง Pixel/.test(log), 'ผู้ใช้บอกแล้วว่าไปเชื่อมเอง ไม่ต้องทวงทุกวัน');
  });

  test('ปิดไว้ก็ยังต้องสร้าง Pixel ให้บัญชีที่ยังไม่มี และเติมแอดต่อได้', async (t) => {
    const world = freshWorld({ pixels: [] });
    const { base } = await boot(t, { world, config: noAutoLink() });
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adspixels`);
    assert.strictEqual(made.length, 1, 'สวิตช์นี้คุมแค่เรื่องหน้า Landing ไม่ได้คุมการสร้าง Pixel');
    const ads = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);
    assert.ok(ads.length > 0, 'ต้องเติมแอดต่อได้ตามปกติ');
  });

  test('ปิดไว้แล้วขึ้นแอดเอง ก็ต้องไม่ฝังพิกเซลลงหน้า Landing', async (t) => {
    const world = freshWorld({ pixels: [{ id: 'px777' }] });
    const { base } = await boot(t, { world, config: noAutoLink() });
    const form = new FormData();
    form.append('data', JSON.stringify({
      profileId: 'p1', accountId: ACCT, pageId: 'page1',
      campaign: { name: 'เทสปิดการเชื่อม', objective: 'OUTCOME_SALES' },
      campaignBudget: 300, cta: 'LEARN_MORE', pixelId: 'px777', conversionEvent: 'SUBSCRIBE', active: false,
      ads: [{ mediaId: 'v1', name: 'Ad-1', message: 'ทดสอบ', link: base + '/lp', ageMin: 20, ageMax: 65, gender: '', countries: ['TH'], interests: [] }],
    }));
    await (await fetch(base + '/api/launch', { method: 'POST', body: form })).text();
    const lp = await get(base, '/api/landing');
    assert.ok(!(lp.pixels || []).some((p) => p.id === 'px777'), 'สวิตช์ต้องคุมเส้นขึ้นแอดเองด้วย ไม่ใช่เฉพาะ autopilot');
  });
});

// ---------- สับคลิปเมื่อ AI ชี้ว่าปัญหาอยู่ที่ตัววิดีโอ ----------
// เกราะที่ต้องไม่หลุด: ตั้งต้น 1 = พฤติกรรมเดิมเป๊ะ (ไม่สับคลิปเลย), ติด noRotate ห้ามขึ้นใหม่,
// ครบเพดานต้องตายถาวร — ทั้งหมดนี้คือสิ่งที่กันไม่ให้ระบบกลายเป็นตัวยิงซ้ำจนหลุดรีวิว
describe('สับคลิปหลังโดนปฏิเสธ', () => {
  const { makeFakeAi } = require('./fake-tg');
  const rejectedAd = (id) => ({
    id, acct: ACCT, name: `แอด ${id}`, effective_status: 'DISAPPROVED', adset_id: 'S1',
    issues_info: [],
    ad_review_feedback: { global: { 'คุณภาพวิดีโอ': 'ภาพในวิดีโอไม่เป็นไปตามนโยบาย' } },
    creative: { id: 'cr1', object_story_spec: { video_data: { video_id: 'vidOld', message: 'ข้อความเดิม', title: 'หัวข้อ' } } },
  });

  // AI ตอบว่าปัญหาอยู่ที่ตัววิดีโอ ไม่ใช่ข้อความ
  const bootWithAi = async (t, limits) => {
    const ai = await makeFakeAi({ fixable: true, where: 'video', violation: 'ภาพในคลิปผิดนโยบาย' });
    t.after(() => ai.server.close());
    const world = freshWorld({
      campaigns: [{ id: 'C1', acct: ACCT, name: 'Autopilot เดิม', status: 'ACTIVE', daily_budget: '333300' }],
    });
    const cfg = baseConfig({
      anthropicKey: 'sk-test',
      autopilot: { enabled: true, minAds: 0, limits },   // minAds 0 = ไม่เติมแอด จะได้เหลือแต่เส้นสับคลิป
    });
    const boots = await boot(t, { world, config: cfg, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}` } });
    return { ...boots, world, ai };
  };
  const newAds = (world) => world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);

  test('ค่าตั้งต้น (1 ครั้ง) ต้องไม่สับคลิปให้ — พฤติกรรมเดิมต้องไม่เปลี่ยนเงียบๆ', async (t) => {
    const { base, world, dir, ai } = await bootWithAi(t, {});
    await post(base, '/api/autopilot/run');
    world.ads.push(rejectedAd('A1'));
    await post(base, '/api/autopilot/run');
    assert.ok(ai.state.requests.length > 0, 'ต้องเดินถึงขั้นวินิจฉัยจริง ไม่ใช่หลุดออกก่อนแล้วเทสผ่านฟรี');
    assert.strictEqual(newAds(world).length, 0, 'ตั้งต้นต้องไม่ขึ้นแอดใหม่จากการสับคลิป');
    assert.strictEqual(Object.keys(readState(dir).relaunch || {}).length, 0);
  });

  test('ตั้งเป็น 2 แล้วต้องสับคลิปขึ้นใหม่ในชุดโฆษณาเดิม พร้อมจดสายพันธุ์ไว้', async (t) => {
    const { base, world, dir } = await bootWithAi(t, { maxRelaunchPerAd: 2 });
    await post(base, '/api/autopilot/run');
    // บอก state ว่าแอดตัวนี้ใช้คลิป v1 อยู่ — จะได้ยืนยันได้ว่าตัวที่สับมาไม่ใช่ตัวเดิม
    const fs2 = require('node:fs'), path2 = require('node:path');
    const p = path2.join(dir, 'autopilot-state.json');
    const st0 = JSON.parse(fs2.readFileSync(p, 'utf8'));
    st0.creative = { A1: { v: 'v1', c: 'c:x', ts: Date.now() } };
    fs2.writeFileSync(p, JSON.stringify(st0));
    world.ads.push(rejectedAd('A1'));
    await post(base, '/api/autopilot/run');

    const made = newAds(world);
    assert.strictEqual(made.length, 1, 'ต้องขึ้นแอดใหม่ 1 ตัว');
    assert.strictEqual(made[0].params.adset_id, 'S1', 'ต้องใช้ชุดโฆษณาเดิม ไม่สร้างใหม่');
    assert.strictEqual(world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`).length, 0);

    const st = readState(dir);
    const newId = Object.keys(st.relaunch)[0];
    assert.ok(newId, 'ต้องจดว่าแอดใหม่เป็นรุ่นที่เท่าไหร่');
    assert.strictEqual(st.relaunch[newId].v, 1, 'แอดใหม่ต้องเป็นรุ่นที่ 1');
    assert.ok(st.creative[newId] && st.creative[newId].v, 'ต้องจดว่าแอดใหม่ใช้คลิปไหน ไม่งั้นรอบให้คะแนนจะไม่นับผลคลิปที่สับมา');
    assert.notStrictEqual(st.creative[newId].v, 'v1', 'ต้องสับไปคลิปอื่น ไม่ใช่ยิงคลิปเดิมที่เพิ่งโดนปฏิเสธซ้ำ');
    assert.match((st.log || []).map((x) => x.msg).join('\n'), /สับเป็นคลิป/);
  });

  test('บัญชีติดเหตุผลเดิมซ้ำ (noRotate) แล้วห้ามสับคลิปขึ้นใหม่', async (t) => {
    const { base, world, dir } = await bootWithAi(t, { maxRelaunchPerAd: 3, sameReasonStop: 1 });
    await post(base, '/api/autopilot/run');
    world.ads.push(rejectedAd('A1'), rejectedAd('A2'));
    await post(base, '/api/autopilot/run');
    assert.ok(readState(dir).noRotate[ACCT], 'หมวดเดิมซ้ำถึงเพดานต้องหยุดบัญชีก่อน');
    assert.strictEqual(newAds(world).length, 0, 'ติดหมวดเดิมแล้ว = ปัญหาไม่ได้อยู่ที่ครีเอทีฟ สับคลิปต่อไม่ได้');
  });

  test('state รุ่นเก่าที่มีแต่ retryOf ต้องนับเป็นขึ้นใหม่แล้ว 1 ครั้ง ไม่ใช่ได้สิทธิ์คืน', async (t) => {
    const { base, world, dir } = await bootWithAi(t, { maxRelaunchPerAd: 1 });
    await post(base, '/api/autopilot/run');
    const fs2 = require('node:fs'), path2 = require('node:path');
    const p = path2.join(dir, 'autopilot-state.json');
    const st0 = JSON.parse(fs2.readFileSync(p, 'utf8'));
    st0.retryOf = { A1: { v: 'A0', ts: Date.now() } };   // เคยถูกแก้มาแล้วตามกติกาเดิม
    delete st0.relaunch;
    fs2.writeFileSync(p, JSON.stringify(st0));
    world.ads.push(rejectedAd('A1'));
    await post(base, '/api/autopilot/run');
    assert.strictEqual(newAds(world).length, 0, 'แอดที่ตายถาวรตามกติกาเดิม ต้องไม่ฟื้นตอนอัปเดต');
    assert.match((readState(dir).log || []).map((x) => x.msg).join('\n'), /หยุดถาวร/);
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
    assert.strictEqual(made.length, 2, 'โควตาปกติ รอบเต็มต้องเดินงานตามเดิม (minAds 2 = แอดละแคมเปญ 2 แคมเปญ)');
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

  test('cursor เพจต้องเก็บแยกต่อโปรไฟล์ (object) ไม่ใช่ตัวเลขรวม', async (t) => {
    const cfg = baseConfig({ autopilot: { enabled: true, minAds: 3 } });
    const { base, dir } = await boot(t, { world: pagesWorld(), config: cfg });
    await runTwice(base);
    const cur = readState(dir).pageCursor;
    assert.strictEqual(typeof cur, 'object', 'pageCursor ต้องเป็น object แยกต่อโปรไฟล์');
    assert.ok(cur.p1 > 0, 'โปรไฟล์ p1 ต้องมีตัวนับของตัวเอง');
  });

  test('migration: state เก่ามี pageCursor เป็นตัวเลข ต้องไม่ค้าง index เดิม/ไม่พัง', async (t) => {
    // ก่อนแก้ pageCursor เป็น number — ถ้าไม่รีเซ็ตเป็น object การเขียน cur[pid] จะเงียบหาย
    // แล้ว round-robin ค้างที่ index เดิมทุกแอด เทสนี้จับเคสนั้น (ต้องหมุนครบทั้ง A/B)
    const cfg = baseConfig({ autopilot: { enabled: true, minAds: 4 } });
    const { base, dir, world } = await boot(t, { world: pagesWorld(), config: cfg });
    const fs = require('node:fs'), path = require('node:path');
    const sp = path.join(dir, 'autopilot-state.json');
    // state เก่าต้องอยู่ก่อนรอบแรก — รอบแรกเติมแอดเลย (รอบ baseline ไม่ข้ามการเติมแอดแล้ว)
    fs.writeFileSync(sp, JSON.stringify({ pageCursor: 7 }));   // ค่าเดิมแบบเก่า (ตัวเลข)
    await post(base, '/api/autopilot/run');               // เติมจริง
    const ids = pageIdsOf(world);
    assert.ok(ids.length >= 2, 'ต้องยังสร้างแอดได้ ไม่พังเพราะ state เก่า: ได้ ' + ids.length);
    assert.deepStrictEqual([...new Set(ids)].sort(), ['PG_A', 'PG_B'], 'ต้องหมุนครบ A/B ไม่ค้าง index เดิม');
    assert.strictEqual(typeof readState(dir).pageCursor, 'object', 'pageCursor ต้องถูกอัปเป็น object');
  });

  test('/api/accounts ต้องไม่คืนเพจแตกให้ dropdown เลือก', async (t) => {
    const { base } = await boot(t, { world: pagesWorld() });
    const r = await get(base, '/api/accounts?profile=p1');
    const ids = (r.pages || []).map((p) => p.id);
    assert.deepStrictEqual(ids.sort(), ['PG_A', 'PG_B'], 'dropdown ต้องเห็นเฉพาะเพจที่ลงโฆษณาได้');
  });
});

// ---------- ปุ่มลูกตาหน้าสุขภาพ: ซ่อนบัญชี/เพจจากทุกหน้า จัดการที่เดียว ----------
describe('ซ่อนบัญชี/เพจจากหน้าสุขภาพ (ปุ่มลูกตา)', () => {
  test('ซ่อนบัญชี: หายจาก /api/accounts แต่หน้าสุขภาพยังเห็นพร้อมธง hidden และโชว์กลับได้', async (t) => {
    const { base } = await boot(t);
    let d = await get(base, '/api/accounts?profile=p1');
    assert.strictEqual(d.adAccounts.length, 1, 'ก่อนซ่อนต้องเห็นบัญชี');
    await post(base, '/api/hidden', { kind: 'account', id: ACCT, hidden: true });
    d = await get(base, '/api/accounts?profile=p1');
    assert.strictEqual(d.adAccounts.length, 0, 'บัญชีที่ซ่อนต้องหายจากแดชบอร์ด/แคมเปญ/ขึ้นแอด (ทุกหน้าที่ใช้เส้นนี้)');
    assert.strictEqual(d.hiddenAccounts, 1, 'ต้องบอกจำนวนที่ซ่อนไว้ — ให้หน้าอื่นแจ้งได้ว่าเงินไม่ได้หาย');
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.strictEqual(h.accounts.length, 1, 'หน้าสุขภาพเป็นตัวจัดการ ต้องเห็นครบทุกตัว');
    assert.strictEqual(h.accounts[0].hidden, true, 'ต้องมีธง hidden ให้ปุ่มตาแสดงสถานะถูก');
    await post(base, '/api/hidden', { kind: 'account', id: ACCT, hidden: false });
    d = await get(base, '/api/accounts?profile=p1');
    assert.strictEqual(d.adAccounts.length, 1, 'กดโชว์กลับ บัญชีต้องกลับมา');
  });

  test('ซ่อนเพจ: หายจาก dropdown (/api/accounts) แต่หน้าสุขภาพยังเห็น', async (t) => {
    const world = freshWorld({ pages: [{ id: '55501', name: 'เพจหลัก', is_published: true, promotion_eligible: true }] });
    const config = baseConfig();
    config.profiles[0].pageId = '55501';
    const { base } = await boot(t, { world, config });
    await post(base, '/api/hidden', { kind: 'page', id: '55501', hidden: true });
    const d = await get(base, '/api/accounts?profile=p1');
    assert.deepStrictEqual(d.pages, [], 'เพจที่ซ่อนต้องไม่โผล่ใน dropdown เลือกเพจ');
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.strictEqual(h.pages.length, 1, 'หน้าสุขภาพยังต้องเห็นเพจที่ซ่อน');
    assert.strictEqual(h.pages[0].hidden, true);
  });

  test('วงเงิน/วัน: ยังไม่เคยได้ตัวเลข = หน้าสุขภาพยังทำงานปกติ และไม่ยิงถาม FB เรื่องวงเงินเลย', async (t) => {
    const { base, world } = await boot(t);
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.strictEqual(h.limitsAt, null, 'ต้องบอกว่ายังไม่เคยอัปเดต');
    assert.strictEqual(h.accounts[0].dsl, undefined, 'ยังไม่มีข้อมูล = ต้องไม่มีตัวเลขมั่วๆ');
    assert.strictEqual(world.calls.filter((c) => c.params.ids).length, 0, 'เซิร์ฟเวอร์ต้องไม่ยิงถามวงเงินเอง');
  });

  test('วงเงิน/วัน: ส่วนขยายส่งตัวเลขมาแล้ว หน้าสุขภาพต้องโชว์ และเซิร์ฟเวอร์ต้องไม่ยิง FB เพิ่ม', async (t) => {
    const { base, world } = await boot(t);
    const r = await post(base, '/api/am-limits', {
      profile: 'p1',
      limits: [{ id: ACCT, dsl: 1688.29, threshold: '11500' }, { id: '999', dsl: -1, threshold: null }],
    });
    assert.strictEqual(r.saved, 2);
    const before = world.calls.length;
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.strictEqual(h.accounts[0].dsl, 1688.29);
    assert.strictEqual(h.accounts[0].threshold, 11500, 'ตัวเลขที่มาเป็นสตริงต้องถูกแปลงเป็นตัวเลข');
    assert.ok(h.limitsAt > 0, 'ต้องบอกเวลาที่อัปเดตล่าสุด');
    const askedLimits = world.calls.slice(before).filter((c) => c.params.fields && /adtrust_dsl/.test(c.params.fields));
    assert.strictEqual(askedLimits.length, 0, 'ห้ามเซิร์ฟเวอร์ยิงถาม adtrust_dsl เองเด็ดขาด');
  });

  test('วงเงิน/วัน: ข้อมูลเพี้ยนต้องกลายเป็น null ไม่ใช่ NaN ไปโผล่บนจอ', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/am-limits', { profile: 'p1', limits: [{ id: ACCT, dsl: 'ไม่ใช่ตัวเลข', threshold: '' }] });
    const h = await get(base, '/api/health-overview?profile=p1');
    assert.strictEqual(h.accounts[0].dsl, null);
    assert.strictEqual(h.accounts[0].threshold, null);
  });

  // เกราะหลักหลังเหตุการณ์ 26 ก.ค. 2026 — Meta สั่ง checkpoint ทั้งบัญชีเพราะเซิร์ฟเวอร์ถือ token ของเบราว์เซอร์
  test('วงเงิน/วัน: เซิร์ฟเวอร์ต้องเก็บ Ads Manager token ไม่ได้อีกเลย', async (t) => {
    const config = baseConfig();
    config.profiles[0].amToken = 'EAAtokenเก่าที่ค้างอยู่';
    const { base, dir } = await boot(t, { config });
    // เส้นที่เคยรับ token ต้องไม่มีอยู่แล้ว
    const res = await fetch(base + '/api/am-token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'p1', token: 'EAAใหม่' }),
    });
    assert.strictEqual(res.status, 404, 'เส้นรับ token ต้องถูกถอดออก');
    // token ที่ค้างอยู่ใน config เดิมต้องถูกล้างทิ้งเอง
    await get(base, '/api/profiles');
    const saved = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(saved.profiles[0].amToken, undefined, 'token เก่าที่ค้างต้องถูกล้างทิ้ง');
    const p = await get(base, '/api/profiles');
    assert.ok(!JSON.stringify(p).includes('EAAtoken'), 'ห้ามส่ง token ออกไปหน้าเว็บ');
  });

  test('ซ่อนบัญชี = autopilot ไม่แตะบัญชีนั้นเลย (ไม่สร้างแคมเปญ/ไม่เติมแอด)', async (t) => {
    const { base, world } = await boot(t);
    await post(base, '/api/hidden', { kind: 'account', id: ACCT, hidden: true });
    await runTwice(base);
    const made = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(made.length, 0, 'บัญชีที่ซ่อนต้องไม่ถูก autopilot เติมแอด/สร้างแคมเปญ');
    await post(base, '/api/hidden', { kind: 'account', id: ACCT, hidden: false });
    await runTwice(base);   // ตอนซ่อนอยู่บัญชีไม่เคยถูก baseline — ปลดแล้วรอบแรก baseline รอบสองเติมจริง
    const after = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/campaigns`);
    assert.strictEqual(after.length, 2, 'กดโชว์กลับแล้ว autopilot ต้องกลับมาดูแลต่อ (แอดละแคมเปญ)');
  });

  test('ซ่อนเพจ = autopilot ไม่เอาเพจนั้นขึ้นแอด (ตัดออกจากพูล round-robin)', async (t) => {
    const world = freshWorld({
      pages: [
        { id: '70001', name: 'เพจ A', is_published: true, promotion_eligible: true },
        { id: '70002', name: 'เพจ B', is_published: true, promotion_eligible: true },
      ],
    });
    const config = baseConfig();
    config.profiles[0].pageId = '70001';
    const { base } = await boot(t, { world, config });
    await post(base, '/api/hidden', { kind: 'page', id: '70001', hidden: true });
    await runTwice(base);
    const creatives = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adcreatives`);
    assert.ok(creatives.length > 0, 'ยังมีเพจ B ใช้ได้ — ต้องเติมแอดตามปกติ');
    for (const c of creatives) {
      assert.ok(!String(c.params.object_story_spec || '').includes('70001'),
        'เพจที่ซ่อนต้องไม่ถูกใช้ขึ้นแอด');
    }
  });
});

// ---------- ด่านตรวจบัตรก่อนเติมแอด: autopilot ต้องไม่เติมให้บัญชีที่ยังไม่ผูกบัตร ----------
describe('autopilot เช็คบัตรก่อนเติมแอด', () => {
  test('บัญชีไม่มีบัตรถูกข้าม บัญชีมีบัตรเติมตามปกติ', async (t) => {
    const world = freshWorld({
      accounts: [
        { name: 'ไม่มีบัตร', account_id: '901', account_status: 1, currency: 'THB', funding_source_details: null },
        { name: 'มีบัตร', account_id: '902', account_status: 1, currency: 'THB' },
      ],
    });
    const { base, world: w } = await boot(t, { world });
    await runTwice(base);
    const noCard = w.calls.filter((c) => c.method === 'POST' && c.path === 'act_901/campaigns');
    const withCard = w.calls.filter((c) => c.method === 'POST' && c.path === 'act_902/campaigns');
    assert.strictEqual(noCard.length, 0, 'บัญชีไม่มีบัตรต้องถูกข้าม — สร้างไปก็โดนปฏิเสธ เสีย API เปล่า');
    assert.strictEqual(withCard.length, 2, 'บัญชีมีบัตรต้องเติมตามปกติ ไม่โดนลากพัง (แอดละแคมเปญ)');
  });

  test('ผูกบัตรแล้ว รอบถัดไปต้องกลับมาเติมให้เอง', async (t) => {
    const world = freshWorld({
      accounts: [{ name: 'เพิ่งผูกบัตร', account_id: '903', account_status: 1, currency: 'THB', funding_source_details: null }],
    });
    const { base, world: w } = await boot(t, { world });
    await runTwice(base);
    assert.strictEqual(w.calls.filter((c) => c.method === 'POST' && c.path === 'act_903/campaigns').length, 0, 'ยังไม่มีบัตรต้องไม่เติม');
    w.accounts[0].funding_source_details = { id: 'f_new', display_string: 'VISA 1234' };   // ผู้ใช้ผูกบัตรแล้ว
    await runTwice(base);
    assert.strictEqual(w.calls.filter((c) => c.method === 'POST' && c.path === 'act_903/campaigns').length, 2,
      'ผูกบัตรแล้วระบบต้องกลับมาเติมเอง ไม่ต้องกดอะไรเพิ่ม');
  });
});

// ---------- เกราะ Meta block: persist cooldown, app-block backoff, เตือน Telegram ----------
describe('เกราะ Meta block API', () => {
  const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
  const coolFile = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'fb-cooldown.json'), 'utf8')); }
    catch { return null; }
  };
  // appBlocks ในไฟล์ key ด้วย hash ของ token (กันเก็บ token ดิบ) — เทสคำนวณแบบเดียวกับ server.js
  const sha16 = (tok) => require('node:crypto').createHash('sha256').update(tok).digest('hex').slice(0, 16);
  const blockOf = (dir, tok) => ((coolFile(dir) || {}).appBlocks || {})[sha16(tok)] || 0;

  test('fix1: โควตาแตะ 90% ต้องเซฟ cooldown ลงไฟล์ (รอด redeploy)', async (t) => {
    const world = freshWorld();
    world.headers = { 'x-app-usage': '{"call_count":95,"total_time":10,"total_cputime":10}' };
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const c = coolFile(dir);
    assert.ok(c, 'ต้องมีไฟล์ fb-cooldown.json');
    assert.ok(c.coolUntil > Date.now(), 'coolUntil ต้องเป็นเวลาในอนาคต — เก็บไว้ให้รอดรีสตาร์ท');
  });

  test('fix4: แอปโดนบล็อก (error 200) ต้องพัก autopilot รอบถัดไป + เซฟ appBlockUntil', async (t) => {
    const world = freshWorld();
    world.route = () => ({ error: 'API access blocked', errorCode: 200 });   // ทุก call โดนบล็อก
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');            // รอบแรก เจอ 200 → ตั้ง appBlock
    const before = world.calls.length;
    assert.ok(before > 0, 'รอบแรกต้องพยายามยิงก่อน');
    assert.ok(blockOf(dir, 'tok') > Date.now(), 'ต้องเซฟ appBlock ของ token นี้ไว้');
    await post(base, '/api/autopilot/run');            // รอบสอง ต้องพัก ไม่ยิงเลย
    assert.strictEqual(world.calls.length, before, 'แอปโดนบล็อก = รอบถัดไปต้องพัก ไม่ยิง FB ซ้ำเปล่าๆ');
    assert.strictEqual(readState(dir).warned.paused, true, 'ต้องตั้งธงพักไว้ (ใช้กันเตือนซ้ำ)');
  });

  test('fix1/4: recovery — หลังแอปหายบล็อก autopilot ต้องกลับมาทำงานและเคลียร์ธงพัก', async (t) => {
    const world = freshWorld();
    world.route = () => ({ error: 'API access blocked', errorCode: 200 });
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');            // ตั้ง appBlock
    await post(base, '/api/autopilot/run');            // พัก → ตั้งธง paused
    assert.strictEqual(readState(dir).warned.paused, true, 'ต้องอยู่โหมดพัก');
    world.route = null;                                 // แอปกลับมา
    await get(base, '/api/accounts?profile=p1');        // call สำเร็จ → ปลด appBlock
    assert.strictEqual(blockOf(dir, 'tok'), 0, 'appBlock ของ token นี้ต้องถูกปลด');
    await post(base, '/api/autopilot/run');            // ไม่พักแล้ว → resume branch เคลียร์ธง
    assert.strictEqual(readState(dir).warned.paused, false, 'กลับมาทำงานต้องเคลียร์ธงพัก (กัน spam)');
  });

  test('fix2: เพดานเวลาพัก — estimated_time ใหญ่ผิดปกติ ต้องถูก clamp ไม่พักค้างยาว', async (t) => {
    const world = freshWorld();
    // Meta บอกว่าให้รอ 100000 นาที (~69 วัน) — ต้องถูก clamp เหลือ ≤ 24 ชม.
    world.headers = { 'x-business-use-case-usage': '{"9":[{"type":"ads_management","call_count":10,"estimated_time_to_regain_access":100000}]}' };
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const c = coolFile(dir);
    assert.ok(c.coolUntil > Date.now(), 'ต้องพักจริง');
    assert.ok(c.coolUntil <= Date.now() + 24 * 3600 * 1000 + 60000, 'ต้องไม่พักเกิน 24 ชม. แม้ Meta บอกมาเยอะ');
  });

  test('fix2: เวลาที่ Meta บอกจริง (8 ชม.) ต้องเคารพเต็มๆ ไม่ตัดให้สั้นลง', async (t) => {
    const world = freshWorld();
    // Meta สั่งรอ 480 นาที — กลับมายิงก่อนเวลามีแต่ยืดโทษ ต้องพักครบ ไม่ใช่โดนเพดานตัด
    world.headers = { 'x-business-use-case-usage': '{"9":[{"type":"ads_management","call_count":10,"estimated_time_to_regain_access":480}]}' };
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const c = coolFile(dir);
    assert.ok(c.coolUntil >= Date.now() + 7.9 * 3600 * 1000, 'ต้องพักตามที่ Meta บอก (~8 ชม.) ไม่ใช่สั้นกว่า');
  });

  test('fix4: rate-limit ไม่ปลดตอนเรียกสำเร็จ (ต่างจาก app-block)', async (t) => {
    const world = freshWorld();
    world.headers = { 'x-app-usage': '{"call_count":95,"total_time":10,"total_cputime":10}' };
    const { base, dir } = await boot(t, { world });
    await get(base, '/api/accounts?profile=p1');        // สำเร็จ แต่ header บอกโควตาเกือบเต็ม
    const c = coolFile(dir);
    assert.ok(c.coolUntil > Date.now(), 'rate-limit cooldown ต้องยังอยู่ แม้ call จะสำเร็จ (ลิมิตเป็นแบบค่อยเป็นค่อยไป)');
  });

  test('บล็อกเป็นรายแอป: แอปโปรไฟล์หนึ่งโดนบล็อก call สำเร็จของอีกแอปต้องไม่ปลดให้', async (t) => {
    const world = freshWorld();
    // จำลองสถานะจริง: แอปเก่า (tokA) โดนบล็อก แอปใหม่ (tokB) ใช้งานได้
    world.route = (m, p, params) => (params.access_token === 'tokA' ? { error: 'API access blocked', errorCode: 200 } : null);
    const config = baseConfig();
    config.profiles = [
      { id: 'pA', label: 'แอปเก่า', accessToken: 'tokA', pageId: 'page1' },
      { id: 'pB', label: 'แอปใหม่', accessToken: 'tokB', pageId: 'page1' },
    ];
    const { base, dir } = await boot(t, { world, config });
    await post(base, '/api/autopilot/run');   // pA เจอ 200 → ติดบล็อก แล้ว pB สำเร็จตามหลัง
    assert.ok(blockOf(dir, 'tokA') > Date.now(), 'บล็อกของ tokA ต้องยังอยู่ แม้ tokB จะเรียกสำเร็จทีหลัง');
    assert.strictEqual(blockOf(dir, 'tokB'), 0, 'tokB ปกติ ต้องไม่ติดบล็อก');
    const callsA = world.calls.filter((c) => c.params.access_token === 'tokA').length;
    await post(base, '/api/autopilot/run');   // รอบสอง: pA ต้องถูกข้าม (ไม่ยิงซ้ำใส่แอปที่โดนบล็อก) pB ทำงานต่อ
    assert.strictEqual(world.calls.filter((c) => c.params.access_token === 'tokA').length, callsA,
      'ห้ามยิงใส่แอปที่ติดบล็อก — ยิงต่อมีแต่ยืดเวลาโดนแขวน');
    assert.ok(world.calls.filter((c) => c.params.access_token === 'tokB').length > 0, 'โปรไฟล์ที่แอปปกติต้องทำงานต่อ');
    assert.notStrictEqual((readState(dir).warned || {}).paused, true, 'บล็อกแค่บางโปรไฟล์ ≠ พักทั้งระบบ');
  });

  test('บล็อกยาว: หมดเวลาพักแล้วยิงยังพัง ต้องไม่ประกาศ "กลับมาแล้ว" — ประกาศเมื่อสำเร็จจริงเท่านั้น', async (t) => {
    // Telegram ปลอม — เก็บทุกข้อความที่ระบบส่ง ไว้พิสูจน์ว่าไม่มีข่าวดีปลอม
    const tgMsgs = [];
    const tg = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => {
        if (req.url.includes('sendMessage')) { try { tgMsgs.push(JSON.parse(b).text); } catch { /* ข้าม */ } }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: [] }));
      });
    });
    await new Promise((r) => tg.listen(0, '127.0.0.1', r));
    t.after(() => tg.close());

    const world = freshWorld();
    world.route = () => ({ error: 'API access blocked', errorCode: 200 });   // ยังบล็อกอยู่
    const fb = await makeFakeFb(world);
    const dir = tmpDir();
    seed(dir, { config: baseConfig({ telegram: { botToken: 'bt', chatId: 'c' } }), videos: 3, captions: 3 });
    // จำลอง "พักครบ 30 นาทีแล้ว": บล็อกหมดเวลา + ธง paused ติดอยู่จากรอบก่อน (เตือนพักไปแล้ว)
    fs.writeFileSync(path.join(dir, 'fb-cooldown.json'),
      JSON.stringify({ coolUntil: 0, appBlocks: { [sha16('tok')]: Date.now() - 1000 } }));
    fs.writeFileSync(path.join(dir, 'autopilot-state.json'), JSON.stringify({ warned: { paused: true } }));
    const srv = await startServer(dir, fb.port, { TG_API_BASE: `http://127.0.0.1:${tg.address().port}` });
    t.after(() => { srv.stop(); fb.server.close(); });

    await post(srv.base, '/api/autopilot/run');   // ลองใหม่ → ยังพัง → ต้องเงียบทั้งสองทาง
    assert.strictEqual(tgMsgs.filter((m) => m.includes('กลับมา')).length, 0, 'ห้ามประกาศกลับมาก่อนมี call สำเร็จจริง');
    assert.strictEqual(tgMsgs.filter((m) => m.includes('พักรอบตรวจ')).length, 0, 'เตือนพักไปแล้ว ห้ามเตือนซ้ำ');
    assert.strictEqual(readState(dir).warned.paused, true, 'ยังไม่ฟื้น ธงพักต้องคงอยู่');

    world.route = null;                            // แอปกลับมาจริง
    await get(srv.base, '/api/accounts?profile=p1');   // call สำเร็จ → ปลดบล็อก (เหมือน watchTick โพรบเจอ)
    await post(srv.base, '/api/autopilot/run');
    assert.strictEqual(tgMsgs.filter((m) => m.includes('กลับมา')).length, 1, 'กลับมาจริงค่อยประกาศ ครั้งเดียว');
    assert.strictEqual(readState(dir).warned.paused, false, 'ฟื้นแล้วต้องเคลียร์ธง');
  });

  test('โควตาแตะ 90%: พักเงียบ — ข้ามรอบแต่ไม่ตั้งธงเตือน และปุ่มตรวจต้องบอกตรงๆ ว่าพักอยู่', async (t) => {
    const world = freshWorld();
    world.headers = { 'x-app-usage': '{"call_count":95,"total_time":10,"total_cputime":10}' };
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');            // รอบแรกเห็น header 90% → ตั้ง soft cool
    const before = world.calls.length;
    const d = await post(base, '/api/autopilot/run');  // รอบสองต้องพัก
    assert.strictEqual(world.calls.length, before, 'ช่วง soft cool ต้องไม่ยิง FB');
    assert.strictEqual(d.paused, true, 'ปุ่มตรวจต้องได้คำตอบว่ารอบนี้ถูกพัก ไม่ใช่ ok เงียบๆ');
    assert.notStrictEqual((readState(dir).warned || {}).paused, true,
      'โควตาแตะ 90% เกิดได้ทั้งวันตอนยุ่ง — พักเงียบพอ ไม่ต้องปลุกคนทุกรอบ');
  });

  test('ฟื้นครึ่งๆ กลางรอบ: call สำเร็จแต่ header สั่งพักใหม่ทันที ต้องไม่ประกาศ "กลับมาแล้ว"', async (t) => {
    const tgMsgs = [];
    const tg = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => {
        if (req.url.includes('sendMessage')) { try { tgMsgs.push(JSON.parse(b).text); } catch { /* ข้าม */ } }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: [] }));
      });
    });
    await new Promise((r) => tg.listen(0, '127.0.0.1', r));
    t.after(() => tg.close());

    const world = freshWorld();
    // call "สำเร็จ" ทุกตัว แต่ header แนบคำสั่งพักจาก Meta มาด้วย — สถานการณ์ throttle ต่อเนื่องของจริง
    world.headers = { 'x-business-use-case-usage': '{"9":[{"type":"ads_management","call_count":10,"estimated_time_to_regain_access":5}]}' };
    const fb = await makeFakeFb(world);
    const dir = tmpDir();
    seed(dir, { config: baseConfig({ telegram: { botToken: 'bt', chatId: 'c' } }), videos: 3, captions: 3 });
    fs.writeFileSync(path.join(dir, 'autopilot-state.json'), JSON.stringify({ warned: { paused: true } }));
    const srv = await startServer(dir, fb.port, { TG_API_BASE: `http://127.0.0.1:${tg.address().port}` });
    t.after(() => { srv.stop(); fb.server.close(); });

    await post(srv.base, '/api/autopilot/run');   // call แรกสำเร็จ (fbOk) แต่โดนสั่งพักซ้ำกลางรอบ
    assert.strictEqual(tgMsgs.filter((m) => m.includes('กลับมา')).length, 0,
      'โดนสั่งพักใหม่ระหว่างรอบ = ยังไม่ฟื้นจริง ห้ามส่งข่าวดีปลอม');
    assert.strictEqual(readState(dir).warned.paused, true, 'ธงพักต้องคงอยู่จนกว่าจะฟื้นจริง');
  });

  test('อัปวิดีโอ (advideos) เจอแอปโดนบล็อก ต้องติดเบรกเหมือน call อื่น', async (t) => {
    const world = freshWorld();
    // จำลองแอปโดนบล็อก "กลางรอบ" พอดีตอนจะอัปวิดีโอ — จากนั้นทุก call พังหมด (เหมือนบล็อกจริง)
    let blocked = false;
    world.route = (m, p) => {
      if (m === 'POST' && /advideos$/.test(p)) blocked = true;
      return blocked ? { error: 'API access blocked', errorCode: 200 } : null;
    };
    const { base, dir } = await boot(t, { world });
    await runTwice(base);   // รอบสองคือรอบเติมแอด → ถึงจุดอัปวิดีโอ
    assert.ok(blockOf(dir, 'tok') > Date.now(),
      'advideos คือ call ที่หนักสุด — เจอ 200 ต้องตั้ง appBlock ไม่ใช่มองไม่เห็นเกราะ');
  });
});

// ---------- เลือกครีเอทีฟที่ "ขึ้นง่าย" ก่อน ----------
describe('สถิติครีเอทีฟจากผลรีวิวจริง', () => {
  test('แอดที่ระบบสร้างต้องถูกผูกกับคลิป+แคปชั่น แล้วให้คะแนนตามสถานะที่ FB ตอบกลับ', async (t) => {
    const { base, dir, world } = await boot(t, { videos: 3, captions: 3 });
    await runTwice(base);
    let s = readState(dir);
    const links = Object.entries(s.creative || {});
    assert.ok(links.length >= 2, `ต้องจดว่าแอดไหนใช้คลิป/แคปชั่นอะไร (ได้ ${links.length})`);
    for (const [, l] of links) { assert.ok(l.v, 'ต้องจดคลิป'); assert.match(String(l.c), /^c:/, 'แคปชั่นต้องจดเป็นคีย์ตามเนื้อหา ไม่ใช่ id'); }

    // แอดตัวแรกโดนปฏิเสธ ที่เหลือผ่าน — รอบตรวจถัดไปต้องแยกแยะได้
    const [badId, badLink] = links[0];
    world.ads.find((x) => x.id === badId).effective_status = 'DISAPPROVED';
    await post(base, '/api/autopilot/run');
    s = readState(dir);
    assert.strictEqual((s.libStats[`v:${badLink.v}`] || {}).bad, 1, 'คลิปของแอดที่โดนปฏิเสธต้องได้ bad');
    assert.strictEqual((s.libStats[badLink.c] || {}).bad, 1, 'แคปชั่นของแอดนั้นต้องได้ bad ด้วย');
    const okLink = links.find(([id]) => id !== badId)[1];
    assert.strictEqual((s.libStats[`v:${okLink.v}`] || {}).ok >= 1, true, 'คลิปที่ผ่านต้องได้ ok');
  });

  test('สถิติต้องรอดข้ามรอบ ไม่ถูกตัว merge ตอน save กลืนหาย', async (t) => {
    const { base, dir, world } = await boot(t, { videos: 3, captions: 3 });
    await runTwice(base);
    const first = Object.entries(readState(dir).creative || {})[0];
    world.ads.find((x) => x.id === first[0]).effective_status = 'DISAPPROVED';
    await post(base, '/api/autopilot/run');
    const after1 = readState(dir).libStats[`v:${first[1].v}`];
    await post(base, '/api/autopilot/run');
    const after2 = readState(dir).libStats[`v:${first[1].v}`];
    assert.deepStrictEqual(after2, after1, 'รอบถัดไปต้องไม่นับซ้ำและต้องไม่ทำของเดิมหาย');
    assert.strictEqual(after2.bad, 1);
  });

  test('โหมดทดสอบต้องไม่จดสถิติ — แอดถูกสร้างเป็น PAUSED ไม่เคยผ่านรีวิวจริง', async (t) => {
    const config = baseConfig();
    config.autopilot.testMode = true;
    const { base, dir } = await boot(t, { config, videos: 3, captions: 3 });
    await runTwice(base);
    const s = readState(dir);
    assert.deepStrictEqual(s.creative || {}, {}, 'แอดทดสอบต้องไม่ถูกผูกกับครีเอทีฟ');
    assert.deepStrictEqual(s.libStats || {}, {}, 'แอดทดสอบต้องไม่ทำให้คลิปไหนดูดีขึ้นลอยๆ');
  });
});

// ---------- ผลจากรีวิว adversarial 26 ก.ค. 2026 ----------
describe('การหมุนครีเอทีฟต้องไม่ติดหล่มอยู่กับตัวเดิม', () => {
  test('คลิปในคลังต้องได้ออกอากาศหลายตัว ไม่ใช่ตัวเดิมยึดทุกช่องตลอดไป', async (t) => {
    const world = freshWorld({
      accounts: [
        { name: 'บช 1', account_id: '111', account_status: 1, currency: 'THB' },
        { name: 'บช 2', account_id: '222', account_status: 1, currency: 'THB' },
      ],
    });
    const config = baseConfig();
    config.autopilot.minAds = 3;
    const { base, dir } = await boot(t, { world, config, videos: 6, captions: 4 });
    for (let i = 0; i < 4; i++) await post(base, '/api/autopilot/run');
    const s = readState(dir);
    const links = Object.values(s.creative || {});
    const vids = new Set(links.map((l) => l.v));
    assert.ok(links.length >= 6, `ต้องมีแอดถูกสร้างพอสมควร (ได้ ${links.length})`);
    assert.ok(vids.size >= 4, `คลัง 6 คลิปต้องได้ใช้อย่างน้อย 4 ตัว ไม่ใช่ยึดอยู่ไม่กี่ตัว (ได้ ${vids.size})`);
  });

  test('บัญชีต่างกันในรอบตรวจเดียวกันต้องไม่ได้คลิปชุดเดียวกันเป๊ะ', async (t) => {
    const world = freshWorld({
      accounts: [
        { name: 'บช 1', account_id: '111', account_status: 1, currency: 'THB' },
        { name: 'บช 2', account_id: '222', account_status: 1, currency: 'THB' },
      ],
    });
    const { base, dir, world: w } = await boot(t, { world, videos: 6, captions: 4 });
    await runTwice(base);
    const s = readState(dir);
    const byAcct = {};
    for (const [adId, l] of Object.entries(s.creative || {})) {
      const ad = w.ads.find((x) => x.id === adId);
      if (ad) (byAcct[ad.acct] = byAcct[ad.acct] || new Set()).add(l.v);
    }
    const sets = Object.values(byAcct);
    if (sets.length >= 2) {
      const [a, b] = sets;
      const same = [...a].filter((v) => b.has(v)).length;
      assert.ok(same < Math.min(a.size, b.size) || a.size === 0,
        `สองบัญชีในรอบเดียวกันได้คลิปซ้ำกันทั้งหมด (${same} ตัว) — taken ไม่ทำงาน`);
    }
  });
});

describe('สวิตช์หยุดฉุกเฉิน (รีวิว 12 ต.ค. 2026)', () => {
  test('ส่งมาแค่ killSwitch ต้องไม่ไปแตะค่าอื่น (เปิดระบบ/minAds/ฝังพิกเซล/เพดานขยายงบ)', async (t) => {
    // หน้าเว็บกดหยุดฉุกเฉินได้ก่อนโหลดค่าเสร็จ — เดิม endpoint ตั้ง enabled จาก body เสมอ
    // ส่งแค่ killSwitch = ปิดระบบอัตโนมัติไปด้วย ปลดหยุดแล้วระบบยังปิดอยู่เงียบๆ
    const config = baseConfig({ autopilot: { enabled: true, minAds: 3, autoLinkPixel: true, scaleMaxBudget: 5000, testMode: true } });
    const { base, dir } = await boot(t, { config });
    await post(base, '/api/autopilot', { killSwitch: true });
    const ap = JSON.parse(require('node:fs').readFileSync(require('node:path').join(dir, 'config.json'), 'utf8')).autopilot;
    assert.deepStrictEqual(
      { enabled: ap.enabled, minAds: ap.minAds, autoLinkPixel: ap.autoLinkPixel, scaleMaxBudget: ap.scaleMaxBudget, testMode: ap.testMode },
      { enabled: true, minAds: 3, autoLinkPixel: true, scaleMaxBudget: 5000, testMode: true });
    assert.strictEqual(readState(dir).killSwitch, true);
    const log = JSON.stringify(readState(dir).log);
    assert.ok(log.includes('กดหยุดฉุกเฉิน') && !log.includes('ปิดระบบอัตโนมัติ'));
  });
});

describe('หน้าสุขภาพบัญชี: สกุลเงิน (รีวิว 12 ต.ค. 2026)', () => {
  test('ต้องส่งสกุลและหน่วยย่อยของแต่ละบัญชี ให้หน้าเว็บโชว์ยอดเรียกเก็บถูกสกุล', async (t) => {
    // เดิมหน้าเว็บหาร 100 และใส่ ฿ ตายตัว — บัญชี VND/JPY/IDR โชว์ยอดเล็กไป 100 เท่า
    const world = freshWorld({ accounts: [
      { name: 'บัญชีดอง', account_id: '111', account_status: 1, currency: 'VND' },
      { name: 'บัญชีดอลลาร์', account_id: '222', account_status: 1, currency: 'USD' },
    ] });
    const { base } = await boot(t, { world });
    const h = await get(base, '/api/health-overview?profile=p1');
    const by = Object.fromEntries(h.accounts.map((a) => [a.id, a]));
    assert.deepStrictEqual([by['111'].currency, by['111'].minor], ['VND', 1]);
    assert.deepStrictEqual([by['222'].currency, by['222'].minor], ['USD', 100]);
  });
});

describe('error ที่ต้องให้คนไปจัดการก่อน (บัญชีจริง 12 ต.ค. 2026)', () => {
  const adPosts = (world) => world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`);

  test('FB ให้ยืนยันบัญชี (3858385) ตอนสร้างแอด: ต้องหยุดบัญชีนี้ ลบชุดโฆษณาเปล่าทิ้ง และไม่ลองซ้ำรอบหน้า', async (t) => {
    // เดิมลองซ้ำทุก 20 นาที ทิ้งชุดโฆษณาเปล่าไว้ทุกรอบ และยิงคำขอใส่บัญชีที่ FB สงสัยอยู่ซ้ำๆ
    const world = freshWorld({
      route: (m, p) => (m === 'POST' && p === `act_${ACCT}/ads`
        ? { error: 'This request requires the user to take a pending action', errorCode: 31, errorSubcode: 3858385 } : null),
    });
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.ok(st.noRotate[ACCT] && st.noRotate[ACCT].action, 'ต้องหยุดเติมแอดให้บัญชีนี้');
    assert.match(st.noRotate[ACCT].cat, /ยืนยันบัญชี/);
    const sets = world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`);
    assert.strictEqual(sets.length, 1);
    assert.ok(world.adsets.every((x) => x.status === 'DELETED'), 'ชุดโฆษณาที่เพิ่งสร้างต้องถูกลบ ไม่ค้างเป็นชุดเปล่า');
    const tries = adPosts(world).length;
    await post(base, '/api/autopilot/run');
    assert.strictEqual(adPosts(world).length, tries, 'รอบถัดไปต้องไม่ลองซ้ำ');
    // แก้แล้วกดปลดล็อก = กลับมาลองได้
    await post(base, '/api/autopilot/unfreeze', { acctId: ACCT });
    world.route = null;
    await post(base, '/api/autopilot/run');
    assert.ok(adPosts(world).length > tries, 'ปลดล็อกแล้วต้องเติมแอดได้');
  });

  test('FB บังคับผู้ลงโฆษณาที่ยืนยันแล้ว (3858634) ตอนสร้างชุดโฆษณา: ต้องหยุดบัญชีนี้และบอกวิธีแก้', async (t) => {
    const world = freshWorld({
      route: (m, p) => (m === 'POST' && p === `act_${ACCT}/adsets`
        ? { error: 'Invalid parameter', errorCode: 100, errorSubcode: 3858634 } : null),
    });
    const { base, dir } = await boot(t, { world });
    await post(base, '/api/autopilot/run');
    const st = readState(dir);
    assert.ok(st.noRotate[ACCT] && st.noRotate[ACCT].action);
    assert.match(st.noRotate[ACCT].cat, /ผู้ลงโฆษณา/);
    assert.strictEqual(adPosts(world).length, 0);
    const before = world.calls.length;
    await post(base, '/api/autopilot/run');
    assert.ok(!world.calls.slice(before).some((c) => c.method === 'POST' && c.path === `act_${ACCT}/adsets`), 'ต้องไม่ลองซ้ำ');
  });
});
