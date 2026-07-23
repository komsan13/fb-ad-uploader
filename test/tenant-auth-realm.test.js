const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const masterDeploy = fs.readFileSync(path.join(root, 'redeploy.sh'), 'utf8');
const tenantDeploy = fs.readFileSync(path.join(root, 'tenant-deploy.sh'), 'utf8');

test('master และ tenant ต้องใช้ Basic Auth realm คนละ protection space', () => {
  assert.match(masterDeploy, /traefik\.http\.middlewares\.fbad-auth\.basicauth\.realm=fbad-master/,
    'master ต้องประกาศ realm ของตัวเอง ไม่ใช้ค่า default ของ Traefik');
  assert.match(tenantDeploy, /traefik\.http\.middlewares\.\$\{AUTH\}\.basicauth\.realm=fbad-tenant-\$\{PROFILE_CODE\}/,
    'tenant แต่ละ profile ต้องมี realm เฉพาะ ไม่ปะปน credential กับ master หรือ tenant รายอื่น');
});
