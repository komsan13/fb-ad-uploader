# FB Ad Uploader 🚀

โปรแกรมขึ้นแอด Facebook ทีละหลายตัวผ่าน **Marketing API** (ช่องทางทางการของ Meta — ไม่เสี่ยงโดนแบนเหมือน bot กดหน้าเว็บ)

## วิธีใช้งาน

```
cd C:\Users\User\fb-ad-uploader
npm install        (ครั้งแรกครั้งเดียว)
npm start
```

แล้วเปิดเบราว์เซอร์ที่ **http://localhost:4000**

---

## วิธีเอา Access Token (ทำครั้งแรกครั้งเดียว ~15 นาที)

### 1. สร้าง Meta App
1. ไปที่ https://developers.facebook.com → ล็อกอินด้วย FB ที่มีสิทธิ์ในบัญชีโฆษณา
2. กด **My Apps → Create App**
3. เลือก Use case: **Other** → App type: **Business** → ตั้งชื่ออะไรก็ได้ เช่น `My Ad Uploader`
4. สร้างเสร็จแล้ว **ไม่ต้องส่ง App Review** — โหมด Development ใช้กับบัญชีโฆษณา/เพจของตัวเองได้เลย

### 2. ออก Token ด้วย Graph API Explorer
1. ไปที่ https://developers.facebook.com/tools/explorer
2. มุมขวา: เลือก **App** ที่เพิ่งสร้าง
3. กด **Add a Permission** เพิ่มสิทธิ์เหล่านี้:
   - `ads_management`
   - `ads_read`
   - `business_management`
   - `pages_show_list`
   - `pages_read_engagement`
4. กด **Generate Access Token** → FB จะเด้งให้ล็อกอิน/ยืนยัน → copy token ที่ได้

### 3. ต่ออายุ token เป็น 60 วัน (token ปกติหมดอายุใน ~2 ชม.)
1. ไปที่ https://developers.facebook.com/tools/debug/accesstoken
2. วาง token → กด **Debug** → กดปุ่ม **Extend Access Token** ด้านล่าง
3. copy token ตัวใหม่ (อายุ ~60 วัน) มาใช้ในโปรแกรม

> 💡 **อยากได้ token ไม่หมดอายุ?** ใช้ System User ใน Business Manager
> (business.facebook.com → Settings → System Users → สร้าง user → Assign asset เป็น ad account + เพจ → Generate token เลือก never expire) เหมาะกับใช้งานระยะยาว

---

## มีหลายเฟส (หลาย FB account) ทำยังไง

**แนวทาง A — แนะนำ:** รวม ad account + เพจทั้งหมดเข้า Business Manager เดียว → สร้าง System User → generate token ไม่หมดอายุ 1 ตัว → ในโปรแกรมเพิ่มหลายการ์ดใช้ token เดียวกัน เลือก ad account ต่างกัน จบ ไม่ต้องสลับ Chrome อีกเลย

**แนวทาง B — token แยกต่อเฟส:** สร้าง Meta App ครั้งเดียวในเฟสหลัก → เพิ่มเฟสอื่นเป็น Tester (App Roles) → เปิด Chrome โปรไฟล์ของแต่ละเฟส เข้า Graph API Explorer เลือกแอปเดียวกัน → generate + extend token → วางในการ์ดบัญชีใหม่ในโปรแกรม ตั้งชื่อตามเฟส (~3-5 นาที/เฟส ทำครั้งเดียว)

## หลายบัญชี FB (Multi-Account)

- หน้า **"บัญชี FB"** เพิ่มได้ไม่จำกัด — แต่ละบัญชีมี token + บัญชีโฆษณา + เพจของตัวเอง
- ถ้าหลาย ad account อยู่ใต้ FB/Business Manager เดียวกัน: ใช้ **token เดียวกัน** แล้วเลือก ad account ต่างกันในแต่ละบัญชีได้เลย
- ตอนขึ้นแอด ติ๊กเลือกที่แถบล่าง **"ขึ้นไปที่:"** ได้หลายบัญชี — แอดชุดเดียวจะถูกสร้างเป็นแคมเปญแยกในทุกบัญชีที่เลือก
- ถ้าบางบัญชี/บางแอดล้มเหลว กดขึ้นซ้ำได้ — ระบบจำว่า (แอด, บัญชี) คู่ไหนสำเร็จแล้วและจะไม่ขึ้นซ้ำ

