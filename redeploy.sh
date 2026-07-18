#!/usr/bin/env bash
# รันบนเซิร์ฟเวอร์ (หลัง git pull): build image + รัน container ใหม่ โดยคงรหัสผ่านเข้าเว็บเดิมไว้
# ปกติไม่ต้องเรียกเอง — ใช้ deploy.cmd จากเครื่อง Windows ได้เลย
set -euo pipefail
cd "$(dirname "$0")"

docker build -t fbad:latest .

# ดึง hash รหัสผ่าน basic auth จาก container เดิม (ถ้ารัน deploy.sh ตัวเก่าจะสุ่มรหัสใหม่ — ตัวนี้ไม่สุ่ม)
HASH="$(docker inspect fbad --format '{{index .Config.Labels "traefik.http.middlewares.fbad-auth.basicauth.users"}}')"
[ -n "$HASH" ] || { echo "หา basic auth hash จาก container เดิมไม่เจอ — ถ้าเป็นการติดตั้งครั้งแรกให้ใช้ deploy.sh"; exit 1; }

docker rm -f fbad >/dev/null
docker run -d --name fbad --restart unless-stopped \
  --network web \
  -e PUBLIC_URL="https://ad.senball.com" \
  -e PORT=4000 \
  -e CONFIG_PATH=/data/config.json \
  -v /opt/fbad-data:/data \
  --label traefik.enable=true \
  --label traefik.docker.network=web \
  --label 'traefik.http.routers.fbad.rule=Host(`ad.senball.com`)' \
  --label traefik.http.routers.fbad.entrypoints=websecure \
  --label traefik.http.routers.fbad.tls.certresolver=le \
  --label traefik.http.routers.fbad.middlewares=fbad-auth \
  --label "traefik.http.middlewares.fbad-auth.basicauth.users=$HASH" \
  --label 'traefik.http.routers.fbadpub.rule=Host(`ad.senball.com`) && Path(`/privacy.html`)' \
  --label traefik.http.routers.fbadpub.entrypoints=websecure \
  --label traefik.http.routers.fbadpub.service=fbad \
  --label traefik.http.routers.fbadpub.tls.certresolver=le \
  --label traefik.http.services.fbad.loadbalancer.server.port=4000 \
  fbad:latest >/dev/null

sleep 2
docker exec fbad wget -qO /dev/null http://localhost:4000/ && echo "✅ deploy สำเร็จ: $(git log -1 --format='%h %s')" || { echo "❌ container ไม่ตอบ — ดู log: docker logs fbad"; exit 1; }
