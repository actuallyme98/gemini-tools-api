#!/usr/bin/env bash
# Usage: bash scripts/deploy.sh ghcr.io/OWNER/gemini-tools-api@sha256:DIGEST
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$SCRIPT_DIR/.deploy-config" ]]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.deploy-config"
fi
: "${SERVER_IP:?Set SERVER_IP or copy scripts/.deploy-config.example}"
: "${SSH_KEY:?Set SSH_KEY}"
case "$SSH_KEY" in
  /*|[A-Za-z]:/*) ;;
  *) SSH_KEY="$REPO_DIR/$SSH_KEY" ;;
esac
SERVER_USER="${SERVER_USER:-ubuntu}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/ubuntu/gemini-tools}"
IMAGE="${1:?Supply an immutable GHCR image digest or full commit SHA tag}"
[[ "$SERVER_IP" =~ ^[A-Za-z0-9.-]+$ && "$SERVER_USER" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
[[ "$DEPLOY_PATH" =~ ^/[A-Za-z0-9_/-]+/gemini-tools$ && "$DEPLOY_PATH" != *..* ]] || exit 2
if [[ "$IMAGE" == --rollback ]]; then
  ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
    "$SERVER_USER@$SERVER_IP" "bash '$DEPLOY_PATH/deploy/deploy-server.sh' '$DEPLOY_PATH' api --rollback"
  exit
fi
[[ "$IMAGE" =~ ^ghcr.io/[a-z0-9_.-]+/gemini-tools-api(@sha256:[a-f0-9]{64}|:[a-f0-9]{40})$ ]] || {
  echo "Use this component's image with @sha256 digest or full 40-character commit SHA." >&2
  exit 2
}
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "$SERVER_USER@$SERVER_IP")
INCOMING="$("${SSH[@]}" "umask 077; mkdir -p '$DEPLOY_PATH'; mktemp -d '$DEPLOY_PATH/.incoming.XXXXXXXX'")"
[[ "$INCOMING" == "$DEPLOY_PATH"/.incoming.* && "$INCOMING" =~ ^/[A-Za-z0-9_./-]+$ ]] || exit 2
# Only deployment assets are uploaded. The runtime .env is provisioned separately.
tar -C "$REPO_DIR" -czf - deploy/compose.production.yml deploy/deploy-server.sh |
  "${SSH[@]}" "tar -xzf - -C '$INCOMING'"
"${SSH[@]}" "bash '$INCOMING/deploy/deploy-server.sh' '$DEPLOY_PATH' api '$IMAGE' '$INCOMING/deploy/compose.production.yml'"
