#!/bin/sh
# The W3 exit gate (plan §11.3 T3.Z), run inside the production image from the repository root:
#
#   sh scripts/editor/w3_exit_gates.sh <section>...
#
# Sections: sec (QG-SEC fuzz, E11 child env, ingest p95), audio (duck, G3, G3b, G-CLICK with
# music, P-AUD and PF-AUDIO on the server), ai (QG-AI hard gates, offline), clean (QG-CLEAN),
# plate (P-FRAME and P-PLATE per layout, the switch, PF-CELLS), markers (marker vectors and
# cold-open suggestions), logo (G5 and the P-LOGO tooling), rt (P-RT and R10), gdet (G-DET),
# ptxt (the P-TXT references for a subset; the browser half runs against them), web (the
# standalone app the image built, for browser runs elsewhere).
#
# Heavy work (FFmpeg on many frames, renders): run it on GitHub Actions through
# editor-gates.yml (suite=command), never on the owner's PC. Every output goes to $OUT
# (default /out); gate evidence to $OUT/evidence. A failing section is listed in $OUT/fail.txt
# and the script exits 1 after running the rest.
set -u
OUT=${OUT:-/out}
EV=$OUT/evidence
WORK=${WORK:-/tmp/w3z}
mkdir -p "$EV" "$WORK"
: > "$OUT/fail.txt"
STACK="GitHub Actions ubuntu-latest runner ($(nproc) vCPU; timings indicative), production image, $(ffmpeg -version | head -1 | cut -d' ' -f1-3), $(python3 --version)"
echo "$STACK" > "$OUT/stack.txt"
fail() { echo "$1" >> "$OUT/fail.txt"; echo "FAIL $1"; }
R=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
SERVER=""

