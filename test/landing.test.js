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

  test('ค่าที่บันทึกต้องอยู่รอดข้ามการอ่านใหม่', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', { title: 'ก่อนแก้', links: [{ label: 'ก', url: 'https://ok.test/a' }] });
    await post(base, '/api/landing', { title: 'หลังแก้' });
    const d = await get(base, '/api/landing');
    assert.strictEqual(d.title, 'หลังแก้');
    assert.strictEqual(d.links.length, 1, 'แก้เฉพาะชื่อ ปุ่มเดิมต้องไม่หาย');
  });
});

describe('ดาวน์โหลดส่วนขยาย', () => {
  test('/extension.zip เป็นไฟล์ zip ที่ใช้ได้ และมีไฟล์ของส่วนขยายจริง', async (t) => {
    const { base } = await boot(t);
    const res = await fetch(base + '/extension.zip');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /fbad-extension\.zip/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.slice(0, 2).toString(), 'PK', 'ต้องขึ้นต้นด้วย PK (ไฟล์ zip)');
    assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'ต้องมี End Of Central Directory = โครงสร้าง zip ครบ');
    const s = buf.toString('latin1');
    assert.ok(s.includes('fbad-extension/manifest.json'), 'ใน zip ต้องมี manifest.json ครอบด้วยโฟลเดอร์เดียว');
    assert.ok(s.includes('fbad-extension/background.js'), 'ใน zip ต้องมี background.js');
  });

  test('/extension-install.reg เป็นไฟล์ .reg UTF-16 ที่ตั้ง policy ด้วย ID ตรงกับ update.xml', async (t) => {
    const { base } = await boot(t);
    const res = await fetch(base + '/extension-install.reg');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /\.reg/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepStrictEqual([buf[0], buf[1]], [0xff, 0xfe], 'ต้องมี BOM UTF-16LE ไม่งั้น Windows merge ไม่ได้');
    const text = buf.slice(2).toString('utf16le'); // ข้าม BOM ก่อนอ่านข้อความ
    assert.ok(text.startsWith('Windows Registry Editor Version 5.00'), 'บรรทัดแรกต้องเป็น header ของ .reg');
    assert.ok(text.includes('ExtensionInstallForcelist'), 'ต้องตั้ง policy force-install');
    // ID ใน .reg ต้องตรงกับ appid ใน update.xml ที่เสิร์ฟจริง ไม่งั้นติดตั้งคนละตัว
    const xml = await (await fetch(base + '/ext/update.xml')).text();
    const id = (xml.match(/appid="([a-p]{32})"/) || [])[1];
    assert.ok(id, 'update.xml ต้องมี appid');
    assert.ok(text.includes(id), '.reg ต้องอ้าง ID เดียวกับ update.xml');
  });
});
