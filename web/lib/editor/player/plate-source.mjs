// Plate source of the editor player (plan §6.2 "Plate source"; Mediabunny 1.59.1, MPL-2.0,
// unmodified).
//
// * A plate cell is one MP4 (H.264, IDR at the cell start, no B-frames) holding source-grid
//   frames [k·C, (k+1)·C) of the layout graph at the output size, timestamps from 0. Frame j of
//   cell k is the sample at (j + 0.5)·den/num.
// * Decode-ahead decodes sequentially (VideoSampleSink.samples from the first needed frame; a
//   getSample per frame would re-decode from the IDR every time). Frames are kept as owned I420
//   copies (copyFrame) in an LRU of `capacity` (90) frames; the decoder's frames go back at once.
// * `ensure(schedule)` takes the decode-ahead schedule (frame-map.decodeSchedule): cells in
//   first-need order, each decoded in one pass over the union of its needed frames; the frames of
//   the schedule are protected from eviction. At most `maxDecoders` cells decode at once; a
//   decoder already past a newly needed frame leaves it to a follow-up pass.
// * `need(k, j)` is a frame the stage waits for: it starts at once (a lone frame with getSample,
//   which decodes from the IDR and flushes), promotes a pass already heading for it, and with
//   `exclusive` (a paused seek) stops the decode-ahead of the previous position. A lone pass
//   that does not deliver its frame (no sample, a neighbour, a decode error) hands it to one
//   sequential pass, the route playback decodes with.
// * A new plate key (a layout change) flushes every frame and ignores decodes still running.

import { cellFramesFor, sampleIndex, sampleTimestamp } from "./frame-map.mjs";

