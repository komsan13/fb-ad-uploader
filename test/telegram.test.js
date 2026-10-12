// เทสถามยอดผ่าน Telegram: รัน server.js จริง ชี้ FB/Telegram/Anthropic ไปตัวปลอมทั้งหมด
// ยืนยันทั้งเส้น: ข้อความเข้า getUpdates → ดึงยอดจริงจาก FB → AI ได้ข้อมูลจริง → คำตอบกลับเข้าแชท
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { makeFakeFb } = require('./fake-fb');
const { makeFakeTg, makeFakeAi } = require('./fake-tg');
const { tmpDir, seed, startServer } = require('./helpers');

const ACCT = '111';
const CHAT = '555';

const world = () => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [],
  insights: [{ acct: ACCT, spend: '123.45', impressions: '678' }],
  pixels: [{ id: 'px1' }],
});

const config = (extra = {}) => ({
  profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', pageId: 'page1' }],
  activeProfileId: 'p1',
  launchDefaults: {},
  autopilot: { enabled: false },                       // ปิด tick กันเสียงรบกวนในเทสชุดนี้
  telegram: { botToken: 'bot-token', chatId: CHAT },
  ...extra,
});

async function bootTg(t, { cfg = config(), aiAnswer = 'คำตอบจาก AI', fbWorld = world(), env = {} } = {}) {
  const fb = await makeFakeFb(fbWorld);
  const tg = await makeFakeTg();
  const ai = await makeFakeAi(aiAnswer);
  const dir = tmpDir();
  seed(dir, { config: cfg, videos: 0, captions: 0 });
  const srv = await startServer(dir, fb.port, {
    TG_API_BASE: `http://127.0.0.1:${tg.port}`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`,
    ANTHROPIC_API_KEY: '',                             // คุมทาง AI ด้วย config เท่านั้น
    ...env,
  });
  t.after(() => { srv.stop(); fb.server.close(); tg.server.close(); ai.server.close(); });
  return { srv: { ...srv, fbWorld: fb.world }, tg, ai };
}

// รอจนเงื่อนไขจริง — polling ทำงานเป็นรอบ ต้องรอไม่ใช่ sleep เดา
async function until(fn, ms = 20000, why = 'เงื่อนไขไม่เกิดในเวลา') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(why);
}

describe('ถามยอดผ่าน Telegram', () => {
  test('AI ตอบคำถามอิสระ โดยได้ยอดจริงจาก FB แนบไปด้วย', async (t) => {
    const { tg, ai } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: 'วันนี้ใช้ไป 123.45 บาทครับ',
    });
    await until(() => tg.state.polls >= 1, 20000, 'บอทไม่เคย poll เลย');   // รอให้ drain รอบบูตผ่านก่อน
    tg.push(CHAT, 'ช่วงนี้ใช้เงินไปเยอะไหม');
    await until(() => tg.state.sent.length >= 2, 20000, 'ต้องได้ทั้ง "รอสักครู่" และคำตอบจริง');

    // ลำดับสำคัญ: รับทราบก่อน แล้วค่อยคำตอบ — ไม่ใช่คำตอบมาก่อนแล้วรับทราบตามหลัง
    assert.match(tg.state.sent[0].text, /รอสักครู่/, 'ข้อความแรกต้องบอกให้รอ ระหว่างดึงข้อมูล');
    assert.strictEqual(String(tg.state.sent[0].chat_id), CHAT);
    assert.strictEqual(tg.state.sent[1].text, 'วันนี้ใช้ไป 123.45 บาทครับ', 'ต้องเป็นคำตอบจาก AI ไม่ใช่ keyword bot');

    const req = ai.state.requests[0];
    assert.ok(req, 'AI ต้องถูกเรียก');
    const sentToAi = JSON.stringify(req);
    assert.ok(sentToAi.includes('123.45'), 'ยอดจริงจาก FB ต้องถูกแนบให้ AI — ไม่งั้น AI เดาตัวเลข');
    assert.ok(sentToAi.includes('ช่วงนี้ใช้เงินไปเยอะไหม'), 'คำถามของผู้ใช้ต้องถึง AI ตามจริง');
    assert.ok(/ห้ามเดา|เฉพาะตัวเลขจากข้อมูล/.test(req.system || ''), 'ต้องกำชับ AI ไม่ให้เดาตัวเลข');
  });

  test('แชทอื่นที่ไม่ใช่เจ้าของ ถามอะไรก็ต้องเงียบ', async (t) => {
    const { tg } = await bootTg(t, { cfg: config({ anthropicKey: 'sk-test' }) });
    await until(() => tg.state.polls >= 1);
    tg.push('999', 'สรุปยอดหน่อย');          // คนแปลกหน้า
    tg.push(CHAT, 'สรุป');                    // เจ้าของ — ใช้เป็นตัวปิดท้ายว่าระบบยังทำงาน
    await until(() => tg.state.sent.length >= 1, 20000, 'เจ้าของถามแล้วต้องได้คำตอบ');
    assert.ok(tg.state.sent.every((m) => String(m.chat_id) === CHAT),
      'ห้ามมีข้อความหลุดไปแชทอื่นเด็ดขาด — ข้อมูลเงินให้เฉพาะเจ้าของ');
  });

  test('ไม่มี Anthropic key ต้องตกไป keyword fallback ไม่ใช่เงียบหาย', async (t) => {
    const { tg, ai } = await bootTg(t);       // config ไม่มี anthropicKey
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'สรุป');
    await until(() => tg.state.sent.length >= 2, 20000, 'fallback ต้องตอบ');
    assert.match(tg.state.sent[0].text, /รอสักครู่/);
    assert.match(tg.state.sent[1].text, /ใช้เงินวันนี้/, 'ต้องได้สรุปแบบ keyword');
    assert.match(tg.state.sent[1].text, /123\.45/, 'ต้องมียอดจริง');
    assert.match(tg.state.sent[1].text, /รวม:/, 'ต้องมีบรรทัดรวม');
    assert.strictEqual(ai.state.requests.length, 0, 'ไม่มี key ห้ามพยายามเรียก AI');
  });

  test('AI ล่มกลางทาง ต้องตกไป fallback ไม่ใช่เงียบหาย', async (t) => {
    const { tg, ai } = await bootTg(t, { cfg: config({ anthropicKey: 'sk-test' }) });
    ai.server.close();                        // AI ตายก่อนคำถามแรก
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'สรุป');
    await until(() => tg.state.sent.length >= 2, 30000, 'AI ล่มแล้ว fallback ต้องยังตอบ');
    assert.match(tg.state.sent[0].text, /รอสักครู่/);
    assert.match(tg.state.sent[1].text, /ใช้เงินวันนี้/);
    assert.match(tg.state.sent[1].text, /123\.45/);
  });
});

describe('AI สั่งงานระบบ — ต้องยืนยันก่อนเสมอ', () => {
  const readState = (dir) => JSON.parse(require('node:fs').readFileSync(require('node:path').join(dir, 'autopilot-state.json'), 'utf8'));
  const proposal = (action, answer = 'จะจัดการให้ครับ') => ({ answer, action });

  test('AI เสนอกดหยุดฉุกเฉิน — ก่อนยืนยันห้ามมีอะไรเกิดขึ้น หลังยืนยันต้องเกิดจริง', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal({ type: 'killSwitch', on: true, value: null, key: null, accountId: null, campaignId: null, profileId: null, status: null }),
    });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'หยุดระบบเดี๋ยวนี้');
    await until(() => tg.state.sent.length >= 2, 20000, 'ต้องได้ ack + คำถามยืนยัน');
    assert.match(tg.state.sent[1].text, /ยืนยัน/, 'ต้องถามยืนยัน ไม่ใช่ทำเลย');
    assert.match(tg.state.sent[1].text, /หยุดฉุกเฉิน/, 'ต้องบอกชัดว่าจะทำอะไร');

    // ยังไม่ยืนยัน — state ต้องไม่ถูกแตะ
    const st1 = await (await fetch(srv.base + '/api/autopilot')).json();
    assert.strictEqual(st1.killSwitch, false, 'แค่เสนอ ห้ามลงมือ');

    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000, 'ยืนยันแล้วต้องรายงานผล');
    const st2 = await (await fetch(srv.base + '/api/autopilot')).json();
    assert.strictEqual(st2.killSwitch, true, 'ยืนยันแล้วต้องเกิดจริง');
  });

  test('ยกเลิก = ไม่มีอะไรถูกทำ และยืนยันหลังจากนั้นต้องไม่ทำงาน', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal({ type: 'autopilotEnabled', on: true, value: null, key: null, accountId: null, campaignId: null, profileId: null, status: null }),
    });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'เปิดระบบให้หน่อย');
    await until(() => tg.state.sent.length >= 2);
    tg.push(CHAT, 'ยกเลิก');
    await until(() => tg.state.sent.some((m) => /ยกเลิกแล้ว/.test(m.text)), 20000);
    tg.push(CHAT, 'ยืนยัน');   // ยืนยันตอนไม่มีอะไรค้าง
    await until(() => tg.state.sent.some((m) => /ไม่มีคำสั่งค้าง/.test(m.text)), 20000);
    const st = await (await fetch(srv.base + '/api/autopilot')).json();
    assert.strictEqual(st.enabled, false, 'ยกเลิกแล้วต้องไม่มีอะไรเปลี่ยน');
  });

  test('สั่งปิดแคมเปญ — หลังยืนยัน FB ต้องได้รับคำสั่งจริง และก่อนหน้าห้ามได้', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal({ type: 'campaignStatus', on: null, value: null, key: null, accountId: null, campaignId: '777001', profileId: 'p1', status: 'PAUSED' }),
    });
    // แคมเปญต้องมีจริงใน world ให้ fake FB แก้สถานะได้
    srv.fbWorld.campaigns.push({ id: '777001', acct: ACCT, name: 'ตัวเป้า', status: 'ACTIVE', daily_budget: '333300' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ปิดแคมเปญตัวเป้าให้หน่อย');
    await until(() => tg.state.sent.length >= 2);
    const paused = () => srv.fbWorld.calls.filter((c) => c.method === 'POST' && c.path === '777001' && c.params.status === 'PAUSED');
    assert.strictEqual(paused().length, 0, 'ก่อนยืนยัน FB ต้องไม่ได้รับคำสั่ง');
    tg.push(CHAT, 'ยืนยัน');
    await until(() => paused().length >= 1, 20000, 'ยืนยันแล้ว FB ต้องได้รับคำสั่งปิด');
    await until(() => tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000);
  });

  test('AI เสนอคำสั่งเพี้ยน (id มั่ว/ชนิดไม่รู้จัก) ต้องถูกทิ้ง ไม่ถามยืนยันด้วยซ้ำ', async (t) => {
    const { tg } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal({ type: 'campaignStatus', on: null, value: null, key: null, accountId: null, campaignId: 'DROP TABLE', profileId: 'p1', status: 'PAUSED' }, 'ตอบปกติ'),
    });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ปิดแคมเปญ');
    await until(() => tg.state.sent.length >= 2);
    assert.ok(!/ยืนยัน/.test(tg.state.sent[1].text), 'คำสั่ง id เพี้ยนต้องไม่กลายเป็น pending');
  });

  test('ข้อมูลที่ส่งให้ AI ต้องมีคลิก/แคมเปญ/เพดาน ครบพอให้ตอบได้ทุกเรื่อง', async (t) => {
    const { tg, ai, srv } = await bootTg(t, { cfg: config({ anthropicKey: 'sk-test' }) });
    srv.fbWorld.campaigns.push({ id: 'C77', acct: ACCT, name: 'แคมเปญโชว์', status: 'ACTIVE', daily_budget: '333300', objective: 'OUTCOME_SALES' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ภาพรวมเป็นไงบ้าง');
    await until(() => ai.state.requests.length >= 1, 20000);
    const sent = JSON.stringify(ai.state.requests[0]);
    for (const key of ['คลิก', 'campaign_id C77', 'แคมเปญโชว์', 'เพดาน', 'maxFixPerDay', 'profile_id p1']) {
      assert.ok(sent.includes(key), `ข้อมูลที่ให้ AI ต้องมี "${key}"`);
    }
  });
});

describe('รูที่รีวิวเจอ — เส้นเงินและการยืนยัน', () => {
  const mkAct = (over) => ({ type: '', on: null, value: null, key: null, accountId: null, campaignId: null, profileId: null, status: null, ...over });
  const proposal = (action, answer = 'จัดการให้ครับ') => ({ answer, action });
  const killProposal = () => proposal(mkAct({ type: 'killSwitch', on: true }));

  test('ตั้งงบแคมเปญ: คูณสกุลเงินถูก และข้อความยืนยันโชว์งบเดิม→ใหม่', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal(mkAct({ type: 'setCampaignBudget', campaignId: '888001', accountId: ACCT, profileId: 'p1', value: 9000 })),
    });
    srv.fbWorld.campaigns.push({ id: '888001', acct: ACCT, account_id: ACCT, name: 'งบเทส', status: 'ACTIVE', daily_budget: '333300' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ขึ้นงบแคมเปญเป็น 9000');
    await until(() => tg.state.sent.length >= 2);
    assert.match(tg.state.sent[1].text, /3,333 → 9,000/, 'ต้องโชว์งบเดิมเทียบใหม่ให้เจ้าของประเมินได้');

    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000);
    const call = srv.fbWorld.calls.find((c) => c.method === 'POST' && c.path === '888001' && c.params.daily_budget);
    assert.ok(call, 'FB ต้องได้รับคำสั่งตั้งงบ');
    assert.strictEqual(call.params.daily_budget, '900000', 'THB ต้องคูณ 100 (9000 → 900000 สตางค์)');
  });

  test('ตั้งงบบัญชี USD: ทศนิยมต้องไม่ถูกปัดทิ้ง ยืนยันต้องโชว์ยอดเทียบบาท และข้อมูลให้ AI ต้องติดหน่วย', async (t) => {
    // เดิมปัดเป็นจำนวนเต็มทุกสกุล 9.99 USD → 10 • และข้อมูลที่ส่งให้ AI ไม่มีหน่วย เลขบาทปนเลขดอลลาร์
    const fbWorld = { ...world(), accounts: [{ name: 'บัญชีดอลลาร์', account_id: ACCT, account_status: 1, currency: 'USD' }] };
    const { tg, srv, ai } = await bootTg(t, {
      fbWorld,
      cfg: config({ anthropicKey: 'sk-test', launchDefaults: { campaignBudget: '3333', ruleCpr: '100' }, autopilot: { enabled: false, scaleMaxBudget: 20000 } }),
      aiAnswer: proposal(mkAct({ type: 'setCampaignBudget', campaignId: '888009', accountId: ACCT, profileId: 'p1', value: 9.99 })),
    });
    srv.fbWorld.campaigns.push({ id: '888009', acct: ACCT, account_id: ACCT, name: 'งบดอลลาร์', status: 'ACTIVE', daily_budget: '1000' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ตั้งงบแคมเปญเป็น 9.99 ดอลลาร์');
    await until(() => tg.state.sent.length >= 2);
    assert.match(tg.state.sent[1].text, /10 → 9\.99 USD\/วัน \(≈ 333 บาท\)/, tg.state.sent[1].text);
    const sentToAi = JSON.stringify(ai.state.requests[0]);
    assert.ok(sentToAi.includes('10 USD/วัน'), 'งบแคมเปญต้องติดสกุลของบัญชี');
    assert.ok(sentToAi.includes('20000 บาท/วัน/แคมเปญ') && sentToAi.includes('3333 บาท'), 'ค่าตั้งค่าต้องบอกว่าเป็นบาท');
    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000);
    const call = srv.fbWorld.calls.find((c) => c.method === 'POST' && c.path === '888009' && c.params.daily_budget);
    assert.strictEqual(call.params.daily_budget, '999', '9.99 ดอลลาร์ = 999 เซนต์ ไม่ใช่ 1000');
  });

  test('ตั้งงบบัญชี VND: งบหลักล้านดองต้องสั่งผ่านแชทได้ (เพดานคิดเป็นบาท ไม่ใช่ 1,000,000 ทุกสกุล)', async (t) => {
    const fbWorld = { ...world(), accounts: [{ name: 'บัญชีดอง', account_id: ACCT, account_status: 1, currency: 'VND' }] };
    const { tg, srv } = await bootTg(t, {
      fbWorld,
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal(mkAct({ type: 'setCampaignBudget', campaignId: '888010', accountId: ACCT, profileId: 'p1', value: 2000000 })),
    });
    srv.fbWorld.campaigns.push({ id: '888010', acct: ACCT, account_id: ACCT, name: 'งบดอง', status: 'ACTIVE', daily_budget: '2559744' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ลดงบเหลือ 2 ล้านดอง');
    await until(() => tg.state.sent.length >= 2);
    assert.match(tg.state.sent[1].text, /2,559,744 → 2,000,000 VND\/วัน/, tg.state.sent[1].text);
    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000);
    const call = srv.fbWorld.calls.find((c) => c.method === 'POST' && c.path === '888010' && c.params.daily_budget);
    assert.strictEqual(call.params.daily_budget, '2000000', 'ดองไม่มีหน่วยย่อย ไม่คูณ 100');
  });

  test('AI เสนอคำสั่งที่ไม่ผ่านการตรวจ ต้องบอกเจ้าของว่ายังไม่ได้ทำ (ไม่ใช่เงียบแล้วรอคำถามยืนยันที่ไม่มา)', async (t) => {
    const { tg } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal(mkAct({ type: 'setCampaignBudget', campaignId: '888011', accountId: ACCT, profileId: 'p1', value: -5 }), 'จะลดงบให้ครับ'),
    });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ลดงบ');
    await until(() => tg.state.sent.length >= 2);
    assert.match(tg.state.sent[1].text, /ไม่ผ่านการตรวจ/);
  });

  test('ตั้งงบ: แคมเปญไม่ได้อยู่ในบัญชีที่อ้าง ต้องตายตั้งแต่ตอนเสนอ', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal(mkAct({ type: 'setCampaignBudget', campaignId: '888002', accountId: ACCT, profileId: 'p1', value: 5000 })),
    });
    // แคมเปญมีจริงแต่เป็นของบัญชีอื่น — คู่ผิดสกุลเงินผิด = งบคูณ 100
    srv.fbWorld.campaigns.push({ id: '888002', acct: '999', account_id: '999', name: 'ของคนอื่น', status: 'ACTIVE', daily_budget: '10000' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ขึ้นงบ');
    await until(() => tg.state.sent.length >= 2);
    assert.match(tg.state.sent[1].text, /ข้อเสนอถูกยกเลิก/, 'จับคู่ผิดต้องถูกยกเลิกตั้งแต่เสนอ');
    assert.ok(!/พิมพ์ "ยืนยัน"/.test(tg.state.sent[1].text), 'ห้ามมีคำถามยืนยันสำหรับข้อเสนอที่ตาย');
    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ไม่มีคำสั่งค้าง/.test(m.text)), 20000);
    assert.ok(!srv.fbWorld.calls.some((c) => c.method === 'POST' && c.path === '888002'), 'FB ต้องไม่ถูกแตะ');
  });

  test('ตั้งงบ: แคมเปญไม่มีงบรายวัน (งบตลอดอายุ/งบที่ชุดโฆษณา) ต้องไม่รับ — ไม่มีงบเดิมให้เกราะ 10 เท่าเทียบ', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal(mkAct({ type: 'setCampaignBudget', campaignId: '888012', accountId: ACCT, profileId: 'p1', value: 500000 })),
    });
    srv.fbWorld.campaigns.push({ id: '888012', acct: ACCT, account_id: ACCT, name: 'งบตลอดอายุ', status: 'ACTIVE', lifetime_budget: '1000000' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ตั้งงบ 500000');
    await until(() => tg.state.sent.length >= 2);
    assert.match(tg.state.sent[1].text, /ไม่มีงบรายวัน/);
    assert.ok(!/พิมพ์ "ยืนยัน"/.test(tg.state.sent[1].text));
  });

  test('ตั้งงบ: กระโดดเกิน 10 เท่าของงบเดิม ต้องถูกปัดตก', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: proposal(mkAct({ type: 'setCampaignBudget', campaignId: '888003', accountId: ACCT, profileId: 'p1', value: 50000 })),
    });
    srv.fbWorld.campaigns.push({ id: '888003', acct: ACCT, account_id: ACCT, name: 'งบเดิมน้อย', status: 'ACTIVE', daily_budget: '333300' });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'อัดงบ 50000 เลย');   // 50000 > 3333*10
    await until(() => tg.state.sent.length >= 2);
    assert.match(tg.state.sent[1].text, /เกิน 10 เท่า/, 'พิมพ์ศูนย์เกินแล้วเผลอยืนยัน ต้องไม่มีทางผ่าน');
  });

  test('ยืนยันซ้ำสองรอบ ต้องทำครั้งเดียว', async (t) => {
    const { tg } = await bootTg(t, { cfg: config({ anthropicKey: 'sk-test' }), aiAnswer: killProposal() });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'หยุดระบบ');
    await until(() => tg.state.sent.length >= 2);
    tg.push(CHAT, 'ยืนยัน');
    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ไม่มีคำสั่งค้าง/.test(m.text)), 20000, 'ยืนยันรอบสองต้องเจอว่าไม่มีอะไรค้าง');
    assert.strictEqual(tg.state.sent.filter((m) => /ทำแล้ว/.test(m.text)).length, 1, 'ลงมือครั้งเดียวเท่านั้น');
  });

  test('สั่งไว้แล้วคุยเรื่องอื่นต่อ — ข้อเสนอเก่าต้องตาย ยืนยันทีหลังต้องไม่ทำงาน', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test' }),
      aiAnswer: [killProposal(), 'ยอดวันนี้ตามที่เห็นครับ'],   // ข้อความสองตอบแบบไม่มี action
    });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'หยุดระบบ');
    await until(() => tg.state.sent.length >= 2);
    tg.push(CHAT, 'แล้ววันนี้ใช้เงินเท่าไหร่');            // คุยเรื่องอื่น = ล้างข้อเสนอ
    await until(() => tg.state.sent.length >= 4);
    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ไม่มีคำสั่งค้าง/.test(m.text)), 20000,
      'ข้อเสนอที่ถูกคั่นด้วยบทสนทนาอื่นต้องตาย — ยืนยันแล้วได้ของที่ลืมไปแล้วคืออุบัติเหตุ');
    const st = await (await fetch(srv.base + '/api/autopilot')).json();
    assert.strictEqual(st.killSwitch, false);
  });

  test('"ยืนยัน" ที่พิมพ์ก่อนข้อเสนอขึ้น (พิมพ์รัว) ต้องถูกปัดตก', async (t) => {
    const { tg, srv } = await bootTg(t, { cfg: config({ anthropicKey: 'sk-test' }), aiAnswer: killProposal() });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'หยุดระบบ');
    await until(() => tg.state.sent.length >= 2);
    tg.push(CHAT, 'ยืนยัน', Math.floor(Date.now() / 1000) - 120);   // เวลาย้อนไปก่อนข้อเสนอถูกสร้าง
    await until(() => tg.state.sent.some((m) => /ก่อนข้อเสนอ/.test(m.text)), 20000, 'ยืนยันล่วงหน้าต้องโดนปัด');
    let st = await (await fetch(srv.base + '/api/autopilot')).json();
    assert.strictEqual(st.killSwitch, false, 'ยังห้ามลงมือ');
    tg.push(CHAT, 'ยืนยัน');                                        // ยืนยันจริงหลังอ่าน
    await until(() => tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000);
    st = await (await fetch(srv.base + '/api/autopilot')).json();
    assert.strictEqual(st.killSwitch, true);
  });

  test('สั่งปรับเพดานผ่านแชท ต้องไม่เผลอปิดระบบที่เปิดอยู่ (passthrough enabled)', async (t) => {
    const { tg, srv } = await bootTg(t, {
      cfg: config({ anthropicKey: 'sk-test', autopilot: { enabled: true, minAds: 0 } }),
      aiAnswer: proposal(mkAct({ type: 'setLimit', key: 'maxFixPerDay', value: 20 })),
    });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'ขยับเพดานแก้ข้อความเป็น 20');
    await until(() => tg.state.sent.length >= 2);
    tg.push(CHAT, 'ยืนยัน');
    await until(() => tg.state.sent.some((m) => /ทำแล้ว/.test(m.text)), 20000);
    const st = await (await fetch(srv.base + '/api/autopilot')).json();
    assert.strictEqual(st.limits.maxFixPerDay, 20, 'เพดานต้องเปลี่ยนจริง');
    assert.strictEqual(st.enabled, true, 'ระบบที่เปิดอยู่ต้องยังเปิด — แก้เพดานห้ามพ่วงปิดระบบ');
  });
});

describe('คำสั่งเช็คตารางแคมเปญ "/<โปรไฟล์>_check" (ผู้ใช้ขอ 12 ต.ค. 2026)', () => {
  // บัญชีที่ใช้ได้ 1 + บัญชีที่ผู้ใช้ซ่อนไว้ 1 • แคมเปญตามมาตรฐานชื่อ 2 ตัว (ยิงอยู่/โดนปฏิเสธ) + แคมเปญตั้งมือ งบที่ชุดโฆษณา
  const checkWorld = (prefix) => ({
    accounts: [
      // ชื่อบัญชีอยู่ในกล่องตาราง — ของจริงเป็นตัวอังกฤษ (sss1, Gosss 2/2)
      { name: 'acc1', account_id: ACCT, account_status: 1, currency: 'THB' },
      { name: 'hidden2', account_id: '222', account_status: 1, currency: 'THB' },
    ],
    campaigns: [
      { id: 'C2', acct: ACCT, name: `${prefix}acc1 2/2`, objective: 'OUTCOME_SALES', daily_budget: '177700' },
      { id: 'C1', acct: ACCT, name: `${prefix}acc1 1/2`, objective: 'OUTCOME_SALES', daily_budget: '177700' },
      { id: 'C3', acct: ACCT, name: 'a<b>&c', objective: 'OUTCOME_SALES' },
      { id: 'C9', acct: '222', name: 'hidden2 1/2', objective: 'OUTCOME_SALES', daily_budget: '100000' },
    ],
    ads: [
      { id: 'A1', acct: ACCT, campaign_id: 'C1', effective_status: 'ACTIVE' },
      { id: 'A2', acct: ACCT, campaign_id: 'C2', effective_status: 'DISAPPROVED' },
      { id: 'A3', acct: ACCT, campaign_id: 'C3', effective_status: 'PENDING_REVIEW' },
    ],
    adsets: [{ id: 'S3', acct: ACCT, campaign_id: 'C3', status: 'ACTIVE', daily_budget: '50000', promoted_object: { custom_event_type: 'SUBSCRIBE' } }],
    // insights รายแคมเปญ • C7 = แคมเปญที่ลบไปแล้ว (/campaigns ไม่คืน) แต่วันนี้ใช้เงินไปแล้ว — ของจริงที่เจอบน Gosss 2/2
    insights: [
      { acct: ACCT, campaign_id: 'C1', spend: '523.4', actions: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '4' }] },
      { acct: ACCT, campaign_id: 'C7', objective: 'OUTCOME_SALES', spend: '350', actions: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '2' }] },
    ],
    pixels: [{ id: 'px1' }],
  });
  const cfgCheck = () => config({ anthropicKey: 'sk-test', hidden: { accounts: { 222: true } } });
  const tables = (tg) => tg.state.sent.filter((m) => m.parse_mode === 'HTML');
  const preOf = (msg) => (msg.match(/<pre>([\s\S]*?)<\/pre>/) || [])[1] || '';

  test('/check ได้ตารางจาก FB ตรงๆ ไม่ผ่าน AI ไม่เขียนอะไรลง FB และไม่รวมบัญชีที่ซ่อน', async (t) => {
    const { tg, ai, srv } = await bootTg(t, { cfg: cfgCheck(), fbWorld: checkWorld('') });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, '/check');
    await until(() => tables(tg).length >= 1, 20000, 'ต้องได้ตาราง');
    const msg = tables(tg)[0].text;

    // หน้าตาที่ผู้ใช้กำหนด: การ์ด (กล่อง) เดียวต่อโปรไฟล์ หัวคอลัมน์ไทยอยู่เหนือกล่อง ในกล่องไม่มีตัวไทย ตัวเลขปัดเต็ม
    assert.match(msg, /^📋 <b>แคมเปญ<\/b> · \d\d:\d\d น\.$/m);
    assert.strictEqual((msg.match(/<pre>/g) || []).length, 1, 'ทั้งโปรไฟล์ต้องเป็นการ์ดเดียว');
    assert.match(msg, /^บัญชี \/ แอด · งบ\/วัน · ใช้ไป · ผล\n<pre>/m, 'หัวคอลัมน์ไทยอยู่เหนือกล่องพอดี');
    const pre = preOf(msg);
    assert.ok(!/[\u0E00-\u0E7F]/.test(pre), 'ในกล่องห้ามมีตัวไทย — Telegram วาดไทยในกล่องตัวเล็กแคบ คอลัมน์เบี้ยว (ภาพจากผู้ใช้)');
    assert.ok(pre.includes('a&lt;b&gt;&amp;c'), 'ชื่อที่มี < > & ต้อง escape');
    const lines = pre.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n');
    const row = (start) => lines.find((l) => l.startsWith(start)) || '';
    // บรรทัดบัญชี = ชื่อ + ยอดใช้วันนี้ (รวมแคมเปญที่ลบแล้ว) • แถวแอดย่อหน้าใต้บัญชี
    // ชื่อมาตรฐานตัดส่วนบัญชีทิ้ง เหลือช่อง • งบ 177700 สตางค์ = 1,777 บาท • ใช้ 523.4 ปัดเป็น 523 • สถานะอยู่ท้ายแถว
    assert.match(lines[0], /^acc1 +873$/);
    assert.match(row('  1/2 '), /^ {2}1\/2 +1,777 +523 +4 {2}🟢$/);
    assert.match(row('  2/2 '), /^ {2}2\/2 +1,777 +0 +0 {2}🔴$/, 'ไม่มีข้อมูลวันนี้ = ใช้ 0 ผล 0 ไม่ใช่แถวหาย');
    assert.ok(lines.indexOf(row('  1/2 ')) < lines.indexOf(row('  2/2 ')), 'เรียงตามช่อง ไม่ใช่ตามลำดับที่ FB ส่งมา');
    assert.match(row('  a<'), /^ {2}a<b>&c +500 +0 +0 {2}⏳$/, 'งบที่ชุดโฆษณาต้องนับ');
    assert.match(row('  - '), /^ {2}- +- +350 +2 {2}🗑$/, 'แคมเปญที่ลบแล้วแต่ใช้เงินวันนี้ต้องโผล่ ไม่งั้นยอดใช้ไม่มีที่มา');
    // คอลัมน์ตรง: แถวแอดทุกแถว (ตัดสัญลักษณ์ท้าย) ยาวเท่ากัน และยอดของบรรทัดบัญชีจบตรงคอลัมน์ "ใช้ไป"
    const rows = lines.filter((l) => l.startsWith('  ')).map((l) => l.replace(/ {2}(🟢|⏳|🔴|⚠️|⏸|🗑)$/u, ''));
    assert.strictEqual(new Set(rows.map((l) => l.length)).size, 1, `คอลัมน์ต้องตรง: ${rows.map((l) => l.length)}`);
    assert.strictEqual(lines[0].length, row('  1/2 ').indexOf('523') + 3, 'ยอดบัญชีต้องอยู่คอลัมน์ "ใช้ไป"');
    assert.ok(!/hidden2/.test(msg), 'บัญชีที่ผู้ใช้ซ่อนต้องไม่ขึ้น (ชุดเดียวกับที่ autopilot ไล่)');
    assert.match(msg, /^💰 ใช้วันนี้รวม 873 บาท$/m, 'ยอดรวม = ทุกแถวรวมตัวที่ลบแล้ว (ตรงกับตาราง)');
    assert.match(msg, /^📊 งบรวม 2,277 บาท\/วัน · ยิงอยู่ 1 · รอตรวจ 1 แคมเปญ$/m, 'งบรวมเฉพาะตัวที่ใช้เงินได้ (ไม่นับตัวที่โดนปฏิเสธ)');
    assert.match(msg, /^🟢 ยิงอยู่ {2}⏳ รอตรวจ {2}🔴 โดนปฏิเสธ {2}🗑 ลบแล้ว/m, 'คำอธิบายสัญลักษณ์เฉพาะตัวที่ใช้');
    assert.ok(!/มีปัญหา/.test(msg));

    assert.strictEqual(ai.state.requests.length, 0, 'คำสั่งเช็คต้องไม่เรียก AI');
    assert.deepStrictEqual(srv.fbWorld.calls.filter((c) => c.method !== 'GET'), [], 'เช็คอย่างเดียว ห้ามเขียน FB');
    assert.deepStrictEqual(tg.state.calls.find((c) => c.method === 'setMyCommands').body.commands.map((c) => c.command), ['check']);
  });

  test('บอทตัวเดียวเช็คได้ทุกโปรไฟล์ (ผู้ใช้สั่ง): @jub_check ผ่านตัวกลาง — โปรเซสของ JUB ดึงเองด้วย token ของ JUB', async (t) => {
    // รัน hub.js จริง: TOP มีบอท + token "tok" • JUB ไม่มีบอท + token "tokj" — ทั้งสองโปรไฟล์ชี้ FB ปลอมตัวเดียวกัน
    const fb = await makeFakeFb(checkWorld('JUB '));
    const tg = await makeFakeTg();
    const ai = await makeFakeAi('ห้ามถูกเรียก');
    const dir = tmpDir();
    seed(dir, { config: cfgCheck(), videos: 0, captions: 0 });
    const jubDir = path.join(dir, 'ws', 'p62');
    fs.mkdirSync(jubDir, { recursive: true });
    seed(jubDir, {
      config: { profiles: [{ id: 'pj', label: 'JUB', accessToken: 'tokj' }], activeProfileId: 'pj', autopilot: { enabled: false } },
      videos: 0, captions: 0,
    });
    fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ list: [{ id: 'top', name: 'TOP' }, { id: 'p62', name: 'JUB' }] }));
    const port = await new Promise((resolve) => {
      const sv = net.createServer();
      sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => resolve(p)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const hub = spawn(process.execPath, [path.join(__dirname, '..', 'hub.js')], {
      env: {
        ...process.env, PORT: String(port), CONFIG_PATH: path.join(dir, 'config.json'), PUBLIC_URL: base,
        FB_API_BASE: `http://127.0.0.1:${fb.port}`, FX_API_URL: `http://127.0.0.1:${fb.port}/fx`,
        TG_API_BASE: `http://127.0.0.1:${tg.port}`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`, ANTHROPIC_API_KEY: '',
        WATCH_FIRST_DELAY_MS: String(10 * 3600 * 1000),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    hub.stdout.on('data', (d) => { log += d; });
    hub.stderr.on('data', (d) => { log += d; });
    t.after(() => { hub.kill(); fb.server.close(); tg.server.close(); ai.server.close(); });
    const up = async (p) => { try { return (await fetch(base + p)).status === 200; } catch { return false; } };
    const end = Date.now() + 30000;
    while (!((await up('/w/top/api/env')) && (await up('/w/p62/api/env')))) {
      if (Date.now() > end) throw new Error(`ตัวกลางไม่ขึ้น\n${log}`);
      await new Promise((r) => setTimeout(r, 200));
    }

    await until(() => tg.state.calls.some((c) => c.method === 'setMyCommands'), 20000, 'บอทต้องลงเมนู');
    assert.deepStrictEqual(tg.state.calls.find((c) => c.method === 'setMyCommands').body.commands.map((c) => c.command),
      ['top_check', 'jub_check'], 'เมนู "/" ต้องมีคำสั่งของทุกโปรไฟล์');

    tg.push(CHAT, '@jub_check');   // แบบที่ผู้ใช้พิมพ์
    await until(() => tables(tg).length >= 1, 30000, `@jub_check ต้องได้ตารางของ JUB\n${log}`);
    const msg = tables(tg)[0].text;
    assert.match(msg, /^📋 <b>JUB<\/b> · \d\d:\d\d น\.$/m, 'หัวตาราง = JUB (สร้างในโปรเซสของ JUB)');
    assert.match(preOf(msg), /^ {2}1\/2 +1,777 +523 +4 {2}🟢$/m, 'ตัด "JUB acc1 " ทิ้ง เหลือช่อง');
    const camps = (tok) => fb.world.calls.filter((c) => c.path === `act_${ACCT}/campaigns` && c.params.access_token === tok).length;
    assert.ok(camps('tokj') > 0, 'ข้อมูล JUB ต้องดึงด้วย token ของ JUB');
    assert.strictEqual(camps('tok'), 0, 'TOP ต้องไม่ดึงตารางเองด้วย token ของ TOP');

    tg.push(CHAT, '/nope_check');
    await until(() => tg.state.sent.some((m) => /ไม่มีโปรไฟล์นี้/.test(m.text)), 20000);
    assert.match(tg.state.sent.find((m) => /ไม่มีโปรไฟล์นี้/.test(m.text)).text, /\/top_check {2}\/jub_check/);
    assert.strictEqual(ai.state.requests.length, 0, 'คำสั่งเช็คต้องไม่เรียก AI');
  });

  test('บัญชีที่อ่านไม่ได้ต้องบอกตรงๆ ไม่ใช่หายไปหรือโชว์ใช้ 0', async (t) => {
    const w = checkWorld('');
    w.route = (method, p) => (method === 'GET' && p === `act_${ACCT}/ads` ? { error: 'จำลอง FB พัง' } : null);
    const { tg } = await bootTg(t, { cfg: cfgCheck(), fbWorld: w });
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, '/check');
    await until(() => tables(tg).length >= 1, 30000, 'ต้องได้ข้อความตาราง');
    const msg = tables(tg)[0].text;
    assert.match(msg, /^⚠️ ดึงไม่ได้: acc1 — ยอดรวมยังไม่ครบ$/m);
  });
});
