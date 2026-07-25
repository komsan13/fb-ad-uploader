// สถิติครีเอทีฟ: จดผลรีวิวรายคลิป/รายแคปชั่น แล้วเอามาใช้เลือกตัวที่ "ขึ้นง่ายกว่า"
// เดินผ่าน server.js จริง + FB ปลอม เพื่อยืนยันว่าเส้นทางตั้งแต่สร้างแอด → รอบตรวจ → คลัง ต่อกันจริง
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get, post } = require('./helpers');

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
const freshWorld = (over = {}) => ({
  accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
  campaigns: [], ads: [], adsets: [], insights: [], pixels: [{ id: 'px1' }],
  pages: [{ id: 'page1', name: 'เพจหลัก', is_published: true, promotion_eligible: true }],
  ...over,
});

async function boot(t, { world = freshWorld(), config = baseConfig(), videos = 3, captions = 3, cre = null } = {}) {
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config, videos, captions });
  if (cre) fs.writeFileSync(path.join(dir, 'creative-stats.json'), JSON.stringify(cre));
  const srv = await startServer(dir, fb.port);
  t.after(() => { srv.stop(); fb.server.close(); });
  return { ...srv, dir, world };
}
const runTwice = async (base) => {
  await post(base, '/api/autopilot/run');
  return post(base, '/api/autopilot/run');
};
// ข้อความที่ถูกส่งไปสร้างครีเอทีฟจริง — อ่านจาก request ที่ FB ปลอมได้รับ
const sentMessages = (world) => world.calls
  .filter((c) => c.method === 'POST' && c.path === `act_${ACCT}/adcreatives`)
  .map((c) => { try { return JSON.parse(c.params.object_story_spec).video_data.message; } catch { return ''; } });

