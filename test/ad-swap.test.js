// ปุ่ม "แก้ไขแอด" (13 ต.ค. 2026): เปลี่ยนคลิปของแอดเดิมที่ระดับแอดอย่างเดียว
// ผู้ใช้กำหนด: ห้ามแตะแคมเปญ/ชุดโฆษณา — ใน Ads Manager ถ้าชุดโฆษณามีปัญหา กดเผยแพร่การแก้ไขไม่ผ่านทั้งก้อน
// รัน server.js จริงคุยกับ FB ปลอม แล้วยืนยันจาก request ที่ FB ได้รับ
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, post, readState } = require('./helpers');

const ACCT = '111';
const AD = '5001';
const videoAd = (extra = {}) => ({
  id: AD, acct: ACCT, account_id: ACCT, name: 'TOP sss3 1/2', status: 'ACTIVE', effective_status: 'DISAPPROVED', adset_id: '4001',
  creative: { id: 'cr1', object_story_spec: { page_id: 'page1', video_data: {
    video_id: 'vidOld', message: 'ข้อความเดิม', title: 'หัวข้อเดิม', image_url: 'http://old.test/thumb.jpg', image_hash: 'oldhash',
    call_to_action: { type: 'LEARN_MORE', value: { link: 'https://example.com/' } },
  } } },
  ...extra,
});

async function boot(t, world, { cooldown, config = {} } = {}) {
  const fb = await makeFakeFb({ accounts: [{ name: 'บัญชีเทส', account_id: ACCT, account_status: 1, currency: 'THB' }], campaigns: [], adsets: [], insights: [], ...world });
  const dir = tmpDir();
  seed(dir, { videos: 2, config: { profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok', adAccountId: ACCT, pageId: 'page1' }], activeProfileId: 'p1', ...config } });
  if (cooldown) fs.writeFileSync(path.join(dir, 'fb-cooldown.json'), JSON.stringify(cooldown));
  const srv = await startServer(dir, fb.port, { WATCH_FIRST_DELAY_MS: String(10 * 3600 * 1000), TG_API_BASE: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: '' });
  t.after(() => { srv.stop(); fb.server.close(); });
  const posts = () => fb.world.calls.filter((c) => c.method === 'POST');
  return { base: srv.base, world: fb.world, dir, posts };
}
const swap = (base, body) => fetch(base + '/api/ad-swap-video', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'p1', adId: AD, mediaId: 'v2', ...body }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('เปลี่ยนคลิป: ยิงแค่ระดับแอด ไม่แตะแคมเปญ/ชุดโฆษณา ไม่เปลี่ยนสถานะ ข้อความคงเดิม', async (t) => {
  const { base, world, dir, posts } = await boot(t, {
    ads: [videoAd()],
    route: (m, p) => (m === 'POST' && p === `act_${ACCT}/adcreatives` ? { id: '8888' } : null),
  });
  const r = await swap(base);
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });

  // ทุก POST ต้องเป็นแค่: อัปคลิป, สร้างครีเอทีฟ, แก้แอดตัวนี้ — ห้ามมี adsets/campaigns/ads ใหม่เด็ดขาด
  assert.deepStrictEqual(posts().map((c) => c.path), [`act_${ACCT}/advideos`, `act_${ACCT}/adcreatives`, AD]);

  const newVid = world.videos[0];
  const spec = JSON.parse(posts()[1].params.object_story_spec);
  assert.strictEqual(spec.video_data.video_id, newVid, 'ครีเอทีฟใหม่ต้องใช้คลิปที่เพิ่งอัป');
  assert.strictEqual(spec.video_data.message, 'ข้อความเดิม');
  assert.strictEqual(spec.video_data.title, 'หัวข้อเดิม');
  assert.deepStrictEqual(spec.video_data.call_to_action, { type: 'LEARN_MORE', value: { link: 'https://example.com/' } });
  assert.strictEqual(spec.video_data.image_url, 'http://thumb.test/x.jpg', 'ภาพปกต้องเป็นของคลิปใหม่ ไม่ใช่ของเดิม');
  assert.strictEqual(spec.video_data.image_hash, undefined, 'ปกเดิมแบบ hash ต้องไม่ติดมา');

  const upd = posts()[2].params;
  assert.deepStrictEqual(JSON.parse(upd.creative), { creative_id: '8888' }, 'แอดต้องชี้ไปครีเอทีฟที่เพิ่งสร้าง');
  assert.deepStrictEqual(Object.keys(upd).sort(), ['access_token', 'creative'], 'ห้ามส่ง status/ชื่อ/อย่างอื่น — เปิด/ปิดต้องคงเดิม');

  const lib = JSON.parse(fs.readFileSync(path.join(dir, 'media-library', 'index.json'), 'utf8'));
  assert.deepStrictEqual(lib.find((x) => x.id === 'v2').usedOn, [ACCT], 'ต้องจดว่าคลิปนี้ใช้ในบัญชีนี้แล้ว (ตัวจัดแผนจะเลี่ยงใช้ซ้ำ)');
});

test('แอดที่ไม่ใช่วิดีโอ: บอก error และไม่แตะแอด', async (t) => {
  const { base, posts } = await boot(t, { ads: [videoAd({ creative: { id: 'cr1', object_story_spec: { link_data: { message: 'x' } } } })] });
  const r = await swap(base);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /ไม่ใช่วิดีโอ/);
  assert.strictEqual(posts().length, 0);
});

