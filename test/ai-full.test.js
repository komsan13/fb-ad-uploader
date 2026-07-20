// เทสโหมด AI เต็มระบบ (aiFull): ตรวจนโยบายก่อนเติมแอด + คลังแคปชั่นใกล้หมด AI เขียนเอง+ยืนยันผ่าน Telegram
// รัน server.js จริง ชี้ FB/Telegram/Anthropic ไปตัวปลอม — ยืนยันจาก request ที่ FB ปลอมได้รับจริง
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeFakeFb } = require('./fake-fb');
const { makeFakeTg, makeFakeAi } = require('./fake-tg');
const { tmpDir, seed, startServer, get, post } = require('./helpers');

const ACCT = '111';
const CHAT = '555';

const baseConfig = (extra = {}) => ({
  profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', pageId: 'page1' }],
  activeProfileId: 'p1',
  launchDefaults: {
    objective: 'OUTCOME_SALES', conversionEvent: 'SUBSCRIBE', campaignBudget: '3333',
    link: 'https://example.com/', ruleCpr: '100', countries: 'TH', cta: 'LEARN_MORE',
  },
  autopilot: { enabled: true, minAds: 2, aiFull: true },
  anthropicKey: 'sk-test',
  ...extra,
});

const freshWorld = (over = {}) => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
  pages: [{ id: 'page1', name: 'เพจหลัก', is_published: true, promotion_eligible: true }],
  ...over,
});

