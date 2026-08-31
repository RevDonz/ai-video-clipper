#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_DIR=${RELEASE_DIR:-/home/probersama/doni/ai-video-clipper-git}
COMPOSE_PROJECT=${COMPOSE_PROJECT:-ai-video-clipper}
APP_CONTAINER=${APP_CONTAINER:-ai-video-clipper}
PRIMARY_CONTAINER=${PRIMARY_CONTAINER:-ai-video-clipper-primary-worker}
RENDER_CONTAINER=${RENDER_CONTAINER:-ai-video-clipper-render-worker}
PRODUCTION_URL=${PRODUCTION_URL:-https://potongin.revdonz.dev}
PLAYWRIGHT_IMAGE=${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.1-noble}
DEPLOY_SHA=${DEPLOY_SHA:?DEPLOY_SHA is required}

case "$DEPLOY_SHA" in
  *[!0-9a-f]*|'') echo "DEPLOY_SHA must be lowercase hexadecimal" >&2; exit 2 ;;
esac
if [ "${#DEPLOY_SHA}" -ne 40 ]; then
  echo "DEPLOY_SHA must contain exactly 40 characters" >&2
  exit 2
fi

cd "$RELEASE_DIR"
[ "$(git rev-parse HEAD)" = "$DEPLOY_SHA" ] || { echo "Checkout does not match DEPLOY_SHA" >&2; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Tracked release checkout is dirty" >&2; exit 2; }
[ -f .env ] || { echo "Release .env is missing" >&2; exit 2; }
docker compose -p "$COMPOSE_PROJECT" config --quiet

active_jobs() {
  docker exec -i "$APP_CONTAINER" python - <<'PY'
import json
from pathlib import Path

root = Path("/data/jobs")
active = []
errors = []
for job_dir in sorted(root.iterdir() if root.is_dir() else []):
    if not job_dir.is_dir():
        continue
    job_file = job_dir / "job.json"
    if job_file.exists():
        try:
            payload = json.loads(job_file.read_text())
            status = payload.get("status")
            # "deleting" is not live work: the job's lease has already been
            # revoked, so no worker is writing to it, and the purge is
            # crash-safe and resumes from its tombstone after a restart.
            if status not in {"completed", "failed", "deleting"}:
                active.append({"kind": "primary", "id": payload.get("id", job_dir.name), "state": status})
        except Exception as error:
            errors.append({"path": str(job_file), "error": type(error).__name__})
    queue = job_dir / "analysis" / "render-requests"
    if queue.is_dir():
        for request_file in sorted(queue.glob("*.json")):
            try:
                payload = json.loads(request_file.read_text())
                state = payload.get("state")
                if state not in {"completed", "failed"}:
                    active.append({"kind": "render", "id": payload.get("render_id", request_file.stem), "state": state})
            except Exception as error:
                errors.append({"path": str(request_file), "error": type(error).__name__})
if errors:
    print(json.dumps({"errors": errors}, separators=(",", ":")))
else:
    print(json.dumps(active, separators=(",", ":")))
PY
}

require_quiescent() {
  local snapshot
  snapshot=$(active_jobs)
  printf 'DURABLE_ACTIVE_JOBS=%s\n' "$snapshot"
  [ "$snapshot" = "[]" ] || { echo "Deployment blocked: durable work is active or unreadable" >&2; return 1; }
}

wait_http_health() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:8100/api/health >/dev/null; then return 0; fi
    sleep 2
  done
  echo "Application health check timed out" >&2
  return 1
}

wait_primary_health() {
  local attempt status
  for attempt in $(seq 1 45); do
    status=$(docker inspect "$PRIMARY_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')
    if [ "$status" = healthy ]; then return 0; fi
    if [ "$status" = unhealthy ]; then echo "Primary worker became unhealthy" >&2; return 1; fi
    sleep 2
  done
  echo "Primary worker health check timed out" >&2
  return 1
}

verify_runtime_identity() {
  local expected_volume actual_volume container restart_count
  expected_volume="${COMPOSE_PROJECT}_clipper_data"
  actual_volume=$(docker inspect "$APP_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
  [ "$actual_volume" = "$expected_volume" ] || {
    echo "Unexpected data volume: $actual_volume (expected $expected_volume)" >&2
    return 1
  }
  for container in "$APP_CONTAINER" "$PRIMARY_CONTAINER" "$RENDER_CONTAINER"; do
    restart_count=$(docker inspect "$container" --format '{{.RestartCount}}')
    [ "$restart_count" = 0 ] || { echo "$container restart count is $restart_count" >&2; return 1; }
  done
  printf 'DATA_VOLUME=%s\nRESTART_COUNTS=0,0,0\n' "$actual_volume"
}

run_read_only_e2e() {
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  docker run --rm --ipc=host \
    -e CI=1 \
    -e E2E_BASE_URL="$PRODUCTION_URL" \
    -e E2E_USERNAME="$APP_USERNAME" \
    -e E2E_PASSWORD="$APP_PASSWORD" \
    -v "$RELEASE_DIR/web:/src:ro" \
    -v "$RELEASE_DIR/.gitignore:/workroot/.gitignore:ro" \
    "$PLAYWRIGHT_IMAGE" bash -lc '
      cp -a /src /workroot/web
      cd /workroot/web
      npm ci --ignore-scripts >/dev/null
      node --test tests/e2e-harness.test.mjs
      npx playwright test e2e/read-only.spec.mjs e2e/smoke.spec.mjs --workers=1 --reporter=line
    '
}

require_quiescent
previous_image=$(docker inspect "$APP_CONTAINER" --format '{{.Image}}')
rollback_tag="rollback-${DEPLOY_SHA}"
docker tag "$previous_image" "ai-video-clipper:${rollback_tag}"

IMAGE_TAG="$DEPLOY_SHA" docker compose -p "$COMPOSE_PROJECT" build app
require_quiescent

deployed=1
rollback() {
  local exit_code=$?
  trap - ERR
  if [ "$deployed" = 1 ]; then
    echo "Deployment verification failed; rolling back to previous image" >&2
    IMAGE_TAG="$rollback_tag" docker compose -p "$COMPOSE_PROJECT" up -d --no-build --remove-orphans || true
    wait_http_health || true
    wait_primary_health || true
  fi
  exit "$exit_code"
}
trap rollback ERR

IMAGE_TAG="$DEPLOY_SHA" docker compose -p "$COMPOSE_PROJECT" up -d --no-build --remove-orphans
wait_http_health
wait_primary_health
verify_runtime_identity
run_read_only_e2e
require_quiescent

trap - ERR
deployed=0
printf 'DEPLOYED_SHA=%s\nPRODUCTION_URL=%s\n' "$DEPLOY_SHA" "$PRODUCTION_URL"
