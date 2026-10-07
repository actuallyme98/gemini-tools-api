#!/usr/bin/env bash
# Shared deployment engine, installed by an API deployment. No source build on EC2.
# Usage: deploy-server.sh /home/ubuntu/gemini-tools api|app IMAGE|--rollback [COMPOSE]
set -euo pipefail
umask 077
ROOT="${1:?Deployment root required}"
COMPONENT="${2:?api or app required}"
IMAGE="${3:?Immutable image or --rollback required}"
[[ "$ROOT" =~ ^/[A-Za-z0-9_/-]+/gemini-tools$ && "$ROOT" != *..* ]] || exit 2
[[ "$COMPONENT" == api || "$COMPONENT" == app ]] || exit 2
mkdir -p "$ROOT/deploy"
# GitHub concurrency is per repository; this lock serializes BOTH repositories.
exec 9>"$ROOT/.deploy.lock"
flock -w 600 9 || { echo "Another Gemini deployment is still running." >&2; exit 1; }

CURRENT="$ROOT/.images.env"
COMPOSE="${4:-$ROOT/deploy/compose.production.yml}"
INSTALLED_COMPOSE="$ROOT/deploy/compose.production.yml"
PREVIOUS="$ROOT/.previous.$COMPONENT.env"
PREVIOUS_COMPOSE="$ROOT/deploy/.previous.$COMPONENT.compose.yml"
read_image() {
  if [[ -f "$1" ]]; then
    awk -F= -v key="$2" '$1 == key {print substr($0, index($0, "=") + 1); exit}' "$1"
  fi
}
validate_image() {
  [[ "$1" =~ ^ghcr.io/[a-z0-9_.-]+/gemini-tools-$2(@sha256:[a-f0-9]{64}|:[a-f0-9]{40})$ ]]
}
KEY="API_IMAGE"
[[ "$COMPONENT" == app ]] && KEY="APP_IMAGE"
if [[ "$IMAGE" == --rollback ]]; then
  IMAGE="$(read_image "$PREVIOUS" "$KEY")"
  [[ -n "$IMAGE" && -f "$PREVIOUS_COMPOSE" ]] || {
    echo "No previous successful $COMPONENT deployment to restore." >&2; exit 1;
  }
  COMPOSE="$PREVIOUS_COMPOSE"
fi
validate_image "$IMAGE" "$COMPONENT" || { echo "Invalid immutable image." >&2; exit 2; }
[[ -f "$ROOT/.env" && -f "$COMPOSE" ]] || {
  echo "Provision $ROOT/.env and deploy API configuration first." >&2; exit 1;
}
API_IMAGE="$(read_image "$CURRENT" API_IMAGE)"
APP_IMAGE="$(read_image "$CURRENT" APP_IMAGE)"
OLD_IMAGE="$(read_image "$CURRENT" "$KEY")"
[[ -z "$API_IMAGE" ]] || validate_image "$API_IMAGE" api
[[ -z "$APP_IMAGE" ]] || validate_image "$APP_IMAGE" app
if [[ "$COMPONENT" == api ]]; then API_IMAGE="$IMAGE"; else APP_IMAGE="$IMAGE"; fi
[[ -n "$API_IMAGE" ]] || { echo "Deploy API before frontend." >&2; exit 1; }
chmod 600 "$ROOT/.env"
CANDIDATE="$(mktemp "$ROOT/.candidate.XXXXXXXX")"
STAGED_COMPOSE="$(mktemp "$ROOT/deploy/.compose.XXXXXXXX.yml")"
trap 'rm -f -- "$CANDIDATE" "$STAGED_COMPOSE"' EXIT
cp "$COMPOSE" "$STAGED_COMPOSE"
COMPOSE="$STAGED_COMPOSE"
printf 'DEPLOY_PATH=%s\nAPI_IMAGE=%s\nAPP_IMAGE=%s\n' "$ROOT" "$API_IMAGE" "$APP_IMAGE" > "$CANDIDATE"
DC=(docker compose --project-name gemini-tools --env-file "$CANDIDATE" -f "$COMPOSE")
# --quiet avoids printing the runtime env and provider credentials.
"${DC[@]}" config --quiet
"${DC[@]}" pull "$COMPONENT"

check_api() {
  curl --fail --silent --show-error --max-time 10 --retry 5 --retry-delay 2 --retry-all-errors \
    http://127.0.0.1:3021/api/health | grep -q '"status":"ok"'
}
check_app() {
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3020/healthz >/dev/null &&
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3020/ >/dev/null &&
  curl --fail --silent --show-error --max-time 10 --retry 10 --retry-delay 2 --retry-all-errors \
    http://127.0.0.1:3020/api/health | grep -q '"status":"ok"'
}
smoke() {
  check_api || return 1
  if [[ -n "$APP_IMAGE" ]]; then check_app || return 1; fi
}
rollback_failed_deploy() {
  echo "Deployment failed; restoring the previous $COMPONENT image." >&2
  if [[ -n "$OLD_IMAGE" && -f "$INSTALLED_COMPOSE" ]]; then
    local previous_dc=(docker compose --project-name gemini-tools --env-file "$CURRENT" -f "$INSTALLED_COMPOSE")
    APP_IMAGE="$(read_image "$CURRENT" APP_IMAGE)"
    if "${previous_dc[@]}" up -d --no-deps --wait --wait-timeout 120 "$COMPONENT" && smoke; then
      echo "Previous $COMPONENT container restored." >&2
    else
      echo "ROLLBACK FAILED. Inspect: docker compose --project-name gemini-tools ps" >&2
    fi
  else
    # First release has no old image. Only remove its failed service.
    "${DC[@]}" stop "$COMPONENT" || true
    "${DC[@]}" rm -f "$COMPONENT" || true
  fi
  exit 1
}
if ! "${DC[@]}" up -d --no-deps --wait --wait-timeout 120 "$COMPONENT"; then
  rollback_failed_deploy
fi
if ! smoke; then rollback_failed_deploy; fi

# Snapshot only after health passes. Failed releases never become "current".
if [[ -f "$CURRENT" && -f "$INSTALLED_COMPOSE" ]]; then
  cp "$CURRENT" "$PREVIOUS.next"
  cp "$INSTALLED_COMPOSE" "$PREVIOUS_COMPOSE.next"
  mv "$PREVIOUS.next" "$PREVIOUS"
  mv "$PREVIOUS_COMPOSE.next" "$PREVIOUS_COMPOSE"
fi
cp "$COMPOSE" "$INSTALLED_COMPOSE.next"
mv "$INSTALLED_COMPOSE.next" "$INSTALLED_COMPOSE"
if [[ "$COMPONENT" == api ]]; then
  cp "${BASH_SOURCE[0]}" "$ROOT/deploy/deploy-server.sh.next"
  chmod 700 "$ROOT/deploy/deploy-server.sh.next"
  mv "$ROOT/deploy/deploy-server.sh.next" "$ROOT/deploy/deploy-server.sh"
fi
mv "$CANDIDATE" "$CURRENT"
echo "Healthy: $COMPONENT -> $IMAGE"
