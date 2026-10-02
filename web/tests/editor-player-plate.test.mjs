// Plate source (plan §6.2 "Plate source"): plate cells (H.264, IDR at every cell start, one file
// per cell) decoded with Mediabunny's VideoSampleSink; frames kept as ImageBitmaps in an LRU of
// 90; the frames of the look-ahead window are protected from eviction; a decoder decodes a cell
// sequentially from the first needed frame and keeps only the needed ones; a new plate key
// flushes everything.
import assert from "node:assert/strict";
import test from "node:test";

import { copyFrame, createFrameCache, createPlateSource, createScratchPool } from "../lib/editor/player/plate-source.mjs";

const FPS = [30, 1];

function fakeMediabunny({ frames = 60, getSample = false } = {}) {
  const log = [];
  class BufferSource {
    constructor(buffer) { this.buffer = buffer; }
  }
  class Input {
    constructor({ source }) { this.source = source; }
    async getPrimaryVideoTrack() { return { cell: this.source.buffer.cell }; }
    dispose() { log.push(["dispose", this.source.buffer.cell]); }
  }
  class VideoSampleSink {
    constructor(track) {
      this.track = track;
      if (getSample) {
        this.getSample = async (timestamp) => {
          const cell = this.track.cell;
          const j = Math.floor((timestamp * FPS[0]) / FPS[1] + 1e-9);
          log.push(["getSample", cell, j]);
          if (j >= frames) return null;
          return { timestamp: (j * FPS[1]) / FPS[0], toVideoFrame: () => ({ cell, j, close() {} }), close() {} };
        };
      }
    }
    async* samples(startTimestamp = 0) {
      const cell = this.track.cell;
      // Like Mediabunny: the first sample yielded is the one whose interval contains the start.
      const first = Math.max(0, Math.floor((startTimestamp * FPS[0]) / FPS[1] + 1e-9));
      log.push(["open", cell, first]);
      try {
        for (let j = first; j < frames; j += 1) {
          await Promise.resolve();
          log.push(["decode", cell, j]);
          yield {
            timestamp: (j * FPS[1]) / FPS[0],
            toVideoFrame: () => ({ cell, j, close() {} }),
            close() {},
          };
        }
      } finally {
        log.push(["close", cell]);
      }
    }
  }
  return { log, module: { Input, BufferSource, VideoSampleSink, ALL_FORMATS: ["mp4"] } };
}

function plateDto(key, ready, cellFrames = 60) {
  return {
    plateKey: key, cellFrames, w: 720, h: 1280,
    cells: ready.map((k) => (typeof k === "number" ? { k, state: "ready", url: `/cells/${key}-${k}.mp4` } : k)),
  };
}

// The yield after each kept frame is a microtask here, as in gatedHarness. The default yield is
// setTimeout(0) on Node (no global scheduler), and whether a 1 ms timer fires before the tests'
// setImmediate differs between Node 20 and 22, so a pass could still be open when a test checks
// that its decoder was closed.
function harness({ frames = 60, capacity = 90, maxDecoders = 3 } = {}) {
  const mb = fakeMediabunny({ frames });
  const fetches = [];
  const closed = [];
  const converted = [];
  const source = createPlateSource({
    fetchImpl: async (url) => {
      fetches.push(url);
      const cell = Number(/-(\d+)\.mp4$/.exec(url)[1]);
      return { ok: true, status: 200, arrayBuffer: async () => ({ cell }) };
    },
    loadMediabunny: async () => mb.module,
    retainFrame: async (frame) => {
      converted.push(`${frame.cell}:${frame.j}`);
      return { cell: frame.cell, j: frame.j, close() { closed.push(`${frame.cell}:${frame.j}`); } };
    },
    yieldTask: () => Promise.resolve(),
    fps: FPS,
    capacity,
    maxDecoders,
  });
  return { source, mb, fetches, closed, converted };
}

