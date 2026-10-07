#!/usr/bin/env bash
# Verify production dependencies can boot the application.
set -euo pipefail
IMAGE="${1:?Image required}"
NAME="gemini-api-smoke-${GITHUB_RUN_ID:-$$}"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$NAME" --env-file .env.example -e NODE_ENV=production \
  -p 127.0.0.1:5181:5177 "$IMAGE" >/dev/null
for _ in {1..40}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$NAME")" == healthy ]] &&
    curl --fail --silent --max-time 3 http://127.0.0.1:5181/api/health | grep -q '"status":"ok"'; then
    echo "Production API image is healthy."
    exit 0
  fi
  sleep 2
done
# Only placeholder CI values, never production credentials.
docker logs "$NAME"
exit 1