export function createFrameCache({ capacity = 90, onEvict = () => {} } = {}) {
  const map = new Map(); // oldest first
  let guarded = new Set();

  function evict() {
    while (map.size > capacity) {
      let victim;
      for (const key of map.keys()) {
        if (!guarded.has(key)) {
          victim = key;
          break;
        }
      }
      if (victim === undefined) victim = map.keys().next().value;
      const value = map.get(victim);
      map.delete(victim);
      onEvict(victim, value);
    }
  }

  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    has(key) {
      return map.has(key);
    },
    set(key, value) {
      if (map.has(key)) {
        const old = map.get(key);
        map.delete(key);
        if (old !== value) onEvict(key, old);
      }
      map.set(key, value);
      evict();
    },
    protect(keys) {
      guarded = keys instanceof Set ? keys : new Set(keys);
    },
    clear() {
      const entries = [...map.entries()];
      map.clear();
      for (const [key, value] of entries) onEvict(key, value);
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * An owned copy of a decoded frame: the visible I420 planes copied into our own buffer
 * (1.4 MB at 720×1280, against 3.7 MB for an RGBA ImageBitmap) with the same colour space. The
 * decoder's frame can then be closed at once, so a hardware decoder never runs out of output
 * buffers while 90 frames are cached. Canvas2D draws the copy with the same pixels as an
 * ImageBitmap of the original (measured: 60 of 60 frames identical in Chrome 147); converting
 * at draw time costs ≈ 8 ms per shown frame instead of ≈ 10 ms per decoded frame in
 * createImageBitmap.
 */
export async function copyFrame(frame, VideoFrameImpl = globalThis.VideoFrame, pool = null) {
  const rect = frame.visibleRect;
  const size = frame.allocationSize();
  const data = pool ? pool.acquire(size) : new Uint8Array(size);
  try {
    const layout = await frame.copyTo(data);
    const colorSpace = typeof frame.colorSpace?.toJSON === "function" ? frame.colorSpace.toJSON() : frame.colorSpace;
    // The VideoFrame constructor copies the planes (WebCodecs), so the scratch can be reused.
    return new VideoFrameImpl(data, {
      format: frame.format, codedWidth: rect.width, codedHeight: rect.height, timestamp: frame.timestamp,
      layout, colorSpace,
    });
  } finally {
    pool?.release(data);
  }
}

/**
 * Scratch buffers for copyFrame: a copy used to allocate a fresh 1.4 MB ArrayBuffer per decoded
 * frame (≈ 45 MB/s while playing), garbage that can stop the main thread for a GC.
 */
export function createScratchPool({ limit = 4 } = {}) {
  const free = [];
  const pool = {
    created: 0,
    acquire(size) {
      const index = free.findIndex((buffer) => buffer.byteLength === size);
      if (index >= 0) return free.splice(index, 1)[0];
      pool.created += 1;
      return new Uint8Array(size);
    },
    release(buffer) {
      if (free.length < limit) free.push(buffer);
    },
    get size() {
      return free.length;
    },
  };
  return pool;
}

// Decoded samples arrive in bursts; converting them back to back in one microtask run made
// 50–70 ms main-thread tasks (Chrome trace of a 20-cut playback), which delayed the
// requestAnimationFrame that presents frames. Each conversion is followed by a yield, so the
// longest decode task is one conversion (≈ 5 ms at 720×1280).
function defaultYield() {
  const scheduler = globalThis.scheduler;
  if (scheduler && typeof scheduler.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const frameKey = (k, j) => `${k}:${j}`;

export function createPlateSource({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  loadMediabunny = () => import("mediabunny"),
  retainFrame = null,
  yieldTask = defaultYield,
  now = () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
  fps,
  capacity = 90,
  maxDecoders = 3,
  cellBufferCapacity = 8,
} = {}) {
  let plate = null;
  let cells = new Map();
  let generation = 0;
  let destroyed = false;
  let mediabunny = null;
  const cache = createFrameCache({ capacity, onEvict: (_key, bitmap) => bitmap?.close?.() });
  const scratch = createScratchPool({ limit: maxDecoders + 1 });
  const retain = retainFrame ?? ((frame) => copyFrame(frame, globalThis.VideoFrame, scratch));
  const buffers = new Map(); // k → Promise<ArrayBuffer>, oldest first
  const jobs = new Map(); // k → the latest pass over cell k (queued or running)
  const active = new Set(); // running passes
  const urgent = new Set(); // "k:j" the stage waits for
  const queue = [];
  const waiters = new Map(); // "k:j" → { promise, resolve, reject }
  let running = 0;
  const stats = { framesDecoded: 0, framesKept: 0, cellFetches: 0, passes: 0, errors: 0 };
  const passLog = []; // the last 64 passes: fetch, open, first sample and total times (ms)
  let cellFrames = fps ? cellFramesFor(fps) : null;

  function cellState(k) {
    const cell = cells.get(k);
    if (!cell) return "missing";
    return cell.state === "ready" && typeof cell.url === "string" && cell.url ? "ready" : "queued";
  }

  function waiter(k, j) {
    const key = frameKey(k, j);
    let entry = waiters.get(key);
    if (!entry) {
      entry = {};
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.promise.catch(() => {});
      waiters.set(key, entry);
    }
    return entry.promise;
  }

  function settle(k, j, bitmap) {
    const key = frameKey(k, j);
    urgent.delete(key);
    const entry = waiters.get(key);
    if (entry) {
      waiters.delete(key);
      entry.resolve(bitmap);
    }
  }

  function failCell(k, error) {
    for (const [key, entry] of [...waiters.entries()]) {
      if (key.startsWith(`${k}:`)) {
        waiters.delete(key);
        urgent.delete(key);
        entry.reject(error);
      }
    }
  }

  function cellBuffer(k) {
    if (buffers.has(k)) {
      const promise = buffers.get(k);
      buffers.delete(k);
      buffers.set(k, promise);
      return promise;
    }
    const url = cells.get(k).url;
    stats.cellFetches += 1;
    const promise = (async () => {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`plate_cell_failed:${k}:${response.status}`);
      return response.arrayBuffer();
    })();
    promise.catch(() => {
      if (buffers.get(k) === promise) buffers.delete(k);
    });
    buffers.set(k, promise);
    while (buffers.size > cellBufferCapacity) buffers.delete(buffers.keys().next().value);
    return promise;
  }

  /** Keeps sample j of the job's cell (an owned copy) in the cache; false when the plate changed. */
  async function keep(job, j, sample) {
    const frame = sample.toVideoFrame();
    let bitmap;
    try {
      bitmap = await retain(frame);
    } finally {
      frame.close?.();
    }
    if (job.generation !== generation || destroyed) {
      bitmap?.close?.();
      return false;
    }
    cache.set(frameKey(job.k, j), bitmap);
    stats.framesKept += 1;
    settle(job.k, j, bitmap);
    await yieldTask();
    return live(job);
  }

  function live(job) {
    return !job.cancelled && job.generation === generation && !destroyed;
  }

  async function runJob(job) {
    stats.passes += 1;
    let input = null;
    const timing = { k: job.k, urgent: job.urgent, started: now() };
    try {
      mediabunny ??= await loadMediabunny();
      const bytes = await cellBuffer(job.k);
      timing.fetched = now() - timing.started;
      if (!live(job)) return;
      input = new mediabunny.Input({ formats: mediabunny.ALL_FORMATS, source: new mediabunny.BufferSource(bytes) });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error(`plate_cell_failed:${job.k}:no_video`);
      const sink = new mediabunny.VideoSampleSink(track);
      timing.opened = now() - timing.started;
      const first = Math.min(...job.wanted);
      job.position = first - 1;
      job.started = true;
      if (job.urgent && !job.sequential && job.wanted.size === 1 && typeof sink.getSample === "function") {
        // A lone seek target: getSample decodes from the IDR to j and flushes the decoder, so
        // the frame comes out without waiting for the next one (samples() needs it to know
        // that j is the frame at j's time) or for the decoder's frame-thread delay.
        job.lone = true;
        const sample = await sink.getSample(sampleTimestamp(first, fps));
        timing.firstSample = now() - timing.started;
        job.done = true;
        if (sample) {
          stats.framesDecoded += 1;
          try {
            const j = sampleIndex(sample.timestamp, fps);
            job.position = j;
            if (j === first && live(job) && !cache.has(frameKey(job.k, j))) await keep(job, j, sample);
          } finally {
            sample.close?.();
          }
        }
        // No sample, or a neighbouring one: the frame is still in the cell (the plan maps the
        // playhead into it), so one sequential pass reads it. Another getSample would give the
        // same answer, and a null here would leave the stage without its frame for good.
        for (const j of job.wanted) {
          if (!cache.has(frameKey(job.k, j)) && live(job)) job.followUp.add(j);
        }
        if (job.followUp.size) job.sequentialFollowUp = true;
        return;
      }
      let exhausted = true; // the cell ended before every needed frame was seen
      for await (const sample of sink.samples(sampleTimestamp(first, fps))) {
        const j = sampleIndex(sample.timestamp, fps);
        stats.framesDecoded += 1;
        timing.firstSample ??= now() - timing.started;
        let stop = !live(job);
        try {
          if (!stop && j >= first) {
            job.position = j;
            if (job.wanted.has(j) && !cache.has(frameKey(job.k, j))) stop = !(await keep(job, j, sample));
          }
        } finally {
          sample.close?.();
        }
        if (stop || j >= Math.max(...job.wanted)) {
          // Closed to new frames before the decoder is released (an await): a frame needed
          // from now on goes to a follow-up pass.
          job.done = true;
          exhausted = false;
          break;
        }
      }
      job.done = true;
      for (const j of job.wanted) {
        if (cache.has(frameKey(job.k, j))) continue;
        // Past the last frame of a short cell: that frame does not exist.
        if (exhausted && j > job.position && !job.cancelled) settle(job.k, j, null);
        else job.followUp.add(j);
      }
    } catch (error) {
      stats.errors += 1;
      if (job.generation === generation && job.lone) {
        // The lone route failed to decode a cell that was fetched and opened: its frames get
        // one sequential pass over the same bytes; a failure there fails the cell.
        job.done = true;
        for (const j of job.wanted) if (!cache.has(frameKey(job.k, j))) job.followUp.add(j);
        job.sequentialFollowUp = true;
      } else if (job.generation === generation) {
        buffers.delete(job.k);
        failCell(job.k, error instanceof Error && /^plate_cell_failed/.test(error.message)
          ? error : new Error(`plate_cell_failed:${job.k}:${error?.message ?? error}`));
      }
    } finally {
      input?.dispose?.();
      timing.total = now() - timing.started;
      timing.kept = job.wanted.size;
      if (passLog.length >= 64) passLog.shift();
      passLog.push(timing);
    }
  }

  function start(job) {
    running += 1;
    job.running = true;
    active.add(job);
    runJob(job).finally(() => {
      running -= 1;
      active.delete(job);
      if (jobs.get(job.k) === job) jobs.delete(job.k);
      if (job.generation === generation && job.followUp.size) {
        const pending = [...job.followUp].filter((j) => !cache.has(frameKey(job.k, j)) && waiters.has(frameKey(job.k, j)));
        if (pending.length) {
          want(job.k, pending, { urgent: pending.some((j) => urgent.has(frameKey(job.k, j))),
            sequential: job.sequentialFollowUp === true });
        }
      }
      pump();
    });
  }

  function pump() {
    // A frame the stage waits for (urgent) starts at once; decode-ahead waits for a free decoder.
    for (let i = 0; i < queue.length;) {
      const job = queue[i];
      if (job.generation !== generation || job.cancelled) {
        queue.splice(i, 1);
        if (jobs.get(job.k) === job) jobs.delete(job.k);
      } else if (job.urgent) {
        queue.splice(i, 1);
        start(job);
      } else {
        i += 1;
      }
    }
    while (running < maxDecoders && queue.length) start(queue.shift());
  }

  /** `sequential`: the frames came back from a lone pass without being decoded (no getSample). */
  function want(k, js, { urgent: isUrgent = false, sequential = false } = {}) {
    const missing = js.filter((j) => !cache.has(frameKey(k, j)));
    if (!missing.length) return;
    let job = jobs.get(k);
    if (job && job.generation === generation && !job.done && !job.cancelled
      && (!job.started || missing.every((j) => j > job.position)) && (!isUrgent || job.urgent)) {
      for (const j of missing) job.wanted.add(j);
      if (sequential) job.sequential = true;
      return;
    }
    if (job && job.generation === generation && !job.done && !job.cancelled && !isUrgent) {
      for (const j of missing) job.followUp.add(j); // behind the running pass
      if (sequential) job.sequentialFollowUp = true;
      return;
    }
    job = { k, wanted: new Set(missing), followUp: new Set(), generation, started: false, running: false,
      done: false, cancelled: false, urgent: isUrgent, position: -1, sequential };
    jobs.set(k, job);
    if (isUrgent) queue.unshift(job);
    else queue.push(job);
    pump();
  }

  /** Stops every pass that is not decoding an urgent frame; their other frames resolve null. */
  function cancelAhead() {
    const stopped = [];
    for (const job of [...queue, ...active]) {
      if (job.urgent || job.cancelled) continue;
      job.cancelled = true;
      stopped.push(job);
    }
    for (const job of stopped) {
      for (const j of [...job.wanted, ...job.followUp]) {
        const key = frameKey(job.k, j);
        if (urgent.has(key) || cache.has(key)) continue;
        const entry = waiters.get(key);
        if (entry) {
          waiters.delete(key);
          entry.resolve(null);
        }
      }
    }
    pump();
  }

  const source = {
    setPlate(dto) {
      if (destroyed) return;
      if (!plate || dto.plateKey !== plate.plateKey) {
        generation += 1;
        for (const [key, entry] of [...waiters.entries()]) {
          waiters.delete(key);
          entry.resolve(null);
        }
        urgent.clear();
        queue.length = 0;
        jobs.clear();
        buffers.clear();
        cache.clear();
      }
      plate = dto;
      cells = new Map((dto.cells || []).map((cell) => [cell.k, cell]));
      if (!cellFrames && dto.cellFrames) cellFrames = dto.cellFrames;
    },
    get plateKey() {
      return plate ? plate.plateKey : null;
    },
    cellState,
    readyCells() {
      let ready = 0;
      for (const k of cells.keys()) if (cellState(k) === "ready") ready += 1;
      return { ready, total: cells.size };
    },
    has(k, j) {
      return cache.has(frameKey(k, j));
    },
    frame(k, j) {
      return cache.get(frameKey(k, j)) ?? null;
    },
    /**
     * The bitmap of frame j of cell k, decoding it first (null when the cell is not ready). The
     * stage waits for it: its pass starts at once, whatever the decode-ahead is doing; a pass
     * already on its way to j is promoted instead of starting another. `exclusive` (a paused
     * seek) also stops the decode-ahead of the previous position.
     */
    async need(k, j, { exclusive = false } = {}) {
      if (destroyed) return null;
      const key = frameKey(k, j);
      const cached = cache.get(key);
      if (cached) return cached;
      if (cellState(k) !== "ready") return null;
      urgent.add(key);
      const promise = waiter(k, j);
      const serving = [...active, ...queue].find((job) => job.k === k && live(job) && !job.done
        && job.wanted.has(j) && (!job.started || job.position < j));
      if (serving) serving.urgent = true;
      if (exclusive) cancelAhead();
      if (serving) pump();
      else want(k, [j], { urgent: true });
      return promise;
    },
    /** Decodes the schedule ahead ([{k, js, firstN}] in first-need order); protects its frames. */
    ensure(schedule, { keep = [] } = {}) {
      if (destroyed) return Promise.resolve();
      const guard = new Set(keep.map(([k, j]) => frameKey(k, j)));
      for (const entry of schedule) for (const j of entry.js) guard.add(frameKey(entry.k, j));
      cache.protect(guard);
      const promises = [];
      for (const entry of schedule) {
        if (cellState(entry.k) !== "ready") continue;
        const missing = entry.js.filter((j) => !cache.has(frameKey(entry.k, j)));
        for (const j of missing) promises.push(waiter(entry.k, j));
        want(entry.k, missing);
      }
      return Promise.allSettled(promises).then(() => undefined);
    },
    stats() {
      return { ...stats, cached: cache.size, running, queued: queue.length, passTimes: passLog.slice() };
    },
    destroy() {
      destroyed = true;
      generation += 1;
      for (const entry of waiters.values()) entry.resolve(null);
      waiters.clear();
      urgent.clear();
      queue.length = 0;
      jobs.clear();
      buffers.clear();
      cache.clear();
    },
  };
  return source;
}
