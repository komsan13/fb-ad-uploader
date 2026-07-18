#!/usr/bin/env bash
# Deploy FB Ad Uploader เป็น Docker container เสียบเข้า Traefik ที่มีอยู่บนเซิร์ฟเวอร์
# ใช้: curl -fsSL <raw>/deploy.sh | APP_PASS='รหัสของคุณ' bash
set -euo pipefail

DOMAIN="${DOMAIN:-ad.senball.com}"
APP_USER="${APP_USER:-admin}"
APP_PASS="${APP_PASS:-}"
REPO="${REPO:-https://github.com/komsan13/fb-ad-uploader.git}"
APP_DIR="/opt/fb-ad-uploader"
DATA_DIR="/opt/fbad-data"
NET="${NET:-web}"          # Traefik docker network
CERTRESOLVER="${CERTRESOLVER:-le}"

command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }
command -v htpasswd >/dev/null || { apt-get update -y && apt-get install -y apache2-utils; }

GEN=0
if [ -z "$APP_PASS" ]; then APP_PASS="$(openssl rand -base64 9)"; GEN=1; fi

echo "==> [1/3] ดึงโค้ด"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR"
mkdir -p "$DATA_DIR"

echo "==> [2/3] build image"
docker build -t fbad:latest .

echo "==> [3/3] รัน container + เสียบ Traefik"
HASH="$(htpasswd -nbB "$APP_USER" "$APP_PASS")"
docker rm -f fbad 2>/dev/null || true
docker run -d --name fbad --restart unless-stopped \
  --network "$NET" \
  -e PUBLIC_URL="https://$DOMAIN" \
  -e PORT=4000 \
  -e CONFIG_PATH=/data/config.json \
  -v "$DATA_DIR:/data" \
  --label traefik.enable=true \
  --label traefik.docker.network="$NET" \
  --label "traefik.http.routers.fbad.rule=Host(\`$DOMAIN\`)" \
  --label traefik.http.routers.fbad.entrypoints=websecure \
  --label "traefik.http.routers.fbad.tls.certresolver=$CERTRESOLVER" \
  --label traefik.http.routers.fbad.middlewares=fbad-auth \
  --label "traefik.http.middlewares.fbad-auth.basicauth.users=$HASH" \
  --label traefik.http.services.fbad.loadbalancer.server.port=4000 \
  fbad:latest

echo ""
echo "======================================================"
echo " ✅ deploy สำเร็จ! เปิด  https://$DOMAIN"
echo "    เข้าเว็บด้วย user: $APP_USER"
[ "$GEN" = 1 ] && echo "    🔑 รหัสผ่าน (สุ่มให้): $APP_PASS"
echo " * รอ 30-60 วิ ให้ Traefik ออกใบรับรอง HTTPS รอบแรก"
echo "======================================================"
