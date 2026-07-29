// เทสหน้า Landing: บันทึกค่า → เรนเดอร์หน้าจริง โดยเดินผ่านเซิร์ฟเวอร์จริง
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeFakeFb } = require('./fake-fb');
const { tmpDir, seed, startServer, get, post } = require('./helpers');

async function boot(t) {
  const fb = await makeFakeFb({});
  const dir = tmpDir();
  seed(dir, { config: {} });
  const srv = await startServer(dir, fb.port);
  t.after(() => { srv.stop(); fb.server.close(); });
  return srv;
}
const html = async (base) => (await fetch(base + '/lp')).text();

describe('หน้า Landing', () => {
  test('บันทึกแล้วหน้าจริงต้องแสดงปุ่มและยิงพิกเซลตามที่ตั้ง', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', {
      title: 'ร้านทดสอบ', bio: 'ทักไลน์ได้เลย',
      pixels: [{ type: 'meta', id: '123456789' }, { type: 'ga', id: 'G-ABC123' }],
      links: [{ label: 'แอดไลน์', url: 'https://line.me/ti/p/~x', icon: '💬', event: 'Lead' }],
    });
    const page = await html(base);
    assert.ok(page.includes('ร้านทดสอบ'), 'ต้องมีชื่อร้าน');
    assert.ok(page.includes('https://line.me/ti/p/~x'), 'ต้องมีลิงก์');
    // ต้องเป็นแพตเทิร์นมาตรฐานแบบเขียน id ตรงๆ เพราะเครื่องมือตรวจของ Meta สแกนหาในซอร์ส
    assert.ok(page.includes("fbq('init','123456789')"), 'ต้องมี init แบบเขียน id ตรงตัว ไม่ใช่ประกอบด้วย JS');
    assert.ok(page.includes("fbq('trackSingle','123456789','PageView')"),
      'ต้องยิง PageView ทีละพิกเซล ไม่ใช่ fbq(track) แบบไม่ระบุตัวซึ่งยิงเข้าทุกพิกเซลพร้อมกัน');
    assert.ok(!page.includes("fbq('track','PageView')"), 'ต้องไม่เหลือรูปแบบเดิมที่ทำให้นับซ้ำ');
    assert.ok(page.includes('G-ABC123'), 'GA ต้องถูกฝัง');
    assert.ok(page.includes('data-ev="Lead"'), 'ปุ่มต้องพก event ที่จะยิงตอนกด');
  });

  test('ลิงก์ที่รันสคริปต์ได้ต้องถูกปฏิเสธ ไม่หลุดไปอยู่ในหน้า', async (t) => {
    const { base } = await boot(t);
    const r = await post(base, '/api/landing', {
      links: [
        { label: 'อันตราย', url: 'javascript:alert(1)' },
        { label: 'อันตราย2', url: 'data:text/html,<script>alert(1)</script>' },
        { label: 'ปกติ', url: 'https://line.me/ti/p/~ok' },
      ],
    });
    assert.strictEqual(r.landing.links.length, 1, 'ต้องเหลือแค่ลิงก์ที่ปลอดภัย');
    assert.strictEqual(r.landing.links[0].label, 'ปกติ');
    const page = await html(base);
    assert.ok(!page.includes('javascript:'), 'javascript: ต้องไม่โผล่ในหน้า');
    assert.ok(!page.includes('data:text/html'), 'data: ต้องไม่โผล่ในหน้า');
  });

  test('ข้อความของผู้ใช้ต้องถูก escape ไม่กลายเป็น HTML', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', {
      title: '<script>alert(1)</script>',
      links: [{ label: '<img src=x onerror=alert(1)>', url: 'https://ok.test/a' }],
    });
    const page = await html(base);
    assert.ok(!page.includes('<script>alert(1)</script>'), 'ชื่อร้านต้องไม่กลายเป็นสคริปต์');
    assert.ok(!page.includes('<img src=x'), 'ข้อความบนปุ่มต้องไม่กลายเป็นแท็ก');
    assert.ok(page.includes('&lt;script&gt;'), 'ต้องถูก escape ไว้แสดงเป็นข้อความ');
  });

  test('ปุ่มที่ไม่มีข้อความหรือไม่มีลิงก์ต้องไม่ถูกบันทึก', async (t) => {
    const { base } = await boot(t);
    const r = await post(base, '/api/landing', {
      links: [{ label: '', url: 'https://ok.test/a' }, { label: 'ไม่มีลิงก์', url: '' }],
    });
    assert.strictEqual(r.landing.links.length, 0);
  });

  test('tel: และ mailto: ใช้ได้ เพราะเป็นลิงก์ติดต่อปกติ', async (t) => {
    const { base } = await boot(t);
    const r = await post(base, '/api/landing', {
      links: [
        { label: 'โทร', url: 'tel:021234567' },
        { label: 'อีเมล', url: 'mailto:a@b.com' },
      ],
    });
    assert.strictEqual(r.landing.links.length, 2);
  });

  // บั๊กที่ผู้ใช้เจอ: พิมพ์ line.me/... เฉยๆ แล้วกดบันทึก ปุ่มหายเงียบๆ
  // หลังบ้านเติม scheme ให้ก่อนส่ง แต่เซิร์ฟเวอร์ต้องยังปฏิเสธของที่ไม่มี scheme จริงๆ อยู่
  test('เซิร์ฟเวอร์ยังต้องปฏิเสธลิงก์ที่ไม่มี scheme (หน้าเว็บเป็นคนเติมให้)', async (t) => {
    const { base } = await boot(t);
    const r = await post(base, '/api/landing', {
      links: [{ label: 'ไลน์', url: 'line.me/ti/p/~x' }],
    });
    assert.strictEqual(r.landing.links.length, 0,
      'ไม่มี scheme = ปฏิเสธ เพราะเบราว์เซอร์จะตีความเป็น path ของเว็บเรา ไม่ใช่ลิงก์ออกไปข้างนอก');
  });

  test('ลิงก์หลังบ้านเดิม /lp/admin ต้องพาไปหน้าหลัก ไม่ใช่ 404', async (t) => {
    const { base } = await boot(t);
    const r = await fetch(base + '/lp/admin', { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.get('location'), /#landing$/);
  });

  test('อัปรูปได้ และเสิร์ฟกลับได้', async (t) => {
    const { base } = await boot(t);
    const fd = new FormData();
    // เนื้อไฟล์ไม่สำคัญ ระบบตัดสินจาก mimetype — ขอแค่มีข้อมูลจริงส่งไป
    fd.append('file', new Blob([Buffer.alloc(256, 7)], { type: 'image/png' }), 'a.png');
    const up = await (await fetch(base + '/api/landing/upload', { method: 'POST', body: fd })).json();
    assert.match(up.url, /^\/lp-asset\/[0-9a-f-]{36}\.png$/, 'ต้องได้ path ของรูปที่อัป');
    assert.strictEqual((await fetch(base + up.url)).status, 200, 'ต้องเสิร์ฟรูปกลับได้');
  });

  test('ไฟล์ที่ไม่ใช่รูปต้องอัปไม่ได้', async (t) => {
    const { base } = await boot(t);
    const fd = new FormData();
    fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
    const r = await fetch(base + '/api/landing/upload', { method: 'POST', body: fd });
    assert.strictEqual(r.status, 400, 'HTML ที่เสิร์ฟกลับออกไปอาจถูกเบราว์เซอร์รันเป็นสคริปต์');
  });

  test('ชื่อไฟล์แปลกปลอมต้องเข้าถึงไฟล์นอกโฟลเดอร์ไม่ได้', async (t) => {
    const { base } = await boot(t);
    for (const bad of ['../config.json', '..%2fconfig.json', 'x.png', 'a'.repeat(36) + '.png']) {
      const r = await fetch(base + '/lp-asset/' + bad);
      assert.ok(r.status === 400 || r.status === 404, `${bad} ต้องไม่ได้ไฟล์ (ได้ ${r.status})`);
    }
  });

  test('พื้นหลัง: รับเฉพาะชื่อที่มีจริง และรูปที่อัปผ่านระบบเราเท่านั้น', async (t) => {
    const { base } = await boot(t);
    const ok = await post(base, '/api/landing', { bg: 'mint' });
    assert.strictEqual(ok.landing.bg, 'mint');
    const bad = await post(base, '/api/landing', { bg: 'ไม่มีจริง', bgImage: 'https://evil.test/x.jpg' });
    assert.strictEqual(bad.landing.bg, '', 'ชื่อพื้นหลังที่ไม่มีในระบบต้องถูกปัดทิ้ง');
    assert.strictEqual(bad.landing.bgImage, '', 'รูปจากเว็บนอกต้องไม่ถูกรับ');
  });

  test('เลือกพื้นหลังแล้วต้องมีผลกับหน้าจริง', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', { bg: 'night' });
    assert.ok((await html(base)).includes('#232838'), 'CSS ของพื้นหลังที่เลือกต้องอยู่ในหน้า');
  });

  // เคสที่ผู้ใช้เจอจริง: เลือกพื้นหลังสว่าง แต่ theme ค้างเป็น dark เลยได้ปุ่มดำบนพื้นม่วงอ่อน
  test('พื้นหลังเป็นตัวกำหนดสีการ์ด/ตัวหนังสือ ไม่ใช่ theme ที่ค้างอยู่', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', { bg: 'lilac', theme: 'dark' });
    const light = await html(base);
    assert.ok(light.includes('--card:#fdfbff'), 'พื้นสว่างต้องได้การ์ดสว่าง แม้ theme จะเป็น dark');
    assert.ok(!light.includes('--card:#1b1e26'), 'ต้องไม่ใช้การ์ดมืด');

    await post(base, '/api/landing', { bg: 'night', theme: 'light' });
    const dark = await html(base);
    assert.ok(dark.includes('--card:#242a3a'), 'พื้นมืดต้องได้การ์ดมืด แม้ theme จะเป็น light');
  });

  test('ใช้รูปพื้นหลังเอง ให้ theme เป็นตัวตัดสิน เพราะเราไม่รู้ว่ารูปสว่างหรือมืด', async (t) => {
    const { base } = await boot(t);
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(64, 3)], { type: 'image/png' }), 'b.png');
    const up = await (await fetch(base + '/api/landing/upload', { method: 'POST', body: fd })).json();
    await post(base, '/api/landing', { bgImage: up.url, bg: 'mint', theme: 'dark' });
    const page = await html(base);
    assert.ok(page.includes('--card:#1b1e26'), 'มีรูปพื้นหลัง + theme dark ต้องได้ชุดสีมืด');
    assert.ok(page.includes(up.url), 'รูปต้องถูกใช้เป็นพื้นหลัง');
  });

  // 1 บัญชี = 1 พิกเซล ระบบฝังให้เองเรื่อยๆ ตอนขึ้นแอด/เติมแอด เพดานเดิม 30 จึงต่ำกว่าของจริง
  // ผลคือกดบันทึกหน้า Landing ครั้งเดียว พิกเซลท้ายๆ หายเงียบ บัญชีนั้นเห็นคอนเวอร์ชั่นเป็น 0 ทั้งที่คนกดจริง
  test('บันทึกหน้า Landing ต้องไม่ตัดพิกเซลของบัญชีทิ้ง', async (t) => {
    const { base } = await boot(t);
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'meta', id: String(100000 + i) }));
    const saved = await post(base, '/api/landing', { pixels: many });
    assert.strictEqual(saved.landing.pixels.length, 40, 'พิกเซลเกิน 30 ต้องไม่ถูกตัดทิ้ง');
    // แก้แค่ชื่อร้าน (หน้าเว็บส่งค่าเดิมกลับมาทั้งก้อน) พิกเซลต้องอยู่ครบเหมือนเดิม
    const again = await post(base, '/api/landing', { title: 'แก้แค่ชื่อ', pixels: many });
    assert.strictEqual(again.landing.pixels.length, 40, 'บันทึกซ้ำต้องไม่ทำให้พิกเซลหาย');
    const page = await html(base);
    assert.ok(page.includes("fbq('init','100039')"), 'พิกเซลตัวท้ายต้องยังอยู่บนหน้าจริง');
  });

  test('ค่าที่บันทึกต้องอยู่รอดข้ามการอ่านใหม่', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', { title: 'ก่อนแก้', links: [{ label: 'ก', url: 'https://ok.test/a' }] });
    await post(base, '/api/landing', { title: 'หลังแก้' });
    const d = await get(base, '/api/landing');
    assert.strictEqual(d.title, 'หลังแก้');
    assert.strictEqual(d.links.length, 1, 'แก้เฉพาะชื่อ ปุ่มเดิมต้องไม่หาย');
  });

  // เดิมพิกเซลถูกผูกเข้าหน้า Landing เฉพาะตอนขึ้นแอดเอง/autopilot เติมแอด
  // บัญชีที่ยังไม่ถึงคิวจึงค้างไม่ผูก = ยิงแอดไปแล้วแต่คอนเวอร์ชั่นขึ้นศูนย์
  test('หน้าสุขภาพต้องผูกพิกเซลที่ยังไม่ผูกเข้าหน้า Landing ให้เอง', async (t) => {
    const fb = await makeFakeFb({
      accounts: [
        { name: 'ใช้งานได้', account_id: '111', account_status: 1, adspixels: { data: [{ id: 'pxA', name: 'A' }] } },
        { name: 'ถูกซ่อน', account_id: '222', account_status: 1, adspixels: { data: [{ id: 'pxB', name: 'B' }] } },
        { name: 'ถูกปิด', account_id: '333', account_status: 2, adspixels: { data: [{ id: 'pxC', name: 'C' }] } },
      ],
      pages: [],
    });
    const dir = tmpDir();
    seed(dir, {
      config: {
        profiles: [{ id: 'p1', label: 'เทส', accessToken: 'tok' }],
        activeProfileId: 'p1',
        hidden: { accounts: { 222: true } },
      },
    });
    const srv = await startServer(dir, fb.port);
    t.after(() => { srv.stop(); fb.server.close(); });

    const d = await get(srv.base, '/api/health-overview?profile=p1');
    assert.deepStrictEqual(d.boundToLp, ['pxA'], 'ผูกให้เฉพาะบัญชีที่ใช้งานได้และไม่ถูกซ่อน');
    const lp = await get(srv.base, '/api/landing');
    assert.deepStrictEqual(lp.pixels.map((p) => p.id), ['pxA']);

    const onLp = Object.fromEntries(d.accounts.flatMap((a) => a.pixels.map((x) => [x.id, x.onLp])));
    assert.strictEqual(onLp.pxA, true, 'ต้องบอกหน้าเว็บว่าผูกแล้ว');
    assert.strictEqual(onLp.pxB, false, 'บัญชีที่ซ่อนต้องขึ้นว่ายังไม่ผูก');

    const again = await get(srv.base, '/api/health-overview?profile=p1');
    assert.deepStrictEqual(again.boundToLp, [], 'เปิดหน้าซ้ำต้องไม่ผูกซ้ำ');

    const page = await html(srv.base);
    assert.ok(page.includes("fbq('init','pxA')"), 'พิกเซลที่ผูกต้องขึ้นบนหน้าจริง');
    assert.ok(!page.includes('pxB'), 'พิกเซลของบัญชีที่ซ่อนต้องไม่ถูกฝัง');
    assert.ok(!page.includes('pxC'), 'พิกเซลของบัญชีที่ถูกปิดต้องไม่ถูกฝัง');
  });

  // เคยกรองพิกเซลตามบัญชีด้วย ?a= แล้ววัดพบว่าทุกพิกเซลได้ conversion ต่ำกว่าเกณฑ์
  // learning phase ของ Meta (~50/สัปดาห์) — ทั้งระบบได้ 61/สัปดาห์ แต่พอหารรายบัญชีเหลือ
  // 29/21/10/1/0/0/0/0 = ไม่มีพิกเซลไหนเรียนรู้ได้เลย จึงเลิกกรอง ให้ทุกตัวเห็นข้อมูลเต็ม
  // เทสนี้ล็อกไว้ว่าห้ามกลับไปกรองอีกโดยไม่ได้ตั้งใจ
  test('หน้า LP ต้องยิงทุกพิกเซลเสมอ ไม่ว่าจะมี ?a= หรือไม่', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', {
      pixels: [
        { type: 'meta', id: '111111', acct: '900' },
        { type: 'meta', id: '222222', acct: '901' },
        { type: 'meta', id: '333333' },
        { type: 'ga', id: 'G-XYZ' },
      ],
    });
    // ทุกทางเข้าต้องได้ผลเหมือนกันหมด รวมถึง ?a= ที่ไม่ตรงกับพิกเซลไหนเลย
    for (const path of ['/lp', '/lp?a=900', '/lp?a=999']) {
      const page = await (await fetch(base + path)).text();
      for (const id of ['111111', '222222', '333333']) {
        assert.ok(page.includes(`fbq('init','${id}')`), `${path}: ต้องมีพิกเซล ${id}`);
        assert.ok(page.includes(`fbq('trackSingle','${id}','PageView')`), `${path}: ${id} ต้องยิง PageView`);
      }
      assert.ok(page.includes('G-XYZ'), `${path}: GA ยังต้องทำงาน`);
    }
    // trackSingle คือตัวกันนับซ้ำในพิกเซลเดียวกัน คนละเรื่องกับการกรองรายบัญชี — ห้ามหลุดกลับเป็น track
    // ต้องตัดบรรทัดคอมเมนต์ทิ้งก่อน เพราะในหน้ามีคอมเมนต์ที่เขียนคำว่า fbq('track',...) ไว้เตือนอยู่
    const one = await (await fetch(base + '/lp')).text();
    const code = one.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/fbq\('track',/.test(code), "ห้ามใช้ fbq('track',...) แบบไม่ระบุพิกเซล จะนับซ้ำข้ามพิกเซล");
  });

  test('บันทึกจากหน้าเว็บต้องไม่ทำให้บัญชีเจ้าของพิกเซลหาย', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', { pixels: [{ type: 'meta', id: '111111', acct: '900' }] });
    const saved = await get(base, '/api/landing');
    await post(base, '/api/landing', { title: 'แก้แค่ชื่อ', pixels: saved.pixels });
    const after = await get(base, '/api/landing');
    assert.strictEqual(after.pixels[0].acct, '900', 'acct ต้องรอดข้ามการบันทึก');
  });
});
