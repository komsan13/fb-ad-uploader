#!/usr/bin/env bash
# สร้าง/อัปเดต instance สำหรับผู้เช่าหนึ่งราย
# create: TENANT_USER=acme bash tenant-deploy.sh
# retry-create: PROFILE_CODE=<รหัสเดิม> TENANT_USER=acme ACTION=retry-create bash tenant-deploy.sh
# redeploy: PROFILE_CODE=<รหัสที่สคริปต์เคยแสดง> ACTION=redeploy bash tenant-deploy.sh
# restore: PROFILE_CODE=<รหัสเดิม> RESTORE_CONFIRM=<รหัสเดิม> TENANT_USER=acme ACTION=restore bash tenant-deploy.sh
# reset-password: PROFILE_CODE=<รหัสเดิม> TENANT_USER=acme ACTION=reset-password bash tenant-deploy.sh
set -euo pipefail
umask 077

ACTION="${ACTION:-create}"
PROFILE_CODE="${PROFILE_CODE:-}"
DOMAIN="${DOMAIN:-ad.senball.com}"
NETWORK="${NETWORK:-web}"
CERTRESOLVER="${CERTRESOLVER:-le}"
DATA_ROOT="${DATA_ROOT:-/opt/fbad-tenants}"
TENANT_IMAGE="${TENANT_IMAGE:-fbad:latest}"
SKIP_BUILD="${SKIP_BUILD:-0}"
AUTOPILOT_HOLD="${AUTOPILOT_HOLD:-0}"

if [[ ! "$ACTION" =~ ^(create|retry-create|redeploy|restore|reset-password)$ ]]; then
  echo "ACTION ต้องเป็น create, retry-create, redeploy, restore หรือ reset-password" >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[a-z0-9.-]+$ ]]; then
  echo "DOMAIN ไม่ถูกต้อง" >&2
  exit 1
fi

if [ -z "$PROFILE_CODE" ] && [ "$ACTION" = "create" ]; then
  command -v openssl >/dev/null || { echo "ไม่พบ openssl สำหรับสร้างรหัส profile" >&2; exit 1; }
  PROFILE_CODE="$(openssl rand -hex 16)"
fi
if [[ ! "$PROFILE_CODE" =~ ^[a-f0-9]{32}$ ]]; then
  echo "PROFILE_CODE ต้องเป็นรหัส hex 32 ตัวอักษร" >&2
  exit 1
fi

CONTAINER="fbad-tenant-${PROFILE_CODE}"
ROUTER="fbad-tenant-${PROFILE_CODE}"
PUBLIC_ROUTER="${ROUTER}-public"
AUTH="${ROUTER}-auth"
SERVICE="${ROUTER}"
DATA_DIR="${DATA_ROOT}/${PROFILE_CODE}"

# create ต้องไม่รับ data directory ที่มีอยู่ เพราะอาจเป็น config/token ของผู้เช่ารายก่อน
# หาก container หายแต่ข้อมูลยังอยู่ ให้ใช้ restore พร้อมยืนยัน code เดิมโดยเจตนา
if [ "$ACTION" = "create" ] && [ -e "$DATA_DIR" ]; then
  echo "data directory ${DATA_DIR} มีอยู่แล้ว — หยุดเพื่อไม่ใช้ข้อมูลผู้เช่ารายก่อน; ใช้ ACTION=redeploy ถ้า container ยังอยู่ หรือ ACTION=restore พร้อม RESTORE_CONFIRM=${PROFILE_CODE} ถ้าต้องการกู้ข้อมูลเดิม" >&2
  exit 1
fi
if [ "$ACTION" = "retry-create" ]; then
  if [ ! -d "$DATA_DIR" ]; then
    echo "ไม่พบ data directory สำหรับ retry — ใช้ ACTION=create แทน" >&2
    exit 1
  fi
  if find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "data directory สำหรับ retry มีข้อมูลอยู่แล้ว — ใช้ ACTION=restore หากมี config เดิม" >&2
    exit 1
  fi
fi
if [ "$ACTION" = "restore" ]; then
  if [ ! -d "$DATA_DIR" ] || [ ! -f "$DATA_DIR/config.json" ]; then
    echo "ไม่พบ config เดิมใน ${DATA_DIR} — restore ทำไม่ได้" >&2
    exit 1
  fi
  if [ "${RESTORE_CONFIRM:-}" != "$PROFILE_CODE" ]; then
    echo "restore ต้องตั้ง RESTORE_CONFIRM ให้ตรงกับ PROFILE_CODE เพื่อยืนยันว่าจะกู้ข้อมูลเดิม" >&2
    exit 1
  fi