async function boot(t, { world = freshWorld(), config = baseConfig(), aiAnswer, captions = 3, extraEnv = {} } = {}) {
  const fb = await makeFakeFb(world);
  const ai = await makeFakeAi(aiAnswer);
  const dir = tmpDir();
  seed(dir, { config, videos: 3, captions });
  const srv = await startServer(dir, fb.port, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`,
    ANTHROPIC_API_KEY: '',
    ...extraEnv,
  });
  t.after(() => { srv.stop(); fb.server.close(); ai.server.close(); });
  return { base: srv.base, world, ai, dir };
}

const runTwice = async (base) => { await post(base, '/api/autopilot/run'); return post(base, '/api/autopilot/run'); };
const adsCreated = (world) => world.calls.filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`).length;

const pfHigh = { items: [{ index: 0, risk: 'high', issues: [{ where: 'text', policy: 'เคลมทางการแพทย์', detail: 'ทดสอบ' }], advice: null }] };
const pfLow = { items: [{ index: 0, risk: 'low', issues: [], advice: null }] };

describe('โหมด AI เต็มระบบ — ตรวจนโยบายก่อนเติมแอด', () => {
  test('AI บอกเสี่ยงสูงทุกแคปชั่น = ห้ามมีแอดถูกสร้างเลย และต้องมีร่องรอยใน log', async (t) => {
    const { base, world } = await boot(t, { aiAnswer: pfHigh });
    await runTwice(base);
    assert.strictEqual(adsCreated(world), 0, 'รู้อยู่แล้วว่าเสี่ยงสูงยังขึ้นแอด = ดันตัวนับ freeze ขึ้นฟรี');
    const d = await get(base, '/api/autopilot');
    assert.ok(d.log.some((l) => l.msg.includes('🛡️')), 'เหตุผลที่ไม่เติมต้องอยู่ใน log ไม่ใช่เงียบหาย');
  });

  test('AI บอกเสี่ยงต่ำ = เติมแอดตามปกติ', async (t) => {
    const { base, world } = await boot(t, { aiAnswer: pfLow });
    await runTwice(base);
    assert.ok(adsCreated(world) >= 1, 'ผ่านตรวจแล้วต้องเติมแอดได้จริง');
  });

  test('ผลตรวจต้องถูกจำ (cache) — คู่เดิมห้ามเรียก AI ซ้ำทุกรอบ', async (t) => {
    const { base, ai } = await boot(t, { aiAnswer: pfHigh });
    await runTwice(base);
    const afterFirst = ai.state.requests.length;
    assert.ok(afterFirst >= 1, 'รอบแรกต้องเรียก AI จริง');
    await post(base, '/api/autopilot/run');
    // ทุกคู่ วิดีโอ×แคปชั่น ถูกตรวจและจำเป็น high ไปแล้ว — รอบใหม่ต้องไม่จ่ายค่า AI ซ้ำ
    assert.strictEqual(ai.state.requests.length, afterFirst, 'ต้องใช้ผลจาก cache ไม่ใช่เรียกใหม่');
  });

  test('AI ล่ม = เติมแอดแบบเดิมไม่สะดุด (fail-open) ไม่ใช่ระบบทั้งตัวหยุด', async (t) => {
    const { base, world, ai } = await boot(t, { aiAnswer: pfLow });
    ai.server.close();
    await runTwice(base);
    assert.ok(adsCreated(world) >= 1, 'ตัวตรวจเป็นของเสริม — ล่มแล้วระบบหลักต้องเดินต่อ');
  });

  test('ปิด aiFull = ห้ามมีการเรียก AI ตอนเติมแอดแม้แต่ครั้งเดียว (พฤติกรรมเดิมเป๊ะ)', async (t) => {
    const { base, world, ai } = await boot(t, {
      config: baseConfig({ autopilot: { enabled: true, minAds: 2, aiFull: false } }),
      aiAnswer: pfLow,
    });
    await runTwice(base);
    assert.ok(adsCreated(world) >= 1);
    assert.strictEqual(ai.state.requests.length, 0, 'aiFull ปิดอยู่ ต้องไม่แตะ AI เลย');
  });
});

describe('โหมด AI เต็มระบบ — คลังแคปชั่นใกล้หมด AI เขียนเอง + ยืนยันผ่าน Telegram', () => {
  // มีแอด ACTIVE ครบเป้าอยู่แล้ว → รอบตรวจไม่เติมแอด (ไม่กินคิวคำตอบ AI ปลอม) เหลือแค่เส้น stock
  const stockWorld = () => freshWorld({
    ads: [
      { id: 'ad1', acct: ACCT, effective_status: 'ACTIVE', adset_id: 'as1' },
      { id: 'ad2', acct: ACCT, effective_status: 'ACTIVE', adset_id: 'as1' },
    ],
  });
  const until = async (fn, ms = 20000, why = 'เงื่อนไขไม่เกิดในเวลา') => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 200)); }
    throw new Error(why);
  };

  test('เส้นเต็ม: เขียน → เสนอใน Telegram พร้อมข้อความเต็ม → พิมพ์ยืนยัน → เข้าคลังจริง', async (t) => {
    const tg = await makeFakeTg();
    const { base, ai } = await boot(t, {
      world: stockWorld(),
      config: baseConfig({ telegram: { botToken: 'bot-token', chatId: CHAT } }),
      captions: 1,   // ใช้วันละ ~2 (minAds 2 × 1 บัญชี) แต่มี 1 = เข้าเงื่อนไขใกล้หมด
      aiAnswer: [
        { variants: [{ message: 'แคปชั่นใหม่ที่ AI เขียนตอนคลังใกล้หมด ยาวกำลังดี', headline: 'หัวข้อจาก AI' }] },
        pfLow,
      ],
      extraEnv: { TG_API_BASE: `http://127.0.0.1:${tg.port}` },
    });
    t.after(() => tg.server.close());
    await until(() => tg.state.polls >= 1, 20000, 'บอทไม่เคย poll');

    await runTwice(base);
    assert.strictEqual(ai.state.requests.length, 2, 'ต้องมีรอบเขียน + รอบตรวจนโยบาย');

    // ข้อเสนอต้องมีข้อความเต็มให้เจ้าของอ่านก่อนยืนยัน
    const proposal = tg.state.sent.find((m) => m.text.includes('พิมพ์ "ยืนยัน"'));
    assert.ok(proposal, 'ต้องมีข้อเสนอใน Telegram');
    assert.ok(proposal.text.includes('แคปชั่นใหม่ที่ AI เขียนตอนคลังใกล้หมด'), 'เจ้าของต้องเห็นข้อความจริง ไม่ใช่แค่จำนวน');

    // ก่อนยืนยัน: ยังเป็น draft
    let caps = await get(base, '/api/captions');
    const draft = caps.find((c) => c.ai);
    assert.ok(draft && draft.draft === true, 'ก่อนยืนยันต้องยังเป็นแบบร่าง');

    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => m.text.includes('✅ ทำแล้ว')), 20000, 'ยืนยันแล้วต้องได้ผลตอบ');
    caps = await get(base, '/api/captions');
    assert.ok(caps.find((c) => c.id === draft.id && !c.draft), 'ยืนยันแล้วต้องเข้าคลังจริง');
  });

  test('วันเดียวกันห้ามเขียนซ้ำ — รอบตรวจถัดไปต้องไม่จ่ายค่า AI เพิ่ม', async (t) => {
    const tg = await makeFakeTg();
    const { base, ai } = await boot(t, {
      world: stockWorld(),
      config: baseConfig({ telegram: { botToken: 'bot-token', chatId: CHAT } }),
      captions: 1,
      aiAnswer: [
        { variants: [{ message: 'แคปชั่นใหม่ตัวเดียวสำหรับเทสรอบซ้ำ ยาวพอประมาณ', headline: '' }] },
        pfLow,
      ],
      extraEnv: { TG_API_BASE: `http://127.0.0.1:${tg.port}` },
    });
    t.after(() => tg.server.close());
    await runTwice(base);
    const n = ai.state.requests.length;
    await post(base, '/api/autopilot/run');
    assert.strictEqual(ai.state.requests.length, n, 'ธงวันละครั้งต้องกันการเขียนรัว');
  });

  test('ไม่ตั้ง Telegram = ไม่เขียนเอง (ไม่มีช่องทางยืนยัน) — ได้แค่เตือนแบบเดิม', async (t) => {
    const { base, ai } = await boot(t, {
      world: stockWorld(),
      config: baseConfig(),   // ไม่มี telegram
      captions: 1,
      aiAnswer: pfLow,
    });
    await runTwice(base);
    assert.strictEqual(ai.state.requests.length, 0, 'ไม่มีทางให้เจ้าของยืนยัน ต้องไม่สร้างของรออนุมัติเอง');
  });

  test('ข้อเสนอต้องมีข้อความเต็มทุกตัวอักษร ไม่ใช่ 300 ตัวแรก', async (t) => {
    const tg = await makeFakeTg();
    const longMsg = 'ข้อความโฆษณาที่ยาวมากสำหรับทดสอบการส่งเต็ม '.repeat(12);   // ~500 ตัวอักษร
    const { base } = await boot(t, {
      world: stockWorld(),
      config: baseConfig({ telegram: { botToken: 'bot-token', chatId: CHAT } }),
      captions: 1,
      aiAnswer: [{ variants: [{ message: longMsg, headline: '' }] }, pfLow],
      extraEnv: { TG_API_BASE: `http://127.0.0.1:${tg.port}` },
    });
    t.after(() => tg.server.close());
    await runTwice(base);
    const all = tg.state.sent.map((m) => m.text).join('');
    assert.ok(all.includes(longMsg.trim()), 'เจ้าของกำลังอนุมัติข้อความนี้ด้วยเงินจริง — ต้องเห็นครบทุกตัวอักษร');
  });

  test('มีคำสั่งอื่นรอยืนยันอยู่ ข้อเสนอแคปชั่นห้ามทับ — "ยืนยัน" ต้องได้คำสั่งเดิม', async (t) => {
    const tg = await makeFakeTg();
    const killAction = { type: 'killSwitch', on: true, value: null, key: null, accountId: null, campaignId: null, profileId: null, status: null };
    const { base } = await boot(t, {
      world: stockWorld(),
      config: baseConfig({ telegram: { botToken: 'bot-token', chatId: CHAT } }),
      captions: 1,
      aiAnswer: [
        { answer: 'จะกดหยุดฉุกเฉินให้ครับ', action: killAction },   // คำสั่งจากแชท → pending แรก
        { variants: [{ message: 'แคปชั่นที่ห้ามถูกอนุมัติด้วยคำยืนยันของคนอื่น ยาวพอ', headline: '' }] },
        pfLow,
      ],
      extraEnv: { TG_API_BASE: `http://127.0.0.1:${tg.port}` },
    });
    t.after(() => tg.server.close());
    const until = async (fn, ms = 20000, why = 'ไม่เกิด') => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 200)); }
      throw new Error(why);
    };
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'หยุดระบบเดี๋ยวนี้');
    await until(() => tg.state.sent.some((m) => m.text.includes('จะทำ:')), 20000, 'ต้องมี pending จากแชทก่อน');

    // ระหว่าง pending ค้าง → รอบตรวจพยายามเสนอแคปชั่น ต้องถูกกันไว้
    await runTwice(base);
    assert.ok(!tg.state.sent.some((m) => m.text.includes('AI เขียนแบบร่าง')),
      'ห้ามเสนอทับ — คำยืนยันของเจ้าของจะเปลี่ยนความหมายกลางอากาศ');

    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => m.text.includes('✅ ทำแล้ว')), 20000, 'ยืนยันต้องทำงาน');
    const done = tg.state.sent.find((m) => m.text.includes('✅ ทำแล้ว'));
    assert.ok(done.text.includes('หยุดฉุกเฉิน'), 'ต้องเป็นคำสั่งเดิมของเจ้าของ');
    assert.ok(!done.text.includes('อนุมัติแคปชั่น'), 'ห้ามกลายเป็นอนุมัติแคปชั่น');
    const caps = await get(base, '/api/captions');
    assert.ok(caps.filter((c) => c.ai).every((c) => c.draft === true), 'แบบร่างต้องยังไม่ถูกอนุมัติ');
  });

  test('AI ในแชทเสนอ approveCaptions เองไม่ได้ — ต้องถูกปัดตกก่อนถามยืนยัน', async (t) => {
    const tg = await makeFakeTg();
    const { base, ai } = await boot(t, {
      world: stockWorld(),
      config: baseConfig({ telegram: { botToken: 'bot-token', chatId: CHAT } }),
      aiAnswer: { answer: 'อนุมัติแคปชั่นให้เลยครับ', action: { type: 'approveCaptions', ids: ['c1'], on: null, value: null, key: null, accountId: null, campaignId: null, profileId: null, status: null } },
      extraEnv: { TG_API_BASE: `http://127.0.0.1:${tg.port}` },
    });
    t.after(() => { tg.server.close(); void base; void ai; });
    const until = async (fn, ms = 20000, why = 'ไม่เกิด') => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 200)); }
      throw new Error(why);
    };
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ช่วยอนุมัติแคปชั่นหน่อย');
    await until(() => tg.state.sent.length >= 2, 20000, 'ต้องได้คำตอบ');
    assert.ok(!tg.state.sent.some((m) => m.text.includes('จะทำ:')),
      'ข้อเสนอจากแชทต้องถูกปัดตก — อนุมัติข้อความที่เจ้าของไม่เคยเห็นไม่ได้');
    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => m.text.includes('ไม่มีคำสั่งค้าง')), 20000, 'ยืนยันลอยๆ ต้องไม่ทำอะไร');
  });

  test('แก้ข้อความแคปชั่น = ผลตรวจที่จำไว้ต้องถูกล้าง แล้วตรวจใหม่ด้วยข้อความจริง', async (t) => {
    const { base, world, ai } = await boot(t, { captions: 1, aiAnswer: [pfHigh, pfLow] });
    await runTwice(base);
    assert.strictEqual(adsCreated(world), 0, 'ตรวจครั้งแรกเสี่ยงสูง ต้องไม่มีแอด');
    const n = ai.state.requests.length;

    await post(base, '/api/captions/update', { id: 'c1', message: 'ข้อความใหม่ที่แก้แล้วเรียบร้อยปลอดภัยขึ้น', headline: '' });
    await post(base, '/api/autopilot/run');
    assert.ok(ai.state.requests.length > n, 'แก้ข้อความแล้วต้องตรวจใหม่ ไม่ใช่ใช้ตั๋วผ่าน/ตั๋วบล็อกของข้อความเก่า');
    assert.ok(adsCreated(world) >= 1, 'ข้อความใหม่ผ่านตรวจ ต้องเติมแอดได้');
  });
});
