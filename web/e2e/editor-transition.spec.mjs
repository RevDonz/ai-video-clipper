// The Transisi section of the Cold open panel (docs/plans/2026-10-02-transisi-cold-open.md §7.1,
// §8 T3) against the editor fakes: every style and the whoosh switch send one command, and the
// real commands (web/lib/editor/commands.mjs) replay them in Node to the document the browser
// shows; with the cold open off (or read-only) the controls are disabled and point at the reason;
// keyboard (Tab into the group, arrows between styles, Space on the switch) with a visible focus
// ring; axe; "Putar transisi" seeks to J − ⌈fps⌉.
//
// Prerequisites (as web/e2e/editor-music.spec.mjs):
//   - a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1, E2E_USERNAME/E2E_PASSWORD;
//   - E2E_EDITOR_FAKES=1 to run the tests;
//   - AXE_CORE_PATH=<axe.min.js> for the axe test (axe-core is not a web dependency);
//   - optional: EDITOR_GATES_OUT=<dir> receives the axe result and screenshots of the section.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-transition.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { pieces } from "../lib/editor/timemap.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const gatesOut = process.env.EDITOR_GATES_OUT || "";

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

function axeSource() {
  const explicit = process.env.AXE_CORE_PATH;
  if (explicit && existsSync(explicit)) return readFileSync(explicit, "utf8");
  try {
    return readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
}

const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();
const AXE = axeSource();

function writeGate(name, value) {
  if (!gatesOut) return;
  mkdirSync(gatesOut, { recursive: true });
  writeFileSync(path.join(gatesOut, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function shot(locator, name) {
  if (!gatesOut) return;
  mkdirSync(gatesOut, { recursive: true });
  await locator.screenshot({ path: path.join(gatesOut, name) });
}

// The clip the tests open: the fakes' seed (no cold open) with a cold open set by the real
// SetColdOpen, so it carries the auto clips' transition (Kilat putih + whoosh).
const CTX = createContext({ words: fakeWords(), seed: fakeDoc() });
const START = applyCommand(fakeDoc(), "SetColdOpen", { firstWord: "w048127", lastWord: "w048132" }, CTX).doc;
const J = pieces(START).filter((piece) => piece.role === "cold_open").reduce((sum, piece) => sum + piece.frames, 0);
const SECOND = Math.ceil(START.output.fps[0] / START.output.fps[1]);
const NOTE_ON = "Efek di sambungan cold open ke awal klip. Durasi klip tetap.";
const NOTE_OFF = "Aktifkan cold open dulu.";
const NOTE_READ_ONLY = "Klip ini sedang dalam mode baca-saja";
const STYLES = [/Potong langsung/, /Kilat putih/, /Gelap sebentar/];

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript): a store that opens `config.doc` and
// applies the transition commands the way commands.mjs does (the replay test proves it), the
// fakes' preview client (its plan DTO carries `joins`), and a player that records its seeks.
function installTransitionScenario(config) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const seeks = [];
  window.__transitionSeeks = seeks;
  const reducers = {
    SetColdOpen(doc, args) {
      if (args !== null && args?.off !== true) throw new Error("this scenario only removes the cold open");
      const co = doc.main.segments.find((segment) => segment.role === "cold_open");
      if (!co) return;
      doc.main.segments = doc.main.segments.filter((segment) => segment !== co);
      doc.main.removals = doc.main.removals.filter((removal) => removal.seg !== co.id);
      doc.main.joins = [];
    },
    SetJoinStyle(doc, { style }) { doc.main.joins[0].style = style; },
    SetJoinSfx(doc, { on }) {
      if (on) doc.main.joins[0].sfx = { id: "whoosh", v: 1 };
      else delete doc.main.joins[0].sfx;
    },
  };

  function transitionStore(fakes, parts) {
    const listeners = new Set();
    const past = [];
    const future = [];
    let seq = 0;
    let state = { status: "loading", doc: null, seed: null, words: null, etag: null, revision: 0, save: "saved",
      savedAtMs: null, canUndo: false, canRedo: false, plan: null, pending: [], warnings: [], selection: null, commands: [],
      conflict: null, readOnlyReason: null };
    const set = (patch) => {
      state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
      for (const listener of [...listeners]) listener(state);
    };
    const replan = async (doc) => {
      const mine = ++seq;
      const dto = await parts.previewClient.plan(doc);
      if (mine === seq) set({ plan: dto, pending: [] });
    };
    const store = {
      getState: () => state,
      dispatch(type, args = {}, options = {}) {
        if (!fakes.COMMANDS.includes(type)) throw new fakes.CommandRejected("unknown_command");
        if (state.status !== "ready") throw new fakes.CommandRejected("read_only");
        const next = clone(state.doc);
        reducers[type]?.(next, clone(args));
        next.audit.last_command = type;
        past.push(state.doc);
        future.length = 0;
        set({ doc: next, save: "dirty", commands: [...state.commands, { type, args: clone(args), mergeKey: options.mergeKey ?? null }] });
        replan(next);
        return next;
      },
      undo() { if (!past.length) return; future.push(state.doc); const doc = past.pop(); set({ doc }); replan(doc); },
      redo() { if (!future.length) return; past.push(state.doc); const doc = future.pop(); set({ doc }); replan(doc); },
      async flush() { set({ save: "saved", savedAtMs: Date.now() }); },
      resolveConflict() {},
      startFromSeed() {},
      dismissNotice() {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() { listeners.clear(); },
    };
    (async () => {
      const edit = await parts.api.getEdit({ seed: false });
      const words = await parts.api.words(edit.words.url);
      const doc = config.doc ? clone(config.doc) : edit.doc;
      set({ status: config.readOnly ? "readOnly" : "ready", readOnlyReason: config.readOnly ? "transcript_changed" : null,
        doc, seed: clone(edit.doc), words, etag: edit.etag });
      await replan(doc);
    })();
    return store;
  }

  window.__potonginEditorScenario = {
    previewClient(client) { return client; },
    store(store, fakes, parts) { store.destroy(); return transitionStore(fakes, parts); },
    player(player) {
      const seek = player.seek.bind(player);
      player.seek = async (frame) => {
        seeks.push(frame);
        return seek(frame);
      };
      return player;
    },
  };
}

// ---------------------------------------------------------------------------------------------

const test = base.extend({
  workerStorageState: [async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: settings.baseURL });
    const page = await context.newPage();
    await login(page, "/projects");
    const state = await context.storageState();
    await context.close();
    await use(state);
  }, { scope: "worker" }],
  storageState: ({ workerStorageState }, use) => use(workerStorageState),
  page: async ({ page }, use, testInfo) => {
    const failures = { console: [], page: [], requests: [] };
    page.on("console", (message) => { if (message.type() === "error") failures.console.push(message.text()); });
    page.on("pageerror", (error) => failures.page.push(error.stack || error.message));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText || "failed";
      const benign = reason === "net::ERR_ABORTED" && ["media", "other", "document"].includes(request.resourceType());
      if (!benign) failures.requests.push(`${request.method()} ${request.url()} ${reason}`);
    });
    await use(page);
    const count = Object.values(failures).reduce((total, list) => total + list.length, 0);
    if (count) {
      if (testInfo.status === testInfo.expectedStatus) throw new Error(`Browser diagnostics:\n${JSON.stringify(failures, null, 2)}`);
      process.stderr.write(`Browser diagnostics for ${testInfo.title}:\n${JSON.stringify(failures, null, 2)}\n`);
    }
  },
});

