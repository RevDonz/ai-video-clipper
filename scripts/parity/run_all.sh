#!/bin/sh
# The editor's parity and render gates (plan §10) inside the production image, by suite:
#
#   sh scripts/parity/run_all.sh smoke|toolchain|full [section...]
#
# Run it from a writable copy of the repository with its environment synced
# (uv sync --frozen --python /usr/bin/python3 --extra vision --extra web); .github/workflows/
# ci-cd.yml does that, runs the browser half against $OUT/ptxt afterwards (the JASSUB side of
# P-TIME, P-TXT and, outside the smoke, P-COLOR) and decides with `ci_gates.py summary`.
#
#   smoke      every pull request: P-TIME (FFmpeg side), the P-TXT references of a subset,
#              300-frame P-FRAME, G-DET, P-AUD (server) and R10
#   toolchain  a new toolchain or JASSUB pin: P-TIME, the whole P-TXT matrix with its exports,
#              P-ENC, P-RT and R10 (the evidence toolchain_guard.py stamps)
#   full       nightly: toolchain, then P-FRAME (2,000+ frames), P-PLATE, G1/G2, G-DET and
#              PF-RENDER, the audio gates, the glyph probe and ASS goldens, and the gates
#              through the app (P-FRAME and P-PLATE per layout, the layout switch, P-AUD and
#              PF-AUDIO through the preview lane)
#
# Named sections run instead of the suite's list. Outputs: evidence in $OUT/evidence
# (CI-<gate>.json, numbers only), the text fixtures in $OUT/ptxt, logs in $OUT/logs, the app
# gates in $OUT/app. A failing section is listed in $OUT/fail.txt; the script runs the rest and
# exits 1.
set -u
suite=${1:?usage: run_all.sh smoke|toolchain|full [section...]}
shift
case $suite in
  smoke) sections="toolchain ptime ptxt pframe gdet paud r10" ;;
  toolchain) sections="toolchain ptime ptxt_full penc rt" ;;
  full) sections="toolchain ptime ptxt_full penc rt frame audio glyph goldens app" ;;
  *) echo "unknown suite: $suite" >&2; exit 2 ;;
