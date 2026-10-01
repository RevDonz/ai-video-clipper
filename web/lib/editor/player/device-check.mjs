// Device check (plan §6.2): if JASSUB's p95 over the first 60 rendered frames exceeds 20 ms per
// frame, the UI shows "Perangkat lambat: pemutaran bisa patah-patah". The resolution is never
// lowered, so exactness is kept; the check only informs.

/** Nearest-rank percentile (the rank ⌈p·N/100⌉), or null for no values. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((sorted.length * p) / 100) - 1)];
}

export function createDeviceCheck({ frames = 60, thresholdMs = 20 } = {}) {
  const samples = [];
  let verdict = null;
  return {
    /** Adds one frame's render time; returns the verdict once, when the window is complete. */
    add(ms) {
      if (verdict) return null;
      samples.push(ms);
      if (samples.length < frames) return null;
      const p95 = percentile(samples, 95);
      verdict = { slow: p95 > thresholdMs, p95, frames: samples.length };
      return { ...verdict };
    },
    get slow() {
      return verdict ? verdict.slow : null;
    },
    get p95() {
      return verdict ? verdict.p95 : null;
    },
  };
}
