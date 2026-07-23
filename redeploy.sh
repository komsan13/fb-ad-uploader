#!/usr/bin/env bash
# รันบนเซิร์ฟเวอร์ (หลัง git pull): build image + รัน container ใหม่ โดยคงรหัสผ่านเข้าเว็บเดิมไว้
# ปกติไม่ต้องเรียกเอง — ใช้ deploy.cmd จากเครื่อง Windows ได้เลย
set -euo pipefail
cd "$(dirname "$0")"
command -v curl >/dev/null || { echo "ไม่พบ curl สำหรับตรวจ routing หลัง deploy" >&2; exit 1; }

PROVISIONER_ENV=/etc/fbad-provisioner/provisioner.env
TRAEFIK_CONTAINER="${TRAEFIK_CONTAINER:-}"
if [ -r "$PROVISIONER_ENV" ]; then
  set -a
  # shellcheck source=/etc/fbad-provisioner/provisioner.env
  . "$PROVISIONER_ENV"
  set +a
fi
TRAEFIK_CONTAINER="${TRAEFIK_CONTAINER:-traefik-traefik-1}"

# ใช้ mkdir เป็น exclusive lock; ห้ามเขียนทับ lock เดิม เพราะแปลว่ามี rollout ค้าง/กำลังทำงาน
DEPLOY_LOCK=""
DEPLOY_LOCK_HELD=0
MUTATION_LOCK_DIR=""
if [ -r "$PROVISIONER_ENV" ]; then
  DEPLOY_LOCK="${PROVISIONER_DEPLOY_LOCK:-/run/fbad-provisioner/deploy.lock}"
  install -d -m 700 "$(dirname "$DEPLOY_LOCK")"
  MUTATION_LOCK_DIR="${DEPLOY_LOCK}.mutations"
  install -d -m 700 "$MUTATION_LOCK_DIR"
  if ! mkdir -m 700 "$DEPLOY_LOCK"; then
    echo "พบ deployment lock ค้างหรือมี deploy อื่นทำงานอยู่: $DEPLOY_LOCK" >&2
    exit 1
  fi
  DEPLOY_LOCK_HELD=1
fi
release_deploy_lock() {
  if [ "$DEPLOY_LOCK_HELD" = "1" ]; then rmdir "$DEPLOY_LOCK" 2>/dev/null || true; DEPLOY_LOCK_HELD=0; fi
}
early_exit_cleanup() { local status=$?; set +e; release_deploy_lock; trap - EXIT; exit "$status"; }
trap early_exit_cleanup EXIT

# ผู้เช่าใช้ immutable image ID; หลัง build image หลักต้องหมุน pin และ restart provisioner
# มิฉะนั้น Docker อาจล้าง ID เก่าจนสร้าง tenant ใหม่ไม่ได้
docker build -t fbad:latest .

# lock กัน mutation ใหม่แล้ว แต่ action ที่เริ่มก่อน deployment ต้องจบก่อนจึงแตะ container ได้
if [ -n "$MUTATION_LOCK_DIR" ]; then
  deadline=$((SECONDS + 600))
  while find "$MUTATION_LOCK_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; do
    if [ "$SECONDS" -ge "$deadline" ]; then echo "รอ tenant mutation เดิมเกิน 10 นาที — ยกเลิก deploy อย่างปลอดภัย" >&2; exit 1; fi
    sleep 1
  done
fi
if [ -f "$PROVISIONER_ENV" ]; then
  bash "$PWD/install-provisioner.sh"
  # install-provisioner หมุน TENANT_IMAGE เป็น immutable image ใหม่ จึงต้องอ่านค่าซ้ำ
  # ไม่เช่นนั้น rollout tenant จะยังใช้ pin ของ release ก่อนหน้า
  set -a
  # shellcheck source=/etc/fbad-provisioner/provisioner.env
  . "$PROVISIONER_ENV"
  set +a
  TRAEFIK_CONTAINER="${TRAEFIK_CONTAINER:-traefik-traefik-1}"
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
UPDATED_TENANTS=()
UPDATED_IMAGES=()
UPDATED_HOLDS=()
MASTER_ROLLBACK_READY=0
MASTER_STOPPED=0
MASTER_RENAMED=0