describe('สถิติครีเอทีฟ', () => {
  test('แอดที่ยิงอยู่จริงต้องถูกจดว่าคลิป+แคปชั่นนั้น "ผ่านรีวิว"', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    assert.ok(world.calls.some((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`), 'ต้องมีการสร้างแอดจริงก่อน');

    // รอบถัดไปเห็นแอดสถานะ ACTIVE ใน FB ปลอม → ต้องจดเป็น "ผ่าน" ให้ทั้งคลิปและแคปชั่น
    await post(base, '/api/autopilot/run');
    const st = await get(base, '/api/creative-stats');
    const okM = Object.values(st.m).reduce((n, x) => n + x.ok, 0);
    const okC = Object.values(st.c).reduce((n, x) => n + x.ok, 0);
    assert.ok(okM > 0, 'คลิปต้องมีแต้มผ่านรีวิว');
    assert.ok(okC > 0, 'แคปชั่นต้องมีแต้มผ่านรีวิว');
    assert.strictEqual(okM, okC, 'แอดหนึ่งตัวต้องจดให้คลิปและแคปชั่นเท่ากัน');
  });

  test('แอดโดนปฏิเสธต้องถูกจดเป็น "ไม่ผ่าน" พร้อมหมวดเหตุผล และนับครั้งเดียวต่อแอด', async (t) => {
    const { base, world } = await boot(t);
    await runTwice(base);
    // FB ตัดสินว่าแอดที่สร้างไปโดนปฏิเสธ พร้อมเหตุผลใน ad_review_feedback (ที่จริง issues_info มักว่าง)
    world.ads.forEach((x) => {
      x.effective_status = 'DISAPPROVED';
      x.ad_review_feedback = { global: { 'สินค้าต้องห้าม': 'ขายของผิดกฎ' } };
    });
    await post(base, '/api/autopilot/run');
    const st1 = await get(base, '/api/creative-stats');
    const bad1 = Object.values(st1.m).reduce((n, x) => n + x.bad, 0);
    assert.ok(bad1 > 0, 'ต้องจดว่าคลิปนั้นไม่ผ่าน');
    assert.ok(Object.values(st1.m).some((x) => x.cats['สินค้าต้องห้าม']), 'ต้องเก็บหมวดเหตุผลไว้ด้วย');

    // แอดเดิมวนกลับมาทุกรอบตรวจ — ห้ามนับซ้ำ ไม่งั้นตัวเลขพองจนพักครีเอทีฟที่ไม่ผิด
    await post(base, '/api/autopilot/run');
    const st2 = await get(base, '/api/creative-stats');
    assert.strictEqual(Object.values(st2.m).reduce((n, x) => n + x.bad, 0), bad1, 'รอบถัดไปต้องไม่นับซ้ำ');
  });

  test('คลิปที่ถูกพักต้องไม่ถูกหยิบไปใช้ — ระบบเลือกตัวที่ยังใช้ได้แทน', async (t) => {
    // v1,v2 โดนปฏิเสธมาแล้วคนละ 2 บัญชี = ถูกพัก เหลือ v3 ตัวเดียวที่ใช้ได้
    const blocked = { ok: 0, bad: 2, accts: { 900: 1, 901: 1 }, cats: {}, usedOn: [] };
    const { base } = await boot(t, { cre: { ads: {}, m: { v1: blocked, v2: blocked }, c: {} } });
    await runTwice(base);
    const lib = await get(base, '/api/library');
    const used = (id) => (lib.find((x) => x.id === id).usedOn || []).includes(ACCT);
    assert.ok(used('v3'), 'ตัวที่ไม่ถูกพักต้องถูกใช้');
    assert.ok(!used('v1') && !used('v2'), 'ตัวที่ถูกพักต้องไม่ถูกหยิบไปใช้เลย');
  });

  test('ถ้าคลิปถูกพักหมดคลัง ต้องหยุดเติมแอดและเตือน ไม่ใช่ฝืนใช้ของที่โดนปฏิเสธ', async (t) => {
    const blocked = { ok: 0, bad: 2, accts: { 900: 1, 901: 1 }, cats: {}, usedOn: [] };
    const { base, world } = await boot(t, { cre: { ads: {}, m: { v1: blocked, v2: blocked, v3: blocked }, c: {} } });
    await runTwice(base);
    assert.ok(!world.calls.some((c) => c.method === 'POST' && c.path === `act_${ACCT}/ads`),
      'ห้ามสร้างแอดเลยเมื่อครีเอทีฟถูกพักทั้งคลัง');
    const s = await get(base, '/api/autopilot');
    assert.ok((s.log || []).some((l) => /ถูกพัก/.test(l.msg || '')), 'ต้องมีบรรทัดล็อกบอกเหตุผล');
  });

  test('แคปชั่นต้องไม่ซ้ำกันเองในบัญชีเดียวกันเมื่อคลังมีพอ', async (t) => {
    const { base, world } = await boot(t, {
      config: baseConfig({ autopilot: { enabled: true, minAds: 3 } }), videos: 3, captions: 3,
    });
    await runTwice(base);
    const msgs = sentMessages(world).filter(Boolean);
    assert.strictEqual(msgs.length, 3, 'ต้องสร้างครบ 3 แอด');
    assert.strictEqual(new Set(msgs).size, 3, 'แคปชั่นทั้ง 3 ตัวต้องไม่ซ้ำกัน');
  });

  test('ปลดพักแล้วต้องกลับมาใช้ได้ และเริ่มนับบัญชีที่ปฏิเสธใหม่', async (t) => {
    const blocked = { ok: 1, bad: 2, accts: { 900: 1, 901: 1 }, cats: { เหตุผลเดิม: 2 }, usedOn: [] };
    const { base } = await boot(t, { cre: { ads: {}, m: { v1: blocked }, c: {} } });
    assert.strictEqual((await get(base, '/api/creative-stats')).m.v1.blocked, true);

    const r = await post(base, '/api/creative-stats/unblock', { kind: 'm', id: 'v1' });
    assert.ok(r.ok, 'ปลดพักต้องสำเร็จ');
    const st = await get(base, '/api/creative-stats');
    assert.strictEqual(st.m.v1.blocked, false, 'ต้องไม่ถูกพักแล้ว');
    assert.strictEqual(st.m.v1.bad, 2, 'ประวัติเดิมต้องยังอยู่ให้ดู');
    assert.strictEqual(st.m.v1.accts, 0, 'ตัวนับบัญชีที่ปฏิเสธต้องเริ่มใหม่');

    const bad = await post(base, '/api/creative-stats/unblock', { kind: 'm', id: 'ไม่มีจริง' });
    assert.ok(bad.error, 'ปลดตัวที่ไม่มีสถิติต้องได้ error ไม่ใช่สร้างข้อมูลขึ้นมาเอง');
  });
});
