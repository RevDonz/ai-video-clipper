#!/usr/bin/env python3
"""The cold-open whoosh, ``resources/sfx/whoosh/v1.wav`` (spec 2026-10-02 §3, Appendix A).

The sound is synthesised from a seeded PRNG: white noise through a Chamberlin state-variable
band-pass whose centre sweeps 500 Hz → 3,200 Hz at the hit (sample 11,520) and back to 900 Hz,
under a quadratic swell and decay, panned left → right. Every step is Python ``int`` or
``fractions.Fraction`` arithmetic (no float, no ``math``), so the bytes do not depend on the
platform's libm. Nothing third-party goes in: the file is CC0 (see ``v1.meta.json``).

Usage (stdlib only)::

    python scripts/sfx/make_whoosh.py --check   # exit 1 unless the committed v1 is these bytes
    python scripts/sfx/make_whoosh.py --write   # write v1.wav and v1.meta.json (needs ffmpeg)

``--write`` measures the file with FFmpeg's ``ebur128=peak=true`` for the meta's ``loudness``;
run it in the production image so the meta names the pinned FFmpeg. ``v1.wav`` is immutable:
a different sound or level ships as ``v2.wav`` with its own pin.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import struct
import subprocess
import sys
import wave
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SFX_DIR = ROOT / "resources" / "sfx" / "whoosh"
WAV = SFX_DIR / "v1.wav"
META = SFX_DIR / "v1.meta.json"

RATE, SAMPLES, HIT, PEAK, SEED = 48_000, 20_160, 11_520, 4_370, 0x9E3779B9
RAMP = 96  # 2 ms linear ramp at both ends
PI, Q16 = Fraction(355, 113), 1 << 16


def xorshift32(state: int) -> int:
    state ^= (state << 13) & 0xFFFFFFFF
    state ^= state >> 17
    state ^= (state << 5) & 0xFFFFFFFF
    return state & 0xFFFFFFFF


def sin_q16(x: Fraction) -> int:
    """sin(x) in Q16 for x ≤ 0.21 rad: four Taylor terms, rounded half up."""
    v = (x - x**3 / 6 + x**5 / 120 - x**7 / 5040) * Q16
    return (2 * v.numerator + v.denominator) // (2 * v.denominator)


def fc_at(n: int) -> Fraction:
    """Band-pass centre in Hz: 500 → 3,200 at the hit, then → 900 at the end."""
    if n <= HIT:
        return Fraction(500) + Fraction(2700 * n, HIT)
    return Fraction(3200) - Fraction(2300 * (n - HIT), SAMPLES - 1 - HIT)


def env_q16(n: int) -> int:
    """Quadratic swell to the hit, quadratic decay after it (Q16)."""
    u = Fraction(n, HIT) if n <= HIT else Fraction(SAMPLES - 1 - n, SAMPLES - 1 - HIT)
    return int(u * u * Q16)


def pcm() -> bytes:
    """The interleaved s16le frames of v1 (stereo, 48 kHz, ``SAMPLES`` frames)."""
    state, low, band, q = SEED, 0, 0, Q16 * 7 // 10  # Chamberlin SVF, q = 0.7
    raw: list[tuple[int, int]] = []
    for n in range(SAMPLES):
        state = xorshift32(state)
        noise = (state >> 16) - 32768
        f = 2 * sin_q16(PI * fc_at(n) / RATE)
        low += (f * band) >> 16
        high = (noise << 4) - low - ((q * band) >> 16)
        band += (f * high) >> 16
        s = (band * env_q16(n)) >> 16
        left = (s * (Q16 - (Q16 * 3 // 10) * n // SAMPLES)) >> 16  # pan L 1.0 → 0.7
        right = (s * (Q16 * 7 // 10 + (Q16 * 3 // 10) * n // SAMPLES)) >> 16  # pan R 0.7 → 1.0
        raw.append((left, right))
    peak = max(max(abs(a), abs(b)) for a, b in raw)
    out = bytearray()
    for n, pair in enumerate(raw):
        ramp = min(n, SAMPLES - 1 - n, RAMP)
        # scaled to PEAK, rounded half up, under the 2 ms ramps
        out += struct.pack("<hh", *((2 * c * PEAK * ramp + peak * RAMP) // (2 * peak * RAMP)
                                    for c in pair))
    return bytes(out)


def wav_bytes() -> bytes:
    """v1.wav: RIFF/WAVE PCM, 2 channels, 16-bit, 48 kHz (``wave``'s 44-byte header)."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm())
    return buffer.getvalue()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def measure(path: Path, ffmpeg: str = "ffmpeg") -> dict[str, object]:
    """Integrated loudness and true peak of ``path`` (centi-LUFS, centi-dBTP) with the FFmpeg
    that runs here, plus its version."""
    result = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-af",
         "ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
        capture_output=True, text=True, check=True)
    summary = result.stderr[result.stderr.rfind("Summary:"):]
    integrated = re.search(r"I:\s+(-?[0-9.]+) LUFS", summary)
    peak = re.search(r"Peak:\s+(-?[0-9.]+) dBFS", summary)
    if integrated is None or peak is None:
        raise RuntimeError("ebur128 printed no summary")
    version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True,
                             check=True).stdout.split()[2].split("-")[0]
    return {"i_clufs": round(float(integrated.group(1)) * 100),
            "tp_cdb": round(float(peak.group(1)) * 100),
            "measured_with": f"FFmpeg {version} ebur128=peak=true"}


def meta(data: bytes, loudness: dict[str, object]) -> dict[str, object]:
    script = Path(__file__).resolve().read_bytes()
    return {
        "schema": "potongin.sfx/1", "id": "whoosh", "v": 1, "file": "v1.wav",
        "sha256": sha256_hex(data), "bytes": len(data),
        "sample_rate": RATE, "channels": 2, "sample_format": "s16le", "samples": SAMPLES,
        "hit_smp": HIT, "peak": PEAK, "loudness": loudness,
        "license": "CC0-1.0", "author": "Potongin (self-made; no third-party material)",
        "generator": {"script": "scripts/sfx/make_whoosh.py", "sha256": sha256_hex(script),
                      "seed": SEED},
    }


def check(wav: Path = WAV, meta_path: Path = META) -> list[str]:
    """Problems of the committed v1 (empty when the bytes and the meta's sha match)."""
    data = wav_bytes()
    problems = []
    try:
        committed = wav.read_bytes()
    except OSError:
        return ["v1.wav is missing"]
    if committed != data:
        problems.append("v1.wav differs from the generator's bytes")
    try:
        recorded = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [*problems, "v1.meta.json is missing or unreadable"]
    if recorded.get("sha256") != sha256_hex(data) or recorded.get("bytes") != len(data):
        problems.append("v1.meta.json does not name the generator's bytes")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args(argv)
    if args.check:
        problems = check()
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1 if problems else 0
    data = wav_bytes()
    SFX_DIR.mkdir(parents=True, exist_ok=True)
    WAV.write_bytes(data)
    record = meta(data, measure(WAV, args.ffmpeg))
    META.write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(record, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
