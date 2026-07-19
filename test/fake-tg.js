// Telegram Bot API ปลอม — ชี้ server.js มาที่นี่ด้วย TG_API_BASE
// เก็บทุก sendMessage ที่ได้รับ และให้เทสป้อนข้อความเข้า getUpdates ได้
const http = require('http');

function makeFakeTg() {
  const state = { updates: [], sent: [], nextId: 1, polls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname.endsWith('/getUpdates')) {
        state.polls++;
        const offset = Number(u.searchParams.get('offset') || 0);
        // ตอบทันที ไม่จำลอง long poll — เทสจะได้ไม่ต้องรอ 25 วิ
        return send({ ok: true, result: state.updates.filter((x) => x.update_id >= offset) });
      }
      if (u.pathname.endsWith('/sendMessage')) {
        try { state.sent.push(JSON.parse(body)); } catch { /* ข้าม */ }
        return send({ ok: true, result: { message_id: state.nextId } });
      }
      send({ ok: true, result: [] });
    });
  });
  const push = (chatId, text, date) => {
    state.updates.push({
      update_id: state.nextId++,
      message: { chat: { id: chatId }, text, date: date || Math.floor(Date.now() / 1000) },
    });
  };
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, push, port: server.address().port }));
  });
}

// Anthropic API ปลอม — server.js ชี้มาที่นี่ด้วย ANTHROPIC_BASE_URL (SDK อ่าน env นี้เอง)
// เก็บ request ที่ได้รับไว้ให้เทสยืนยันว่าข้อมูลจริงถูกส่งเข้า AI
// answer: string = ตอบอย่างเดียว, object = {answer, action} ตาม TG_SCHEMA (เทสเส้นสั่งงาน)
function makeFakeAi(answer) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { state.requests.push(JSON.parse(body)); } catch { /* ข้าม */ }
      // string = ตอบเดิมทุกครั้ง • array = ไล่ตอบตามลำดับ (ตัวสุดท้ายค้าง) • object = โครง {answer, action}
      const next = Array.isArray(answer) ? (answer.length > 1 ? answer.shift() : answer[0]) : answer;
      const out = typeof next === 'string' ? { answer: next, action: null } : next;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

module.exports = { makeFakeTg, makeFakeAi };
