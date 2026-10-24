#!/usr/bin/env bash
# Download an encrypted archive; recovery keys must be stored separately.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.deploy-config" ]]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.deploy-config"
fi
: "${SERVER_IP:?Set SERVER_IP}"
: "${SSH_KEY:?Set SSH_KEY}"
SERVER_USER="${SERVER_USER:-ubuntu}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/ubuntu/gemini-tools}"
DESTINATION="${1:?Supply a private local backup directory}"
FILE="${2:?Supply the exact lcg-YYYYMMDDTHHMMSSZ.enc filename}"
[[ "$FILE" =~ ^lcg-[0-9]{8}T[0-9]{6}Z\.enc$ ]] || exit 2
[[ "$DEPLOY_PATH" =~ ^/[A-Za-z0-9_/-]+/gemini-tools$ && "$DEPLOY_PATH" != *..* ]] || exit 2
[[ "$SERVER_IP" =~ ^[A-Za-z0-9.-]+$ && "$SERVER_USER" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "$SERVER_USER@$SERVER_IP")
REMOTE="$DEPLOY_PATH/backups/agent/$FILE"
EXPECTED="$("${SSH[@]}" "sha256sum '$REMOTE'")"
EXPECTED="${EXPECTED%% *}"
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || exit 1
mkdir -p "$DESTINATION"
if [[ ! -e "$DESTINATION/$FILE" ]]; then
  scp -q -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "$SERVER_USER@$SERVER_IP:$REMOTE" "$DESTINATION/$FILE"
fi
ACTUAL="$(sha256sum "$DESTINATION/$FILE")"
[[ "${ACTUAL%% *}" == "$EXPECTED" ]] || { echo 'Replica checksum mismatch; source is retained.' >&2; exit 1; }
# The marker is written only after the off-server copy passes the checksum.
"${SSH[@]}" "printf '%s  %s\n' '$EXPECTED' '$FILE' > '$REMOTE.replicated'"
echo "Off-server encrypted replica verified: $DESTINATION/$FILE"
