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
ARCHIVES="$ROOT/backups/agent"
[[ -d "$ARCHIVES" && -w "$ARCHIVES" ]] || { echo 'Provision a private backups/agent directory writable by container UID 1000.' >&2; exit 2; }
# Reject missing keys/configuration before entering maintenance.
"${DC[@]}" run --rm --no-deps --entrypoint node backup -e '
  if (!/^[a-f0-9]{64}$/i.test(process.env.AGENT_BACKUP_KEY || "") ||
      !process.env.MONGODB_URI || !process.env.AGENT_ASSET_ENCRYPTION_KEY) process.exit(2);
  require("./scripts/agent-backup.cjs").replicaConfiguration(process.env);
'
FILE="lcg-$(date -u +%Y%m%dT%H%M%SZ).enc"
STOPPED=0
restart() {
  if [[ "$STOPPED" == 1 ]]; then
    "${DC[@]}" up -d --no-deps --wait --wait-timeout 180 api worker
    curl --fail --silent --max-time 10 http://127.0.0.1:3021/api/health >/dev/null
  fi
}
trap restart EXIT
STOPPED=1
"${DC[@]}" stop api worker
"${DC[@]}" run --rm --no-deps backup backup "$FILE" --maintenance-confirmed
"${DC[@]}" run --rm --no-deps backup verify "$FILE"
restart
STOPPED=0
echo "Encrypted backup verified: $FILE"
"${DC[@]}" run --rm --no-deps backup replicate "$FILE"
# Only replicas confirmed by the export script may expire; keep unreplicated archives.
while IFS= read -r -d '' archive; do
  if [[ -f "$archive.replicated" ]] && (cd "$ARCHIVES" && sha256sum --check --status "$(basename "$archive").replicated"); then
    rm -- "$archive" "$archive.replicated"
  fi
done < <(find "$ARCHIVES" -maxdepth 1 -type f -name 'lcg-*.enc' -mtime +13 -print0)
