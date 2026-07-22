function fmtAge(at) {
  const d = Math.floor((Date.now() - at) / 86400000);
  if (d <= 0) return 'วันนี้';
  return d + ' วันก่อน';
}
async function render() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('sess_'));
  const list = document.getElementById('list');
  if (!keys.length) { list.innerHTML = '<div class="empty">ยังไม่มีบัญชีที่เชื่อม session</div>'; return; }
  list.innerHTML = '';
  for (const k of keys) {
    const s = all[k];
    const row = document.createElement('div');
    row.className = 'row';
    const info = document.createElement('div');
    info.innerHTML = '<div>id ' + s.cUser + '</div><div class="cu">เชื่อมเมื่อ ' + fmtAge(s.at) + '</div>';
    const btn = document.createElement('button');
    btn.textContent = 'ลบ';
    btn.onclick = async () => { await chrome.storage.local.remove(k); render(); };
    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  }
}
render();
