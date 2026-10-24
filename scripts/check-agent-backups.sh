#!/usr/bin/env bash
# Read-only check, also used from GitHub's external production monitor.
set -euo pipefail
ROOT="${1:?Deployment root required}"
[[ "$ROOT" =~ ^/[A-Za-z0-9_/-]+/gemini-tools$ && "$ROOT" != *..* ]] || exit 2
systemctl is-active --quiet lcg-agent-backup.timer
STATE="$(systemctl show lcg-agent-backup.service --property=ActiveState --value)"
if [[ "$STATE" == activating || "$STATE" == active ]]; then
  echo 'Backup maintenance is in progress; systemd timeout bounds this operation.'
  exit 0
fi
[[ "$(systemctl show lcg-agent-backup.service --property=Result --value)" == success ]]
LATEST="$(find "$ROOT/backups/agent" -maxdepth 1 -type f -name 'lcg-*.enc' -printf '%f\n' | sort | tail -1)"
[[ "$LATEST" =~ ^lcg-[0-9]{8}T[0-9]{6}Z\.enc$ ]]
MODIFIED="$(stat -c %Y "$ROOT/backups/agent/$LATEST")"
AGE=$(( $(date +%s) - MODIFIED ))
(( AGE >= 0 && AGE <= 129600 )) || { echo 'Backup is missing or older than 36 hours.' >&2; exit 1; }
cd "$ROOT/backups/agent"
sha256sum --check --status "$LATEST.replicated"
echo "Backup is recent and its verified replica marker matches: $LATEST"
