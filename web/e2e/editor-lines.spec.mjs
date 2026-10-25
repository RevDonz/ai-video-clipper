// Baris, the caption lines of the transcript in the one-layout editor (rombak 06 §6, §10 #24;
// 08 Fase 10 Editor F2), on the editor fakes. It takes over editor-quick-lines.spec.mjs, the
// Mode Cepat card's spec, once the old shell goes (F10): one field per caption line, Enter or
// blur commits as word edits (one Urungkan per line), a deleted word is only hidden from the
// caption and its line says so, Esc restores, and the line under the playhead is marked. The page
// runs the real store over a fake server kept in localStorage, and the fakes' engine-like cues.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-lines.spec.mjs'
import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { formatClock, frameToMs } from "../components/editor/shell-model.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { LINE_MESSAGES, captionRows } from "../lib/editor/caption-lines.mjs";
import { expect, test, useShellDefaults } from "./support/editor-shell.mjs";
import { L } from "./support/i18n.mjs";

useShellDefaults();

const EDIT_PATH = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const WORDS = fakeWords();
const ID = WORDS.words.map((word) => word.id); // ID[0] "Kenapa" … ID[11] "subuh"
const rowsOf = (doc) => captionRows({ plan: fakePlan(doc), doc, words: WORDS, model: buildTranscriptModel(WORDS, doc) });
const key = (index, seg = "seg_b1") => `${seg}:${ID[index]}`;

// Browser side (serialised by addInitScript; self-contained): the one-layout shell, one fake
// server in localStorage, and the real store over the fakes.
function installLinesScenario(config) {
  const SERVER = "potongin-e2e-lines-view-server";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  window.__potonginEditorScenario = {
    shell: "v2",
    api(api, fakes) {
      const read = () => JSON.parse(window.localStorage.getItem(SERVER) ?? "null");
      const write = (value) => window.localStorage.setItem(SERVER, JSON.stringify(value));
      if (!read()) {
        const seed = fakes.fakeDoc();
        const etag = fakes.fakeSha256(JSON.stringify(seed));
        write({ seed, seedEtag: etag, doc: seed, etag, receipts: {} });
      }
      return {
        ...api,
        async getEdit({ seed: wantSeed = false } = {}) {
          const server = read();
          const isSeed = wantSeed || server.doc.revision === 0;
          return {
            doc: clone(isSeed ? server.seed : server.doc), etag: isSeed ? server.seedEtag : server.etag, seed: isSeed,
            words: { sha256: server.seed.base.words.sha256, url: `/api/jobs/${fakes.FAKE_JOB_ID}/clips/${fakes.FAKE_CLIP_ID}/words` },
            readOnly: config.readOnly === true, readOnlyReason: config.readOnly === true ? "transcript_changed" : null,
          };
        },
        async putEdit(next, { etag, key: receipt }) {
          const server = read();
          if (server.receipts[receipt]) return clone(server.receipts[receipt]);
          if (etag !== server.etag || next.revision !== server.doc.revision + 1 || next.parent_sha256 !== server.etag) {
            throw new fakes.FakeApiError(409, "revision_conflict", { current: clone(server.doc), etag: server.etag });
          }
          const doc = clone(next);
          const result = { doc, etag: fakes.fakeSha256(JSON.stringify(doc)), warnings: [] };
          write({ ...server, doc, etag: result.etag, receipts: { ...server.receipts, [receipt]: result } });
          return clone(result);
        },
      };
    },
    store(store, fakes, parts) {
      store.destroy();
      // A long autosave keeps the pending steps inspectable.
      return fakes.createRealEditorStore({ ...parts, autosave: { debounceMs: 600_000, maxIntervalMs: 600_000 } });
    },
  };
}

const transcript = (page) => page.locator('[data-slot="transcript"]');
const lines = (page) => transcript(page).locator("[data-caption-lines]");
const mode = (page, id) => transcript(page).getByRole("radiogroup", { name: L("editor.transcript.modeLabel") })
  .getByRole("radio", { name: L(`editor.transcript.modes.${id}`), exact: true });
const field = (page, rowKey) => lines(page).locator(`[data-line-key="${rowKey}"] input`);
const lineKeys = (page) => lines(page).locator("[data-line-key]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-line-key")));
const lineTexts = (page) => lines(page).locator("[data-line-key] input").evaluateAll((inputs) => inputs.map((input) => input.value));
const editor = (page) => page.evaluate(() => {
  const state = window.__potonginEditor.store.getState();
  return { canUndo: state.canUndo, edits: state.doc.captions.word_edits, cues: state.plan?.cues.map((cue) => cue.text) ?? [] };
});
// Urungkan, by its shortcut (its name moves to the catalog with i18n M8a).
const undoButton = (page) => page.locator('[data-slot="topBar"] button[aria-keyshortcuts="Control+Z"]');

/** Opens the editor in Baris: from the transcript's Kata | Baris, or through the old ?card=lines link. */
async function openLines(page, { via = "toggle", ...config } = {}) {
  await page.addInitScript(installLinesScenario, config);
  await page.goto(via === "link" ? `${EDIT_PATH}?card=lines` : EDIT_PATH);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  if (via !== "link") await mode(page, "lines").click();
  await expect(mode(page, "lines")).toBeChecked();
  await expect(lines(page).locator("[data-line-key]").first()).toBeVisible();
}

