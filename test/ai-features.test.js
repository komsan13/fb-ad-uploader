// เทสฟีเจอร์ AI เฟส 1: ตรวจแอดก่อนขึ้น (pre-flight) + AI เขียนแคปชั่นเป็นแบบร่าง
// รัน server.js จริง ชี้ FB/Anthropic ไปตัวปลอม — ยืนยันจาก state บนดิสก์และ request ที่ AI ได้รับจริง
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeFakeFb } = require('./fake-fb');
const { makeFakeAi } = require('./fake-tg');
const { tmpDir, seed, startServer, get, post } = require('./helpers');

const ACCT = '111';

const world = () => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [],
  insights: [{ acct: ACCT, spend: '100.00', impressions: '500' }],
  pixels: [{ id: 'px1' }],
});

const config = (extra = {}) => ({
  profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', pageId: 'page1' }],
  activeProfileId: 'p1',
  launchDefaults: {},
  autopilot: { enabled: false },   // ปิด tick กันเสียงรบกวน
  ...extra,
});

async function boot(t, { cfg = config({ anthropicKey: 'sk-test' }), aiAnswer, captions = 1, fbWorld = world() } = {}) {
  const fb = await makeFakeFb(fbWorld);
  const ai = await makeFakeAi(aiAnswer);
  const dir = tmpDir();
  seed(dir, { config: cfg, videos: 2, captions });
  const srv = await startServer(dir, fb.port, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`,
    ANTHROPIC_API_KEY: '',                              // คุมทาง AI ด้วย config เท่านั้น
  });
  t.after(() => { srv.stop(); fb.server.close(); ai.server.close(); });
  return { base: srv.base, ai, dir };
}

describe('AI ตรวจแอดก่อนขึ้น (/api/preflight)', () => {
  test('ไม่มี key ต้องบอกตรงๆ ไม่ใช่เงียบหรือล่ม', async (t) => {
    const { base, ai } = await boot(t, { cfg: config() });
    const r = await post(base, '/api/preflight', { items: [{ message: 'ทดสอบ' }] });
    assert.match(r.error || '', /Anthropic API key/);
    assert.strictEqual(ai.state.requests.length, 0, 'ไม่มี key ห้ามพยายามเรียก AI');
  });

  test('ไม่มีแอดให้ตรวจ ต้องได้ 400 ไม่ใช่เรียก AI ฟรี', async (t) => {
    const { base, ai } = await boot(t);
    const r = await post(base, '/api/preflight', { items: [] });
    assert.ok(r.error, 'ต้องมี error');
    assert.strictEqual(ai.state.requests.length, 0);
  });

  test('ผลตรวจของจริงต้องถึงผู้ใช้ครบ และ index มั่ว/ตัวที่ AI ข้ามต้องถูกจัดการ', async (t) => {
    const aiAnswer = {
      items: [
        { index: 0, risk: 'high', issues: [{ where: 'text', policy: 'เคลมทางการแพทย์', detail: 'คำว่า "หายขาด 100%"' }], advice: 'เอาคำว่าหายขาดออก' },
        { index: 5, risk: 'low', issues: [], advice: null },   // index ที่ไม่มีจริง — ต้องถูกกรองทิ้ง
      ],
    };
    const { base, ai } = await boot(t, { aiAnswer });
    const r = await post(base, '/api/preflight', {
      items: [
        { message: 'กินแล้วหายขาด 100%', headline: 'หัวข้อ' },
        { message: 'ข้อความปกติ', headline: '' },
      ],
    });
    assert.strictEqual(r.items.length, 1, 'index มั่วต้องถูกกรอง เหลือของจริง');
    assert.strictEqual(r.items[0].risk, 'high');
    assert.deepStrictEqual(r.missing, [1], 'แอดที่ AI ไม่ได้ตรวจต้องถูกรายงาน ไม่ใช่เงียบ');

    const sent = JSON.stringify(ai.state.requests[0]);
    assert.ok(sent.includes('หายขาด 100%'), 'ข้อความจริงต้องถึง AI');
    const sys = ai.state.requests[0].system || '';
    assert.ok(/ห้ามแนะนำวิธีเลี่ยงคำ|หลบระบบตรวจ/.test(sys), 'ต้องกำชับไม่ให้สอนเลี่ยงระบบตรวจ');
  });

  test('ประวัติหมวดเหตุผลที่เคยโดนปฏิเสธ ต้องถูกแนบให้ AI', async (t) => {
    const { base, ai, dir } = await boot(t);
    // จำลอง autopilot-state ที่เคยโดนปฏิเสธหมวด สุขภาพ 2 ครั้งใน 7 วัน
    require('fs').writeFileSync(require('path').join(dir, 'autopilot-state.json'),
      JSON.stringify({ reasons: { [`${ACCT}|สุขภาพและความงาม`]: [Date.now() - 3600 * 1000, Date.now() - 7200 * 1000] } }));
    await post(base, '/api/preflight', { items: [{ message: 'ข้อความทดสอบ' }] });
    const sent = JSON.stringify(ai.state.requests[0]);
    assert.ok(sent.includes('สุขภาพและความงาม'), 'หมวดที่เคยโดนต้องถูกแนบให้ AI เข้มขึ้น');
  });
});

describe('AI เขียนแคปชั่น (/api/captions/generate) — ต้องเป็นแบบร่างเสมอ', () => {
  const genThenCheck = () => ([
    {
      variants: [
        { message: 'แคปชั่นใหม่จาก AI เขียนยาวพอสมควรสำหรับโฆษณา', headline: 'หัวข้อใหม่' },
        { message: 'ข้อความโฆษณาทดสอบชุดที่ 1', headline: 'ตัวนี้ซ้ำกับของเดิมเป๊ะ' },   // ต้องถูกกรองทิ้ง
      ],
    },
    { items: [{ index: 0, risk: 'low', issues: [], advice: null }] },   // ผลตรวจนโยบายของ variant ที่รอด
  ]);

  test('ของที่ AI เขียนเข้าคลังเป็น draft, ตัวซ้ำถูกกรอง, ผ่านตรวจนโยบาย', async (t) => {
    const { base, ai } = await boot(t, { aiAnswer: genThenCheck() });
    const r = await post(base, '/api/captions/generate', { count: 5 });
    assert.strictEqual((r.drafts || []).length, 1, 'ตัวซ้ำกับคลังต้องถูกกรอง เหลือตัวเดียว');
    assert.strictEqual(r.drafts[0].draft, true, 'ต้องเป็นแบบร่าง ห้ามเข้าคลังจริงเอง');
    assert.strictEqual(r.drafts[0].risk, 'low', 'ผลตรวจนโยบายต้องติดมากับแบบร่าง');

    // ตัวอย่าง+คำกำชับต้องถึง AI จริง
    const sent = JSON.stringify(ai.state.requests[0]);
    assert.ok(sent.includes('ข้อความโฆษณาทดสอบชุดที่ 1'), 'แคปชั่นเดิมต้องถูกส่งเป็นตัวอย่าง');
    assert.match(ai.state.requests[0].system || '', /Không tự bịa giá|lời hứa mới/i, 'ต้องห้าม AI แต่งข้อเสนอใหม่');
    assert.match(ai.state.requests[0].system || '', /tiếng Việt/i, 'ต้องบังคับให้ AI เขียนภาษาเวียดนามเสมอ');
    assert.match(ai.state.requests[0].messages?.[0]?.content || '', /Đây là các caption đã dùng thật/, 'ต้องบอกให้ AI อ่านแคปชั่นเดิมก่อนเขียน');
    assert.strictEqual(ai.state.requests.length, 2, 'ต้องมีรอบตรวจนโยบายตามหลังรอบเขียน');

    const all = await get(base, '/api/captions');
    assert.strictEqual(all.length, 2, 'คลังต้องมีของเดิม 1 + แบบร่าง 1');
    assert.strictEqual(all[0].draft, true);
  });

  test('draft ต้องไม่ถูกตัวจัดแผนหยิบใช้ จนกว่าจะกดอนุมัติ', async (t) => {
    const { base } = await boot(t, { aiAnswer: genThenCheck() });
    const r = await post(base, '/api/captions/generate', { count: 5 });
    const draftId = r.drafts[0].id;

    // ก่อนอนุมัติ: ตัวจัดแผนขอ 2 แอด ต้องวนใช้แคปชั่นจริงตัวเดียว ไม่แตะ draft
    const plan1 = await post(base, '/api/autoplan', { accounts: [{ pid: 'p1', acctId: ACCT, name: 'บัญชีเทส' }], perAccount: 2 });
    const used1 = plan1.plan.flatMap((a) => a.ads.map((x) => x.captionId));
    assert.ok(used1.length >= 2, 'ต้องได้แผนมาจริง');
    assert.ok(!used1.includes(draftId), 'draft หลุดไปถูกใช้ก่อนอนุมัติ = ของที่เจ้าของยังไม่เห็นถูกยิงด้วยเงินจริง');

    // อนุมัติแล้วต้องถูกหยิบใช้ได้
    const ok = await post(base, '/api/captions/approve', { id: draftId });
    assert.strictEqual(ok.ok, true);
    const plan2 = await post(base, '/api/autoplan', { accounts: [{ pid: 'p1', acctId: ACCT, name: 'บัญชีเทส' }], perAccount: 2 });
    const used2 = plan2.plan.flatMap((a) => a.ads.map((x) => x.captionId));
    assert.ok(used2.includes(draftId), 'อนุมัติแล้วตัวจัดแผนต้องมองเห็น');

    const all = await get(base, '/api/captions');
    assert.ok(!all.find((c) => c.id === draftId).draft, 'ธง draft ต้องหายหลังอนุมัติ');
  });

  test('คลังว่าง (มีแต่ draft หรือไม่มีเลย) ต้องไม่ให้ AI เขียนจากความว่างเปล่า', async (t) => {
    const { base, ai } = await boot(t, { captions: 0 });
    const r = await post(base, '/api/captions/generate', {});
    assert.match(r.error || '', /ตัวอย่าง/, 'ไม่มีตัวอย่างต้องปฏิเสธ — AI แต่งเองคือแต่งข้อเสนอมั่ว');
    assert.strictEqual(ai.state.requests.length, 0);
  });

  test('AI เขียนมาแต่ตัวซ้ำทั้งหมด ต้องได้ error ไม่ใช่คลังบวมด้วยของซ้ำ', async (t) => {
    const { base } = await boot(t, {
      aiAnswer: { variants: [{ message: 'ข้อความโฆษณาทดสอบชุดที่ 1', headline: '' }] },
    });
    const r = await post(base, '/api/captions/generate', {});
    assert.ok(r.error, 'ต้องมี error');
    const all = await get(base, '/api/captions');
    assert.strictEqual(all.length, 1, 'คลังต้องไม่บวม');
  });

  test('สถิติจริงจาก FB ต้องถึง AI แยกต่อสกุลเงิน ไม่ใช่บวกข้ามสกุล', async (t) => {
    const fbWorld = {
      accounts: [
        { name: 'บัญชีไทย', account_id: '111', account_status: 1, currency: 'THB' },
        { name: 'บัญชีญี่ปุ่น', account_id: '222', account_status: 1, currency: 'JPY' },
      ],
      campaigns: [], adsets: [],
      // แอดจริงที่ใช้ข้อความตรงกับแคปชั่นในคลัง — คนละบัญชี คนละสกุลเงิน
      ads: [
        { id: 'ad1', acct: '111', creative: { body: 'ข้อความโฆษณาทดสอบชุดที่ 1' }, effective_status: 'ACTIVE' },
        { id: 'ad2', acct: '222', creative: { body: 'ข้อความโฆษณาทดสอบชุดที่ 1' }, effective_status: 'ACTIVE' },
      ],
      insights: [
        { acct: '111', ad_id: 'ad1', spend: '300.00', actions: [] },
        { acct: '222', ad_id: 'ad2', spend: '500', actions: [] },
      ],
    };
    const { base, ai } = await boot(t, { aiAnswer: genThenCheck(), fbWorld });
    const r = await post(base, '/api/captions/generate', {});
    assert.ok(!r.error, `ต้องไม่ error: ${r.error}`);
    const sent = JSON.stringify(ai.state.requests[0]);
    assert.ok(sent.includes('300 THB'), 'ยอดฝั่งไทยต้องรายงานพร้อมสกุลเงิน');
    assert.ok(sent.includes('500 JPY'), 'ยอดฝั่งญี่ปุ่นต้องแยกของมัน');
    assert.ok(!sent.includes('800'), 'ห้ามบวก 300 THB + 500 JPY เป็น 800 เด็ดขาด');
  });

  test('แก้ข้อความแบบร่าง ป้ายผลตรวจนโยบายเดิมต้องหมดอายุ ไม่ใช่ค้างว่า "ผ่าน"', async (t) => {
    const { base } = await boot(t, { aiAnswer: genThenCheck() });
    const r = await post(base, '/api/captions/generate', {});
    assert.strictEqual(r.drafts[0].risk, 'low');
    await post(base, '/api/captions/update', { id: r.drafts[0].id, message: 'ข้อความใหม่ที่คนแก้เองหลัง AI ตรวจไปแล้ว', headline: '' });
    const all = await get(base, '/api/captions');
    const item = all.find((c) => c.id === r.drafts[0].id);
    assert.strictEqual(item.draft, true, 'แก้ข้อความไม่ใช่การอนุมัติ');
    assert.strictEqual(item.risk, 'unchecked', 'ผลตรวจเดิมต้องถูกล้าง — ข้อความใหม่ยังไม่เคยถูกตรวจ');
  });
});

describe('เกราะกัน key เสียทับ key จริง (/api/ai-key)', () => {
  test('ค่าที่ไม่ใช่ key ของ Anthropic ต้องถูกปฏิเสธ — key เดิมห้ามหาย', async (t) => {
    const { base } = await boot(t);   // config มี anthropicKey 'sk-test' อยู่แล้ว... ใส่ key จริงรูปแบบถูกก่อน
    await post(base, '/api/ai-key', { key: 'sk-ant-ของจริงยาวๆ' });
    // เหตุการณ์จริงที่เคยเกิด: browser autofill ยัดรหัสผ่าน 32 ตัวลงช่อง แล้วถูกเซฟทับ
    const r = await post(base, '/api/ai-key', { key: 'b7d5b4c0123456789abcdef012345678' });
    assert.ok(r.error, 'ของปลอมต้องถูกปฏิเสธ');
    assert.match(r.error, /sk-ant/, 'ต้องบอกรูปแบบที่ถูกต้อง');
    const st = await get(base, '/api/ai-key');
    assert.strictEqual(st.hasKey, true, 'key จริงต้องยังอยู่ ไม่ถูกทับ');
  });

  test('ค่าว่าง = ตั้งใจลบ ยังลบได้ (ปุ่มลบในหน้าเว็บใช้เส้นนี้)', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/ai-key', { key: 'sk-ant-abc123' });
    const r = await post(base, '/api/ai-key', { key: '' });
    assert.strictEqual(r.ok, true);
    const st = await get(base, '/api/ai-key');
    assert.strictEqual(st.hasKey, false, 'ลบโดยตั้งใจต้องลบได้จริง');
  });
});

describe('ตั้งรุ่น AI จากหน้าเว็บ (/api/ai-model)', () => {
  test('ตั้งรุ่นใหม่: ยิงทดสอบก่อนเซฟ แล้วงานจริงทุกจุดต้องใช้รุ่นนั้น', async (t) => {
    const { base, ai } = await boot(t, { aiAnswer: { items: [] } });
    const r = await post(base, '/api/ai-model', { model: 'claude-test-9' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.effective, 'claude-test-9');
    assert.strictEqual(ai.state.requests[0].model, 'claude-test-9', 'ต้องยิงทดสอบด้วยรุ่นที่จะตั้งจริง');

    await post(base, '/api/preflight', { items: [{ message: 'ทดสอบรุ่นใหม่' }] });
    assert.strictEqual(ai.state.requests[ai.state.requests.length - 1].model, 'claude-test-9', 'งานจริงต้องใช้รุ่นที่ตั้ง');

    const st = await get(base, '/api/ai-key');
    assert.strictEqual(st.model, 'claude-test-9');
  });

  test('ชื่อรุ่นมั่วต้องถูกปฏิเสธ ไม่ลงดิสก์ — ล้างค่าแล้วกลับไปใช้ค่าตั้งต้น', async (t) => {
    const { base, ai } = await boot(t, { aiAnswer: { items: [] } });
    const bad = await post(base, '/api/ai-model', { model: 'x y!!<script>' });
    assert.ok(bad.error, 'ชื่อรุ่นผิดรูปแบบต้องมี error');
    let st = await get(base, '/api/ai-key');
    assert.strictEqual(st.model, '', 'ของเสียห้ามลงดิสก์');

    const clear = await post(base, '/api/ai-model', { model: '' });
    assert.strictEqual(clear.effective, st.defaultModel, 'ล้างค่า = ใช้ค่าตั้งต้น');
    await post(base, '/api/preflight', { items: [{ message: 'ทดสอบ' }] });
    assert.strictEqual(ai.state.requests[ai.state.requests.length - 1].model, st.defaultModel, 'ไม่ตั้ง = รุ่นตั้งต้นเสมอ');
  });
});

describe('ขอบเขตของ pre-flight ที่ต้องไม่โกหกผู้ใช้', () => {
  test('เกิน 20 แอด ต้องรายงาน truncated ตรงๆ และไม่ส่งตัวเกินไปให้ AI แบบครึ่งๆ', async (t) => {
    const { base, ai } = await boot(t, { aiAnswer: { items: [] } });
    const r = await post(base, '/api/preflight', {
      items: Array.from({ length: 22 }, (_, i) => ({ message: `ข้อความที่ ${i}` })),
    });
    assert.strictEqual(r.truncated, 2, 'ต้องบอกว่ามี 2 แอดที่ไม่ถูกตรวจ');
    const sent = JSON.stringify(ai.state.requests[0]);
    assert.ok(sent.includes('แอด #19'), 'ตัวที่ 20 (index 19) ต้องถูกส่ง');
    assert.ok(!sent.includes('แอด #20'), 'ตัวเกินเพดานต้องไม่หลุดไปครึ่งเดียว');
  });

  test('mediaId แปลกปลอม (path traversal) ต้องถูกทิ้ง ไม่ใช่เอาไปเปิดไฟล์', async (t) => {
    const { base, ai } = await boot(t, { aiAnswer: { items: [] } });
    const r = await post(base, '/api/preflight', {
      items: [{ message: 'ข้อความ', mediaId: '../../config' }],
    });
    assert.ok(!r.error, 'ต้องไม่ล่ม');
    assert.ok(!JSON.stringify(ai.state.requests[0]).includes('ภาพหน้าปก'), 'id นอกคลังต้องไม่มีรูปแนบ');
  });

  test('mediaId ที่อยู่ในคลังจริงและมี thumbnail ต้องแนบรูปให้ AI ดู', async (t) => {
    const { base, ai, dir } = await boot(t, { aiAnswer: { items: [] } });
    require('fs').writeFileSync(require('path').join(dir, 'media-library', 'v1.jpg'), Buffer.from('รูปปลอม'));
    await post(base, '/api/preflight', { items: [{ message: 'ข้อความ', mediaId: 'v1' }] });
    const req = ai.state.requests[0];
    assert.ok(JSON.stringify(req).includes('ภาพหน้าปกวิดีโอของแอด #0'), 'ต้องมีป้ายบอกว่ารูปเป็นของแอดไหน');
    const blocks = (req.messages[0] || {}).content || [];
    assert.ok(blocks.some((b) => b.type === 'image' && b.source && b.source.type === 'base64'), 'ต้องมี image block จริง');
  });
});
