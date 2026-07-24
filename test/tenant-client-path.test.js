const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('tenant ต้องคง /p/<profile-code>/app ไว้เมื่อเริ่มหน้าและเปลี่ยนเมนู', () => {
  assert.match(page, /const appUrl = \(url\) => \(typeof url === 'string' && url\.startsWith\('\/'\) && !url\.startsWith\('\/\/'\)\n  \? `\$\{TENANT_PATH\}\/app\$\{url\}` : url\);/,
    'dashboard ของ tenant ต้องอยู่ใต้ /app เพื่อไม่ย้อนกลับไปหน้า login public');
  assert.match(page, /const routeUrl = name === 'members' \? membersUrl\(\) : appUrl\('\/#' \+ name\);/,
    'เปลี่ยนเมนูของ tenant ต้องไม่ตัด profile path หรือ /app ออกจาก address bar');
  assert.match(page, /history\.replaceState\(null, '', startPage === 'members' && directMemberRoute \? membersUrl\(\) : appUrl\('\/#' \+ startPage\)\);/,
    'หน้าแรกของ tenant ต้องไม่ rewrite URL กลับไป root ซึ่งเป็นหน้า login public');
});