test("a decoded frame is kept as an owned I420 copy (1.4 MB, not 3.7 MB RGBA; the decoder's frame goes back)", async () => {
  const created = [];
  class FakeVideoFrame {
    constructor(data, init) { this.data = data; this.init = init; created.push(this); }
  }
  const source = {
    format: "I420", codedWidth: 720, codedHeight: 1282, timestamp: 33_367,
    visibleRect: { x: 0, y: 0, width: 720, height: 1280 },
    colorSpace: { toJSON: () => ({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false }) },
    allocationSize: () => 1_382_400,
    async copyTo(buffer) {
      buffer[0] = 7;
      return [{ offset: 0, stride: 720 }, { offset: 921_600, stride: 360 }, { offset: 1_152_000, stride: 360 }];
    },
  };
  const copy = await copyFrame(source, FakeVideoFrame);
  assert.equal(created.length, 1);
  assert.equal(copy.data.byteLength, 1_382_400);
  assert.equal(copy.data[0], 7);
  assert.deepEqual(copy.init, {
    format: "I420", codedWidth: 720, codedHeight: 1280, timestamp: 33_367,
    layout: [{ offset: 0, stride: 720 }, { offset: 921_600, stride: 360 }, { offset: 1_152_000, stride: 360 }],
    colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
  });
});

test("copies reuse scratch buffers (VideoFrame copies its data), so playback allocates no garbage", async () => {
  class FakeVideoFrame {
    constructor(data, init) { this.copied = Uint8Array.from(data); this.init = init; }
  }
  const frame = (value) => ({
    format: "I420", timestamp: 0, visibleRect: { width: 2, height: 2 },
    colorSpace: { primaries: "bt709" }, allocationSize: () => 6,
    async copyTo(buffer) { buffer.fill(value); return [{ offset: 0, stride: 2 }]; },
  });
  const pool = createScratchPool({ limit: 2 });
  const first = await copyFrame(frame(1), FakeVideoFrame, pool);
  const second = await copyFrame(frame(2), FakeVideoFrame, pool);
  assert.deepEqual([...first.copied], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual([...second.copied], [2, 2, 2, 2, 2, 2]);
  assert.equal(pool.created, 1, "one scratch buffer served both sequential copies");
  const [a, b, c] = await Promise.all([copyFrame(frame(3), FakeVideoFrame, pool),
    copyFrame(frame(4), FakeVideoFrame, pool), copyFrame(frame(5), FakeVideoFrame, pool)]);
  assert.deepEqual([a.copied[0], b.copied[0], c.copied[0]], [3, 4, 5], "concurrent copies never share a buffer");
  assert.ok(pool.size <= 2);
});

test("the frame cache is an LRU that never evicts protected frames", () => {
  const evicted = [];
  const cache = createFrameCache({ capacity: 3, onEvict: (key, value) => evicted.push([key, value]) });
  cache.set("0:1", "a");
  cache.set("0:2", "b");
  cache.set("0:3", "c");
  assert.equal(cache.get("0:1"), "a"); // touch: 0:2 is now the oldest
  cache.protect(new Set(["0:2"]));
  cache.set("0:4", "d");
  assert.deepEqual(evicted, [["0:3", "c"]]);
  assert.equal(cache.size, 3);
  assert.equal(cache.has("0:2"), true);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(evicted.length, 4);
});

test("when every frame is protected the oldest one goes anyway, so the cap holds", () => {
  const cache = createFrameCache({ capacity: 2 });
  cache.protect(new Set(["a", "b", "c"]));
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.has("a"), false);
});

test("cell states come from the plan; only ready cells with a URL are decodable", () => {
  const { source } = harness();
  source.setPlate(plateDto("p1", [0, { k: 1, state: "queued" }, { k: 2, state: "ready" }]));
  assert.equal(source.cellState(0), "ready");
  assert.equal(source.cellState(1), "queued");
  assert.equal(source.cellState(2), "queued"); // ready without a URL cannot be fetched
  assert.equal(source.cellState(9), "missing");
  assert.deepEqual(source.readyCells(), { ready: 1, total: 3 });
});