test.use({
  launchOptions: chrome ? { executablePath: chrome } : {},
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});

async function openColdOpen(page, config = { doc: START }) {
  await page.addInitScript(installTransitionScenario, config);
  await page.goto(EDITOR);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Cold open" }).click();
  await expect(page.locator('[data-panel="coldopen"]')).toBeVisible();
}

const panel = (page) => page.locator('[data-panel="coldopen"]');
const section = (page) => panel(page).locator("[data-coldopen-transition]");
const note = (page) => section(page).locator("[data-transition-note]");
const statusLine = (page) => section(page).locator("[data-transition-status]");
const state = (page) => page.evaluate(() => {
  const current = window.__potonginEditor.store.getState();
  return { status: current.status, doc: current.doc, commands: current.commands, plan: current.plan };
});
const lastCommand = async (page) => (await state(page)).commands.at(-1);
const joinOf = async (page) => (await state(page)).doc.main.joins[0] ?? null;

/** The focused control draws a ring on itself, its card (label) or the switch track beside it. */
const focusRing = (page) => page.evaluate(() => {
  const element = document.activeElement;
  const drawn = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    return (style.outlineStyle !== "none" && style.outlineWidth !== "0px") || style.boxShadow !== "none";
  };
  return [element, element?.closest("label"), element?.nextElementSibling].some(drawn);
});

