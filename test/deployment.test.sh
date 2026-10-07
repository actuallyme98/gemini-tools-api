#!/usr/bin/env bash
# Exercise deployment state, rollback and cross-repo locking without real Docker.
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/gemini-deploy-test-XXXXXXXX")"
cleanup() {
  [[ "$TEMP" == "${TMPDIR:-/tmp}"/gemini-deploy-test-* ]] || return
  find "$TEMP" -depth -delete
}
trap cleanup EXIT
mkdir -p "$TEMP/bin"
export PATH="$TEMP/bin:$PATH"
export TRACE="$TEMP/trace" FAIL_UP="$TEMP/fail-up" FAIL_PULL="$TEMP/fail-pull" FAIL_CURL="$TEMP/fail-curl"
cat > "$TEMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TRACE"
if [[ "$*" == *" up "* ]]; then
  args=("$@")
  for ((i=0; i<${#args[@]}; i++)); do
    if [[ "${args[i]}" == --env-file ]]; then
      cat "${args[i+1]}" >> "$TRACE"
    fi
  done
  if [[ -f "$FAIL_UP" ]]; then rm -f "$FAIL_UP"; exit 1; fi
  sleep "${UP_DELAY:-0}"
fi
if [[ "$*" == *" pull "* && -f "$FAIL_PULL" ]]; then rm -f "$FAIL_PULL"; exit 1; fi
MOCK
cat > "$TEMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "$TRACE"
if [[ -f "$FAIL_CURL" ]]; then rm -f "$FAIL_CURL"; exit 1; fi
printf '{"status":"ok"}'
MOCK
chmod +x "$TEMP/bin/docker" "$TEMP/bin/curl"
ROOT="$TEMP/case/gemini-tools"
mkdir -p "$ROOT"
echo 'FAKE_ENV=for-tests-only' > "$ROOT/.env"
API1="ghcr.io/actuallyme98/gemini-tools-api:$(printf '%040d' 1)"
API2="ghcr.io/actuallyme98/gemini-tools-api:$(printf '%040d' 2)"
API3="ghcr.io/actuallyme98/gemini-tools-api:$(printf '%040d' 3)"
APP1="ghcr.io/actuallyme98/gemini-tools-app:$(printf '%040d' 1)"
APP2="ghcr.io/actuallyme98/gemini-tools-app:$(printf '%040d' 2)"
CONFIG="$TEMP/config.yml"
cp "$PROJECT/deploy/compose.production.yml" "$CONFIG"
run() { bash "$PROJECT/deploy/deploy-server.sh" "$ROOT" "$@" > "$TEMP/output" 2>&1; }
expect_failure() {
  if run "$@"; then echo "Expected failure: $*" >&2; exit 1; fi
}
assert_image() { grep -Fxq "$1=$2" "$ROOT/.images.env"; }
passed() { echo "PASS: $1"; }

# No API means the first frontend release cannot accidentally start another stack.
expect_failure app "$APP1" "$CONFIG"
[[ ! -f "$TRACE" ]]
passed 'frontend requires an existing API deployment'

run api "$API1" "$CONFIG"
assert_image API_IMAGE "$API1"
grep -Fxq 'APP_IMAGE=' "$ROOT/.images.env"
grep -q ' up .* api$' "$TRACE"
if grep -q ' up .* app$' "$TRACE"; then exit 1; fi
passed 'first API release starts only API'

run app "$APP1"
assert_image API_IMAGE "$API1"
assert_image APP_IMAGE "$APP1"
grep -q '3020/api/health' "$TRACE"
passed 'frontend preserves API and checks the proxy'

echo '# revision two' >> "$CONFIG"
run api "$API2" "$CONFIG"
assert_image API_IMAGE "$API2"
assert_image APP_IMAGE "$APP1"
grep -Fxq "API_IMAGE=$API1" "$ROOT/.previous.api.env"
passed 'API release preserves frontend and snapshots its previous image'

cp "$ROOT/.images.env" "$TEMP/before.env"
touch "$FAIL_PULL"
expect_failure api "$API3" "$CONFIG"
cmp "$TEMP/before.env" "$ROOT/.images.env"
passed 'failed pull preserves deployment state'

touch "$FAIL_UP"
expect_failure api "$API3" "$CONFIG"
cmp "$TEMP/before.env" "$ROOT/.images.env"
grep -q 'Previous api container restored' "$TEMP/output"
passed 'failed container startup restores the prior API'

touch "$FAIL_CURL"
expect_failure app "$APP2"
assert_image APP_IMAGE "$APP1"
grep -q 'Previous app container restored' "$TEMP/output"
passed 'failed smoke check restores the prior frontend'

run api --rollback
assert_image API_IMAGE "$API1"
assert_image APP_IMAGE "$APP1"
if grep -q 'revision two' "$ROOT/deploy/compose.production.yml"; then exit 1; fi
passed 'manual rollback restores image and Compose configuration'

# Both publishers may run at once. The shared flock prevents a lost state update.
UP_DELAY=1 run api "$API3" "$CONFIG" &
PID_API=$!
UP_DELAY=1 run app "$APP2" &
PID_APP=$!
wait "$PID_API"
wait "$PID_APP"
assert_image API_IMAGE "$API3"
assert_image APP_IMAGE "$APP2"
passed 'concurrent repositories preserve both image updates'

ROOT="$TEMP/first-failure/gemini-tools"
mkdir -p "$ROOT"
echo 'FAKE_ENV=for-tests-only' > "$ROOT/.env"
touch "$FAIL_UP"
expect_failure api "$API1" "$CONFIG"
[[ ! -f "$ROOT/.images.env" ]]
grep -q ' rm -f api$' "$TRACE"
if grep -Eq ' (down|prune)( |$)|ezihubb' "$TRACE"; then exit 1; fi
passed 'failed first release removes only its own service'
