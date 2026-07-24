const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('หน้า Terms และ App icon ต้องเป็น public asset สำหรับ Meta App Review', () => {
  const terms = fs.readFileSync(path.join(root, 'public', 'terms.html'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'public', 'privacy.html'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, 'redeploy.sh'), 'utf8');
  const icon = path.join(root, 'public', 'meta-app-icon.png');

  assert.match(terms, /ข้อกำหนดการใช้บริการ/);
  assert.match(terms, /privacy\.html/);
  assert.match(terms, /komsanchartsom007@gmail\.com/);
  assert.match(privacy, /terms\.html/, 'Privacy ต้องพาไปอ่าน Terms ได้');
  assert.match(privacy, /komsanchartsom007@gmail\.com/, 'ข้อมูลติดต่อ Privacy ต้องตรงกับ Terms');
  assert.match(deploy, /Path\(`\/terms\.html`\)/, 'Terms ต้องข้าม Basic Auth');
  assert.match(deploy, /Path\(`\/meta-app-icon\.png`\)/, 'icon สำหรับอัปโหลดต้องเปิดดาวน์โหลดได้');
  assert.ok(fs.statSync(icon).size > 10_000, 'App icon ต้องมีไฟล์จริง');
});
