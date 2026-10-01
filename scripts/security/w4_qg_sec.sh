#!/bin/sh
# QG-SEC, complete (plan §10.2, §11.4 T4.2), run inside the production image from the repository
# root:
#
#   sh scripts/security/w4_qg_sec.sh
#
# 1. the upload fuzz in process (the Node transport rules and edit_v2.assets);
# 2. a synthetic rendered job (scripts/editor_fixture/make_job.py) and an empty job for the fuzz;
# 3. the standalone app with every editor flag on, recorders first on its PATH and planted secret
#    values in its environment (never real ones);
# 4. the upload fuzz over HTTP, then every editor route over HTTP with the E11 audit of every
#    child the server started (scripts/security/route_matrix.py);
# 5. the standalone app as a tarball, for web/e2e/editor-security.spec.mjs in a browser elsewhere.
#
# Heavy: run it on GitHub Actions (editor-gates.yml, suite=command). Outputs go to $OUT (default
# /out), evidence to $OUT/evidence/W4; a failing step is listed in $OUT/fail.txt and the script
# exits 1 after running the rest.
set -u
OUT=${OUT:-/out}
EV=$OUT/evidence/W4
WORK=${WORK:-/tmp/w4sec}
PORT=3141
mkdir -p "$EV" "$WORK"
: > "$OUT/fail.txt"
fail() { echo "$1" >> "$OUT/fail.txt"; echo "FAIL $1"; }
STACK="GitHub Actions ubuntu-latest runner ($(nproc) vCPU; timings indicative), production image, $(ffmpeg -version | head -1 | cut -d' ' -f1-3), $(python3 --version)"
R=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
F=scripts/security/make_upload_fuzz.py
M=scripts/security/route_matrix.py

uv run python $F write "$WORK/corpus" > "$OUT/fuzz-write.txt" 2>&1 || fail fuzz-write
uv run python $F ingest "$WORK/corpus" "$EV/T4.2-QG-SEC-fuzz-ingest.json" > "$OUT/fuzz-ingest.txt" 2>&1 || fail fuzz-ingest

uv run python scripts/editor_fixture/make_job.py build "$WORK/fx" --only main --render --stub-camera \
  > "$OUT/fixture.txt" 2>&1 || fail fixture
JOBS=$WORK/fx/jobs
MAIN=$(uv run python -c "import sys; sys.path.insert(0, 'scripts/editor_fixture'); import make_job; print(make_job.job_id('main'))")
FUZZ=$(cat /proc/sys/kernel/random/uuid)
mkdir -p "$JOBS/$FUZZ/analysis"
echo "canary-$R" > "$WORK/secret-canary.txt"

uv run python $M recorders "$WORK/rec" --log "$WORK/environ.log" --python /app/.venv/bin/python || fail recorders
mkdir -p "$WORK/settings" && chmod 700 "$WORK/settings"
export APP_USERNAME=gate APP_PASSWORD="planted-p-$R"
(cd /app && exec env PORT=$PORT HOSTNAME=127.0.0.1 PATH="$WORK/rec:$PATH" JOBS_ROOT="$JOBS" \
  POTONGIN_SETTINGS_DIR="$WORK/settings" APP_SESSION_SECRET="planted-s-$R$R" POTONGIN_SETTINGS_SECRET="planted-x-$R" \
  POTONGIN_EDITOR_V3=on POTONGIN_EDITOR_UPLOADS=on POTONGIN_EDITOR_LLM=on \
  POTONGIN_LLM_PROVIDER=custom POTONGIN_LLM_CUSTOM_NAME=gate POTONGIN_LLM_CUSTOM_BASE_URL=http://127.0.0.1:9/v1 \
  POTONGIN_LLM_CUSTOM_MODEL=gate-model POTONGIN_LLM_CUSTOM_API_KEY="planted-l-$R" \
  JOBS_STORAGE_QUOTA_BYTES=32212254720 JOBS_STORAGE_MIN_FREE_BYTES=1073741824 \
  JOBS_STORAGE_ACTIVE_RESERVE_BYTES=1073741824 JOBS_STORAGE_SCAN_MAX_ENTRIES=200000 \
  JOBS_STORAGE_SCAN_MAX_DEPTH=16 JOBS_STORAGE_SCAN_DEADLINE_MS=30000 JOBS_STORAGE_RECHECK_BYTES=8388608 \
  JOBS_STORAGE_RECHECK_INTERVAL_MS=5000 node server.js) > "$OUT/server.log" 2>&1 &
SERVER=$!
up=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || fail server
H="$STACK, node server.js (standalone), every editor flag on, proxy.js in place, planted secret values in the server env, recorders on PATH"

uv run python $F http "$WORK/corpus" "$EV/T4.2-QG-SEC-fuzz-http.json" --base "http://127.0.0.1:$PORT" --job "$FUZZ" \
  --stack "$H" > "$OUT/fuzz-http.txt" 2>&1 || fail fuzz-http
QG_PLANTED="{\"dashboard\": [\"planted-p-$R\", \"planted-s-$R$R\", \"planted-x-$R\"], \"llm\": [\"planted-l-$R\"]}" \
  uv run python $M matrix "$EV/T4.2-QG-SEC-routes.json" --base "http://127.0.0.1:$PORT" --job "$MAIN" --jobs-root "$JOBS" \
  --environ-log "$WORK/environ.log" --canary "$WORK/secret-canary.txt" --stack "$H" > "$OUT/routes.txt" 2>&1 || fail routes
kill "$SERVER" 2> /dev/null

tar -C /app -czf "$OUT/web-standalone.tgz" server.js package.json .next node_modules public > "$OUT/web.txt" 2>&1 || fail web
tail -n 3 "$OUT/fuzz-ingest.txt" "$OUT/fuzz-http.txt"
head -c 4000 "$OUT/routes.txt"
if [ -s "$OUT/fail.txt" ]; then
  echo "failed: $(tr '\n' ' ' < "$OUT/fail.txt")"
  exit 1
fi
