// เทสงาน AI รายสัปดาห์ (เฟส 2.4/2.5/2.6/3.7/3.8) — เรียกฟังก์ชันจริงผ่าน module.exports
// ชี้ FB/Telegram/Anthropic ไปตัวปลอมทั้งหมด ยืนยันจากข้อความที่ส่งจริงและไฟล์ state บนดิสก์
// หมายเหตุ: fake AI ตอบตามลำดับ array — เทสในไฟล์นี้ต้องรันตามลำดับ (single test + subtests)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { makeFakeFb } = require('./fake-fb');
const { makeFakeTg, makeFakeAi } = require('./fake-tg');
const { tmpDir, seed, readState } = require('./helpers');

const ACCT = '111';
const CHAT = '555';

test('งาน AI รายสัปดาห์', async (t) => {
  const fb = await makeFakeFb({
    accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
    campaigns: [], ads: [], adsets: [],
    insights: [{ acct: ACCT, spend: '4000.00', actions: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '50' }] }],
  });
  const tg = await makeFakeTg();
  // ลำดับคำตอบ AI: 1) เสนอเป้ากระโดด (ต้องถูกปัดตก) 2) เสนอเป้าปกติ 3) ตรวจ landing 4) แท็กวิดีโอ 5) รายงานกลยุทธ์
  const ai = await makeFakeAi([
    { proposal: 500, reason: 'กระโดดเกินไป' },
    { proposal: 120, reason: 'CPA จริงเฉลี่ย 80 ต่ำกว่าเป้า 100 อย่างสม่ำเสมอ' },
    { consistent: false, problems: ['หน้า Landing ไม่พูดถึงโปรที่แอดสัญญา'], suggestions: ['เพิ่มรายละเอียดโปรลงหน้า Landing'] },
    { items: [{ index: 0, tags: ['รีวิวสินค้า', 'โทนสว่าง'], note: 'คนถือสินค้ารีวิว' }] },
    { report: 'ภาพรวม 30 วันใช้เงินสม่ำเสมอ วิดีโอสไตล์รีวิวสินค้าทำผลได้ดีกว่าค่าเฉลี่ย', actions: ['ถ่ายวิดีโอแนวรีวิวสินค้าเพิ่ม'] },
  ]);
  // เว็บปลายทางปลอมที่ตอบ 404 — ไว้ทดสอบเช็คลิงก์เสียแบบวัดจริง
  const dead = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });

  const dir = tmpDir();
  const cfg = {
    profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok' }],
    activeProfileId: 'p1',
    launchDefaults: { objective: 'OUTCOME_SALES', conversionEvent: 'SUBSCRIBE', ruleCpr: '100', campaignBudget: '3333' },
    autopilot: { enabled: false },
    telegram: { botToken: 'bot-token', chatId: CHAT },
    anthropicKey: 'sk-test',
  };
  seed(dir, { config: cfg, videos: 1, captions: 1 });
  fs.writeFileSync(path.join(dir, 'media-library', 'v1.jpg'), Buffer.from('ภาพหน้าปกปลอม'));
  fs.writeFileSync(path.join(dir, 'landing.json'), JSON.stringify({
    title: 'ร้านเทส', bio: 'ทักไลน์ได้',
    links: [{ id: 'l1', label: 'สั่งซื้อ', url: `http://127.0.0.1:${dead.port}/order`, icon: '', event: '' }],
  }));

  process.env.CONFIG_PATH = path.join(dir, 'config.json');
  process.env.FB_API_BASE = `http://127.0.0.1:${fb.port}`;
  process.env.TG_API_BASE = `http://127.0.0.1:${tg.port}`;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.port}`;
  process.env.ANTHROPIC_API_KEY = '';
  const { aiCprReview, aiLandingCheck, aiWeeklyStrategy, aiTagVideos, apRankCaptions } = require('../server.js');
  t.after(() => { fb.server.close(); tg.server.close(); ai.server.close(); dead.srv.close(); });

  await t.test('2.5 ข้อเสนอเป้า CPA ที่กระโดดเกิน ±50% ต้องถูกปัดตกฝั่งเรา ไม่ใช่เชื่อ AI', async () => {
    await aiCprReview(cfg, 'sk-test');
    assert.strictEqual(tg.state.sent.length, 0, 'ห้ามมีข้อเสนอหลุดไปถึงแชท');
    const st = readState(dir);
    assert.ok((st.log || []).some((l) => l.msg.includes('ปัดตก')), 'ต้องมีร่องรอยว่าปัดตกเพราะอะไร');
  });

  await t.test('2.5 ข้อเสนอปกติ ต้องส่งเข้าแชทพร้อมเหตุผล และรอยืนยัน (ไม่ตั้งค่าเอง)', async () => {
    await aiCprReview(cfg, 'sk-test');
    const m = tg.state.sent.find((x) => x.text.includes('🎯'));
    assert.ok(m, 'ต้องมีข้อเสนอในแชท');
    assert.ok(m.text.includes('120'), 'ต้องบอกค่าที่เสนอ');
    assert.ok(m.text.includes('CPA จริงเฉลี่ย 80'), 'ต้องมีเหตุผลจาก AI');
    assert.ok(m.text.includes('พิมพ์ "ยืนยัน"'), 'ต้องรอยืนยัน ไม่ใช่ตั้งเอง');
    // ยอดจริงจาก FB ต้องถึง AI — ไม่งั้นข้อเสนอคือนิยาย
    const sentToAi = JSON.stringify(ai.state.requests[1]);
    assert.ok(sentToAi.includes('4,000') || sentToAi.includes('4000'), 'ยอดใช้จ่ายจริงต้องถูกแนบให้ AI');
    // config ต้องยังไม่ถูกแตะ
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(saved.launchDefaults.ruleCpr, '100', 'ค่าจริงห้ามเปลี่ยนก่อนเจ้าของยืนยัน');
  });

  await t.test('2.6 ตรวจ Landing: ลิงก์ 404 ต้องถูกจับ + ความไม่สอดคล้องจาก AI ต้องถึงแชท', async () => {
    const before = tg.state.sent.length;
    await aiLandingCheck(cfg, 'sk-test');
    const m = tg.state.sent.slice(before).find((x) => x.text.includes('🏠'));
    assert.ok(m, 'ต้องมีรายงาน Landing');
    assert.ok(m.text.includes('HTTP 404'), 'ลิงก์เสียต้องถูกจับด้วยการยิงจริง ไม่ใช่ให้ AI เดา');
    assert.ok(m.text.includes('ไม่พูดถึงโปรที่แอดสัญญา'), 'ผลวิเคราะห์ความสอดคล้องต้องถึงแชท');
  });

  await t.test('3.8 แท็กวิดีโอ: ผลจาก AI ต้องถูกเขียนลงคลังจริง', async () => {
    const n = await aiTagVideos('sk-test', 20);
    assert.strictEqual(n, 1);
    const lib = JSON.parse(fs.readFileSync(path.join(dir, 'media-library', 'index.json'), 'utf8'));
    assert.deepStrictEqual(lib[0].tags, ['รีวิวสินค้า', 'โทนสว่าง']);
    assert.ok(lib[0].aiNote.includes('รีวิว'));
    // เรียกซ้ำต้องไม่แท็กซ้ำ (ไม่เปลืองเงิน)
    const again = await aiTagVideos('sk-test', 20);
    assert.strictEqual(again, 0, 'วิดีโอที่มีแท็กแล้วห้ามส่งไปให้ AI ดูซ้ำ');
  });

  await t.test('3.7 รายงานกลยุทธ์: ข้อมูลจริง+แท็กต้องถึง AI และรายงานต้องถึงแชท', async () => {
    const before = tg.state.sent.length;
    await aiWeeklyStrategy(cfg, 'sk-test');
    const m = tg.state.sent.slice(before).find((x) => x.text.includes('📊'));
    assert.ok(m, 'ต้องมีรายงานกลยุทธ์');
    assert.ok(m.text.includes('วิดีโอสไตล์รีวิวสินค้า'), 'เนื้อรายงานจาก AI ต้องถึงแชท');
    assert.ok(m.text.includes('1. ถ่ายวิดีโอแนวรีวิวสินค้าเพิ่ม'), 'ข้อแนะนำต้องถูกจัดเรียง');
    const sentToAi = JSON.stringify(ai.state.requests[ai.state.requests.length - 1]);
    assert.ok(sentToAi.includes('รีวิวสินค้า'), 'แท็กวิดีโอต้องถูกแนบให้ AI ใช้วิเคราะห์สไตล์');
    assert.ok(sentToAi.includes('4,000') || sentToAi.includes('4000'), 'ยอดจริงต้องถูกแนบ');
  });

  await t.test('2.4 apRankCaptions: ชนะขึ้นก่อน แพ้ถูกตัด ของค้าง/ต่างสกุล/ไม่มีเป้า ไม่ถูกนับ', () => {
    const now = Date.now();
    const caps = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    const s = {
      adMeta: {
        a1: { cap: 'c1', vid: 'v1', cur: 'THB' },
        a2: { cap: 'c2', vid: 'v1', cur: 'THB' },
        a3: { cap: 'c1', vid: 'v2', cur: 'JPY' },   // คนละสกุล — ห้ามปนเข้าคะแนน THB
        a4: { cap: 'c3', vid: 'v3', cur: 'THB' },   // snapshot ค้าง 10 วัน — ต้องไม่ถูกนับ
      },
      adPerf: {
        a1: { spend: 300, results: 5, ts: now },
        a2: { spend: 300, results: 0, ts: now },
        a3: { spend: 99999, results: 0, ts: now },
        a4: { spend: 9999, results: 0, ts: now - 10 * 24 * 3600 * 1000 },
      },
    };
    const cfgT = { launchDefaults: { ruleCpr: '100', ruleOn: true }, autopilot: {} };
    const { order, losers } = apRankCaptions(cfgT, s, caps, 'THB', 0);
    assert.deepStrictEqual(order.map((c) => c.id), ['c1', 'c3'], 'c1 ชนะ (CPA 60) ขึ้นก่อน, c3 ข้อมูลค้างเกิน 4 วัน = ยังไม่รู้ ไม่ใช่แพ้');
    assert.deepStrictEqual(losers.map((c) => c.id), ['c2'], 'c2 ใช้ 300 ไม่มีผล = แพ้ ถูกตัด');
    // cursor คี่ = รอบสำรวจ: ตัวยังไม่รู้ได้ขึ้นก่อน ไม่ให้ตัวชนะผูกขาดทุกสลอต
    const explore = apRankCaptions(cfgT, s, caps, 'THB', 1);
    assert.strictEqual(explore.order[0].id, 'c3', 'สลอตคี่ต้องให้ตัวใหม่ได้ลอง');
    // ruleOn ปิด = ตัวเก็บหลักฐาน (adPerf) หยุดเขียน — ห้ามตัดสินจากข้อมูลแช่แข็ง
    const noRule = apRankCaptions({ launchDefaults: { ruleCpr: '100' }, autopilot: {} }, s, caps, 'THB', 0);
    assert.strictEqual(noRule.order.length, 3, 'ruleOn ปิด = ไม่ตัดสิน ทุกตัวหมุนตามคิว');
    assert.strictEqual(noRule.losers.length, 0);
    const noTarget = apRankCaptions({ launchDefaults: {}, autopilot: {} }, s, caps, 'THB', 1);
    assert.deepStrictEqual(noTarget.order.map((c) => c.id), ['c2', 'c3', 'c1'], 'ไม่มีเป้า = หมุนตาม cursor');
  });

  await t.test('ตัวจ่ายงานรายสัปดาห์: ยิงตามวัน กันซ้ำด้วยธง #done และไม่ยิงวันผิด', async () => {
    const { weeklyAiJobs } = require('../server.js');
    const monday = Date.UTC(2026, 6, 20, 5, 0, 0);    // 20 ก.ค. 2026 = จันทร์ (12:00 เวลาไทย)
    const tuesday = Date.UTC(2026, 6, 21, 5, 0, 0);
    const before = ai.state.requests.length;
    await weeklyAiJobs(monday);                        // จันทร์ = รีวิวเป้า CPA (เรียก AI 1 ครั้ง)
    assert.strictEqual(ai.state.requests.length, before + 1, 'วันจันทร์ต้องรันงานรีวิวเป้า CPA');
    await weeklyAiJobs(monday);
    assert.strictEqual(ai.state.requests.length, before + 1, 'วันเดียวกันสำเร็จแล้วห้ามรันซ้ำ (#done)');
    await weeklyAiJobs(tuesday);
    assert.strictEqual(ai.state.requests.length, before + 1, 'วันอังคารไม่มีงาน ห้ามยิง AI');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'watch-state.json'), 'utf8'));
    assert.strictEqual(st['job:cpr'], '2026-07-20#done', 'ธงต้องบอกว่าสำเร็จแล้ว');
  });
});