fi
command -v docker >/dev/null || { echo "ไม่พบ docker" >&2; exit 1; }
command -v htpasswd >/dev/null || { echo "ไม่พบ htpasswd (ติดตั้ง apache2-utils ก่อน)" >&2; exit 1; }

set_new_auth() {
  TENANT_USER="${TENANT_USER:-}"
  TENANT_PASS="${TENANT_PASS:-}"
  if [[ ! "$TENANT_USER" =~ ^[A-Za-z0-9._-]{3,64}$ ]]; then
    echo "TENANT_USER ต้องมี 3-64 ตัว และใช้ได้เฉพาะ A-Z, a-z, 0-9, ., _, -" >&2
    exit 1
  fi
  if [ -z "$TENANT_PASS" ]; then
    if [ "${TENANT_PASS_STDIN:-}" = "1" ]; then
      IFS= read -r -s TENANT_PASS || { echo "อ่านรหัสผู้เช่าจาก stdin ไม่สำเร็จ" >&2; exit 1; }
    else
      read -r -s -p "ตั้งรหัสผู้เช่า: " TENANT_PASS
      echo
    fi
  fi
  if [ "${#TENANT_PASS}" -lt 12 ]; then
    echo "TENANT_PASS ต้องยาวอย่างน้อย 12 ตัวอักษร" >&2
    exit 1
  fi
  # ส่งรหัสผ่านผ่าน stdin เพื่อไม่ให้โผล่ชั่วคราวใน process list ของ host
  AUTH_HASH="$(printf '%s\n' "$TENANT_PASS" | htpasswd -i -nB "$TENANT_USER")"
  unset TENANT_PASS
}

if [ "$ACTION" = "create" ] || [ "$ACTION" = "retry-create" ]; then
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "มี instance ${PROFILE_CODE} อยู่แล้ว — ใช้ ACTION=redeploy เพื่ออัปเดต" >&2
    exit 1
  fi
  set_new_auth
  if [ "$ACTION" = "create" ]; then install -d -m 700 "$DATA_DIR"; fi
elif [ "$ACTION" = "restore" ]; then
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "มี instance ${PROFILE_CODE} อยู่แล้ว — ใช้ ACTION=redeploy เพื่ออัปเดต" >&2
    exit 1
  fi
  set_new_auth
elif [ "$ACTION" = "reset-password" ]; then
  if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "ไม่พบ instance ${PROFILE_CODE} — ใช้ ACTION=restore หากต้องการกู้ container ที่หาย" >&2
    exit 1
  fi
  if [ ! -d "$DATA_DIR" ]; then
    echo "ไม่พบ data directory ${DATA_DIR} — หยุดเพื่อไม่สร้าง instance ว่างทับของเดิม" >&2
    exit 1
  fi
  OLD_URL="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PUBLIC_URL=//p')"
  EXPECTED_URL="https://${DOMAIN}/p/${PROFILE_CODE}"
  if [ "$OLD_URL" != "$EXPECTED_URL" ]; then
    echo "PUBLIC_URL เดิมไม่ตรงกับ profile นี้ — หยุดเพื่อไม่ย้าย instance ไป URL อื่น" >&2
    exit 1
  fi
  set_new_auth
