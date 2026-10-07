#!/usr/bin/env bash
# Configure deployment credentials and variables in BOTH GitHub repositories.
# Requires gh auth login and a previously verified SSH host in known_hosts.
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
GH_OWNER="${GH_OWNER:-actuallyme98}"
case "$SSH_KEY" in /*|[A-Za-z]:/*) ;; *) SSH_KEY="$REPO_DIR/$SSH_KEY" ;; esac
[[ -f "$SSH_KEY" && "$GH_OWNER" =~ ^[A-Za-z0-9-]+$ ]] || exit 2
HOSTS="$(mktemp)"
trap 'rm -f -- "$HOSTS"' EXIT
ssh-keygen -F "$SERVER_IP" | sed '/^#/d' > "$HOSTS"
[[ -s "$HOSTS" ]] || { echo "Verify the server host key before configuring CI." >&2; exit 1; }
for name in gemini-tools-api gemini-tools-app; do
  repo="$GH_OWNER/$name"
  gh secret set DEPLOY_SSH_KEY --repo "$repo" < "$SSH_KEY"
  gh secret set DEPLOY_KNOWN_HOSTS --repo "$repo" < "$HOSTS"
  gh variable set DEPLOY_HOST --repo "$repo" --body "$SERVER_IP"
  gh variable set DEPLOY_USER --repo "$repo" --body "$SERVER_USER"
  # Prevent Git Bash from rewriting the Linux path for native gh.exe on Windows.
  MSYS_NO_PATHCONV=1 gh variable set DEPLOY_PATH --repo "$repo" --body "$DEPLOY_PATH"
  # Enable after the first manual API + frontend deployment succeeds.
  gh variable set DEPLOY_ENABLED --repo "$repo" --body false
  echo "Configured $repo; automatic deploy disabled until initial verification."
done
