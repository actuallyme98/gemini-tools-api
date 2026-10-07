#!/usr/bin/env bash
# Provision deployment files and the API runtime env; does not start containers.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$SCRIPT_DIR/.deploy-config" ]]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.deploy-config"
fi
: "${SERVER_IP:?Set SERVER_IP}"
: "${SSH_KEY:?Set SSH_KEY}"
SERVER_USER="${SERVER_USER:-ubuntu}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/ubuntu/gemini-tools}"
API_ENV_FILE="${API_ENV_FILE:-$REPO_DIR/.env}"
case "$SSH_KEY" in /*|[A-Za-z]:/*) ;; *) SSH_KEY="$REPO_DIR/$SSH_KEY" ;; esac
[[ "$SERVER_IP" =~ ^[A-Za-z0-9.-]+$ && "$SERVER_USER" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
[[ "$DEPLOY_PATH" =~ ^/[A-Za-z0-9_/-]+/gemini-tools$ && "$DEPLOY_PATH" != *..* ]] || exit 2
[[ -f "$API_ENV_FILE" ]] || { echo "Missing API runtime env file." >&2; exit 1; }
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "$SERVER_USER@$SERVER_IP")
INCOMING="$("${SSH[@]}" "umask 077; mkdir -p '$DEPLOY_PATH'; mktemp -d '$DEPLOY_PATH/.bootstrap.XXXXXXXX'")"
[[ "$INCOMING" == "$DEPLOY_PATH"/.bootstrap.* && "$INCOMING" =~ ^/[A-Za-z0-9_./-]+$ ]] || exit 2
tar -C "$REPO_DIR" -czf - deploy/compose.production.yml deploy/deploy-server.sh deploy/nginx-gemini-tools.conf |
  "${SSH[@]}" "tar -xzf - -C '$INCOMING'"
if ! "${SSH[@]}" "test -f '$DEPLOY_PATH/.env'"; then
  # Stream over SSH with a restrictive umask; never print or commit credentials.
  "${SSH[@]}" "umask 077; cat > '$INCOMING/.env'" < "$API_ENV_FILE"
fi
"${SSH[@]}" "flock -w 600 '$DEPLOY_PATH/.deploy.lock' bash -s -- '$DEPLOY_PATH' '$INCOMING'" <<'BOOTSTRAP'
set -euo pipefail
ROOT="$1"
INCOMING="$2"
mkdir -p "$ROOT/deploy"
if [[ ! -f "$ROOT/.env" ]]; then mv "$INCOMING/.env" "$ROOT/.env"; fi
chmod 600 "$ROOT/.env"
if [[ ! -f "$ROOT/deploy/deploy-server.sh" || ! -f "$ROOT/.images.env" ]]; then
  install -m 700 "$INCOMING/deploy/deploy-server.sh" "$ROOT/deploy/deploy-server.sh"
  install -m 600 "$INCOMING/deploy/compose.production.yml" "$ROOT/deploy/compose.production.yml"
fi
if [[ ! -f "$ROOT/deploy/nginx-gemini-tools.conf" ]]; then
  install -m 600 "$INCOMING/deploy/nginx-gemini-tools.conf" "$ROOT/deploy/nginx-gemini-tools.conf"
fi
docker compose version
command -v curl
echo "Server files prepared. Existing runtime env preserved; active releases keep their deployment files."
BOOTSTRAP