## การใช้งานในหน้าเว็บ

1. **เชื่อมต่อ** — วาง token กด "เชื่อมต่อ" → เลือกบัญชีโฆษณาและเพจ (จำค่าไว้ให้ ครั้งหน้าไม่ต้องทำใหม่)
2. **ตั้งค่าแคมเปญ** — ชื่อ, วัตถุประสงค์, ปุ่ม CTA (แอดทุกตัวในชุดอยู่ใต้แคมเปญเดียวกัน)
3. **ตั้งค่าเริ่มต้น** — ข้อความ/ลิงก์/งบ/กลุ่มเป้าหมายที่ใช้บ่อย ตั้งครั้งเดียว แอดใหม่ทุกตัวเติมให้อัตโนมัติ
4. **ลากรูปหลายไฟล์มาวางทีเดียว** — 1 รูป = 1 แอด (ตั้งชื่อตามชื่อไฟล์) แล้วค่อยแก้จุดที่ต่างรายตัว
   - ปุ่ม **"ทำซ้ำ"** copy แอดทั้งการ์ด (รวมรูป) ได้เหมือนเดิม
5. กด **🚀 ขึ้นแอดทั้งหมด** — ขึ้นขนานกันทีละ 4 ตัว มี progress bar และสถานะ ✅/❌ บนการ์ดแต่ละใบ
   - ตัวที่ล้มเหลว: แก้ตามข้อความสีแดงแล้วกดขึ้นซ้ำได้เลย — ตัวที่สำเร็จแล้วจะไม่ขึ้นซ้ำ และใช้แคมเปญเดิม

โครงสร้างที่สร้าง: 1 แคมเปญ → แอดละ 1 ad set (เพราะ targeting แยกกันได้) → 1 ad

## ข้อควรรู้

- แอดขึ้นเป็น **PAUSED** โดยค่าเริ่มต้น — งบไม่เดินจนกว่าจะเข้าไปกดเปิดใน Ads Manager (ปลอดภัย ตรวจก่อนเปิดได้)
- งบต่อวันขั้นต่ำของ FB ประมาณ 100 บาท/วัน ต่อ ad set (แล้วแต่บัญชี)
- ตอนนี้รองรับ**รูปภาพ**เท่านั้น (วิดีโอเพิ่มทีหลังได้)
- token 60 วันหมดอายุแล้วแค่ generate ใหม่มาวางแทน (หรือใช้ System User token จะไม่หมดอายุ)
- token เก็บไว้ในไฟล์ `config.json` ในเครื่องคุณเท่านั้น — **อย่าแชร์ไฟล์นี้ให้ใคร**
- ถ้าขึ้นแอดถี่มากๆ อาจเจอ rate limit ของ FB ชั่วคราว — รอ 5-10 นาทีแล้วขึ้นต่อได้

---

## เปิดเช่าแบบแยกผู้เช่า

ใช้ `tenant-deploy.sh` สร้าง **หนึ่ง container และหนึ่ง data directory ต่อผู้เช่า** แทนการเพิ่ม profile ของลูกค้าหลายคนใน instance เดียว จึงแยก `config.json` (รวม Meta token), media, captions, Landing, autopilot state, Telegram และ AI settings ออกจากกันจริง

ทุกผู้เช่าอยู่ใต้ `ad.senball.com` เดิม โดย script จะสร้าง profile code แบบสุ่ม 32 ตัวอักษร แล้วรันบนเซิร์ฟเวอร์ในโฟลเดอร์โปรเจกต์:

```bash
TENANT_USER=shop-a \
bash tenant-deploy.sh
```

สคริปต์จะถามรหัสแบบซ่อน และบังคับความยาวอย่างน้อย 12 ตัวอักษร จึงไม่ต้องใส่รหัสลงใน command history.

