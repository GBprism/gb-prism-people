#!/usr/bin/env bash
# One-time setup of GB Prism on a fresh Debian 12 VM (Google Compute Engine).
#   sudo bash deploy/vm-setup.sh prism.gb-advisory.com gs://<backup-bucket>
# Re-running is safe: it updates the app and keeps data, secrets and backups.
set -euo pipefail

DOMAIN="${1:?usage: vm-setup.sh <domain> [gs://backup-bucket]}"
BUCKET="${2:-}"
APP_DIR=/opt/gb-prism
DATA_DIR=/var/lib/gb-prism
ENV_FILE=/etc/gb-prism/env
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "== app user and folders"
id gbprism >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin gbprism
mkdir -p "$APP_DIR" "$DATA_DIR" /etc/gb-prism
chown gbprism:gbprism "$DATA_DIR"; chmod 700 "$DATA_DIR"

echo "== app code"
rsync -a --delete --exclude .git --exclude node_modules --exclude data --exclude private-extracts --exclude backup --exclude config/private "$SRC_DIR"/ "$APP_DIR"/ 2>/dev/null \
  || { apt-get install -y -qq rsync >/dev/null; rsync -a --delete --exclude .git --exclude node_modules --exclude data --exclude private-extracts --exclude backup --exclude config/private "$SRC_DIR"/ "$APP_DIR"/; }
(cd "$APP_DIR" && npm ci --omit=dev --silent)
mkdir -p "$APP_DIR/config/private"; chown -R gbprism:gbprism "$APP_DIR/config/private"; chmod 700 "$APP_DIR/config/private"

echo "== settings file (secrets stay on this server only)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DB_FILE=$DATA_DIR/prism-people.db
BASE_URL=https://$DOMAIN
AUTH_MODE=google
GOOGLE_ALLOWED_DOMAIN=gb-advisory.com
GOOGLE_TENANT=gb-advisory
GOOGLE_CLIENT_ID=PASTE_CLIENT_ID_HERE
GOOGLE_CLIENT_SECRET=PASTE_CLIENT_SECRET_HERE
SESSION_SECRET=$(openssl rand -hex 32)
OUTBOX_DIR=$DATA_DIR/outbox
EOF
fi
chown root:gbprism "$ENV_FILE"; chmod 640 "$ENV_FILE"

echo "== service"
cp "$APP_DIR/deploy/gb-prism.service" /etc/systemd/system/gb-prism.service
sed "s/__DOMAIN__/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable gb-prism caddy >/dev/null

echo "== nightly backup"
if [ -n "$BUCKET" ]; then
  cat > /etc/cron.d/gb-prism-backup <<EOF
15 1 * * * root $APP_DIR/deploy/backup.sh $DATA_DIR/prism-people.db $BUCKET >> /var/log/gb-prism-backup.log 2>&1
EOF
fi

if grep -q PASTE_CLIENT "$ENV_FILE"; then
  echo
  echo "NEXT: put the Google client ID and secret in $ENV_FILE:"
  echo "  sudo nano $ENV_FILE"
  echo "then start the app:"
  echo "  sudo systemctl restart gb-prism caddy"
else
  systemctl restart gb-prism caddy
  echo "Running at https://$DOMAIN"
fi
