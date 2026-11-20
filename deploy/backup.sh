#!/usr/bin/env bash
# Consistent SQLite snapshot → Cloud Storage bucket (keep the bucket private, with a retention rule).
set -euo pipefail
DB="${1:?db path}"; BUCKET="${2:?gs://bucket}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d)
sqlite3 "$DB" ".backup '$TMP/prism-people-$STAMP.db'"
gzip "$TMP/prism-people-$STAMP.db"
gcloud storage cp "$TMP/prism-people-$STAMP.db.gz" "$BUCKET/db/" --quiet
rm -rf "$TMP"
echo "$STAMP backup ok"
