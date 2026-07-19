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
    assert.ok(page.includes("fbq('init','123456789')"), 'Meta Pixel ต้องถูกฝัง');
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

  test('ค่าที่บันทึกต้องอยู่รอดข้ามการอ่านใหม่', async (t) => {
    const { base } = await boot(t);
    await post(base, '/api/landing', { title: 'ก่อนแก้', links: [{ label: 'ก', url: 'https://ok.test/a' }] });
    await post(base, '/api/landing', { title: 'หลังแก้' });
    const d = await get(base, '/api/landing');
    assert.strictEqual(d.title, 'หลังแก้');
    assert.strictEqual(d.links.length, 1, 'แก้เฉพาะชื่อ ปุ่มเดิมต้องไม่หาย');
  });
});
