// เทสถามยอดผ่าน Telegram: รัน server.js จริง ชี้ FB/Telegram/Anthropic ไปตัวปลอมทั้งหมด
// ยืนยันทั้งเส้น: ข้อความเข้า getUpdates → ดึงยอดจริงจาก FB → AI ได้ข้อมูลจริง → คำตอบกลับเข้าแชท
const { test, describe } = require('node:test');
const assert = require('node:assert');
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

async function bootTg(t, { cfg = config(), aiAnswer = 'คำตอบจาก AI' } = {}) {
  const fb = await makeFakeFb(world());
  const tg = await makeFakeTg();
  const ai = await makeFakeAi(aiAnswer);
  const dir = tmpDir();
  seed(dir, { config: cfg, videos: 0, captions: 0 });
  const srv = await startServer(dir, fb.port, {
    TG_API_BASE: `http://127.0.0.1:${tg.port}`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`,
    ANTHROPIC_API_KEY: '',                             // คุมทาง AI ด้วย config เท่านั้น
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
