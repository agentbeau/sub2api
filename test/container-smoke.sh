#!/bin/sh
# Builds the CPA image and runs it against the Worker's S3 shim (src/s3.ts) served by Node:
# management, branded panel, an API key saved the way the dashboard saves it, empty-provider
# authentication rejection, the config surviving a restart from the bucket, and
# a first start that takes a config and logins moved from the Workers-only install.
set -eu

build=true
case "${1:-}" in
  "") ;;
  --prebuilt) build=false; [ -n "${IMAGE:-}" ] || { echo "--prebuilt requires IMAGE" >&2; exit 64; } ;;
  *) echo "usage: sh test/container-smoke.sh [--prebuilt]" >&2; exit 64 ;;
esac

IMAGE=${IMAGE:-sub2api-cpa:test}
NODE_IMAGE=node:24-alpine
NET=sub2api-smoke
PORT=18317
S3_BASE=http://127.0.0.1:19000
S3_ENDPOINT=http://smoke-s3:9000
NETWORK_MODE=${SUB2API_DOCKER_NETWORK:-bridge}
case "$NETWORK_MODE" in
  bridge) ;;
  host) NET=host; PORT=8317; S3_BASE=http://127.0.0.1:9000; S3_ENDPOINT=$S3_BASE ;;
  *) echo "SUB2API_DOCKER_NETWORK must be bridge or host" >&2; exit 64 ;;
esac
CLIENT_KEY=client-key-0123456789abcdef0123456789abcdef
MANAGEMENT_KEY=management-key-0123456789abcdef0123456789ab

