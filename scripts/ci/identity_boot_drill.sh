#!/usr/bin/env bash
# The boot and rollback drill of Fase 4 on real containers (rombak 01 §5.2, 02 §14.3, 08 §8.6), with
# throwaway volumes and throwaway credentials; run by editor-gates.yml suite=drill, never against
# anything real. It follows the deploy's own order: old image -> backup + settings copy -> new image
# -> old image with the new compose -> old image with the old compose -> new image again -> restore.
#
#   identity_boot_drill.sh <new-image-tag> <old-image-tag> <old-compose-file>
set -Eeuo pipefail

NEW_TAG=${1:?new image tag}
OLD_TAG=${2:?old image tag}
OLD_COMPOSE=${3:?old compose file}
PROJECT=potongin-drill
BASE=http://127.0.0.1:8100

OVERRIDE=$(mktemp --suffix=.yaml)
cat > "$OVERRIDE" <<'YAML'
# The runner has 4 CPUs; the limits of production do not fit.
services:
  app:
    cpus: "2"
    mem_limit: 4g
  primary-worker:
    cpus: "1"
    mem_limit: 2g
  render-worker:
    cpus: "1"
    mem_limit: 2g
YAML

set -a
# shellcheck disable=SC1091
. ./.env.example
set +a
APP_USERNAME=drill-owner
APP_PASSWORD=$(openssl rand -hex 24)
APP_SESSION_SECRET=$(openssl rand -hex 32)
POTONGIN_SETTINGS_SECRET=$APP_SESSION_SECRET
E2E_SMOKE_USERNAME=drill-smoke
E2E_SMOKE_PASSWORD=$(openssl rand -hex 24)
AUTH_TRUSTED_CLIENT_IP_HEADER=nginx
export APP_USERNAME APP_PASSWORD APP_SESSION_SECRET POTONGIN_SETTINGS_SECRET E2E_SMOKE_USERNAME E2E_SMOKE_PASSWORD AUTH_TRUSTED_CLIENT_IP_HEADER
echo "::add-mask::$APP_PASSWORD"
echo "::add-mask::$APP_SESSION_SECRET"
echo "::add-mask::$E2E_SMOKE_PASSWORD"

new_compose() { docker compose -p "$PROJECT" -f compose.yaml -f "$OVERRIDE" "$@"; }
old_compose() { docker compose -p "$PROJECT" -f "$OLD_COMPOSE" -f "$OVERRIDE" "$@"; }

step() { printf '\n=== %s\n' "$*"; }
fail() { echo "DRILL FAILED: $*" >&2; exit 1; }
check() { local what=$1; shift; "$@" || fail "$what"; echo "ok: $what"; }

cleanup() {
  local code=$?
  if [ "$code" != 0 ]; then
    new_compose logs --no-color --tail=60 || true
  fi
  new_compose down -v --remove-orphans > /dev/null 2>&1 || true
  rm -f "$OVERRIDE"
  exit "$code"
}
trap cleanup EXIT

