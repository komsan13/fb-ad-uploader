#!/usr/bin/env node
// เครื่องมือหา field จริงของ "กลยุทธ์วงจรลูกค้า" (หรือ setting อื่นที่ UI มีแต่หา API ไม่เจอ)
//
// วิธีใช้:
//   1. ใน Ads Manager: เปิด ad set ที่โปรแกรมสร้าง → ติ๊ก dropdown "กลยุทธ์วงจรลูกค้า"
//      เป็น "รับคอนเวอร์ชั่นจากกลุ่มเป้าหมายทั้งหมด" ด้วยมือ → กดเผยแพร่
//   2. เอา id ของ ad set ตัวที่ติ๊กแล้ว กับตัวที่ยังไม่ติ๊ก (ดูจาก URL หรือคอลัมน์ id)
//   3. node diff-adsets.js <adsetId ติ๊กแล้ว> <adsetId ยังไม่ติ๊ก>
//
// สคริปต์จะดึงทุก field ที่อ่านได้ของทั้งสองตัวมาเทียบ แล้วพิมพ์เฉพาะจุดที่ต่างกัน
// → field ที่โผล่ในผลต่างคือตัวที่ Ads Manager เขียนจริงตอนติ๊ก dropdown

const fs = require('fs');
const path = require('path');

const API = 'https://graph.facebook.com/v23.0';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const prof = (cfg.profiles || []).find((p) => p.id === cfg.activeProfileId) || (cfg.profiles || [])[0];
if (!prof || !prof.accessToken) {
  console.error('config.json ไม่มีบัญชี/token — เปิดโปรแกรม (localhost:4000) แล้วเชื่อม Facebook ก่อน');
  process.exit(1);
}
const token = prof.accessToken;

const [idA, idB] = process.argv.slice(2);
if (!idA || !idB) {
  console.error('วิธีใช้: node diff-adsets.js <adsetId ติ๊กแล้ว> <adsetId ยังไม่ติ๊ก>');
  process.exit(1);
}

// field ทั้งหมดที่พอรู้ว่ามีใน ad set (ตัวไหน FB บอกไม่มีจริง จะถูกถอดออกอัตโนมัติ)
let FIELDS = [
  'name', 'status', 'effective_status', 'campaign_id', 'created_time', 'updated_time',
  'optimization_goal', 'billing_event', 'bid_strategy', 'bid_amount', 'daily_budget',
  'destination_type', 'promoted_object', 'attribution_spec', 'targeting',
  'existing_customer_budget_percentage', 'full_funnel_exploration_mode',
  'optimization_sub_event', 'multi_optimization_goal_weight', 'is_dynamic_creative',
  'dsa_beneficiary', 'dsa_payor', 'regional_regulation_identities',
  'automation_settings', 'value_rule_set_id', 'value_rules_applied',
  'daily_min_spend_target', 'daily_spend_cap', 'pacing_type', 'learning_stage_info',
];

async function fetchAdset(id) {
  for (let guard = 0; guard < 30; guard++) {
    const url = `${API}/${id}?fields=${FIELDS.join(',')}&access_token=${encodeURIComponent(token)}`;
    const r = await (await fetch(url)).json();
    if (!r.error) return r;
    // FB บอก field ไหนไม่มีจริง → ถอดออกแล้วลองใหม่
    const m = /nonexisting field \(([^)]+)\)/.exec(r.error.message || '');
    if (m && FIELDS.includes(m[1])) { FIELDS = FIELDS.filter((f) => f !== m[1]); continue; }
    throw new Error(`FB error (adset ${id}): ${r.error.message}`);
  }
  throw new Error('ถอด field ไม่จบ — ผิดปกติ');
}

(async () => {
  const a = await fetchAdset(idA);
  const b = await fetchAdset(idB); // เรียกตามลำดับ เพื่อให้ FIELDS ที่ถูกถอดแล้วใช้ร่วมกัน
  const a2 = await fetchAdset(idA); // ดึง A ซ้ำด้วย field list สุดท้าย ให้เทียบชุดเดียวกันเป๊ะ

  console.log(`\nเทียบ ad set ${idA} (ติ๊กแล้ว) กับ ${idB} (ยังไม่ติ๊ก)\n`);
  let diffCount = 0;
  for (const f of FIELDS) {
    const va = JSON.stringify(a2[f]);
    const vb = JSON.stringify(b[f]);
    if (va !== vb) {
      diffCount++;
      console.log(`≠ ${f}`);
      console.log(`    ติ๊กแล้ว : ${va === undefined ? '(ไม่มีค่า)' : va}`);
      console.log(`    ยังไม่ติ๊ก: ${vb === undefined ? '(ไม่มีค่า)' : vb}`);
    }
  }
  if (!diffCount) {
    console.log('ทุก field ที่ API อ่านได้ เหมือนกันทั้งคู่ — แปลว่า dropdown ตัวนี้เก็บค่าในที่ที่ Marketing API เปิดให้อ่านไม่ได้ (UI-only)');
  } else {
    console.log(`\nต่างกัน ${diffCount} field — ตัวที่เกี่ยวกับวงจรลูกค้าคือ field ที่ต้องให้โปรแกรมตั้งตาม "ติ๊กแล้ว"`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