esac
[ $# -gt 0 ] && sections=$*

OUT=${OUT:-/out}
WORK=${WORK:-/tmp/parity-work}
EV=$OUT/evidence
LOGS=$OUT/logs
mkdir -p "$EV" "$LOGS" "$WORK"
: > "$OUT/fail.txt"
: > "$OUT/times.txt"
export PYTHONPATH="$PWD/src:$PWD/tests"
PY="uv run python"
fail() { echo "$1" >> "$OUT/fail.txt"; echo "FAIL $1"; }

# The P-TXT subset of a pull request: the four packs at 40 characters, the hook and the fallback
# glyph, plus the five P-TIME timing fixtures (24, 25, 30, 24000/1001, 30000/1001).
SMOKE_TEXT=classic-40,karaoke-40,bold-40,box-40,hook,fallback
TIMING=timing-24-1,timing-25-1,timing-30-1,timing-24000-1001,timing-30000-1001

section_toolchain() {
  # The guard's premise: the image's toolchain.json is what the Dockerfile pins derive.
  $PY scripts/parity/toolchain_guard.py image --toolchain /app/resources/toolchain.json \
    > "$LOGS/toolchain.txt" 2>&1 || fail toolchain
  $PY scripts/parity/toolchain_guard.py state --out "$OUT/state.json" >> "$LOGS/toolchain.txt" 2>&1 \
    || fail toolchain-state
}

section_ptime() {
  $PY scripts/parity/ci_gates.py p-time --evidence "$EV" --jobs "$(nproc)" > "$LOGS/ptime.txt" 2>&1 \
    || fail ptime
}

section_ptxt() {
  $PY scripts/parity/reference_text.py --out "$OUT/ptxt" --fonts resources/fonts --formats gbrp \
    --no-export --only "$SMOKE_TEXT,$TIMING" > "$LOGS/ptxt.txt" 2>&1 || fail ptxt
}

section_ptxt_full() {
  # Every clip of the matrix, the pack variants and the P-COLOR sheet, with the delivered MP4 and
  # the lossless composite of each (P-ENC, P-COLOR).
  $PY scripts/parity/reference_text.py --out "$OUT/ptxt" --fonts resources/fonts --formats gbrp \
    > "$LOGS/ptxt.txt" 2>&1 || fail ptxt
}

section_penc() {
  $PY scripts/parity/ci_gates.py p-enc --fixtures "$OUT/ptxt" --evidence "$EV" \
    --baseline docs/editor/evidence/W1/T1.Z-P-ENC.json > "$LOGS/penc.txt" 2>&1 || fail penc
}

section_pframe() {
  $PY scripts/parity/ci_gates.py p-frame-smoke --evidence "$EV" > "$LOGS/pframe.txt" 2>&1 \
    || fail pframe
}

section_gdet() {
  $PY scripts/parity/frame_identity.py g-det --evidence "$EV" --task CI > "$LOGS/gdet.txt" 2>&1 \
    || fail gdet
}

section_paud() {
  $PY scripts/parity/ci_gates.py p-aud --evidence "$EV" > "$LOGS/paud.txt" 2>&1 || fail paud
}

section_r10() {
  $PY scripts/editor_fixture/make_job.py build "$WORK/r10" --only main --render --stub-camera \
    > "$LOGS/r10-build.txt" 2>&1 || fail r10-build
  $PY scripts/parity/rt_check.py r10 "$WORK/r10/jobs" --out "$EV/CI-R10.json" --work "$WORK/r10w" \
    > "$LOGS/r10.txt" 2>&1 || fail r10
}

section_rt() {
  # A 29.97 job, a 60 fps face-track job and a job rendered before the engine switch.
  $PY scripts/editor_fixture/make_job.py build "$WORK/rt" --only main,fps60,old --render --stub-camera \
    > "$LOGS/rt-build.txt" 2>&1 || fail rt-build
  $PY scripts/parity/rt_check.py rerender "$WORK/rt/jobs" --out "$WORK/rt-rerender.json" \
    --work "$WORK/rtw" > "$LOGS/rt-rerender.txt" 2>&1 || fail rt-rerender
  $PY scripts/parity/rt_check.py r10 "$WORK/rt/jobs" --out "$EV/CI-R10.json" --work "$WORK/rtw" \
    > "$LOGS/rt-r10.txt" 2>&1 || fail rt-r10
  $PY scripts/parity/rt_check.py evidence --rerender "$WORK/rt-rerender.json" --r10 "$EV/CI-R10.json" \
    --label CI --out "$EV/CI-P-RT.json" --note "stack=ci-production-image-$(nproc)cpu" \
    > "$LOGS/rt-evidence.txt" 2>&1 || fail rt-evidence
}

section_frame() {
  $PY scripts/parity/frame_identity.py all --evidence "$EV" --task CI > "$LOGS/frame.txt" 2>&1 \
    || fail frame
}

section_audio() {
  $PY -m support.edit_v2_audio_harness gates "$EV" --backend compiler --task CI \
    > "$LOGS/audio.txt" 2>&1 || fail audio
}

section_glyph() {
  $PY -m support.edit_v2_text glyph-probe "$EV/CI-glyph-probe.json" > "$LOGS/glyph.txt" 2>&1 \
    || fail glyph
}

section_goldens() {
  $PY -m support.edit_v2_text goldens --check > "$LOGS/goldens.txt" 2>&1 || fail goldens
}

section_app() {
  # Through the standalone app of this image, with the W3 exit gate's runner.
  OUT="$OUT/app" WORK="$WORK/app" sh scripts/editor/w3_exit_gates.sh plate audio \
    > "$LOGS/app.txt" 2>&1 || fail "app ($(tr '\n' ' ' < "$OUT/app/fail.txt" 2> /dev/null))"
}

{
  echo "suite=$suite sections=$sections"
  echo "stack=$(nproc) CPU, $(ffmpeg -version | head -1 | cut -d' ' -f1-3), $(python3 --version)"
} > "$OUT/run.txt"
for section in $sections; do
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
