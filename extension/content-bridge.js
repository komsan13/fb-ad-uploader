// สะพานระหว่างหน้าเครื่องมือ (index.html) กับ service worker
// หน้าเว็บส่ง window.postMessage({__fbtool:true,...}) มา → ส่งต่อให้ background → ตอบกลับทาง postMessage
(function () {
  const ORIGIN = window.location.origin;

  // แจ้งหน้าเว็บว่าส่วนขยายพร้อม (เผื่อหน้าเว็บผูก listener ทัน)
  window.postMessage({ __fbtoolExt: true, type: 'present', v: 1 }, ORIGIN);

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const m = e.data;
    if (!m || m.__fbtool !== true) return;
    try {
      chrome.runtime.sendMessage(m.payload, (resp) => {
        const err = chrome.runtime.lastError;
        window.postMessage({
          __fbtoolExt: true, type: 'response', reqId: m.reqId,
          resp: resp || { ok: false, error: err ? err.message : 'ไม่มีการตอบกลับจากส่วนขยาย' },
        }, ORIGIN);
      });
    } catch (err) {
      window.postMessage({ __fbtoolExt: true, type: 'response', reqId: m.reqId, resp: { ok: false, error: String(err && err.message || err) } }, ORIGIN);
    }
  });
})();
