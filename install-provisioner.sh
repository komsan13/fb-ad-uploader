#!/usr/bin/env bash
# ติดตั้งเพียงครั้งเดียวบน production host หลัง git pull; ไม่ได้รันจากเว็บแอดมิน
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(realpath -e "${REPO_DIR:-$SCRIPT_DIR}")"
CONF_DIR=/etc/fbad-provisioner
RUNTIME_DIR=/usr/local/lib/fbad-provisioner
PROVISIONER_ENV="$CONF_DIR/provisioner.env"
MASTER_ENV="$CONF_DIR/master.env"

[ -f "$REPO_DIR/tenant-provisioner.js" ] || { echo "ไม่พบ $REPO_DIR/tenant-provisioner.js" >&2; exit 1; }
[ -f "$REPO_DIR/tenant-deploy.sh" ] || { echo "ไม่พบ $REPO_DIR/tenant-deploy.sh" >&2; exit 1; }
[ -f "$REPO_DIR/systemd/fbad-provisioner.service" ] || { echo "ไม่พบ systemd unit" >&2; exit 1; }
command -v openssl >/dev/null || { echo "ต้องติดตั้ง openssl ก่อน" >&2; exit 1; }
IMAGE_ID="$(docker image inspect fbad:latest --format '{{.Id}}' 2>/dev/null || true)"
[[ "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "ไม่พบ immutable image ID ของ fbad:latest — build image หลักก่อน" >&2; exit 1; }

install -d -m 700 "$CONF_DIR" "$RUNTIME_DIR" /opt/fbad-provisioner /opt/fbad-tenants /opt/fbad-tenants-archive
install -o root -g root -m 700 "$REPO_DIR/tenant-provisioner.js" "$RUNTIME_DIR/tenant-provisioner.js"
install -o root -g root -m 700 "$REPO_DIR/tenant-deploy.sh" "$RUNTIME_DIR/tenant-deploy.sh"
if [ ! -f "$MASTER_ENV" ]; then
  TOKEN="$(openssl rand -hex 32)"
  printf 'TENANT_PROVISIONER_SOCKET=/run/fbad-provisioner.sock\nTENANT_PROVISIONER_TOKEN=%s\n' "$TOKEN" > "$MASTER_ENV"
  chmod 600 "$MASTER_ENV"
fi
if [ ! -f "$PROVISIONER_ENV" ]; then
  TOKEN="$(sed -n 's/^TENANT_PROVISIONER_TOKEN=//p' "$MASTER_ENV")"
  cat > "$PROVISIONER_ENV" <<EOF
PROVISIONER_SOCKET=/run/fbad-provisioner.sock
PROVISIONER_TOKEN=$TOKEN
PROVISIONER_REGISTRY=/opt/fbad-provisioner/tenants.json
PROVISIONER_AUDIT=/opt/fbad-provisioner/audit.jsonl
TENANT_DEPLOY_SCRIPT=$RUNTIME_DIR/tenant-deploy.sh
TENANT_DOMAIN=ad.senball.com
TENANT_DATA_ROOT=/opt/fbad-tenants
TENANT_ARCHIVE_ROOT=/opt/fbad-tenants-archive
TENANT_IMAGE=$IMAGE_ID
TRAEFIK_CONTAINER=traefik-traefik-1
EOF
  chmod 600 "$PROVISIONER_ENV"
else
  CURRENT_PIN="$(sed -n 's/^TENANT_IMAGE=//p' "$PROVISIONER_ENV" | tail -n 1)"
  if [[ ! "$CURRENT_PIN" =~ ^([A-Za-z0-9._/-]+@)?sha256:[a-f0-9]{64}$ ]]; then
    cp "$PROVISIONER_ENV" "${PROVISIONER_ENV}.bak-before-image-pin"
    if grep -q '^TENANT_IMAGE=' "$PROVISIONER_ENV"; then
      sed -i "s|^TENANT_IMAGE=.*|TENANT_IMAGE=$IMAGE_ID|" "$PROVISIONER_ENV"
    else
      printf '\nTENANT_IMAGE=%s\n' "$IMAGE_ID" >> "$PROVISIONER_ENV"
    fi
    chmod 600 "$PROVISIONER_ENV"
  fi
fi
install -m 644 "$REPO_DIR/systemd/fbad-provisioner.service" /etc/systemd/system/fbad-provisioner.service
systemctl daemon-reload
systemctl enable --now fbad-provisioner
systemctl --no-pager --full status fbad-provisioner
