const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('tenant ต้องคง /p/<profile-code> ไว้เมื่อเริ่มหน้าและเปลี่ยนเมนู', () => {
  assert.match(page, /const routeUrl = tenantUrl\(name === 'members' \? '\/members' : '\/#' \+ name\);/,
    'เปลี่ยนเมนูของ tenant ต้องไม่ตัด profile path ออกจาก address bar');
  assert.match(page, /history\.replaceState\(null, '', tenantUrl\(startPage === 'members' && directMemberRoute \? '\/members' : '\/#' \+ startPage\)\);/,
    'หน้าแรกของ tenant ต้องไม่ rewrite URL กลับไปแอดมินใหญ่');
});