# The standalone app on 127.0.0.1:$1 over $JOBS; further arguments are extra environment
# entries (NAME=value). Credentials are made per run and never printed.
start_server() {
  port=$1
  shift
  mkdir -p "$WORK/settings-$port" && chmod 700 "$WORK/settings-$port"
  (cd /app && exec env PORT="$port" HOSTNAME=127.0.0.1 JOBS_ROOT="$JOBS" POTONGIN_SETTINGS_DIR="$WORK/settings-$port" \
    APP_USERNAME=gate APP_PASSWORD="gate-$R" APP_SESSION_SECRET="s$R$R" POTONGIN_EDITOR_V3=on \
    JOBS_STORAGE_QUOTA_BYTES=32212254720 JOBS_STORAGE_MIN_FREE_BYTES=1073741824 \
    JOBS_STORAGE_ACTIVE_RESERVE_BYTES=1073741824 JOBS_STORAGE_SCAN_MAX_ENTRIES=200000 \
    JOBS_STORAGE_SCAN_MAX_DEPTH=16 JOBS_STORAGE_SCAN_DEADLINE_MS=30000 JOBS_STORAGE_RECHECK_BYTES=8388608 \
    JOBS_STORAGE_RECHECK_INTERVAL_MS=5000 "$@" node server.js) > "$OUT/server-$port.log" 2>&1 &
  SERVER=$!
  for _ in $(seq 1 90); do
    curl -fsS "http://127.0.0.1:$port/api/health" > /dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
stop_server() {
  [ -n "$SERVER" ] && kill "$SERVER" 2> /dev/null
  SERVER=""
}
export E2E_USERNAME=gate E2E_PASSWORD="gate-$R"

section_sec() {
  F=scripts/security/make_upload_fuzz.py
  uv run python $F write "$WORK/corpus" > "$OUT/sec-write.txt" 2>&1
  uv run python $F ingest "$WORK/corpus" "$EV/W3Z-QG-SEC-fuzz-ingest.json" > "$OUT/sec-ingest.txt" 2>&1 || fail sec-ingest
  uv run python $F timing-inputs "$WORK/timing" > "$OUT/sec-timing-inputs.txt" 2>&1
  uv run python $F timing "$WORK/timing" "$EV/W3Z-ingest-perf.json" --stack "$STACK" > "$OUT/sec-timing.txt" 2>&1 || fail sec-timing
  uv run python $F recorders "$WORK/rec" --log "$WORK/environ.log" --interpreter /usr/bin/python3 --python /app/.venv/bin/python
  J1=$(cat /proc/sys/kernel/random/uuid)
  J2=$(cat /proc/sys/kernel/random/uuid)
  JOBS=$WORK/sec-jobs
  mkdir -p "$JOBS/$J1/analysis" "$JOBS/$J2/analysis"
  # Planted values: the E11 audit looks for them in every child's /proc/<pid>/environ.
  key="planted-secret-k-$R"
  llm="planted-secret-l-$R"
  sealer="planted-secret-x-$R$R"
  start_server 3107 "PATH=$WORK/rec:$PATH" "OPENROUTER_API_KEY=$key" "POTONGIN_LLM_API_KEY=$llm" \
    "POTONGIN_SETTINGS_SECRET=$sealer" POTONGIN_EDITOR_UPLOADS=on || fail sec-server
  H="$STACK, node server.js (standalone), flags on, proxy.js in place, planted secret values in the server env, recorders on PATH"
  uv run python $F http "$WORK/corpus" "$EV/W3Z-QG-SEC-fuzz-http.json" --base http://127.0.0.1:3107 --job "$J1" --stack "$H" \
    > "$OUT/sec-http.txt" 2>&1 || fail sec-http
  uv run python $F matrix "$EV/W3Z-QG-SEC-http.json" --base http://127.0.0.1:3107 --job "$J2" --environ-log "$WORK/environ.log" \
    --stack "$H" > "$OUT/sec-matrix.txt" 2>&1 || fail sec-matrix
  stop_server
  tail -n 3 "$OUT/sec-ingest.txt" "$OUT/sec-timing.txt" "$OUT/sec-http.txt" "$OUT/sec-matrix.txt"
}

section_audio() {
  export AUDIO_GATES_TASK=W3Z POTONGIN_RESOURCES_DIR=/app/resources
  G="uv run python scripts/parity/audio_gates.py"
  T=$WORK/audio
  JOBS=$T/jobs
  mkdir -p "$JOBS" "$T/work" "$EV/audio"
  uv run python scripts/editor_fixture/make_job.py build "$T/fixture" --only main,fps25,fps60,vfr > "$OUT/audio-build.log" 2>&1 || fail audio-build
  $G setup --synthetic --originals "$T/fixture" --jobs-root "$JOBS" --twins > "$OUT/audio-setup.log" 2>&1 || fail audio-setup
  for g in click duck loudness; do
    $G exports --gate $g --jobs-root "$JOBS" --work "$T/work" --evidence "$EV/audio" > "$OUT/audio-exports-$g.log" 2>&1 || fail "audio-$g"
  done
  start_server 3291 || fail audio-server
  $G lane p-aud --base-url http://127.0.0.1:3291 --jobs-root "$JOBS" --work "$T/work" --evidence "$EV/audio" \
    --browser-fixtures "$OUT/paud-fixtures" > "$OUT/audio-lane-paud.log" 2>&1 || fail audio-p-aud
  $G lane pf-audio --base-url http://127.0.0.1:3291 --jobs-root "$JOBS" --work "$T/work" --evidence "$EV/audio" \
    --label w3z-ci-4vcpu > "$OUT/audio-lane-pfaudio.log" 2>&1 || echo "pf-audio is indicative (W4 speed-up)" >> "$OUT/notes.txt"
  stop_server
  grep -hE ": (pass|FAIL)" "$OUT"/audio-exports-*.log "$OUT"/audio-lane-*.log || true
}

section_ai() {
  uv run pytest tests/test_editor_ai.py -q -rA -p no:cacheprovider > "$OUT/ai-pytest.txt" 2>&1 || fail ai
  tail -n 3 "$OUT/ai-pytest.txt"
}

section_clean() {
  PYTHONPATH=src:tests uv run python -m support.edit_v2_cleanup_gate labels "$EV/W3Z-QG-CLEAN-labels.json" > "$OUT/clean-labels.txt" 2>&1 || fail clean-labels
  uv run python scripts/editor_fixture/make_job.py build "$WORK/syn" --only main --render --stub-camera --force > "$OUT/clean-build.log" 2>&1 || fail clean-build
  job=$(uv run python -c "import sys; sys.path.insert(0, 'scripts/editor_fixture'); import make_job; print(make_job.job_id('main'))")
  mkdir -p "$WORK/qgw"
  PYTHONPATH=src:tests uv run python -m support.edit_v2_cleanup_gate media "$EV/W3Z-QG-CLEAN-synthetic.json" --jobs-root "$WORK/syn/jobs" \
    --job "$job" --items 20 --work "$WORK/qgw" > "$OUT/clean-media.txt" 2>&1 || fail clean-media
  tail -n 3 "$OUT/clean-labels.txt" "$OUT/clean-media.txt"
}

section_plate() {
  JOBS=$WORK/plate-jobs
  mkdir -p "$JOBS" "$WORK/t36" "$EV/plate"
  start_server 3361 || fail plate-server
  g() { uv run python scripts/parity/plate_gates.py --base-url http://127.0.0.1:3361 --jobs-root "$JOBS" --work "$WORK/t36" \
    --evidence "$EV/plate" --label w3z-ci-4vcpu --note "$STACK" "$@"; }
  g p-frame > "$OUT/plate-p-frame.txt" 2>&1 || fail plate-p-frame
  sleep 15
  g p-plate > "$OUT/plate-p-plate.txt" 2>&1 || fail plate-p-plate
  sleep 15
  g switch > "$OUT/plate-switch.txt" 2>&1 || fail plate-switch
  stop_server
  tail -n 4 "$OUT/plate-p-frame.txt" "$OUT/plate-p-plate.txt" "$OUT/plate-switch.txt"
}

section_markers() {
  (cd web && node --test tests/editor-markers.test.mjs tests/coldopen-suggestions.test.mjs) > "$OUT/markers-node.txt" 2>&1 || fail markers-node
  uv run pytest -q -p no:cacheprovider tests/test_edit_v2_markers.py tests/test_edit_v2_coldopen.py > "$OUT/markers-pytest.txt" 2>&1 || fail markers-pytest
  uv run python scripts/editor/gen_t37_fixtures.py --check > "$OUT/markers-vectors.txt" 2>&1 || fail markers-vectors
  grep -hE "^# (pass|fail)" "$OUT/markers-node.txt"
  tail -n 2 "$OUT/markers-pytest.txt" "$OUT/markers-vectors.txt"
}

section_logo() {
  PYTHONPATH=$PWD/src:$PWD/tests uv run python scripts/parity/logo_gates.py vectors --check > "$OUT/logo-vectors.txt" 2>&1 || fail logo-vectors
  PYTHONPATH=$PWD/src:$PWD/tests uv run pytest -q -p no:cacheprovider tests/test_parity_logo_gates.py > "$OUT/logo-pytest.txt" 2>&1 || fail logo-pytest
  PYTHONPATH=$PWD/src:$PWD/tests uv run python scripts/parity/logo_gates.py g5 --out "$EV/W3Z-G5.json" > "$OUT/logo-g5.txt" 2>&1 || fail logo-g5
  (cd web && node --test tests/editor-logo.test.mjs) > "$OUT/logo-node.txt" 2>&1 || fail logo-node
  tail -n 2 "$OUT/logo-vectors.txt" "$OUT/logo-pytest.txt" "$OUT/logo-g5.txt"
  grep -hE "^# (pass|fail)" "$OUT/logo-node.txt"
}

section_rt() {
  uv run python scripts/editor_fixture/make_job.py build "$WORK/rt" --only main,fps60,old --render --stub-camera > "$OUT/rt-build.log" 2>&1 || fail rt-build
  uv run python scripts/parity/rt_check.py rerender "$WORK/rt/jobs" --out "$OUT/rt-rerender.json" --work "$WORK/rtw" > "$OUT/rt-rerender.txt" 2>&1 || fail rt-rerender
  uv run python scripts/parity/rt_check.py r10 "$WORK/rt/jobs" --out "$OUT/rt-r10.json" --work "$WORK/rtw" > "$OUT/rt-r10.txt" 2>&1 || fail rt-r10
  uv run python scripts/parity/rt_check.py evidence --rerender "$OUT/rt-rerender.json" --r10 "$OUT/rt-r10.json" --label W3Z \
    --out "$EV/W3Z-P-RT.json" --note "stack=github-4vcpu-image" > "$OUT/rt-evidence.txt" 2>&1 || fail rt-evidence
  tail -n 3 "$OUT/rt-rerender.txt" "$OUT/rt-r10.txt" "$OUT/rt-evidence.txt"
}

section_gdet() {
  uv run python scripts/parity/frame_identity.py g-det --evidence "$EV" --task W3Z > "$OUT/gdet.txt" 2>&1 || fail gdet
  tail -n 4 "$OUT/gdet.txt"
}

section_ptxt() {
  uv run python scripts/parity/reference_text.py --out "$OUT/ptxt" --fonts resources/fonts --no-timing \
    --only classic-40,karaoke-40,bold-40,box-40,hook,fallback > "$OUT/ptxt.txt" 2>&1 || fail ptxt
  tail -n 3 "$OUT/ptxt.txt"
}

section_web() {
  tar -C /app -czf "$OUT/web-standalone.tgz" server.js package.json .next node_modules public > "$OUT/web.txt" 2>&1 || fail web
  ls -l "$OUT/web-standalone.tgz"
}

for section in "$@"; do
  echo "== $section"
  started=$(date +%s)
  "section_$section"
  echo "$section $(( $(date +%s) - started )) s" >> "$OUT/times.txt"
done
cat "$OUT/times.txt"
if [ -s "$OUT/fail.txt" ]; then
  echo "failed: $(tr '\n' ' ' < "$OUT/fail.txt")"
  exit 1
fi