test("need(k, j) decodes the cell from j, converts only the needed frame, and caches it", async () => {
  const { source, mb, fetches, converted } = harness();
  source.setPlate(plateDto("p1", [0, 1]));
  const bitmap = await source.need(1, 17);
  assert.deepEqual([bitmap.cell, bitmap.j], [1, 17]);
  assert.deepEqual(fetches, ["/cells/p1-1.mp4"]);
  assert.deepEqual(converted, ["1:17"]);
  assert.deepEqual(mb.log.filter(([kind]) => kind === "open"), [["open", 1, 17]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(mb.log.some(([kind, cell]) => kind === "close" && cell === 1), "the decoder is closed after the last needed frame");
  assert.equal(mb.log.filter(([kind, cell, j]) => kind === "decode" && cell === 1 && j > 17).length, 0);
  assert.equal(source.frame(1, 17), bitmap);
  assert.equal(await source.need(1, 17), bitmap);
  assert.equal(mb.log.filter(([kind]) => kind === "open").length, 1);
});

test("a cell that is not ready gives no frame and fetches nothing", async () => {
  const { source, fetches } = harness();
  source.setPlate(plateDto("p1", [{ k: 3, state: "queued" }]));
  assert.equal(await source.need(3, 0), null);
  assert.deepEqual(fetches, []);
});

test("ensure decodes the schedule in order, one pass per cell, keeping the needed frames", async () => {
  const { source, mb, converted, fetches } = harness();
  source.setPlate(plateDto("p1", [0, 5, 6]));
  await source.ensure([
    { k: 6, js: [20, 21, 22], firstN: 50 },
    { k: 0, js: [30, 31], firstN: 60 },
  ]);
  // Cells decode in parallel (up to maxDecoders), each in frame order; cell 6 is needed first.
  assert.deepEqual(converted.filter((key) => key.startsWith("6:")), ["6:20", "6:21", "6:22"]);
  assert.deepEqual(converted.filter((key) => key.startsWith("0:")), ["0:30", "0:31"]);
  assert.deepEqual(mb.log.filter(([kind]) => kind === "open").map(([, cell]) => cell), [6, 0]);
  assert.deepEqual(fetches, ["/cells/p1-6.mp4", "/cells/p1-0.mp4"]);
  // No frame after the last needed one is decoded.
  assert.equal(mb.log.filter(([kind, cell, j]) => kind === "decode" && cell === 6 && j > 22).length, 0);
  for (const key of ["6:20", "6:21", "6:22", "0:30", "0:31"]) {
    const [k, j] = key.split(":").map(Number);
    assert.ok(source.frame(k, j), key);
  }
});

test("frames of the look-ahead window are protected; the cap of 90 holds", async () => {
  const { source, closed } = harness({ capacity: 90 });
  source.setPlate(plateDto("p1", [0, 1, 2]));
  await source.ensure([{ k: 0, js: Array.from({ length: 60 }, (_, j) => j), firstN: 0 }]);
  await source.ensure([{ k: 1, js: Array.from({ length: 60 }, (_, j) => j), firstN: 60 }]);
  assert.equal(source.stats().cached, 90);
  // The oldest frames (cell 0) were evicted and closed; cell 1 (the window) is intact.
  assert.equal(closed.length, 30);
  assert.ok(closed.every((key) => key.startsWith("0:")));
  for (let j = 0; j < 60; j += 1) assert.ok(source.frame(1, j), `1:${j}`);
});

test("a later schedule reuses cached frames and the cell buffer", async () => {
  const { source, fetches, converted } = harness();
  source.setPlate(plateDto("p1", [0]));
  await source.ensure([{ k: 0, js: [1, 2, 3], firstN: 0 }]);
  await source.ensure([{ k: 0, js: [2, 3, 4, 5], firstN: 1 }]);
  assert.deepEqual(converted, ["0:1", "0:2", "0:3", "0:4", "0:5"]);
  assert.deepEqual(fetches, ["/cells/p1-0.mp4"]);
});

test("a new plate key flushes the frames and ignores decodes of the old plate", async () => {
  const { source, closed } = harness();
  source.setPlate(plateDto("p1", [0]));
  await source.need(0, 3);
  source.setPlate(plateDto("p2", [0]));
  assert.deepEqual(closed, ["0:3"]);
  assert.equal(source.frame(0, 3), null);
  const again = await source.need(0, 3);
  assert.ok(again);
  // The same plate key again keeps the cache.
  source.setPlate(plateDto("p2", [0, 1]));
  assert.equal(source.frame(0, 3), again);
  assert.equal(source.cellState(1), "ready");
});

test("at most maxDecoders cells decode at once", async () => {
  const { source, mb } = harness({ maxDecoders: 1 });
  source.setPlate(plateDto("p1", [0, 1, 2]));
  await source.ensure([
    { k: 0, js: [0, 1], firstN: 0 },
    { k: 1, js: [0, 1], firstN: 2 },
    { k: 2, js: [0, 1], firstN: 4 },
  ]);
  let open = 0;
  let peak = 0;
  for (const [kind] of mb.log) {
    if (kind === "open") peak = Math.max(peak, ++open);
    if (kind === "close") open -= 1;
  }
  assert.equal(peak, 1);
});

function gatedHarness({ maxDecoders = 1, gateCell = 0 } = {}) {
  const mb = fakeMediabunny();
  const converted = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const source = createPlateSource({
    fetchImpl: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => ({ cell: Number(/-(\d+)\.mp4$/.exec(url)[1]) }) }),
    loadMediabunny: async () => mb.module,
    retainFrame: async (frame) => {
      if (frame.cell === gateCell) await gate;
      converted.push(`${frame.cell}:${frame.j}`);
      return { cell: frame.cell, j: frame.j, close() {} };
    },
    yieldTask: () => Promise.resolve(),
    fps: FPS,
    maxDecoders,
  });
  return { source, mb, converted, release };
}

