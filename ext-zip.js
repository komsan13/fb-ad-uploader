// สร้างไฟล์ .zip ของโฟลเดอร์ extension แบบ "stored" (ไม่บีบอัด) — ไม่พึ่ง dependency ภายนอก
// ใช้ทำปุ่ม "ดาวน์โหลดส่วนขยาย" ให้ผู้ใช้เอาไป Load unpacked โดยไม่ต้องหาโฟลเดอร์ในเครื่องเอง
const fs = require('fs');
const path = require('path');

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// prefix = โฟลเดอร์ครอบไฟล์ทั้งหมดใน zip เพื่อให้แตกออกมาได้โฟลเดอร์เดียวพร้อม Load unpacked
function buildExtensionZip(dir, prefix = 'fbad-extension') {
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(dir, name));
    const fname = Buffer.from(`${prefix}/${name}`, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header
    lh.writeUInt16LE(20, 4);         // version needed
    lh.writeUInt16LE(0, 6);          // flags
    lh.writeUInt16LE(0, 8);          // method = 0 (stored)
    lh.writeUInt16LE(0, 10);         // mod time
    lh.writeUInt16LE(0x21, 12);      // mod date = 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(fname.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, fname, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory header
    ch.writeUInt16LE(20, 4);         // version made by
    ch.writeUInt16LE(20, 6);         // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(fname.length, 28);
    ch.writeUInt16LE(0, 30);         // extra len
    ch.writeUInt16LE(0, 32);         // comment len
    ch.writeUInt16LE(0, 34);         // disk number start
    ch.writeUInt16LE(0, 36);         // internal attrs
    ch.writeUInt32LE(0, 38);         // external attrs
    ch.writeUInt32LE(offset, 42);    // local header offset
    centrals.push(ch, fname);

    offset += lh.length + fname.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

module.exports = { buildExtensionZip };
