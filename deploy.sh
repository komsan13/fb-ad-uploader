#!/usr/bin/env bash
# สคริปต์ deploy FB Ad Uploader ขึ้น VPS (Ubuntu/Debian)
# ใช้: curl -fsSL <raw url>/deploy.sh | APP_PASS='รหัสของคุณ' bash
set -euo pipefail

DOMAIN="${DOMAIN:-ad.senball.com}"
APP_USER="${APP_USER:-admin}"
APP_PASS="${APP_PASS:-}"
REPO="${REPO:-https://github.com/komsan13/fb-ad-uploader.git}"
APP_DIR="/opt/fb-ad-uploader"

if [ -z "$APP_PASS" ]; then
  read -rsp "ตั้งรหัสผ่านสำหรับเข้าหน้าเว็บ (user: $APP_USER): " APP_PASS; echo
fi
[ -z "$APP_PASS" ] && { echo "ต้องตั้งรหัสผ่านก่อน"; exit 1; }

echo "==> [1/5] ติดตั้ง Node.js + git"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> [2/5] ติดตั้ง Caddy (HTTPS อัตโนมัติ)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> [3/5] ดึงโค้ดแอป"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev

echo "==> [4/5] ตั้ง service ให้รันตลอด"
cat >/etc/systemd/system/fbad.service <<EOF
[Unit]
Description=FB Ad Uploader
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=4000
Environment=PUBLIC_URL=https://$DOMAIN
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable fbad >/dev/null 2>&1 || true
systemctl restart fbad

echo "==> [5/5] ตั้ง Caddy + รหัสผ่านหน้าเว็บ"
command -v ufw >/dev/null && { ufw allow 80/tcp >/dev/null 2>&1 || true; ufw allow 443/tcp >/dev/null 2>&1 || true; }
HASH=$(caddy hash-password --plaintext "$APP_PASS")
cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN {
    basic_auth {
        $APP_USER $HASH
    }
    reverse_proxy localhost:4000
}
EOF
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo ""
echo "======================================================"
echo " ✅ เสร็จแล้ว! เปิด  https://$DOMAIN"
echo "    เข้าเว็บด้วย user: $APP_USER  (รหัสที่ตั้งไว้)"
echo " * รอ 30-60 วิ ให้ Caddy ออกใบรับรอง HTTPS รอบแรก"
echo "======================================================"