async function expectDisabled(page, reason) {
  await expect(note(page)).toHaveText(reason);
  const noteId = await note(page).getAttribute("id");
  expect(noteId).toBeTruthy();
  for (const name of STYLES) {
    const radio = section(page).getByRole("radio", { name });
    await expect(radio).toBeDisabled();
    await expect(radio).toHaveAttribute("aria-describedby", noteId);
    await expect(radio).toHaveAttribute("title", reason);
  }
  const whoosh = section(page).getByRole("switch", { name: "Suara whoosh" });
  await expect(whoosh).toBeDisabled();
  await expect(whoosh).toHaveAttribute("aria-describedby", noteId);
  return noteId;
}

async function axeViolations(page) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(() => window.axe.run("[data-coldopen-transition]", { resultTypes: ["violations"] }));
  return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length }));
}

// ---------------------------------------------------------------------------------------------

test.describe("Transisi in the Cold open panel on the fakes", () => {
  test.skip(process.env.E2E_EDITOR_FAKES !== "1",
    "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
  test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

  test("each style and the whoosh send one command; the real commands replay them to the browser's document", async ({ page }) => {
    await openColdOpen(page);
    await expect(section(page).getByRole("heading", { name: "Transisi" })).toBeVisible();
    await expect(note(page)).toHaveText(NOTE_ON);
    await expect(section(page).getByRole("group", { name: "Efek gambar" })).toBeVisible();
    await expect(section(page).getByRole("radio", { name: /Kilat putih/ })).toBeChecked();
    // The card's name carries its length, so a screen reader hears what each choice does.
    await expect(section(page).getByRole("radio", { name: /Kilat putih/ })).toHaveAccessibleName(/^Kilat putih\s*0,2 dtk$/);
    await expect(section(page).getByRole("radio", { name: /Gelap sebentar/ })).toHaveAccessibleName(/^Gelap sebentar\s*0,3 dtk$/);
    await expect(section(page).getByRole("radio", { name: /Potong langsung/ })).toHaveAccessibleName(/^Potong langsung\s*Tanpa efek$/);
    await expect(section(page).getByRole("switch", { name: "Suara whoosh" })).toBeChecked();
    // The cold-open note no longer claims a plain cut.
    await expect(panel(page).getByText("Potongan singkat (0,5–8 dtk) yang diputar lebih dulu, lalu klip mulai dari awal.", { exact: true }))
      .toBeVisible();
    await expect(panel(page).getByText(/potong langsung dengan fade audio/)).toHaveCount(0);

    const steps = [
      ["radio", /Gelap sebentar/, { type: "SetJoinStyle", args: { style: "dip_black" }, mergeKey: null }, "Transisi: Gelap sebentar."],
      ["radio", /Potong langsung/, { type: "SetJoinStyle", args: { style: "cut" }, mergeKey: null }, "Transisi: Potong langsung."],
      ["switch", "Suara whoosh", { type: "SetJoinSfx", args: { on: false }, mergeKey: null }, "Whoosh mati."],
      ["radio", /Kilat putih/, { type: "SetJoinStyle", args: { style: "flash_white" }, mergeKey: null }, "Transisi: Kilat putih."],
      ["switch", "Suara whoosh", { type: "SetJoinSfx", args: { on: true }, mergeKey: null }, "Whoosh aktif."],
      ["radio", /Gelap sebentar/, { type: "SetJoinStyle", args: { style: "dip_black" }, mergeKey: null }, "Transisi: Gelap sebentar."],
    ];
    for (const [role, name, command, status] of steps) {
      await section(page).getByRole(role, { name }).click();
      expect(await lastCommand(page)).toEqual(command);
      await expect(statusLine(page)).toHaveText(status);
      if (role === "radio") await expect(section(page).getByRole(role, { name })).toBeChecked();
    }
    await expect(section(page).getByRole("switch", { name: "Suara whoosh" })).toBeChecked();
    expect(await joinOf(page)).toEqual({ after: "seg_co", style: "dip_black", audio_fade_ms: 30, sfx: { id: "whoosh", v: 1 } });

    // The plan DTO follows the document: Gelap sebentar is 9 frames around J at 29.97 fps.
    await expect.poll(async () => (await state(page)).plan?.joins?.[0]?.style).toBe("dip_black");
    const { plan } = await state(page);
    expect(plan.joins[0]).toMatchObject({ after: "seg_co", atF: J, rgb: [0, 0, 0] });
    expect(plan.joins[0].alphaPm.map(([frame]) => frame)).toEqual([J - 4, J - 3, J - 2, J - 1, J, J + 1, J + 2, J + 3, J + 4]);
    expect(plan.joins[0].sfx).toMatchObject({ id: "whoosh", v: 1 });

    const browser = await state(page);
    expect(browser.commands).toHaveLength(steps.length);
    let doc = START;
    for (const command of browser.commands) doc = applyCommand(doc, command.type, command.args, CTX).doc;
    expect(doc.main).toEqual(browser.doc.main);
    // Duration and time map are untouched: the pieces are the ones the clip opened with.
    expect(pieces(doc)).toEqual(pieces(START));
  });

  test("with the cold open off, the section is disabled and says why", async ({ page }) => {
    await openColdOpen(page);
    await panel(page).getByRole("button", { name: "Hapus cold open" }).click();
    expect(await lastCommand(page)).toEqual({ type: "SetColdOpen", args: null, mergeKey: null });
    const noteId = await expectDisabled(page, NOTE_OFF);
    for (const name of STYLES) await expect(section(page).getByRole("radio", { name })).not.toBeChecked();
    await expect(section(page).getByRole("switch", { name: "Suara whoosh" })).not.toBeChecked();
    const play = section(page).getByRole("button", { name: "Putar transisi" });
    await expect(play).toBeDisabled();
    await expect(play).toHaveAttribute("aria-describedby", noteId);
    await expect(statusLine(page)).toHaveText("");
    // A clip that opens without a cold open says the same.
    await openColdOpen(page, { doc: null });
    await expectDisabled(page, NOTE_OFF);
  });

  test("a read-only clip shows its transition, cannot change it, and still plays it", async ({ page }) => {
    await openColdOpen(page, { doc: START, readOnly: true });
    await expectDisabled(page, NOTE_READ_ONLY);
    await expect(section(page).getByRole("radio", { name: /Kilat putih/ })).toBeChecked();
    await expect(section(page).getByRole("switch", { name: "Suara whoosh" })).toBeChecked();
    await expect(section(page).getByRole("button", { name: "Putar transisi" })).toBeEnabled();
  });

  test("keyboard: Tab into the group, arrows between the styles, Space on the switch, a ring on each", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openColdOpen(page);
    // Reach the control before the group by keyboard, so :focus-visible applies from the start.
    const remove = panel(page).getByRole("button", { name: "Hapus cold open" });
    await remove.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(remove).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(section(page).getByRole("radio", { name: /Kilat putih/ })).toBeFocused();
    expect(await focusRing(page)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect(section(page).getByRole("radio", { name: /Gelap sebentar/ })).toBeFocused();
    await expect(section(page).getByRole("radio", { name: /Gelap sebentar/ })).toBeChecked();
    expect(await focusRing(page)).toBe(true);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(section(page).getByRole("radio", { name: /Potong langsung/ })).toBeChecked();
    expect((await state(page)).commands.map((command) => command.args.style)).toEqual(["dip_black", "flash_white", "cut"]);
    await expect(statusLine(page)).toHaveText("Transisi: Potong langsung.");

    // The group is one tab stop: the next Tab is the switch.
    await page.keyboard.press("Tab");
    const whoosh = section(page).getByRole("switch", { name: "Suara whoosh" });
    await expect(whoosh).toBeFocused();
    expect(await focusRing(page)).toBe(true);
    await page.keyboard.press("Space");
    await expect(whoosh).not.toBeChecked();
    expect(await lastCommand(page)).toEqual({ type: "SetJoinSfx", args: { on: false }, mergeKey: null });
    await expect(statusLine(page)).toHaveText("Whoosh mati.");

    await page.keyboard.press("Tab");
    const play = section(page).getByRole("button", { name: "Putar transisi" });
    await expect(play).toBeFocused();
    expect(await focusRing(page)).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__transitionSeeks.at(-1))).toBe(J - SECOND);
    expect(await joinOf(page)).toEqual({ after: "seg_co", style: "cut", audio_fade_ms: 30 });
  });

  test("Putar transisi plays one second on each side of the join: it seeks to J − ⌈fps⌉", async ({ page }) => {
    await openColdOpen(page);
    const play = section(page).getByRole("button", { name: "Putar transisi" });
    await expect(play).toHaveAttribute("data-transition-audition", `${J - SECOND}-${J + SECOND}`);
    const before = await page.evaluate(() => window.__transitionSeeks.length);
    await play.click();
    await expect.poll(() => page.evaluate(() => window.__transitionSeeks.slice(before)), { timeout: 5000 }).toEqual([J - SECOND]);
    await expect(section(page).getByRole("button", { name: "Hentikan" })).toBeVisible();
    await section(page).getByRole("button", { name: "Hentikan" }).click();
    await expect(section(page).getByRole("button", { name: "Putar transisi" })).toBeVisible();
    // Playing is not an edit: no command was sent.
    expect((await state(page)).commands).toEqual([]);
  });

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    const size = `${viewport.width}x${viewport.height}`;
    test(`axe finds nothing in the section, on and off; no overflow at ${size}`, async ({ page }) => {
      test.skip(!AXE, "AXE_CORE_PATH=<axe.min.js> runs the axe check");
      await page.setViewportSize(viewport);
      await openColdOpen(page);
      const overflow = await panel(page).evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const box = await section(page).boundingBox();
      for (const name of STYLES) {
        const card = await section(page).getByRole("radio", { name }).boundingBox();
        expect(card.x).toBeGreaterThanOrEqual(box.x);
        expect(card.x + card.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
      await shot(section(page), `transisi-on-${size}.png`);
      const on = await axeViolations(page);
      await panel(page).getByRole("button", { name: "Hapus cold open" }).click();
      await expect(note(page)).toHaveText(NOTE_OFF);
      await shot(section(page), `transisi-off-${size}.png`);
      const off = await axeViolations(page);
      writeGate(`TR-T3-axe-${size}.json`, { gate: "axe (Transisi section)", viewport, on, off, pass: !on.length && !off.length });
      expect({ on, off }).toEqual({ on: [], off: [] });
    });
  }
});
