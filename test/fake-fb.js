// Facebook Graph API ปลอมสำหรับเทส — ชี้ server.js มาที่นี่ด้วย FB_API_BASE
// จุดประสงค์คือเทสโค้ดจริงทั้งเส้น (ประกอบ URL, อ่านค่า, จัดการ error) ไม่ใช่ stub ฟังก์ชันทิ้ง
const http = require('http');

function makeFakeFb(world) {
  // world = สถานะที่เทสควบคุมได้ + บันทึกทุก request ที่เข้ามา ไว้ยืนยันว่าโค้ดส่งอะไรไป
  world.calls = [];
  world.seq = world.seq || 1000;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const params = Object.fromEntries(new URLSearchParams(req.method === 'GET' ? u.search : body));
      const path = u.pathname.replace(/^\/+/, '');
      world.calls.push({ method: req.method, path, params });

      const send = (obj, code = 200) => {
        // world.headers = header ที่แนบทุก response (เช่น x-app-usage จำลองโควตาของ Meta)
        res.writeHead(code, { 'content-type': 'application/json', ...(world.headers || {}) });
        res.end(JSON.stringify(obj));
      };
      const fail = (message, code = 100) => send({ error: { message, code } }, 400);

      // ให้เทสแทรกพฤติกรรมเฉพาะเคสได้ (เช่น บังคับให้ endpoint หนึ่งพัง)
      // hook.errorCode = ใส่ code ของ FB เองได้ (เช่น 200 = API access blocked) ไม่งั้น default 100
      const hook = world.route && world.route(req.method, path, params);
      if (hook) return hook.error ? fail(hook.error, hook.errorCode || 100) : send(hook);

      // ---- อ่าน ----
      if (req.method === 'GET') {
        if (path === 'me/adaccounts') {
          // บัญชีเทสถือว่าผูกบัตรแล้วโดยปริยาย (เหมือนบัญชีจริงส่วนใหญ่) — เทสที่อยากจำลอง
          // "ยังไม่เชื่อมบัตร" ให้ประกาศ funding_source_details: null ในบัญชีนั้นตรงๆ
          return send({
            data: (world.accounts || []).map((a) =>
              'funding_source_details' in a ? a : { ...a, funding_source_details: { id: 'f_test', display_string: 'บัตรเทส' } }),
          });
        }
        if (path === 'me/accounts') return send({ data: world.pages || [] });
        if (path === 'me/businesses') return send({ data: world.businesses || [] });
        if (path === 'me') return send({ name: 'เทส' });

        const acct = path.match(/^act_(\d+)$/);
        if (acct) {
          const a = (world.accounts || []).find((x) => x.account_id === acct[1]) || {};
          return send({ id: path, currency: a.currency || 'THB', spend_cap: a.spend_cap || 0, amount_spent: a.amount_spent || 0 });
        }
        const sub = path.match(/^act_(\d+)\/(\w+)$/);
        if (sub) {
          const [, id, kind] = sub;
          if (kind === 'campaigns') return send({ data: (world.campaigns || []).filter((c) => c.acct === id) });
          if (kind === 'ads') return send({ data: (world.ads || []).filter((c) => c.acct === id) });
          if (kind === 'adsets') return send({ data: (world.adsets || []).filter((c) => c.acct === id) });
          if (kind === 'insights') return send({ data: (world.insights || []).filter((r) => r.acct === id) });
          if (kind === 'adspixels') return send({ data: world.pixels || [{ id: 'px1' }] });
          return send({ data: [] });
        }
        // วิดีโอที่เพิ่งอัป — โค้ดจะ poll สถานะจนกว่าจะ ready แล้วขอ thumbnail
        if ((world.videos || []).includes(path)) return send({ id: path, status: { video_status: 'ready' } });
        const thumb = path.match(/^(\d+)\/thumbnails$/);
        if (thumb && (world.videos || []).includes(thumb[1])) {
          return send({ data: [{ uri: 'http://thumb.test/x.jpg', is_preferred: true }] });
        }

        // อ่าน node ตรงๆ ด้วย id (แคมเปญ/แอด)
        const node = (world.campaigns || []).concat(world.ads || []).find((x) => x.id === path);
        if (node) return send(node);
        return fail(`Object with ID '${path}' does not exist`, 803);
      }

      // ---- เขียน ----
      if (req.method === 'POST') {
        const id = String(++world.seq);
        const acctM = path.match(/^act_(\d+)\/(\w+)$/);
        if (acctM) {
          const [, acct, kind] = acctM;
          const rec = { id, acct, ...params, status: params.status || 'ACTIVE' };
          if (kind === 'campaigns') (world.campaigns = world.campaigns || []).push({ ...rec, effective_status: rec.status });
          if (kind === 'adsets') (world.adsets = world.adsets || []).push(rec);
          if (kind === 'ads') (world.ads = world.ads || []).push({ ...rec, effective_status: rec.status });
          if (kind === 'advideos') { (world.videos = world.videos || []).push(id); return send({ id }); }
          return send({ id });
        }
        // แก้ไข node เดิม (เช่น ปิดแอด / เปลี่ยนงบ)
        for (const bag of [world.ads || [], world.campaigns || [], world.adsets || []]) {
          const it = bag.find((x) => x.id === path);
          if (it) {
            Object.assign(it, params);
            if (params.status) it.effective_status = params.status;
            return send({ success: true });
          }
        }
        return send({ id });
      }

      if (req.method === 'DELETE') return send({ success: true });
      return fail('ไม่รองรับ');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, world }));
  });
}

module.exports = { makeFakeFb };