test("a frame the stage waits for starts at once, even with every decoder busy decoding ahead", async () => {
  const { source, converted, release } = gatedHarness({ maxDecoders: 1 });
  source.setPlate(plateDto("p1", [0, 2]));
  const ahead = source.ensure([{ k: 0, js: [0, 1, 2, 3], firstN: 0 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const bitmap = await source.need(2, 5);
  assert.deepEqual([bitmap.cell, bitmap.j], [2, 5]);
  assert.deepEqual(converted, ["2:5"], "the decode-ahead of cell 0 is still blocked");
  release();
  await ahead;
  assert.deepEqual(converted.slice(1), ["0:0", "0:1", "0:2", "0:3"]);
});

test("an exclusive need (a paused seek) stops the decode-ahead of the previous position", async () => {
  const { source, converted, release } = gatedHarness({ maxDecoders: 3 });
  source.setPlate(plateDto("p1", [0, 2]));
  const ahead = source.ensure([{ k: 0, js: [0, 1, 2, 3, 4, 5], firstN: 0 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const bitmap = await source.need(2, 5, { exclusive: true });
  assert.deepEqual([bitmap.cell, bitmap.j], [2, 5]);
  release();
  await ahead; // the cancelled frames resolve (to null) instead of hanging
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(converted.filter((key) => key.startsWith("0:")).length <= 1, converted.join(","));
  assert.equal(source.frame(0, 5), null);
});

test("a need for a frame a pass is already heading for promotes that pass", async () => {
  const { source, mb, release } = gatedHarness({ maxDecoders: 3, gateCell: 1 });
  source.setPlate(plateDto("p1", [1]));
  const ahead = source.ensure([{ k: 1, js: [0, 1, 2, 3, 4, 5, 6], firstN: 0 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = source.need(1, 5);
  release();
  const bitmap = await waiting;
  await ahead;
  assert.deepEqual([bitmap.cell, bitmap.j], [1, 5]);
  assert.equal(mb.log.filter(([kind]) => kind === "open").length, 1, "no second pass over cell 1");
});

test("a lone frame the stage waits for is decoded with getSample; decode-ahead streams", async () => {
  const mb = fakeMediabunny({ getSample: true });
  const converted = [];
  const source = createPlateSource({
    fetchImpl: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => ({ cell: Number(/-(\d+)\.mp4$/.exec(url)[1]) }) }),
    loadMediabunny: async () => mb.module,
    retainFrame: async (frame) => { converted.push(`${frame.cell}:${frame.j}`); return { cell: frame.cell, j: frame.j, close() {} }; },
    yieldTask: () => Promise.resolve(),
    fps: FPS,
  });
  source.setPlate(plateDto("p1", [0, 1]));
  const bitmap = await source.need(1, 42, { exclusive: true });
  assert.deepEqual([bitmap.cell, bitmap.j], [1, 42]);
  assert.deepEqual(mb.log.filter(([kind]) => kind === "getSample" || kind === "open"), [["getSample", 1, 42]]);
  await source.ensure([{ k: 0, js: [3, 4, 5], firstN: 0 }]);
  assert.deepEqual(mb.log.filter(([kind]) => kind === "open"), [["open", 0, 3]]);
  assert.deepEqual(converted, ["1:42", "0:3", "0:4", "0:5"]);
});

test("a failed cell fetch rejects its waiters and a later request retries", async () => {
  let fail = true;
  const mb = fakeMediabunny();
  const source = createPlateSource({
    fetchImpl: async () => (fail ? { ok: false, status: 503 } : { ok: true, status: 200, arrayBuffer: async () => ({ cell: 0 }) }),
    loadMediabunny: async () => mb.module,
    retainFrame: async (frame) => ({ cell: frame.cell, j: frame.j, close() {} }),
    fps: FPS,
  });
  source.setPlate(plateDto("p1", [0]));
  await assert.rejects(source.need(0, 0), /plate_cell_failed/);
  fail = false;
  assert.ok(await source.need(0, 0));
  assert.equal(source.stats().errors, 1);
});

test("destroy closes every cached frame", async () => {
  const { source, closed } = harness();
  source.setPlate(plateDto("p1", [0]));
  await source.ensure([{ k: 0, js: [0, 1], firstN: 0 }]);
  source.destroy();
  assert.deepEqual(closed.sort(), ["0:0", "0:1"]);
});

// The lone-frame route (getSample) that a paused frame uses can come back without that frame: no
// sample, the neighbouring sample, or a decode error. The frame then goes to one sequential pass
// (the route playback uses) instead of resolving null, asking getSample forever, or failing.
function loneHarness(lone, { now } = {}) {
  const mb = fakeMediabunny({ getSample: true });
  const { VideoSampleSink } = mb.module;
  class Sink extends VideoSampleSink {
    constructor(track) {
      super(track);
      this.getSample = async (timestamp) => {
        // A macrotask, as a real decode is: a pass that keeps asking cannot starve the timers.
        await new Promise((resolve) => setImmediate(resolve));
        const j = Math.floor((timestamp * FPS[0]) / FPS[1] + 1e-9);
        mb.log.push(["lone", track.cell, j]);
        return lone({ cell: track.cell, j });
      };
    }
  }
  const converted = [];
  const fetches = [];
  const source = createPlateSource({
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => ({ cell: Number(/-(\d+)\.mp4$/.exec(url)[1]) }) };
    },
    loadMediabunny: async () => ({ ...mb.module, VideoSampleSink: Sink }),
    retainFrame: async (frame) => { converted.push(`${frame.cell}:${frame.j}`); return { cell: frame.cell, j: frame.j, close() {} }; },
    yieldTask: () => Promise.resolve(),
    fps: FPS,
    ...(now ? { now } : {}),
  });
  return { source, mb, converted, fetches };
}

function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not settled in ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test("a lone frame getSample does not find is decoded by one sequential pass", async () => {
  const { source, mb, converted } = loneHarness(async () => null);
  source.setPlate(plateDto("p1", [47]));
  let bitmap = null;
  try {
    bitmap = await within(source.need(47, 30, { exclusive: true }), 2000, "need(47, 30)");
  } finally {
    source.destroy();
  }
  assert.ok(bitmap, "the frame is decoded, not given up");
  assert.deepEqual([bitmap.cell, bitmap.j], [47, 30]);
  assert.deepEqual(mb.log.filter(([kind]) => kind === "lone" || kind === "open"), [["lone", 47, 30], ["open", 47, 30]]);
  assert.deepEqual(converted, ["47:30"]);
});

test("a lone frame answered with its neighbour streams once instead of asking getSample forever", async () => {
  const { source, mb, converted } = loneHarness(async ({ cell, j }) => (
    { timestamp: ((j - 1) * FPS[1]) / FPS[0], toVideoFrame: () => ({ cell, j: j - 1, close() {} }), close() {} }));
  source.setPlate(plateDto("p1", [47]));
  let bitmap = null;
  try {
    bitmap = await within(source.need(47, 30, { exclusive: true }), 2000, "need(47, 30)");
  } finally {
    source.destroy();
  }
  assert.deepEqual([bitmap.cell, bitmap.j], [47, 30]);
  assert.equal(mb.log.filter(([kind]) => kind === "lone").length, 1, "getSample is asked once");
  assert.deepEqual(mb.log.filter(([kind]) => kind === "open"), [["open", 47, 30]]);
  assert.deepEqual(converted, ["47:30"]);
});

test("a lone pass whose decode fails hands the frame to one sequential pass; a second failure rejects", async () => {
  const flaky = loneHarness(async () => { throw new Error("EncodingError: Decoder failure"); });
  flaky.source.setPlate(plateDto("p1", [47]));
  let bitmap = null;
  try {
    bitmap = await within(flaky.source.need(47, 30, { exclusive: true }), 2000, "need(47, 30)");
  } finally {
    flaky.source.destroy();
  }
  assert.deepEqual([bitmap.cell, bitmap.j], [47, 30]);
  assert.deepEqual(flaky.mb.log.filter(([kind]) => kind === "lone" || kind === "open"), [["lone", 47, 30], ["open", 47, 30]]);
  assert.deepEqual(flaky.fetches, ["/cells/p1-47.mp4"], "the cell bytes are reused");

  const broken = loneHarness(async () => { throw new Error("EncodingError: Decoder failure"); });
  const { VideoSampleSink } = broken.mb.module;
  VideoSampleSink.prototype.samples = async function* samples() {
    broken.mb.log.push(["open", this.track.cell, -1]);
    throw new Error("EncodingError: Decoder failure");
  };
  broken.source.setPlate(plateDto("p1", [47]));
  try {
    await assert.rejects(within(broken.source.need(47, 30, { exclusive: true }), 2000, "need(47, 30)"), /plate_cell_failed:47/);
  } finally {
    broken.source.destroy();
  }
  assert.equal(broken.mb.log.filter(([kind]) => kind === "lone").length, 1);
  assert.equal(broken.mb.log.filter(([kind]) => kind === "open").length, 1);
});

test("a cell fetch that fails in a lone pass is not retried by a second pass", async () => {
  const mb = fakeMediabunny({ getSample: true });
  const fetches = [];
  const source = createPlateSource({
    fetchImpl: async (url) => { fetches.push(url); return { ok: false, status: 503 }; },
    loadMediabunny: async () => mb.module,
    retainFrame: async (frame) => ({ cell: frame.cell, j: frame.j, close() {} }),
    yieldTask: () => Promise.resolve(),
    fps: FPS,
  });
  source.setPlate(plateDto("p1", [47]));
  await assert.rejects(source.need(47, 30, { exclusive: true }), /plate_cell_failed:47:503/);
  assert.deepEqual(fetches, ["/cells/p1-47.mp4"]);
});

test("a frame missing from its cell resolves null after one lone and one sequential pass", async () => {
  // The cell has no sample for frame 30: getSample answers with 29, and the stream skips 30.
  const h = loneHarness(async ({ cell, j }) => sampleOf(cell, j === 30 ? 29 : j));
  const { VideoSampleSink } = h.mb.module;
  const stream = VideoSampleSink.prototype.samples;
  VideoSampleSink.prototype.samples = async function* gapped(start) {
    for await (const sample of stream.call(this, start)) {
      if (Math.round((sample.timestamp * FPS[0]) / FPS[1]) !== 30) yield sample;
    }
  };
  h.source.setPlate(plateDto("p1", [47]));
  let bitmap;
  try {
    bitmap = await within(h.source.need(47, 30, { exclusive: true }), 2000, "need(47, 30)");
  } finally {
    h.source.destroy();
  }
  assert.equal(bitmap, null, "no such frame: the caller is told, not left with lone and sequential passes taking turns");
  assert.deepEqual(h.mb.log.filter(([kind]) => kind === "lone" || kind === "open"), [["lone", 47, 30], ["open", 47, 30]]);
});

// A lone pass that never settles (a decoder flush that stalls under memory pressure): a caller who
// asks again joins it, and so does playback's decode-ahead. need({ fresh }) abandons the passes over
// the cell that show no progress and decodes the frame in one sequential pass from the cell start,
// where every decoded frame counts as progress.
const ticks = async (count) => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function sampleOf(cell, j) {
  return { timestamp: (j * FPS[1]) / FPS[0], toVideoFrame: () => ({ cell, j, close() {} }), close() {} };
}

test("a fresh need abandons a lone pass that never settles: one pass from the cell start, and nobody joins the stalled one", async () => {
  let calls = 0;
  const { source, mb, converted } = loneHarness(({ cell, j }) => (calls++ === 0 ? new Promise(() => {}) : sampleOf(cell, j)));
  source.setPlate(plateDto("p1", [47]));
  let firstSettled = false;
  const first = source.need(47, 30, { exclusive: true });
  first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  await ticks(20);
  let aheadDone = false;
  const ahead = source.ensure([{ k: 47, js: [31, 32], firstN: 1 }]);
  ahead.then(() => { aheadDone = true; });
  await ticks(20);
  assert.equal(firstSettled, false);
  assert.equal(aheadDone, false, "the decode-ahead waits on the stalled pass too");
  try {
    const bitmap = await within(source.need(47, 30, { exclusive: true, fresh: true }), 2000, "fresh need(47, 30)");
    assert.deepEqual([bitmap.cell, bitmap.j], [47, 30]);
    assert.equal(await within(first, 2000, "the first need"), bitmap, "the first caller gets the same frame");
    await within(ahead, 2000, "ensure"); // the decode-ahead it owed is dropped, as for any paused seek
    const next = await within(source.need(47, 31), 2000, "need(47, 31)");
    assert.deepEqual([next.cell, next.j], [47, 31], "a later caller does not join the stalled pass");
    await ticks(20);
    assert.equal(source.stats().abandoned, 1);
    assert.equal(source.stats().running, 0, "the stalled pass no longer holds a decoder slot");
  } finally {
    source.destroy();
  }
  assert.deepEqual(mb.log.filter(([kind]) => kind === "lone" || kind === "open"),
    [["lone", 47, 30], ["open", 47, 0], ["lone", 47, 31]]);
  assert.deepEqual(converted, ["47:30", "47:31"]);
});

test("an abandoned lone pass that answers first still gives its frame, and only once", async () => {
  const stalled = deferred();
  const h = loneHarness(() => stalled.promise);
  const gate = deferred();
  const { VideoSampleSink } = h.mb.module;
  const stream = VideoSampleSink.prototype.samples;
  VideoSampleSink.prototype.samples = async function* gated(start) {
    await gate.promise;
    yield* stream.call(this, start);
  };
  h.source.setPlate(plateDto("p1", [47]));
  const first = h.source.need(47, 30, { exclusive: true });
  await ticks(20);
  const fresh = h.source.need(47, 30, { exclusive: true, fresh: true });
  await ticks(20);
  stalled.resolve(sampleOf(47, 30)); // the stalled decode answers after all, before the fresh pass
  try {
    const bitmap = await within(fresh, 2000, "fresh need(47, 30)");
    assert.deepEqual([bitmap.cell, bitmap.j], [47, 30]);
    assert.equal(await first, bitmap);
    gate.resolve();
    await ticks(80);
    assert.equal(h.source.stats().running, 0);
  } finally {
    h.source.destroy();
  }
  assert.deepEqual(h.converted, ["47:30"], "the fresh pass finds the frame decoded");
});

test("a fresh need keeps a pass that is still decoding and abandons one that stopped; its late failure fails nothing", async () => {
  let clock = 0;
  const h = loneHarness(() => new Promise(() => {}), { now: () => clock });
  const { VideoSampleSink } = h.mb.module;
  // Each pass yields only the samples the test allows: a decoder whose speed the test sets.
  const passes = [];
  VideoSampleSink.prototype.samples = async function* stepped(start) {
    const pass = { allowed: 0, failure: null, wake: () => {} };
    passes.push(pass);
    const first = Math.floor((start * FPS[0]) / FPS[1] + 1e-9);
    h.mb.log.push(["open", this.track.cell, first]);
    for (let j = first; j < 60; j += 1) {
      while (!pass.allowed && !pass.failure) await new Promise((resolve) => { pass.wake = resolve; });
      if (pass.failure) throw pass.failure;
      pass.allowed -= 1;
      yield sampleOf(this.track.cell, j);
    }
  };
  const allow = async (pass, count) => {
    pass.allowed += count;
    pass.wake();
    await ticks(count * 4 + 20);
  };
  h.source.setPlate(plateDto("p1", [47]));
  const opens = () => h.mb.log.filter(([kind]) => kind === "open");
  try {
    const first = h.source.need(47, 40, { exclusive: true }); // a lone pass that stalls
    await ticks(20);
    clock = 1500;
    const retry = h.source.need(47, 40, { exclusive: true, fresh: true });
    await ticks(20);
    assert.deepEqual(opens(), [["open", 47, 0]]);
    await allow(passes[0], 10); // frames 0–9 decoded at 1.5 s
    clock = 2000;
    h.source.need(47, 40, { exclusive: true, fresh: true });
    await ticks(20);
    assert.equal(h.source.stats().abandoned, 1, "a pass that decoded 0.5 s ago is kept");
    assert.equal(opens().length, 1);
    clock = 3500; // nothing decoded for 2 s: stopped
    const last = h.source.need(47, 40, { exclusive: true, fresh: true });
    await ticks(20);
    assert.equal(h.source.stats().abandoned, 2);
    assert.deepEqual(opens(), [["open", 47, 0], ["open", 47, 0]]);
    passes[0].failure = new Error("EncodingError: Decoder failure");
    passes[0].wake();
    await ticks(20);
    await allow(passes[1], 41);
    const bitmap = await within(last, 2000, "need(47, 40)");
    assert.deepEqual([bitmap.cell, bitmap.j], [47, 40]);
    assert.equal(await within(first, 2000, "the first need"), bitmap, "the abandoned pass's failure rejected nobody");
    assert.equal(await retry, bitmap);
  } finally {
    h.source.destroy();
  }
  assert.deepEqual(h.converted, ["47:40"]);
});
