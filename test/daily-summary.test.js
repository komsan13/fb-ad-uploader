// เทสสรุปเช้า 08:00: ตัวเลขดิบต้องถึง Telegram เสมอ — บทวิเคราะห์ AI เป็นของแถม ล่มได้แต่ห้ามพาตัวเลขหายไปด้วย
// เรียก dailySummary() ตรงผ่าน module.exports (ตัวจับเวลา 08:00 เทสไม่ได้ แต่ตัวงานจริงเทสได้เต็มเส้น)
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makeFakeFb } = require('./fake-fb');
const { makeFakeTg, makeFakeAi } = require('./fake-tg');
const { tmpDir, seed } = require('./helpers');

const ACCT = '111';
const CHAT = '555';

test('สรุปเช้า + บทวิเคราะห์ AI', async (t) => {
  const fb = await makeFakeFb({
    accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
    campaigns: [], ads: [], adsets: [],
    insights: [{ acct: ACCT, spend: '123.45', impressions: '678' }],
  });
  const tg = await makeFakeTg();
  const ai = await makeFakeAi({ analysis: 'เมื่อวานใช้เงินปกติดี ไม่มีอะไรผิดจังหวะ', actions: ['เติมคลังวิดีโออีกหน่อย'] });
  const dir = tmpDir();
  seed(dir, {
    config: {
      profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok' }],
      activeProfileId: 'p1',
      launchDefaults: {},
      autopilot: { enabled: false },
      telegram: { botToken: 'bot-token', chatId: CHAT },
      anthropicKey: 'sk-test',
    },
  });
  // env ต้องถูกตั้งก่อน require เพราะ server.js อ่านตอนโหลด — ไฟล์นี้จึงมีเทสเดียวคุมทั้งลำดับ
  process.env.CONFIG_PATH = path.join(dir, 'config.json');
  process.env.FB_API_BASE = `http://127.0.0.1:${fb.port}`;
  process.env.TG_API_BASE = `http://127.0.0.1:${tg.port}`;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.port}`;
  process.env.ANTHROPIC_API_KEY = '';
  const { dailySummary } = require('../server.js');
  t.after(() => { fb.server.close(); tg.server.close(); ai.server.close(); });

  await t.test('มี key: ตัวเลขดิบ + บทวิเคราะห์ + ข้อควรทำ ในข้อความเดียว', async () => {
    await dailySummary();
    assert.strictEqual(tg.state.sent.length, 1, 'ต้องส่งข้อความเดียว');
    const m = tg.state.sent[0];
    assert.strictEqual(String(m.chat_id), CHAT);
    assert.match(m.text, /สรุปการใช้จ่ายเมื่อวาน/);
    assert.match(m.text, /123\.45/, 'ยอดจริงต้องอยู่ครบแบบเดิม — AI มาเสริม ไม่ใช่มาแทน');
    assert.match(m.text, /🤖 บทวิเคราะห์/);
    assert.match(m.text, /เมื่อวานใช้เงินปกติดี/);
    assert.match(m.text, /1\. เติมคลังวิดีโออีกหน่อย/);
    // ข้อมูลจริงต้องถูกแนบให้ AI — ไม่งั้นบทวิเคราะห์คือนิยาย
    const sentToAi = JSON.stringify(ai.state.requests[0] || {});
    assert.ok(sentToAi.includes('123.45'), 'ยอดจริงต้องถึง AI');
    assert.ok(/ห้ามเดา|ห้ามแต่ง/.test((ai.state.requests[0] || {}).system || ''), 'ต้องกำชับไม่ให้แต่งตัวเลข');
  });

  await t.test('AI ล่ม: ตัวเลขดิบต้องยังถึงเหมือนเดิมทุกประการ', async () => {
    ai.server.close();
    await dailySummary();
    assert.strictEqual(tg.state.sent.length, 2, 'AI ล่มก็ต้องส่ง ไม่ใช่เงียบ');
    const m = tg.state.sent[1];
    assert.match(m.text, /สรุปการใช้จ่ายเมื่อวาน/);
    assert.match(m.text, /123\.45/);
    assert.ok(!m.text.includes('🤖'), 'ห้ามมีบทวิเคราะห์ครึ่งๆ กลางๆ ตอน AI ล่ม');
  });
});
