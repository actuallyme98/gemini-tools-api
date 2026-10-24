#!/usr/bin/env bash
# Run from a systemd timer, separately from deployment. Never prints runtime env.
set -euo pipefail
umask 077
ROOT="${1:?Deployment root required}"
[[ "$ROOT" =~ ^/[A-Za-z0-9_/-]+/gemini-tools$ && "$ROOT" != *..* ]] || exit 2
[[ -f "$ROOT/.images.env" && -f "$ROOT/deploy/compose.backup.yml" ]] || exit 2
exec 9>"$ROOT/.deploy.lock"
flock -w 600 9 || exit 1
DC=(docker compose --project-name gemini-tools --env-file "$ROOT/.images.env" -f "$ROOT/deploy/compose.production.yml" -f "$ROOT/deploy/compose.backup.yml")
"${DC[@]}" config --quiet
[[ -d "$ROOT/backups" && -w "$ROOT/backups" ]] || { echo 'Provision a private backups directory writable by container UID 1000.' >&2; exit 2; }
FILE="lcg-$(date -u +%Y%m%dT%H%M%SZ).enc"
STOPPED=0
restart() {
  if [[ "$STOPPED" == 1 ]]; then "${DC[@]}" up -d --no-deps --wait --wait-timeout 180 api worker; fi
}
trap restart EXIT
STOPPED=1
"${DC[@]}" stop api worker
"${DC[@]}" run --rm --no-deps backup backup "$FILE" --maintenance-confirmed
"${DC[@]}" run --rm --no-deps backup verify "$FILE"
restart
STOPPED=0
echo "Encrypted backup verified: $FILE"
# Retain locally until an operator configures off-server replication and retention.
