const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'install-provisioner.sh'), 'utf8');
const redeploy = fs.readFileSync(path.join(root, 'redeploy.sh'), 'utf8');

test('redeploy ต้องหมุน image pin ของ provisioner เมื่อ build image หลักใหม่', () => {
  assert.match(installer, /if \[\[ "\$CURRENT_PIN" != "\$IMAGE_ID" \]\]; then/,
    'digest ที่รูปแบบถูกแต่เป็น image เก่าต้องถูกแทนด้วย ID ล่าสุด');
  assert.match(installer, /systemctl restart fbad-provisioner/,
    'process ต้องถูก restart เพื่ออ่าน TENANT_IMAGE ใหม่จาก EnvironmentFile');
  assert.match(installer, /\[ -S \/run\/fbad-provisioner\.sock \] \|\|/,
    'installer ต้องรอ socket ก่อนให้ redeploy นำไป mount กับแอดมินหลัก');
  assert.match(redeploy, /bash "\$PWD\/install-provisioner\.sh"/,
    'redeploy หลักต้อง refresh pin หลัง docker build ทุกครั้งเมื่อ provisioner ถูกติดตั้งแล้ว');
});
