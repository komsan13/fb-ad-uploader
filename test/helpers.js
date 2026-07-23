// ตัวช่วยสตาร์ท server.js จริงในสภาพแวดล้อมแยก ชี้ FB ไปที่ตัวปลอม
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbad-test-'));
}

// เขียน config + คลังวิดีโอ/แคปชั่นให้พร้อมใช้ (autopilot ต้องมีของครบถึงจะเติมแอด)
function seed(dir, { config = {}, videos = 1, captions = 1 } = {}) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));

  const lib = path.join(dir, 'media-library');
  fs.mkdirSync(lib, { recursive: true });
  const items = [];
  for (let i = 1; i <= videos; i++) {
    const id = `v${i}`;
    fs.writeFileSync(path.join(lib, id + '.bin'), Buffer.from('วิดีโอปลอมสำหรับเทส'));
    items.push({ id, name: `คลิป ${i}`, filename: `${id}.mp4`, mimetype: 'video/mp4', ts: Date.now() - i * 1000, usedOn: [] });
  }
  fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify(items));

  const caps = [];
  for (let i = 1; i <= captions; i++) caps.push({ id: `c${i}`, message: `ข้อความโฆษณาทดสอบชุดที่ ${i}`, headline: `หัวข้อ ${i}` });
  fs.writeFileSync(path.join(dir, 'captions.json'), JSON.stringify(caps));
}

async function startServer(dir, fbPort, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { PUBLIC_URL_PATH = '', ...restEnv } = extraEnv;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      CONFIG_PATH: path.join(dir, 'config.json'),
      FB_API_BASE: `http://127.0.0.1:${fbPort}`,
      // ต้องตรงกับ base ที่เทสใช้เรียก ไม่งั้นโค้ดที่เทียบว่า "ลิงก์ชี้มาหน้าเราไหม" จะไม่ตรง
      PUBLIC_URL: `http://127.0.0.1:${port}${PUBLIC_URL_PATH}`,
      ...restEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/api/autopilot'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { child, base, getLog: () => log, stop: () => child.kill() };
}

const get = async (base, p) => (await fetch(base + p)).json();
const post = async (base, p, body) => (await fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
})).json();

const readState = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'autopilot-state.json'), 'utf8')); }
  catch { return null; }
};

module.exports = { tmpDir, seed, startServer, get, post, readState };
