#!/usr/bin/env bash
# Pull the latest code and reinstall it into /opt/gb-prism (data, secrets and private config are kept).
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
DOMAIN=$(sudo grep '^BASE_URL=' /etc/gb-prism/env | sed 's#^BASE_URL=https://##')
if [ -z "$DOMAIN" ]; then echo "Could not read BASE_URL from /etc/gb-prism/env"; exit 1; fi
sudo bash deploy/vm-setup.sh "$DOMAIN"
sudo systemctl restart gb-prism
echo "Installed: $(git log --oneline -1)"