สคริปต์จะแสดง profile code เช่น `a1b2…` เก็บรหัสนี้ไว้เพื่อใช้ตอนอัปเดต ผู้เช่าจะเข้าโปรแกรมที่ `https://ad.senball.com/p/<profile-code>/` ด้วยรหัสของตนเอง และใช้ Landing ที่เปิดสาธารณะเฉพาะร้านที่ `https://ad.senball.com/p/<profile-code>/lp` โดย `MAX_PROFILES=1` บังคับให้ instance เช่านี้มี FB profile เดียว รหัสใน URL เป็นตัวระบุเพื่อกันเข้าผิด ไม่ใช่สิทธิ์เข้าหลังบ้าน

อัปเดตโค้ดโดยไม่เปลี่ยนข้อมูลหรือรหัสของผู้เช่า:

```bash
git pull --ff-only
PROFILE_CODE=<profile-code> ACTION=redeploy bash tenant-deploy.sh
```

หาก container หายแต่ data directory เดิมยังอยู่ ห้ามใช้ `create` ทับ เพราะจะถูกปฏิเสธเพื่อป้องกันการยึดข้อมูลผู้เช่ารายก่อน ให้กู้โดยตั้งใจเท่านั้น (ระบบจะขอรหัสหลังบ้านใหม่):

```bash
PROFILE_CODE=<profile-code> \
RESTORE_CONFIRM=<profile-code> \
TENANT_USER=shop-a \
ACTION=restore bash tenant-deploy.sh
```

ห้ามนำผู้เช่ามาเพิ่มเป็น profile ใน container `fbad` เดิม เพราะ container เก่านั้นเป็นระบบรวม ข้อมูลจะไม่แยกกัน. `tenant-deploy.sh` เก็บข้อมูลของแต่ละรายไว้ที่ `/opt/fbad-tenants/<profile-code>` และไม่เปิด port ตรงออกอินเทอร์เน็ต — เข้าได้ผ่าน Traefik และ Basic Auth ของผู้เช่ารายนั้นเท่านั้น

### เมนูสมาชิกในแอดมินใหญ่

เมนู **สมาชิก** สร้างและจัดการผู้เช่าจากแอดมินใหญ่ได้: สร้าง profile และรหัสเข้าหลังบ้าน, แก้ข้อมูล/วันหมดอายุ, เปลี่ยนรหัส, ระงับการเข้าใช้, archive/restore และเปิด URL หลังบ้านหรือ Landing ของแต่ละราย

ก่อนเปิดเมนูนี้บน production ต้องติดตั้ง root-only provisioner บน host ก่อนหนึ่งครั้ง แล้วค่อย redeploy แอปหลัก:

```bash
cd /opt/fbad
git pull --ff-only
bash redeploy.sh
bash install-provisioner.sh
bash redeploy.sh
```

Provisioner ฟังเฉพาะ Unix socket `/run/fbad-provisioner.sock` และยอมรับเฉพาะ lifecycle ที่กำหนดไว้ตายตัว เว็บแอดมินหลักเป็นเพียง proxy จึง **ไม่ mount Docker socket และไม่ mount data ของผู้เช่า**. ข้อมูลทะเบียนและ audit เก็บที่ `/opt/fbad-provisioner/`; รหัสผ่านไม่ถูกเก็บในทะเบียนหรือส่งกลับ API

Provisioner จะสร้าง private Docker network ต่อผู้เช่าหนึ่งราย แล้วเชื่อมเฉพาะ Traefik กับ tenant container (ไม่ใช้ `web` network ร่วม) เพื่อไม่ให้ tenant ต่อ HTTP ถึง container อื่นโดยตรง. ตอนติดตั้ง script จะตรึง `TENANT_IMAGE` เป็น local Docker image ID (`sha256:...`) ที่เพิ่ง build แล้ว, provisioner ปฏิเสธ mutable tag เช่น `fbad:latest`

`Archive` หยุด instance และย้าย data ไป `/opt/fbad-tenants-archive/` โดยไม่ลบข้อมูล แต่ไม่ได้ pause แคมเปญที่เปิดอยู่บน Meta. `Restore` จะเปิด container ด้วย `AUTOPILOT_HOLD=1`; ต้องพิมพ์ `ENABLE_AUTOPILOT` ในเมนูสมาชิกเพื่อปลด hold อย่างตั้งใจเท่านั้น
