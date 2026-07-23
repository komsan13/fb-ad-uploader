#!/usr/bin/env bash
# รันบนเซิร์ฟเวอร์ (หลัง git pull): build image + รัน container ใหม่ โดยคงรหัสผ่านเข้าเว็บเดิมไว้
# ปกติไม่ต้องเรียกเอง — ใช้ deploy.cmd จากเครื่อง Windows ได้เลย
set -euo pipefail
cd "$(dirname "$0")"

docker build -t fbad:latest .

# ผู้เช่าใช้ immutable image ID; หลัง build image หลักต้องหมุน pin และ restart provisioner
# มิฉะนั้น Docker อาจล้าง ID เก่าจนสร้าง tenant ใหม่ไม่ได้
if [ -f /etc/fbad-provisioner/provisioner.env ]; then
  bash "$PWD/install-provisioner.sh"
fi

# ดึง hash รหัสผ่าน basic auth จาก container เดิม (ถ้ารัน deploy.sh ตัวเก่าจะสุ่มรหัสใหม่ — ตัวนี้ไม่สุ่ม)
HASH="$(docker inspect fbad --format '{{index .Config.Labels "traefik.http.middlewares.fbad-auth.basicauth.users"}}')"
[ -n "$HASH" ] || { echo "หา basic auth hash จาก container เดิมไม่เจอ — ถ้าเป็นการติดตั้งครั้งแรกให้ใช้ deploy.sh"; exit 1; }

# control plane เป็น Unix socket แยกจาก Docker socket และจะ mount เฉพาะเมื่อ provisioner พร้อมแล้ว
PROVISIONER_ARGS=()
if [ -S /run/fbad-provisioner.sock ]; then
  [ -r /etc/fbad-provisioner/master.env ] || { echo "พบ provisioner socket แต่ไม่พบ /etc/fbad-provisioner/master.env"; exit 1; }
  set -a
  # shellcheck source=/etc/fbad-provisioner/master.env
  . /etc/fbad-provisioner/master.env
  set +a
  [[ "${TENANT_PROVISIONER_SOCKET:-}" =~ ^/run/[A-Za-z0-9._/-]+\.sock$ ]] || { echo "TENANT_PROVISIONER_SOCKET ไม่ถูกต้อง"; exit 1; }
  [[ "${TENANT_PROVISIONER_TOKEN:-}" =~ ^[A-Fa-f0-9]{64}$ ]] || { echo "TENANT_PROVISIONER_TOKEN ต้องเป็น hex 64 ตัว"; exit 1; }
  [ -S "$TENANT_PROVISIONER_SOCKET" ] || { echo "ไม่พบ provisioner socket ตามที่ตั้งค่า"; exit 1; }
  PROVISIONER_ARGS=(-e "TENANT_PROVISIONER_SOCKET=$TENANT_PROVISIONER_SOCKET" -e "TENANT_PROVISIONER_TOKEN=$TENANT_PROVISIONER_TOKEN" -v "$TENANT_PROVISIONER_SOCKET:$TENANT_PROVISIONER_SOCKET")
fi

# router fbadpub = ส่วนที่เปิดสาธารณะ ไม่ผ่าน basic auth
# หน้า Landing กับรูปของมันต้องเข้าถึงได้โดยไม่มีรหัสผ่าน เพราะคนที่กดโฆษณาไม่มี
# และ Meta ต้องเข้ามาอ่านพิกเซล/รีวิวโฆษณาได้ด้วย
# ใช้ Path() ตรงตัว ไม่เปิด path ย่อยของ /lp โดยไม่ตั้งใจ
docker rm -f fbad >/dev/null
docker run -d --name fbad --restart unless-stopped \
  --network web \
  -e PUBLIC_URL="https://ad.senball.com" \
  -e PORT=4000 \
  -e CONFIG_PATH=/data/config.json \
  -v /opt/fbad-data:/data \
  "${PROVISIONER_ARGS[@]}" \
  --label traefik.enable=true \
  --label traefik.docker.network=web \
  --label 'traefik.http.routers.fbad.rule=Host(`ad.senball.com`)' \
  --label traefik.http.routers.fbad.entrypoints=websecure \
  --label traefik.http.routers.fbad.tls.certresolver=le \
  --label traefik.http.routers.fbad.middlewares=fbad-auth \
  --label "traefik.http.middlewares.fbad-auth.basicauth.users=$HASH" \
  --label 'traefik.http.middlewares.fbad-auth.basicauth.realm=fbad-master' \
  --label 'traefik.http.routers.fbadpub.rule=Host(`ad.senball.com`) && (Path(`/privacy.html`) || Path(`/lp`) || Path(`/lp/`) || PathPrefix(`/lp-asset/`))' \
  --label traefik.http.routers.fbadpub.entrypoints=websecure \
  --label traefik.http.routers.fbadpub.service=fbad \
  --label traefik.http.routers.fbadpub.tls.certresolver=le \
  --label traefik.http.services.fbad.loadbalancer.server.port=4000 \
  fbad:latest >/dev/null

sleep 2
docker exec fbad wget -qO /dev/null http://localhost:4000/ && echo "✅ deploy สำเร็จ: $(git log -1 --format='%h %s')" || { echo "❌ container ไม่ตอบ — ดู log: docker logs fbad"; exit 1; }
