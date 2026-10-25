// Pengaturan's one save bar (05-ui-dashboard.md §6.10): which tabs carry unsaved changes, the dirty
// cards saved one after another in page order, and a partial failure that names the first card
// that failed. Plus the hash of each tab, old anchors included (08 Fase 3: "Hash lama Pengaturan
// membuka tab yang benar").
import assert from "node:assert/strict";
import test from "node:test";

import { dirtyCards, dirtyTabs, saveDirtyCards, saveOutcome } from "../lib/settings-save-model.mjs";
import { SETTINGS_TABS, hashForTab, tabFromHash } from "../lib/settings-tabs.mjs";

const card = (id, tab, dirty, save = async () => ({ ok: true })) => ({ id, tab, dirty, save });

test("the tabs are AI, Transkripsi, Tampilan, YouTube and Sistem, in that order, with no Akun tab", () => {
  assert.deepEqual(SETTINGS_TABS, ["ai", "transkripsi", "tampilan", "youtube", "sistem"]);
  assert.ok(!SETTINGS_TABS.includes("akun"));
  assert.ok(Object.isFrozen(SETTINGS_TABS));
});

test("every old anchor of the page opens its tab", () => {
  for (const id of SETTINGS_TABS) {
    assert.equal(tabFromHash(`#${id}`), id);
    assert.equal(tabFromHash(id), id, "without the #");
    assert.equal(hashForTab(id), `#${id}`);
  }
  // A provider card's anchor (#provider-openrouter) lived in the AI part of the page.
  assert.equal(tabFromHash("#provider-openrouter"), "ai");
  assert.equal(tabFromHash("#provider-custom2"), "ai");
  assert.equal(tabFromHash("#AI"), "ai", "case does not matter");
  assert.equal(tabFromHash("#tampilan%20"), "tampilan", "an encoded space is trimmed");
});

test("no hash, an unknown hash or a hidden tab's hash falls back to the first tab shown", () => {
  for (const hash of ["", "#", "#akun", "#nope", null, undefined, "#%E0%A4%A"]) assert.equal(tabFromHash(hash), "ai", String(hash));
  // A member without the AI tab (Fase 5) lands on the first tab they have.
  const shown = ["transkripsi", "tampilan"];
  assert.equal(tabFromHash("#ai", shown), "transkripsi");
  assert.equal(tabFromHash("#provider-groq", shown), "transkripsi");
  assert.equal(tabFromHash("#tampilan", shown), "tampilan");
  assert.equal(hashForTab("nope"), null);
});

test("a tab is dirty while one of its cards is", () => {
  const cards = [card("llm", "ai", false), card("transcription", "transkripsi", true), card("watermark", "tampilan", true), card("logo", "tampilan", false)];
  assert.deepEqual([...dirtyTabs(cards)], ["transkripsi", "tampilan"]);
  assert.deepEqual([...dirtyTabs([])], []);
  assert.deepEqual([...dirtyTabs(cards.map((item) => ({ ...item, dirty: false })))], []);
});

test("the dirty cards come in page order: by tab, then in the order they were registered", () => {
  const cards = [card("watermark", "tampilan", true), card("transcription", "transkripsi", true), card("llm", "ai", true), card("cookies", "youtube", false), card("logo2", "tampilan", true)];
  assert.deepEqual(dirtyCards(cards).map((item) => item.id), ["llm", "transcription", "watermark", "logo2"]);
  // A card on a tab the page does not know goes last.
  assert.deepEqual(dirtyCards([card("x", "elsewhere", true), card("llm", "ai", true)]).map((item) => item.id), ["llm", "x"]);
});

test("Simpan saves the dirty cards one after another, never two at once", async () => {
  const log = [];
  let running = 0;
  const slow = (id) => async () => {
    running += 1;
    assert.equal(running, 1, `${id} started while another save ran`);
    log.push(`start ${id}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    log.push(`end ${id}`);
    running -= 1;
    return { ok: true };
  };
  const cards = [card("watermark", "tampilan", true, slow("watermark")), card("llm", "ai", true, slow("llm")), card("clean", "ai", false, slow("clean"))];
  const started = [];
  const result = await saveDirtyCards(cards, { onCard: (item) => started.push(item.id) });
  assert.deepEqual(log, ["start llm", "end llm", "start watermark", "end watermark"]);
  assert.deepEqual(started, ["llm", "watermark"]);
  assert.deepEqual(result, { saved: ["llm", "watermark"], failed: [] });
});

test("a failed card does not stop the others, and a throw counts as a failure", async () => {
  const cards = [
    card("llm", "ai", true, async () => ({ ok: false })),
    card("transcription", "transkripsi", true, async () => { throw new Error("offline"); }),
    card("watermark", "tampilan", true),
  ];
  const result = await saveDirtyCards(cards);
  assert.deepEqual(result.saved, ["watermark"]);
  assert.deepEqual(result.failed, [{ id: "llm", tab: "ai" }, { id: "transcription", tab: "transkripsi" }]);
  assert.deepEqual(saveOutcome(result), { kind: "partial", failedCount: 2, first: { id: "llm", tab: "ai" } });
});

test("the outcome says saved, failed or nothing to save", () => {
  assert.deepEqual(saveOutcome({ saved: ["llm"], failed: [] }), { kind: "saved", failedCount: 0, first: null });
  assert.deepEqual(saveOutcome({ saved: [], failed: [{ id: "llm", tab: "ai" }] }), { kind: "partial", failedCount: 1, first: { id: "llm", tab: "ai" } });
  assert.deepEqual(saveOutcome({ saved: [], failed: [] }), { kind: "none", failedCount: 0, first: null });
});

test("a card with nothing to save is not called", async () => {
  let called = false;
  const result = await saveDirtyCards([card("llm", "ai", false, async () => { called = true; return { ok: true }; })]);
  assert.equal(called, false);
  assert.deepEqual(result, { saved: [], failed: [] });
});
