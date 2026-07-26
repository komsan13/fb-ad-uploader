// ดึง access token ของ Ads Manager ออกจาก HTML ของหน้า
// ใช้ร่วมกันทั้ง background (importScripts) และ content script (โหลดก่อน content.js
// จึงอยู่ world เดียวกัน เรียกฟังก์ชันนี้ได้ตรงๆ) — ที่เดียวจะได้ไม่หลุดซิงก์กัน
//
// รูปแบบพวกนี้แกะมาจาก extension ตระกูลเดียวกัน (AdsMeta v5.3.3 — content.js) ที่ทำเรื่องนี้อยู่แล้ว
// เรียงจากตัวเจาะจงที่สุดไปหลวมที่สุด: ตัวหลวมยิงโดน token ของอย่างอื่นในหน้าได้ จึงต้องอยู่ท้าย
const FB_TOKEN_PATTERNS = [
  /window\.__accessToken="([^"]+)"/,
  /"access_token":"(EAA[A-Za-z0-9_-]{20,})"/,
  /"token":"(EAA[A-Za-z0-9_-]{40,})"/,
  /["'](EAA[A-Za-z0-9_-]{80,})["']/,
];

// คืน token ตัวแรกที่หน้าตาถูกต้อง — ต้องขึ้นต้น EAA เสมอ กัน placeholder อย่าง "NO" ที่ FB ใส่มาเมื่อไม่มีสิทธิ์
function extractFbToken(html) {
  for (const rx of FB_TOKEN_PATTERNS) {
    const m = String(html || '').match(rx);
    if (m && m[1] && m[1].startsWith('EAA')) return m[1];
  }
  return null;
}

// ให้เทสใน node เรียกฟังก์ชันเดียวกับที่ extension ใช้จริงได้ (ในเบราว์เซอร์ไม่มี module)
if (typeof module === 'object' && module.exports) module.exports = { extractFbToken };
