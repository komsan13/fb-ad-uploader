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
  return { srv, tg, ai };
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
    await until(() => tg.state.sent.length >= 1, 20000, 'ไม่มีคำตอบกลับเข้าแชท');

    assert.strictEqual(String(tg.state.sent[0].chat_id), CHAT);
    assert.strictEqual(tg.state.sent[0].text, 'วันนี้ใช้ไป 123.45 บาทครับ', 'ต้องเป็นคำตอบจาก AI ไม่ใช่ keyword bot');

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
    await until(() => tg.state.sent.length >= 1, 20000, 'fallback ต้องตอบ');
    assert.match(tg.state.sent[0].text, /ใช้เงินวันนี้/, 'ต้องได้สรุปแบบ keyword');
    assert.match(tg.state.sent[0].text, /123\.45/, 'ต้องมียอดจริง');
    assert.match(tg.state.sent[0].text, /รวม:/, 'ต้องมีบรรทัดรวม');
    assert.strictEqual(ai.state.requests.length, 0, 'ไม่มี key ห้ามพยายามเรียก AI');
  });

  test('AI ล่มกลางทาง ต้องตกไป fallback ไม่ใช่เงียบหาย', async (t) => {
    const { tg, ai } = await bootTg(t, { cfg: config({ anthropicKey: 'sk-test' }) });
    ai.server.close();                        // AI ตายก่อนคำถามแรก
    await until(() => tg.state.polls >= 1);
    tg.push(CHAT, 'สรุป');
    await until(() => tg.state.sent.length >= 1, 30000, 'AI ล่มแล้ว fallback ต้องยังตอบ');
    assert.match(tg.state.sent[0].text, /ใช้เงินวันนี้/);
    assert.match(tg.state.sent[0].text, /123\.45/);
  });
});
