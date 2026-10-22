#!/usr/bin/env bash
# Verify production dependencies can boot the application.
set -euo pipefail
IMAGE="${1:?Image required}"
NAME="gemini-api-smoke-${GITHUB_RUN_ID:-$$}"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
# Default image/vision and the text fallback use ShopAIKey at startup.
# Placeholder credentials exercise that configuration without calling either AI provider.
docker run -d --name "$NAME" --env-file .env.example -e NODE_ENV=production \
  -e QUEUE_ENABLED=false -e AGENT_ENABLED=false \
  -e SHOPAIKEY_API_KEY=ci-placeholder-shopaikey-key \
  -e SHOPAIKEY_MODEL_IMAGE=gemini-3.1-flash-image-preview \
  -e VYCEAI_API_KEY=ci-placeholder-vyceai-key \
  -p 127.0.0.1:5181:5177 "$IMAGE" >/dev/null
for _ in {1..40}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$NAME")" == healthy ]] &&
    curl --fail --silent --max-time 3 http://127.0.0.1:5181/api/health | grep -q '"status":"ok"'; then
    headers="$(curl --fail --silent --show-error --max-time 5 -D - -o /dev/null \
      -X OPTIONS -H 'Origin: https://tools.lcgmedia.uk' -H 'Access-Control-Request-Method: POST' \
      -H 'Access-Control-Request-Headers: content-type' http://127.0.0.1:5181/api/backgrounds/replace)"
    grep -qi '^Access-Control-Allow-Origin: https://tools.lcgmedia.uk' <<< "$headers"
    denied="$(curl --fail --silent --show-error --max-time 5 -D - -o /dev/null \
      -H 'Origin: https://untrusted.example' http://127.0.0.1:5181/api/health)"
    if grep -qi '^Access-Control-Allow-Origin:' <<< "$denied"; then exit 1; fi
    echo "Production API image is healthy."
    exit 0
  fi
  sleep 2
done
# Only placeholder CI values, never production credentials.
docker logs "$NAME"
exit 1
