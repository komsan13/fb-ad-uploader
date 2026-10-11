// ช่วงวันที่ที่หน้าเว็บเลือก (วันนี้/เมื่อวาน/7 วัน/...) ต้องไปถึง FB จริง
// ทุก endpoint มี whitelist ของตัวเอง — ค่าที่ไม่อยู่ในลิสต์จะถูกเปลี่ยนเป็นค่าตั้งต้นเงียบๆ
// ผู้ใช้กด "เมื่อวาน" แต่ได้ตัวเลข "ทั้งหมด" กลับมาโดยไม่มีอะไรเตือน
const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get } = require('./helpers');

const ACCT = '111';
const CAMP = '555';

async function boot(t) {
  const world = {
    accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }],
    campaigns: [], ads: [], adsets: [], insights: [],
    // campaign-detail อ่านแคมเปญตาม id ตรงๆ — FB ปลอมไม่มีเส้นนี้ ตอบให้เองตรงนี้
    route: (m, path) => {
      if (m !== 'GET') return null;
      if (path === CAMP) return { name: 'แคมเปญเทส', objective: 'OUTCOME_SALES', account: { currency: 'THB' } };
      if (path.startsWith(CAMP + '/')) return { data: [] };
      return null;
    },
  };
  const fb = await makeFakeFb(world);
  const dir = tmpDir();
  seed(dir, { config: { profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', adAccountId: ACCT, pageId: 'page1' }], activeProfileId: 'p1' } });
  const srv = await startServer(dir, fb.port);
  t.after(() => { srv.stop(); fb.server.close(); });
  const presetSent = (path) => {
    const call = world.calls.filter((c) => c.path === path && c.params.date_preset).pop();
    return call && call.params.date_preset;
  };
  return { base: srv.base, presetSent };
}

test('เมื่อวาน: หน้าแคมเปญต้องขอข้อมูลของเมื่อวานจาก FB', async (t) => {
  const { base, presetSent } = await boot(t);
  const r = await get(base, `/api/campaigns?profile=p1&account=${ACCT}&date=yesterday`);
  assert.strictEqual(r.datePreset, 'yesterday');
  assert.strictEqual(presetSent(`act_${ACCT}/insights`), 'yesterday');
});

test('เมื่อวาน: หน้าต่างรายละเอียดแคมเปญต้องขอของเมื่อวาน', async (t) => {
  const { base, presetSent } = await boot(t);
  const r = await get(base, `/api/campaign-detail?profile=p1&id=${CAMP}&date=yesterday`);
  assert.strictEqual(r.datePreset, 'yesterday');
  assert.strictEqual(presetSent(`${CAMP}/insights`), 'yesterday');
});

test('ค่าแปลกปลอมยังต้องถูกบีบเป็นค่าตั้งต้น ไม่ส่งต่อให้ FB ตรงๆ', async (t) => {
  const { base, presetSent } = await boot(t);
  const r = await get(base, `/api/campaigns?profile=p1&account=${ACCT}&date=last_999d`);
  assert.strictEqual(r.datePreset, 'maximum');
  assert.strictEqual(presetSent(`act_${ACCT}/insights`), 'maximum');
});