// ผู้ใช้กำหนด: "ไม่รวมกับแอดที่ปิดอยู่" — ปิดตัวแอดเอง หรือแคมเปญ/ชุดโฆษณาที่ครอบมันปิด
for (const [label, extra] of [
  ['ปิดตัวแอดเอง', { status: 'PAUSED', effective_status: 'PAUSED' }],
  ['แคมเปญปิด', { effective_status: 'CAMPAIGN_PAUSED' }],
  ['ชุดโฆษณาปิด', { effective_status: 'ADSET_PAUSED' }],
]) {
  test(`แอดที่ปิดอยู่ (${label}): ปฏิเสธ ไม่อัปคลิป ไม่แตะแอด`, async (t) => {
    const { base, posts } = await boot(t, { ads: [videoAd(extra)] });
    const r = await swap(base);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /ปิดอยู่/);
    assert.strictEqual(posts().length, 0);
  });
}

// ---- กันชนกับ autopilot (รีวิว adversarial 13 ต.ค.: ชุบแอดที่ autopilot เติมแทนไปแล้ว = ยิงซ้อน +งบเต็มอีกแคมเปญ/วัน) ----
const writeState = (dir, st) => fs.writeFileSync(path.join(dir, 'autopilot-state.json'), JSON.stringify(st));
const adPosts = (posts) => posts().filter((c) => c.path === AD);

test('แอดตายที่ autopilot ตัดสินไปแล้ว: ห้ามแก้ (มันเติมแคมเปญแทนไปแล้ว) ไม่อัปคลิปเลย', async (t) => {
  const { base, dir, posts } = await boot(t, { ads: [videoAd()] });
  writeState(dir, { handled: { [AD]: { v: 'not-fixable', ts: Date.now() } } });
  const r = await swap(base);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /เติมแคมเปญแทน/);
  assert.strictEqual(posts().length, 0);
});

test('แอดที่ autopilot เคยจด แต่ตอนนี้กลับมายิงแล้ว: แก้ได้ (นับเป็นช่องอยู่แล้ว ไม่ซ้อนงบ)', async (t) => {
  const { base, dir } = await boot(t, { ads: [videoAd({ effective_status: 'ACTIVE' })] });
  writeState(dir, { handled: { [AD]: { v: 'not-fixable', ts: Date.now() } } });
  assert.strictEqual((await swap(base)).status, 200);
});