else
  if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "ไม่พบ instance ${PROFILE_CODE}" >&2
    exit 1
  fi
  if [ ! -d "$DATA_DIR" ]; then
    echo "ไม่พบ data directory ${DATA_DIR} — หยุดเพื่อไม่สร้าง instance ว่างทับของเดิม" >&2
    exit 1
  fi
  AUTH_HASH="$(docker inspect "$CONTAINER" --format "{{ index .Config.Labels \"traefik.http.middlewares.${AUTH}.basicauth.users\" }}")"
  if [ -z "$AUTH_HASH" ]; then
    echo "หา Basic Auth hash เดิมไม่เจอ — หยุดเพื่อไม่เปลี่ยนรหัสผู้เช่า" >&2
    exit 1
  fi
  OLD_URL="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PUBLIC_URL=//p')"
  EXPECTED_URL="https://${DOMAIN}/p/${PROFILE_CODE}"
  if [ "$OLD_URL" != "$EXPECTED_URL" ]; then
    echo "PUBLIC_URL เดิมไม่ตรงกับ profile นี้ — หยุดเพื่อไม่ย้าย instance ไป URL อื่น" >&2
    exit 1
  fi
fi

if [ "$SKIP_BUILD" != "1" ]; then
  docker build -t "$TENANT_IMAGE" .
fi
ROLLBACK_CONTAINER=""
rollback_previous_container() {
  if [ -n "$ROLLBACK_CONTAINER" ] && docker container inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker rename "$ROLLBACK_CONTAINER" "$CONTAINER" >/dev/null
    docker start "$CONTAINER" >/dev/null || true
  fi
}
if [ "$ACTION" = "redeploy" ] || [ "$ACTION" = "reset-password" ]; then
  ROLLBACK_CONTAINER="${CONTAINER}-rollback"
  docker container inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1 && { echo "พบ rollback container ค้างอยู่ — หยุดเพื่อไม่ทับ instance เดิม" >&2; exit 1; }
  docker stop "$CONTAINER" >/dev/null
  docker rename "$CONTAINER" "$ROLLBACK_CONTAINER" >/dev/null
fi

if ! docker run -d --name "$CONTAINER" --restart unless-stopped \
  --network "$NETWORK" \
  -e "PUBLIC_URL=https://${DOMAIN}/p/${PROFILE_CODE}" \
  -e PORT=4000 \
  -e CONFIG_PATH=/data/config.json \
  -e MAX_PROFILES=1 \
  -e "AUTOPILOT_HOLD=${AUTOPILOT_HOLD}" \
  -v "${DATA_DIR}:/data" \
  --label fbad.tenant.managed=true \
  --label "fbad.tenant.code=${PROFILE_CODE}" \
  --label traefik.enable=true \
  --label "traefik.docker.network=${NETWORK}" \
  --label "traefik.http.routers.${ROUTER}.rule=Host(\`${DOMAIN}\`) && (Path(\`/p/${PROFILE_CODE}\`) || PathPrefix(\`/p/${PROFILE_CODE}/\`))" \
  --label "traefik.http.routers.${ROUTER}.entrypoints=websecure" \
  --label "traefik.http.routers.${ROUTER}.tls.certresolver=${CERTRESOLVER}" \
  --label "traefik.http.routers.${ROUTER}.service=${SERVICE}" \
  --label "traefik.http.routers.${ROUTER}.middlewares=${AUTH},${ROUTER}-strip" \
  --label "traefik.http.middlewares.${AUTH}.basicauth.users=${AUTH_HASH}" \
  --label "traefik.http.middlewares.${AUTH}.basicauth.realm=fbad-tenant-${PROFILE_CODE}" \
  --label "traefik.http.middlewares.${ROUTER}-strip.stripprefix.prefixes=/p/${PROFILE_CODE}" \
  --label "traefik.http.routers.${PUBLIC_ROUTER}.rule=Host(\`${DOMAIN}\`) && (Path(\`/p/${PROFILE_CODE}/privacy.html\`) || Path(\`/p/${PROFILE_CODE}/lp\`) || Path(\`/p/${PROFILE_CODE}/lp/\`) || PathPrefix(\`/p/${PROFILE_CODE}/lp-asset/\`))" \
  --label "traefik.http.routers.${PUBLIC_ROUTER}.entrypoints=websecure" \
  --label "traefik.http.routers.${PUBLIC_ROUTER}.service=${SERVICE}" \
  --label "traefik.http.routers.${PUBLIC_ROUTER}.middlewares=${ROUTER}-strip" \
  --label "traefik.http.routers.${PUBLIC_ROUTER}.tls.certresolver=${CERTRESOLVER}" \
  --label "traefik.http.services.${SERVICE}.loadbalancer.server.port=4000" \
  "$TENANT_IMAGE" >/dev/null; then
  rollback_previous_container
  echo "สร้าง container ใหม่ไม่สำเร็จ — กู้ instance เดิมกลับแล้ว" >&2
  exit 1
fi

sleep 2
if ! docker exec "$CONTAINER" wget -qO /dev/null http://localhost:4000/; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rollback_previous_container
  echo "container ใหม่ไม่ตอบ — กู้ instance เดิมกลับแล้ว" >&2
  exit 1
fi
if [ -n "$ROLLBACK_CONTAINER" ]; then docker rm -f "$ROLLBACK_CONTAINER" >/dev/null; fi
echo "✅ ${ACTION} สำเร็จ"
echo "   profile code: ${PROFILE_CODE}"
echo "   หลังบ้าน: https://${DOMAIN}/p/${PROFILE_CODE}/"
echo "   Landing สาธารณะ: https://${DOMAIN}/p/${PROFILE_CODE}/lp"
echo "   ข้อมูลแยกอยู่ที่: ${DATA_DIR}"