wait_health() {
  local attempt
  for attempt in $(seq 1 90); do
    curl -fsS "$BASE/api/health" > /dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

wait_primary() {
  local attempt status
  for attempt in $(seq 1 60); do
    status=$(docker inspect ai-video-clipper-primary-worker --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && return 1
    sleep 2
  done
  return 1
}

# The headers of a login form post: cookies are read from them (curl keeps no Secure cookie on http).
login_headers() {
  curl -sS -o /dev/null -D - -X POST "$BASE/api/auth/login" \
    -H "Origin: $BASE" -H "Host: 127.0.0.1:8100" \
    --data-urlencode "username=$1" --data-urlencode "password=$2" --data-urlencode "next=/projects"
}

cookie_value() { # <headers> <cookie name>
  printf '%s\n' "$1" | tr -d '\r' | sed -n "s/^[Ss]et-[Cc]ookie: $2=\([^;]*\);.*/\1/p" | tail -n 1
}

status_of() { # <path> <cookie>
  curl -sS -o /dev/null -w '%{http_code}' "$BASE$1" -H "Cookie: $2"
}

header_of() { # <path> <cookie>
  curl -sS -o /dev/null -D - "$BASE$1" -H "Cookie: $2"
}

in_app() { docker exec ai-video-clipper "$@"; }

JOB_ID=8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55
S2=__Host-potongin_session
V1=potongin_session
PROBE='{"drill":"settings-probe"}'

step "1. The old image with the old compose, as production runs today"
IMAGE_TAG=$OLD_TAG old_compose up -d --no-build --remove-orphans
check "old image healthy" wait_health
in_app sh -ec "mkdir -p /data/settings /data/jobs/$JOB_ID && printf '%s' '$PROBE' > /data/settings/drill-probe.json \
  && chmod 600 /data/settings/drill-probe.json \
  && printf '%s' '{\"id\":\"$JOB_ID\",\"status\":\"completed\",\"source\":{\"type\":\"upload\"},\"createdAt\":\"2026-10-01T00:00:00.000Z\"}' > /data/jobs/$JOB_ID/job.json"
headers=$(login_headers "$APP_USERNAME" "$APP_PASSWORD")
OLD_V1=$(cookie_value "$headers" "$V1")
[ -n "$OLD_V1" ] || fail "the old image gave no v1 cookie"
check "v1 cookie works on the old image" test "$(status_of /api/storage/status "$V1=$OLD_V1")" = 200
PROBE_SHA=$(in_app sha256sum /data/settings/drill-probe.json | cut -d' ' -f1)

step "2. The deploy's steps with the new image, the old one still serving"
out=$(IMAGE_TAG=$NEW_TAG new_compose run --rm --no-deps --entrypoint node app scripts/db-backup.mjs --reason deploy)
printf '%s\n' "$out"
check "the first backup says DB_BACKUP=none" grep -q '^DB_BACKUP=none$' <<<"$out"
out=$(IMAGE_TAG=$NEW_TAG new_compose run --rm --no-deps --entrypoint node app scripts/start-app.mjs --prepare-settings)
printf '%s\n' "$out"
check "the settings were copied" grep -Eq '^SETTINGS_MOVE=copied:[1-9]' <<<"$out"
if POTONGIN_SETTINGS_SECRET=short IMAGE_TAG=$NEW_TAG new_compose run --rm --no-deps --entrypoint node app scripts/start-app.mjs --prepare-settings > /dev/null 2>&1; then
  fail "a short secret must stop the deploy"
fi
echo "ok: a short secret stops the deploy before any container changes"
check "the old image still serves after those steps" test "$(status_of /api/storage/status "$V1=$OLD_V1")" = 200

step "3. The new image with the new compose"
IMAGE_TAG=$NEW_TAG new_compose up -d --no-build --remove-orphans
check "new image healthy" wait_health
check "primary worker healthy" wait_primary
check "render worker runs" test "$(docker inspect ai-video-clipper-render-worker --format '{{.State.Running}}')" = true

step "4. Isolation: the render worker cannot open /control"
mounts=$(docker inspect ai-video-clipper-render-worker --format '{{range .Mounts}}{{.Destination}} {{end}}')
case " $mounts " in *" /control "*) fail "render worker mounts /control" ;; esac
if docker exec ai-video-clipper-render-worker sh -c 'ls /control/potongin.sqlite 2>/dev/null || cat /control/settings/drill-probe.json 2>/dev/null'; then
  fail "render worker reads /control"
fi
echo "ok: render worker has no /control"
if docker exec ai-video-clipper-render-worker sh -c 'env' | grep -Eq '^(POTONGIN_DB_PATH|POTONGIN_SETTINGS_SECRET|APP_SESSION_SECRET)='; then
  fail "render worker holds a control variable"
fi
echo "ok: render worker holds no control variable"
for container in ai-video-clipper ai-video-clipper-primary-worker; do
  docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/control"}}{{.Name}}{{end}}{{end}}' | grep -q "${PROJECT}_potongin_control" || fail "$container has no control volume"
done

step "5. The settings: copied with the same sha, marker there, the old copy frozen"
check "copy has the same sha" test "$(in_app sha256sum /control/settings/drill-probe.json | cut -d' ' -f1)" = "$PROBE_SHA"
check "the frozen copy stays" test "$(in_app sha256sum /data/settings/drill-probe.json | cut -d' ' -f1)" = "$PROBE_SHA"
check "marker" in_app test -f /control/settings/.migrated-from-data
check "DB is 0600" test "$(in_app stat -c '%a' /control/potongin.sqlite)" = 600
check "control is 0700" test "$(in_app stat -c '%a' /control)" = 700

step "6. The owner's v1 cookie upgrades once; logout ends it on the server"
headers=$(header_of /dashboard "$V1=$OLD_V1")
UPGRADED=$(cookie_value "$headers" "$S2")
[ -n "$UPGRADED" ] || fail "the v1 cookie was not upgraded"
printf '%s\n' "$headers" | tr -d '\r' | grep -iq "^set-cookie: $V1=;" || fail "the v1 cookie was not cleared"
again=$(cookie_value "$(header_of /dashboard "$V1=$OLD_V1")" "$S2")
check "a parallel request gets the same s2 cookie" test "$UPGRADED" = "$again"
check "the s2 cookie works" test "$(status_of /api/storage/status "$S2=$UPGRADED")" = 200
check "old jobs are visible" sh -c "curl -sS '$BASE/api/jobs' -H 'Cookie: $S2=$UPGRADED' | grep -q '$JOB_ID'"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/logout" -H "Origin: $BASE" -H "Cookie: $S2=$UPGRADED")
check "logout answers 303" test "$code" = 303
check "the s2 cookie is revoked" test "$(status_of /api/storage/status "$S2=$UPGRADED")" = 401
check "the old v1 token is revoked too" test "$(status_of /api/storage/status "$V1=$OLD_V1")" = 401

step "7. Login: APP_*, the smoke user, a wrong password"
headers=$(login_headers "$APP_USERNAME" "$APP_PASSWORD")
OWNER=$(cookie_value "$headers" "$S2")
[ -n "$OWNER" ] || fail "APP_* gave no s2 cookie"
check "owner session works" test "$(status_of /api/storage/status "$S2=$OWNER")" = 200
headers=$(login_headers "$E2E_SMOKE_USERNAME" "$E2E_SMOKE_PASSWORD")
SMOKE=$(cookie_value "$headers" "$S2")
[ -n "$SMOKE" ] || fail "the smoke user gave no s2 cookie"
check "smoke session works" test "$(status_of /api/storage/status "$S2=$SMOKE")" = 200
headers=$(login_headers "$APP_USERNAME" nope)
printf '%s\n' "$headers" | tr -d '\r' | grep -iq '^location: /login?error=1' || fail "a wrong password must go back to the form"
in_app node scripts/admin-reset.mjs --list | grep -q "^drill-smoke	member	active	smoke$" || fail "--list"

step "8. Backup of the live DB"
out=$(docker exec ai-video-clipper node scripts/db-backup.mjs --reason manual)
printf '%s\n' "$out"
BACKUP=$(sed -n 's/^DB_BACKUP=//p' <<<"$out")
[ -n "$BACKUP" ] && [ "$BACKUP" != none ] || fail "no backup path"
check "backup is 0600" test "$(in_app stat -c '%a' "$BACKUP")" = 600

step "9. Rollback: the old image with the new compose (what production.sh's rollback runs)"
IMAGE_TAG=$OLD_TAG new_compose up -d --no-build --remove-orphans
check "old image healthy on the new compose" wait_health
check "it reads /control/settings" test "$(in_app sh -c 'printf %s "$POTONGIN_SETTINGS_DIR"')" = /control/settings
check "the s2 cookie means nothing to it" test "$(status_of /api/storage/status "$S2=$OWNER")" = 401
headers=$(login_headers "$APP_USERNAME" "$APP_PASSWORD")
ROLLBACK_V1=$(cookie_value "$headers" "$V1")
[ -n "$ROLLBACK_V1" ] || fail "APP_* must work on the old image"
check "old jobs are visible on the old image" sh -c "curl -sS '$BASE/api/jobs' -H 'Cookie: $V1=$ROLLBACK_V1' | grep -q '$JOB_ID'"

step "10. Rollback: the old image with the old compose (the frozen copy)"
IMAGE_TAG=$OLD_TAG old_compose up -d --no-build --remove-orphans
check "old image healthy on the old compose" wait_health
check "it reads /data/settings" test "$(in_app sh -c 'printf %s "$POTONGIN_SETTINGS_DIR"')" = /data/settings
check "the frozen copy is intact" test "$(in_app sha256sum /data/settings/drill-probe.json | cut -d' ' -f1)" = "$PROBE_SHA"
headers=$(login_headers "$APP_USERNAME" "$APP_PASSWORD")
[ -n "$(cookie_value "$headers" "$V1")" ] || fail "APP_* must work on the old compose"

step "11. Forward again: the new image on the same volumes"
IMAGE_TAG=$NEW_TAG new_compose up -d --no-build --remove-orphans
check "new image healthy again" wait_health
check "primary worker healthy again" wait_primary
check "the session of step 7 is still live" test "$(status_of /api/storage/status "$S2=$OWNER")" = 200
users=$(in_app node scripts/admin-reset.mjs --list | wc -l)
check "no user was added by the second boot" test "$users" = 2

step "12. Restore, offline"
new_compose stop app primary-worker
sleep 31
out=$(IMAGE_TAG=$NEW_TAG new_compose run --rm --no-deps --entrypoint node app scripts/db-restore.mjs --from "$BACKUP" --yes)
printf '%s\n' "$out"
check "RESTORED printed" grep -q '^RESTORED=/control/potongin.sqlite SCHEMA=' <<<"$out"
IMAGE_TAG=$NEW_TAG new_compose up -d --no-build
check "healthy after the restore" wait_health
headers=$(login_headers "$APP_USERNAME" "$APP_PASSWORD")
[ -n "$(cookie_value "$headers" "$S2")" ] || fail "login after the restore"

printf '\nDRILL OK\n'