# data มี FB/AI/Telegram token: จำกัดสิทธิ์บน host ทุกครั้งที่ deploy ก่อน container ตัวใหม่อ่าน
install -d -m 700 /opt/fbad-data
chmod 700 /opt/fbad-data
find /opt/fbad-data -maxdepth 1 -type f \( -name 'config.json' -o -name 'config.json.bak-*' \) -exec chmod 600 {} +

# Master ไม่อยู่ shared `web`: มีเฉพาะ Traefik ที่ถูกต่อเข้ามาเท่านั้นที่เข้าถึง app ได้
MASTER_NETWORK="${MASTER_NETWORK:-fbad-master-net}"
docker network inspect "$MASTER_NETWORK" >/dev/null 2>&1 || docker network create "$MASTER_NETWORK" >/dev/null
docker inspect "$TRAEFIK_CONTAINER" >/dev/null 2>&1 || { echo "ไม่พบ Traefik container ${TRAEFIK_CONTAINER}"; exit 1; }
if ! docker inspect "$TRAEFIK_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | grep -Fxq "$MASTER_NETWORK"; then
  docker network connect "$MASTER_NETWORK" "$TRAEFIK_CONTAINER"
fi

ROLLBACK_CONTAINER=fbad-rollback
docker container inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1 && { echo "พบ rollback container ค้างอยู่ — หยุดเพื่อไม่ทับ instance เดิม"; exit 1; }
rollback_master() {
  # หาก stop สำเร็จแต่ rename ไม่สำเร็จ master เดิมยังชื่อ fbad อยู่: ห้าม rm ทิ้ง
  if [ "$MASTER_RENAMED" != "1" ]; then
    if [ "$MASTER_STOPPED" = "1" ] && docker container inspect fbad >/dev/null 2>&1; then docker start fbad >/dev/null || true; fi
    return
  fi
  docker rm -f fbad >/dev/null 2>&1 || true
  if docker container inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
    docker rename "$ROLLBACK_CONTAINER" fbad
    docker start fbad >/dev/null || true
  fi
}
rollback_updated_tenants() {
  local i code image hold
  for ((i=${#UPDATED_TENANTS[@]} - 1; i >= 0; i--)); do
    code="${UPDATED_TENANTS[$i]}"
    image="${UPDATED_IMAGES[$i]}"
    hold="${UPDATED_HOLDS[$i]}"
    echo "กำลังกู้ tenant ${code} กลับ image เดิม"
    ACTION=redeploy PROFILE_CODE="$code" DOMAIN="${TENANT_DOMAIN:-ad.senball.com}" NETWORK="fbad-tenant-net-${code}" DATA_ROOT="${TENANT_DATA_ROOT:-/opt/fbad-tenants}" TENANT_IMAGE="$image" AUTOPILOT_HOLD="$hold" SKIP_BUILD=1 bash "$TENANT_DEPLOY_SCRIPT" || echo "⚠️ กู้ tenant ${code} ไม่สำเร็จ ต้องตรวจทันที" >&2
  done
}
deploy_cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [ "$status" -ne 0 ]; then
    rollback_updated_tenants
    if [ "$MASTER_STOPPED" = "1" ]; then rollback_master; fi
  fi
  release_deploy_lock
  exit "$status"
}
trap deploy_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker stop fbad >/dev/null
MASTER_STOPPED=1
docker rename fbad "$ROLLBACK_CONTAINER"
MASTER_RENAMED=1
MASTER_ROLLBACK_READY=1

# router fbadpub = ส่วนที่เปิดสาธารณะ ไม่ผ่าน basic auth
# หน้า Landing กับรูปของมันต้องเข้าถึงได้โดยไม่มีรหัสผ่าน เพราะคนที่กดโฆษณาไม่มี
# และ Meta ต้องเข้ามาอ่านพิกเซล/รีวิวโฆษณาได้ด้วย
if ! docker run -d --name fbad --restart unless-stopped \
  --network "$MASTER_NETWORK" \
  -e PUBLIC_URL="https://ad.senball.com" \
  -e PORT=4000 \
  -e CONFIG_PATH=/data/config.json \
  -v /opt/fbad-data:/data \
  "${PROVISIONER_ARGS[@]}" \
  --label traefik.enable=true \
  --label "traefik.docker.network=$MASTER_NETWORK" \
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
  fbad:latest >/dev/null; then
  echo "❌ สร้าง master container ใหม่ไม่สำเร็จ — จะกู้ตัวเดิมกลับแล้ว" >&2
  exit 1
fi

sleep 2
MASTER_LP_STATUS=""; MASTER_ADMIN_STATUS=""
for _ in {1..5}; do
  MASTER_LP_STATUS="$(curl -sk --connect-timeout 5 --resolve ad.senball.com:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://ad.senball.com/lp || true)"
  MASTER_ADMIN_STATUS="$(curl -sk --connect-timeout 5 --resolve ad.senball.com:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://ad.senball.com/ || true)"
  [ "$MASTER_LP_STATUS" = "200" ] && [ "$MASTER_ADMIN_STATUS" = "401" ] && break
  sleep 2
done
if ! docker exec fbad wget -qO /dev/null http://localhost:4000/ || [ "$MASTER_LP_STATUS" != "200" ] || [ "$MASTER_ADMIN_STATUS" != "401" ]; then
  echo "❌ master health/routing ไม่ผ่าน (lp=${MASTER_LP_STATUS:-none}, admin=${MASTER_ADMIN_STATUS:-none}) — จะกู้ตัวเดิมกลับแล้ว" >&2
  exit 1
fi

# source ใหม่ต้องถูกใช้กับ tenant ที่ live ทุกสถานะ ไม่เช่นนั้น fixes ด้าน isolation จะค้างอยู่แค่ master
# restored_hold ต้องส่ง hold กลับเข้า container ใหม่เสมอ ห้ามปลด Autopilot ด้วย rollout
if [ -r "$PROVISIONER_ENV" ] && [ -n "${PROVISIONER_REGISTRY:-}" ] && [ -n "${TENANT_DEPLOY_SCRIPT:-}" ]; then
  mapfile -t ACTIVE_TENANTS < <(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const t of r.tenants||[]) if (["active","access_suspended","restored_hold"].includes(t.status) && /^[a-f0-9]{32}$/.test(t.code)) console.log(`${t.code}:${t.status}`)' "$PROVISIONER_REGISTRY")
  for tenant in "${ACTIVE_TENANTS[@]}"; do
    code="${tenant%%:*}"
    status="${tenant##*:}"
    hold=0; [ "$status" = "restored_hold" ] && hold=1
    echo "กำลังอัปเดต tenant ${code}"
    old_image="$(docker inspect "fbad-tenant-${code}" --format '{{.Image}}')"
    if ! ACTION=redeploy PROFILE_CODE="$code" DOMAIN="${TENANT_DOMAIN:-ad.senball.com}" NETWORK="fbad-tenant-net-${code}" DATA_ROOT="${TENANT_DATA_ROOT:-/opt/fbad-tenants}" TENANT_IMAGE="$TENANT_IMAGE" AUTOPILOT_HOLD="$hold" SKIP_BUILD=1 bash "$TENANT_DEPLOY_SCRIPT"; then
      echo "❌ tenant ${code} อัปเดตไม่สำเร็จ — จะกู้ master และ tenant ที่อัปเดตไปแล้วกลับ" >&2
      exit 1
    fi
    UPDATED_TENANTS+=("$code")
    UPDATED_IMAGES+=("$old_image")
    UPDATED_HOLDS+=("$hold")
  done
fi

docker rm -f "$ROLLBACK_CONTAINER" >/dev/null
MASTER_ROLLBACK_READY=0
MASTER_STOPPED=0
MASTER_RENAMED=0
echo "✅ deploy สำเร็จ: $(git log -1 --format='%h %s')"