cleanup() {
  docker rm -f smoke-cpa smoke-s3 >/dev/null 2>&1 || true
  if [ "$NETWORK_MODE" = bridge ]; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
cleanup

fail() {
  echo "FAIL: $*" >&2
  docker logs smoke-cpa >&2 || true
  docker logs smoke-s3 >&2 || true
  exit 1
}

status() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

expect() {
  want=$1
  shift
  got=$(status "$@")
  [ "$got" = "$want" ] || fail "expected $want, got $got for: $*"
  echo "ok $want $*"
}

start_cpa() {
  docker rm -f smoke-cpa >/dev/null 2>&1 || true
  if [ "$NETWORK_MODE" = bridge ]; then set -- -p "127.0.0.1:$PORT:8317" "$@"; fi
  docker run -d --name smoke-cpa --network "$NET" \
    -e OBJECTSTORE_ENDPOINT="$S3_ENDPOINT" \
    -e OBJECTSTORE_BUCKET=state \
    -e OBJECTSTORE_ACCESS_KEY=smoke-access \
    -e OBJECTSTORE_SECRET_KEY=smoke-secret-0123456789 \
    -e CPA_MANAGEMENT_KEY="$MANAGEMENT_KEY" \
    -e SUB2API_ACTIVITY_ENDPOINT="$S3_ENDPOINT/__sub2api/activity" \
    "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    [ "$(status "http://127.0.0.1:$PORT/healthz")" = 200 ] && return 0
    sleep 1
  done
  fail "CPA did not become healthy"
}

start_s3() {
  docker rm -f smoke-s3 >/dev/null 2>&1 || true
  set --
  if [ "$NETWORK_MODE" = bridge ]; then set -- -p "127.0.0.1:19000:9000"; fi
  docker run -d --name smoke-s3 --network "$NET" "$@" \
    -v "$(pwd):/app:ro" -w /app "$NODE_IMAGE" node test/s3-server.ts >/dev/null
  for _ in $(seq 1 30); do
    [ "$(status "$S3_BASE/__keys")" = 200 ] && return 0
    sleep 1
  done
  fail "S3 shim did not start"
}

if [ "$build" = true ]; then
  set --
  if [ "$NETWORK_MODE" = host ]; then set -- --network host; fi
  docker build -q --load "$@" -t "$IMAGE" container >/dev/null
else
  docker image inspect "$IMAGE" >/dev/null
fi
if [ "$NETWORK_MODE" = bridge ]; then docker network create "$NET" >/dev/null; fi
start_s3

base="http://127.0.0.1:$PORT"
mgmt="authorization: Bearer $MANAGEMENT_KEY"

wait_for() {
  for _ in $(seq 1 30); do
    eval "$1" && return 0
    sleep 1
  done
  fail "timed out waiting for: $1"
}

activity_status() {
  curl --fail --silent "$S3_BASE/__activity"
}

activity_pending() {
  activity_status | node -e 'const x=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.exit(x.delayed.pending ? 0 : 1)'
}

activity_finished() {
  activity_status | node -e 'const x=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.exit(x.delayed.completed===1 && x.active===0 ? 0 : 1)'
}

start_cpa
expect 200 "$base/healthz"
expect 200 "$base/__sub2api/lifecycle"
curl --fail --silent "$base/__sub2api/lifecycle" | node -e 'const x=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(x.activity_protocol!==1 || x.frontend_auth_protocol!==1) process.exit(1)' || fail "provider does not advertise both required lifecycle/auth protocols"
expect 401 "$base/v1/models"
expect 401 -H "authorization: Bearer unconfigured-key" "$base/v1/models"
expect 401 "$base/v8/management/config"
expect 200 -H "$mgmt" "$base/v8/management/config"
expect 200 "$base/management.html"
curl --fail --silent "$base/management.html" | node -e 'const html=require("node:fs").readFileSync(0,"utf8"); if(!html.includes("<title>sub2api Console</title>") || html.includes("<title>CLI Proxy API")) process.exit(1)' || fail "provider image does not contain the branded dashboard"
expect 204 -X POST "$S3_BASE/__delay-config-put"
expect 200 -X PUT -H "$mgmt" -H "content-type: application/json" -d "[\"$CLIENT_KEY\"]" "$base/v8/management/config/access/api-keys"
wait_for activity_pending
# Hold the actual object-store write beyond the production one-second idle setting.
sleep 2
activity_status | node -e 'const x=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(!x.delayed.pending || !x.delayed.protected || x.active<1 || x.remainingMs<=0) process.exit(1)' || fail "config persistence lost its activity lease while the S3 write was pending"
expect 204 -X POST "$S3_BASE/__release-config-put"
wait_for activity_finished
activity_status | node -e 'const x=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(!x.delayed.protected || x.delayed.timedOut || x.delayed.elapsedMs<1000 || x.begin<1 || x.end!==x.begin || x.rejected!==0) process.exit(1)' || fail "activity handoff or release did not cover the completed config write"
echo "ok background reload and persistence stay protected until the delayed bucket write completes"
wait_for '[ "$(status -H "x-api-key: $CLIENT_KEY" "$base/v1/models")" = 200 ]'
echo "ok a key saved the way the dashboard saves it works"
expect 401 "$base/v1/models"
expect 401 -H "authorization: Bearer probe-0123456789abcdef" "$base/v1/models"
expect 200 -H "x-api-key: $CLIENT_KEY" "$base/v1/models"
expect 200 -H "authorization: Bearer $CLIENT_KEY" "$base/v1/models"

if docker run --rm --network "$NET" -e OBJECTSTORE_BUCKET=x "$IMAGE" >/dev/null 2>&1; then
  fail "entrypoint started without its required settings"
fi
echo "ok entrypoint refuses missing settings"

start_cpa
expect 200 -H "x-api-key: $CLIENT_KEY" "$base/v1/models"
expect 401 -H "x-api-key: wrong-key" "$base/v1/models"
echo "ok config survived a restart from the bucket"

expect 200 -X PUT -H "$mgmt" -H "content-type: application/json" -d "[]" "$base/v8/management/config/access/api-keys"
wait_for '[ "$(status -H "x-api-key: $CLIENT_KEY" "$base/v1/models")" = 401 ]'
expect 401 "$base/v1/models"
expect 401 -H "authorization: Bearer probe-0123456789abcdef" "$base/v1/models"
echo "ok removing the last effective key rejects old, missing and arbitrary credentials"

state=$(curl -s -H "$mgmt" "$base/v0/management/anthropic-auth-url" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')
[ -n "$state" ] || fail "anthropic-auth-url returned no state"
expect 200 "$base/v0/management/oauth-callback?code=smoke-code&state=$state"
expect 404 "$base/v0/management/oauth-callback?code=smoke-code&state=0123456789abcdef0123456789abcdef"
echo "ok CPA takes a pasted callback by its state alone"

# A move from the Workers-only install: an empty bucket holding only moved logins, and the moved
# config handed over in CPA_IMPORT_CONFIG as src/import-config.ts leaves it.
MOVED_KEY=moved-key-0123456789abcdef0123456789abcdef
start_s3
expect 200 -X PUT --data-binary '{"type":"codex","email":"moved@example.com","access_token":"a","refresh_token":"r","disabled":true}' \
  "$S3_BASE/state/auths/codex-moved@example.com.json"
start_cpa -e CPA_IMPORT_CONFIG="access:
  api-keys:
    - $MOVED_KEY
routing:
  strategy: fill-first"
expect 200 -H "x-api-key: $MOVED_KEY" "$base/v1/models"
expect 401 -H "x-api-key: $CLIENT_KEY" "$base/v1/models"
curl -s -H "$mgmt" "$base/v0/management/auth-files" | grep -q 'codex-moved@example.com.json' || fail "moved login not listed"
seeded=$(curl -s "$S3_BASE/state/config/config.yaml")
printf '%s' "$seeded" | grep -q "$MOVED_KEY" || fail "moved config not seeded into the bucket"
printf '%s' "$seeded" | grep -q fill-first || fail "moved routing not seeded into the bucket"
if printf '%s' "$seeded" | grep -q "$MANAGEMENT_KEY"; then fail "plaintext management key reached the bucket"; fi
echo "ok a first start takes the moved config and logins"
