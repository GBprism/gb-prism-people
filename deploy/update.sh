#!/usr/bin/env bash
# Pull the latest code and restart (data, secrets and private config are kept).
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
sudo bash deploy/vm-setup.sh "$(grep ^BASE_URL= /etc/gb-prism/env | sed 's#BASE_URL=https://##')"