// รีวิวรอบยืนยัน: apRefill เติมแทน "ทุกแอดที่ไม่ได้ยิงอยู่" ในบัญชีที่ autopilot ดูแล แม้ไม่เคยจด handled
// (ไม่มี AI key / ชนเพดานแก้รายวัน / WITH_ISSUES) — ต้องกันตามเกณฑ์เดียวกับ refill ไม่ใช่ตาม handled
const AP_ON = { autopilot: { enabled: true, minAds: 2 } };
for (const st of ['DISAPPROVED', 'WITH_ISSUES']) {
  test(`บัญชีที่ autopilot ดูแล: แอด ${st} ที่ไม่เคยถูกจด ก็ห้ามแก้ (ถูกเติมแทนไปแล้ว)`, async (t) => {
    const { base, posts } = await boot(t, { ads: [videoAd({ effective_status: st })] }, { config: AP_ON });
    const r = await swap(base);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /เติมแคมเปญแทน/);
    assert.strictEqual(posts().length, 0);
  });
}
test('บัญชีที่ autopilot ดูแล: แอดที่ยิงอยู่แก้ได้ • บัญชีที่ซ่อนไว้ (autopilot ไม่แตะ) แก้แอดตายได้', async (t) => {
  const a = await boot(t, { ads: [videoAd({ effective_status: 'ACTIVE' })] }, { config: AP_ON });
  assert.strictEqual((await swap(a.base)).status, 200);
  const b = await boot(t, { ads: [videoAd()] }, { config: { ...AP_ON, hidden: { accounts: { [ACCT]: true } } } });
  assert.strictEqual((await swap(b.base)).status, 200);
});

for (const bag of ['frozen', 'noRotate']) {
  test(`บัญชีที่ autopilot หยุดไว้ (${bag}): ห้ามส่งแอดเข้ารีวิวซ้ำ`, async (t) => {
    const { base, dir, posts } = await boot(t, { ads: [videoAd({ effective_status: 'ACTIVE' })] });
    writeState(dir, { [bag]: { [ACCT]: { since: Date.now(), reason: 'เทส' } } });
    const r = await swap(base);
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /หยุดบัญชีนี้/);
    assert.strictEqual(posts().length, 0);
  });
}

test('autopilot ตัดสินแอดนี้ระหว่างกำลังอัปคลิป: เช็คซ้ำแล้วไม่แตะแอด', async (t) => {
  let dir;
  const { base, posts, dir: d } = await boot(t, {
    ads: [videoAd()],
    route: (m, p) => {
      if (m === 'POST' && p === `act_${ACCT}/advideos`) writeState(dir, { handled: { [AD]: { v: 'fixed', ts: Date.now() } } });
      return null;
    },
  });
  dir = d;
  const r = await swap(base);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /ระหว่างอัปคลิป/);
  assert.strictEqual(adPosts(posts).length, 0, 'ห้ามชุบแอดที่ autopilot เพิ่งขึ้นตัวแก้แทน — ได้สองแอดในชุดเดียว');
});

test('มีคนปิดแอดระหว่างกำลังอัปคลิป: เช็คซ้ำแล้วไม่แตะแอด', async (t) => {
  const world = { ads: [videoAd()] };
  world.route = (m, p) => {
    if (m === 'POST' && p === `act_${ACCT}/advideos`) Object.assign(world.ads[0], { status: 'PAUSED', effective_status: 'PAUSED' });
    return null;
  };
  const { base, posts } = await boot(t, world);
  const r = await swap(base);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /ปิดอยู่/);
  assert.strictEqual(adPosts(posts).length, 0);
});

test('ตารางรายละเอียดแคมเปญ: บอกตัวที่แก้ไม่ได้พร้อมเหตุผล + งบระดับแคมเปญ', async (t) => {
  const CAMP = '9001';
  const world = {
    campaigns: [{ id: CAMP, acct: ACCT, account_id: ACCT, name: 'TOP sss3 1/2', objective: 'OUTCOME_TRAFFIC', daily_budget: '333300', account: { currency: 'THB' } }],
    ads: [videoAd(), videoAd({ id: '5002', effective_status: 'ACTIVE' }), videoAd({ id: '5003', status: 'PAUSED', effective_status: 'PAUSED' })],
  };
  world.route = (m, p) => {
    if (m !== 'GET') return null;
    if (p === `${CAMP}/ads`) return { data: world.ads.map(({ creative, ...a }) => a) };
    if (p.startsWith(CAMP + '/')) return { data: [] };
    return null;
  };
  const { base, dir } = await boot(t, world);
  writeState(dir, { handled: { [AD]: { v: 'not-fixable', ts: Date.now() } } });
  const d = await (await fetch(`${base}/api/campaign-detail?profile=p1&id=${CAMP}&date=today`)).json();
  const by = Object.fromEntries(d.ads.map((a) => [a.id, a.swapBlock]));
  assert.match(by[AD], /เติมแคมเปญแทน/);
  assert.strictEqual(by['5002'], null);
  assert.match(by['5003'], /ปิดอยู่/);
  assert.strictEqual(d.dailyBudget, 3333, 'แคมเปญของ autopilot ตั้งงบระดับแคมเปญ — หน้ายืนยันต้องมีตัวเลขนี้');
});

