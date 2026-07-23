const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('หน้าแอปประกาศ favicon แบบฝัง เพื่อตัด request /favicon.ico ที่หลุดไป master', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/,
    'favicon ต้องฝังในเอกสาร ไม่ให้ browser ขอ /favicon.ico ที่ origin root');
});
