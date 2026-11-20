#!/usr/bin/env bash
# Run an admin script on the server as the app user, with the server settings loaded.
#   sudo bash deploy/run.sh scripts/setup-gb.js --roster config/private/roster.csv --decisions config/private/gb-decisions.json
set -euo pipefail
cd /opt/gb-prism
exec sudo -u gbprism bash -c 'set -a; . /etc/gb-prism/env; set +a; exec node --no-warnings "$@" --db "$DB_FILE"' _ "$@"
