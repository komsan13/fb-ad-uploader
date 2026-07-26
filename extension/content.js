// รันบนหน้า Ads Manager ที่ผู้ใช้เปิดอยู่จริง
// token ที่ฝังในหน้าที่เปิดอยู่คือตัวที่สดที่สุด — ตัวที่ background ไป fetch เองบางครั้งได้หน้า
// redirect/ล็อกอินแทน เลยใช้ทางนี้เป็นตัวหลักและให้รอบอัตโนมัติเป็นตัวสำรอง
const t = extractFbToken(document.documentElement.outerHTML);
if (t) chrome.runtime.sendMessage({ type: 'token', token: t });