async function commitLine(page, rowKey, text, keyName = "Enter") {
  const input = field(page, rowKey);
  await input.click();
  await input.fill(text);
  await input.press(keyName);
}

test("one field per caption line of the plan, labelled by its time, with the help line", async ({ page }) => {
  await openLines(page);
  const rows = rowsOf(fakeDoc());
  const fps = fakeDoc().output.fps;
  expect(await lineKeys(page)).toEqual(rows.map((row) => row.key));
  expect(await lineTexts(page)).toEqual(rows.map((row) => row.text));
  for (const row of rows) {
    const input = lines(page).getByLabel(formatClock(frameToMs(row.f0, fps)), { exact: true });
    await expect(input).toHaveValue(row.text);
    await expect(input).toHaveAttribute("maxlength", "160");
  }
  await expect(lines(page).getByText(L("editor.transcript.lines.help"), { exact: true })).toBeVisible();
});

test("the old ?card=lines link lands in Baris and the address keeps only the tab", async ({ page }) => {
  await openLines(page, { via: "link" });
  await expect(page).toHaveURL(/\?panel=text$/);
});

test("fix one word and Enter: the caption shows it, and one Urungkan takes the line back", async ({ page }) => {
  await openLines(page);
  await commitLine(page, key(0), "Kenapa sutradaranya ditahan di");
  await expect.poll(async () => (await editor(page)).cues[0]).toBe("Kenapa sutradaranya ditahan di");
  expect((await editor(page)).edits).toEqual({ [ID[1]]: { text: "sutradaranya" } });
  await expect(field(page, key(0))).toBeFocused();
  await undoButton(page).click();
  await expect.poll(async () => (await editor(page)).edits).toEqual({});
  expect((await editor(page)).canUndo).toBe(false);
  await expect(field(page, key(0))).toHaveValue("Kenapa sutradara ditahan di");
});

test("a word deleted in Baris is only hidden from the caption, and its line says Disembunyikan", async ({ page }) => {
  await openLines(page);
  await commitLine(page, key(6), "Jadi itu kita");
  await expect.poll(async () => (await editor(page)).edits[ID[7]]).toEqual({ hidden: true });
  const row = lines(page).locator(`[data-line-key="${key(6)}"]`);
  await expect(row.locator("[data-line-hidden]")).toHaveText(L("editor.transcript.lines.hidden"));
  // The hidden word shifts the 4-word groups after it, so the line takes in "datang"; retyping the
  // word brings it back and the mark goes with it.
  await expect.poll(() => lineTexts(page)).toContain("Jadi itu kita datang");
  await commitLine(page, key(6), "Jadi waktu itu kita datang");
  await expect.poll(async () => (await editor(page)).edits).toEqual({});
  await expect(row.locator("[data-line-hidden]")).toHaveCount(0);
  // The word list shows the same word hidden, not cut (the sound stays).
  await commitLine(page, key(6), "Jadi itu kita");
  await expect.poll(async () => (await editor(page)).edits[ID[7]]).toEqual({ hidden: true });
  await mode(page, "words").click();
  const word = transcript(page).locator(`[data-word-id="${ID[7]}"]`);
  await expect(word).toHaveAttribute("data-hidden", /.*/);
  await expect(word).not.toHaveAttribute("data-removed", /.*/);
});

test("an empty line leaves the caption; the status says so and one Urungkan brings it back", async ({ page }) => {
  await openLines(page);
  await commitLine(page, key(10), "");
  await expect(lines(page).locator(`[data-line-key="${key(10)}"]`)).toHaveCount(0);
  await expect(lines(page).getByRole("status").filter({ hasText: L("editor.transcript.lines.rowHidden") })).toBeVisible();
  await undoButton(page).click();
  await expect(field(page, key(10))).toHaveValue("datang subuh");
});

test("a refusal keeps the draft and marks the field; Esc restores the line", async ({ page }) => {
  await openLines(page);
  const input = field(page, key(0));
  const draft = "Kenapa sutradara ditahan di satu dua tiga empat lima enam tujuh delapan";
  await commitLine(page, key(0), draft);
  await expect(lines(page).getByRole("alert")).toHaveText(LINE_MESSAGES.text_too_long);
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveValue(draft);
  await input.press("Escape");
  await expect(input).toHaveValue("Kenapa sutradara ditahan di");
  await expect(lines(page).getByRole("alert")).toHaveCount(0);
});

test("focusing a line seeks the paused preview to it, and the line under the playhead is marked", async ({ page }) => {
  await openLines(page);
  const rows = rowsOf(fakeDoc());
  await field(page, rows[2].key).focus();
  await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame())).toBe(rows[2].f0);
  await expect(lines(page).locator(`[data-line-key="${rows[2].key}"]`)).toHaveAttribute("data-current", "true");
  await expect(lines(page).locator('[data-current="true"]')).toHaveCount(1);
});

test("read-only: the fields cannot be typed in", async ({ page }) => {
  await openLines(page, { readOnly: true });
  await expect(field(page, key(0))).toHaveAttribute("readonly", "");
});

test("captions off: Baris says where to turn them on", async ({ page }) => {
  await openLines(page);
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await expect(lines(page).getByText(L("editor.transcript.lines.captionsOff"), { exact: true })).toBeVisible();
});