test('คลิปไม่อยู่ในคลัง / id แปลก: ปฏิเสธก่อนยิง FB สักครั้ง', async (t) => {
  const { base, world } = await boot(t, { ads: [videoAd()] });
  const before = world.calls.length;
  assert.strictEqual((await swap(base, { mediaId: 'ไม่มีจริง' })).status, 400);
  assert.strictEqual((await swap(base, { adId: { toString: 1 } })).status, 400);
  assert.strictEqual((await swap(base, { adId: '5001/adsets' })).status, 400);
  assert.strictEqual(world.calls.filter((c) => c.path !== 'fx').length - before, 0);
});

test('ระหว่าง Meta สั่งพัก (hard): ไม่อัปคลิป ไม่ต่อเวลาพัก', async (t) => {
  const { base, world } = await boot(t, { ads: [videoAd()] }, { cooldown: { coolUntil: Date.now() + 20 * 60000, coolHard: true, appBlocks: {} } });
  const r = await swap(base);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.cooling, true);
  assert.strictEqual(world.calls.filter((c) => c.path !== 'fx').length, 0);
});

test('กดซ้ำระหว่างกำลังอัป: ตัวที่สองถูกปฏิเสธ ไม่ได้ครีเอทีฟสองชุด', async (t) => {
  let hold = true;
  const { base, world, posts } = await boot(t, {
    ads: [videoAd()],
    route: (m, p) => (m === 'POST' && p === `act_${ACCT}/advideos` && hold ? { id: '7777', delay: 800 } : null),
    videos: ['7777'],
  });
  const first = swap(base);
  await new Promise((r) => setTimeout(r, 300));
  const second = await swap(base);
  assert.strictEqual(second.status, 409);
  assert.strictEqual((await first).status, 200);
  hold = false;
  assert.strictEqual(posts().filter((c) => c.path === `act_${ACCT}/adcreatives`).length, 1);
  // เสร็จแล้วต้องปลดล็อก — เปลี่ยนอีกรอบได้
  // (FB ปลอมเก็บ creative เป็นสตริงที่ส่งไป ไม่ได้ขยายเป็นครีเอทีฟจริงแบบ FB — คืนรูปเดิมให้อ่านได้อีกรอบ)
  world.ads[0].creative = videoAd().creative;
  assert.strictEqual((await swap(base)).status, 200);
});

test('แอดที่ autopilot ผูกคลิปไว้: ชี้ไปคลิปใหม่ และล้างผลรีวิวเก่าไม่ให้ไปหักคะแนนคลิปใหม่', async (t) => {
  const { base, dir } = await boot(t, { ads: [videoAd()] });
  const p = path.join(dir, 'autopilot-state.json');
  const st0 = readState(dir) || {};
  st0.creative = { [AD]: { v: 'v1', c: 'c:x', ts: 1 }, other: { v: 'v1', c: 'c:y', ts: 1 } };
  st0.adScore = { [AD]: { v: 'bad', ts: 1 }, other: { v: 'ok', ts: 1 } };
  fs.writeFileSync(p, JSON.stringify(st0));

  assert.strictEqual((await swap(base)).status, 200);
  const st = readState(dir);
  assert.strictEqual(st.creative[AD].v, 'v2');
  assert.strictEqual(st.creative[AD].c, 'c:x', 'แคปชั่นไม่ได้เปลี่ยน ต้องผูกตัวเดิมไว้');
  assert.strictEqual(st.adScore[AD], undefined);
  assert.deepStrictEqual(st.creative.other, { v: 'v1', c: 'c:y', ts: 1 }, 'แอดอื่นต้องไม่ถูกแตะ');
  assert.deepStrictEqual(st.adScore.other, { v: 'ok', ts: 1 });
});
