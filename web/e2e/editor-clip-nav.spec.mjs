// "Klip 3/8 ‹ ›" in the editor's top bar (web/lib/editor/clip-nav.mjs) on the editor fakes: the
// count and the two buttons with their names, ends and keyboard; the save that finishes before
// the editor opens the neighbour in the same view (with Lengkap's panel or Cepat's open card); a
// failed save or a conflict that keeps the editor on the clip with the existing error UI; and the
// top bar still on one 64 px row of 44 px targets with the group in it.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-clip-nav.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { login, settings } from "./support/harness.mjs";

// Eight clips; the fakes' clip is number `at`, the others get ids of their own.
const otherId = (n) => `clip_${"0".repeat(23)}${n}`;
function listing(at) {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    clipId: n === at ? FAKE_CLIP_ID : otherId(n), index: n, title: `Klip nomor ${n}`, openable: true, reason: null,
  }));
}
const editorPath = (clipId) => `/projects/${FAKE_JOB_ID}/clips/${clipId}/edit`;
const LOG_KEY = "__clipNavLog";

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}
const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();

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
      // Leaving a clip is what these tests do, and leaving aborts whatever the page was still loading.
      const benign = reason === "net::ERR_ABORTED";
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
  viewport: { width: 1366, height: 650 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

// Browser side (serialised by addInitScript, so self-contained; it runs again on every page the
// test opens). `clips` replaces the listing; `save` is "ok" (the fakes' store, its save held at
// "Menyimpan…" for `saveMs` through a slow plan and logged in sessionStorage), "fails" or
// "conflict" (a small store whose flush ends that way, as the real store does: the state first,
// then a rejection).
function installNavScenario(config) {
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const log = (entry) => {
    const list = JSON.parse(window.sessionStorage.getItem(config.logKey) || "[]");
    list.push({ ...entry, at: window.location.pathname });
    window.sessionStorage.setItem(config.logKey, JSON.stringify(list));
  };

  function endingStore(fakes, parts) {
    const listeners = new Set();
    let state = { status: "loading", doc: null, seed: null, words: null, etag: null, revision: null, save: "saved",
      savedAtMs: null, canUndo: false, canRedo: false, plan: null, pending: [], warnings: [], selection: null,
      commands: [], conflict: null, notice: null, otherTab: false, readOnlyReason: null, error: null };
    const set = (patch) => {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state);
    };
    const store = {
      getState: () => state,
      dispatch(type, args = {}) {
        if (!fakes.COMMANDS.includes(type)) throw new fakes.CommandRejected("unknown_command");
        if (state.status !== "ready") throw new fakes.CommandRejected("not_ready");
        const next = JSON.parse(JSON.stringify(state.doc));
        next.audit.last_command = type;
        set({ doc: next, save: "dirty", commands: [...state.commands, { type, args, mergeKey: null }] });
        return next;
      },
      undo() {},
      redo() {},
      async flush() {
        if (state.save === "conflict") throw new fakes.CommandRejected("conflict_unresolved");
        if (state.save !== "dirty" && state.save !== "error") return state.etag;
        set({ save: "saving" });
        await wait(config.saveMs);
        if (config.save === "fails") {
          set({ save: "error", error: { code: "backend_unavailable", message: "Gagal menyimpan; perubahan aman di browser ini", retrying: true } });
          throw Object.assign(new Error("save failed"), { status: 503, code: "backend_unavailable" });
        }
        set({ save: "conflict", conflict: { groups: [{ id: "hook", label: "Teks hook", parts: ["hook"], mine: "Punyaku", theirs: "Tersimpan" }], error: null } });
        throw Object.assign(new Error("revision conflict"), { status: 409, code: "revision_conflict" });
      },
      async resolveConflict() { set({ conflict: null, save: "dirty" }); },
      async startFromSeed() {},
      retrySave() {},
      setSelection(selection) { set({ selection }); },
      dismissNotice() { set({ notice: null }); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() { listeners.clear(); },
    };
    (async () => {
      const edit = await parts.api.getEdit({ seed: false });
      const words = await parts.api.words(edit.words.url);
      const plan = await parts.previewClient.plan(edit.doc);
      set({ status: "ready", doc: edit.doc, seed: JSON.parse(JSON.stringify(edit.doc)), words, etag: edit.etag,
        revision: edit.doc.revision, plan, savedAtMs: Date.now() });
    })();
    return store;
  }

  window.__potonginEditorScenario = {
    api(api) {
      if (!config.clips) return api;
      return {
        ...api,
        async clips() {
          const [model] = (await api.clips()).clips;
          return { clips: config.clips.map((clip) => ({ ...model, ...clip })) };
        },
      };
    },
    // The fakes' store saves "saving" first and "saved" once the new plan is in.
    previewClient(client) {
      return {
        ...client,
        async plan(doc) {
          if (window.__clipNavSaving) await wait(config.saveMs);
          return client.plan(doc);
        },
      };
    },
    store(store, fakes, parts) {
      if (config.save !== "ok") {
        store.destroy();
        return endingStore(fakes, parts);
      }
      return {
        ...store,
        async flush() {
          const pending = store.getState().save === "dirty";
          window.__clipNavSaving = pending;
          try {
            const result = await store.flush();
            if (pending) log({ saved: true });
            return result;
          } finally {
            window.__clipNavSaving = false;
          }
        },
      };
    },
  };
}

async function openEditor(page, target, { at = 3, save = "ok", saveMs = 400, clips = listing(at) } = {}) {
  await page.addInitScript(installNavScenario, { clips, save, saveMs, logKey: LOG_KEY });
  await page.goto(target);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

const bar = (page) => page.locator('[data-slot="topBar"]');
const navGroup = (page) => bar(page).getByRole("group", { name: "Pindah klip" });
// The visible "Klip 3/8" (screen readers get "Klip 3 dari 8" instead).
const countText = (page) => navGroup(page).locator('span[aria-hidden="true"]');
const previousButton = (page) => navGroup(page).getByRole("button", { name: "Klip sebelumnya" });
const nextButton = (page) => navGroup(page).getByRole("button", { name: "Klip berikutnya" });
const savedLog = (page) => page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || "[]"), LOG_KEY);
const makeDirty = (page) => page.evaluate(() => { window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }); });

test("'Klip 3/8' with ‹ and › beside '← Proyek': names, shortcuts and the clip count for screen readers", async ({ page }) => {
  await openEditor(page, `${editorPath(FAKE_CLIP_ID)}?mode=lengkap`);
  const group = navGroup(page);
  await expect(group).toBeVisible();
  await expect(countText(page)).toHaveText("Klip 3/8");
  await expect(group).toContainText("Klip 3 dari 8");
  await expect(previousButton(page)).toBeEnabled();
  await expect(nextButton(page)).toBeEnabled();
  await expect(previousButton(page)).toHaveAttribute("aria-keyshortcuts", "Control+Shift+ArrowLeft");
  await expect(nextButton(page)).toHaveAttribute("aria-keyshortcuts", "Control+Shift+ArrowRight");
  await expect(previousButton(page)).toHaveAttribute("title", "Klip sebelumnya (Ctrl+Shift+←)");
  // Tab order follows the bar: "← Proyek", ‹, ›, then the rest.
  await bar(page).getByRole("link", { name: "← Proyek" }).focus();
  await page.keyboard.press("Tab");
  await expect(previousButton(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(nextButton(page)).toBeFocused();
  expect(await nextButton(page).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
});

test("‹ is off on the first clip and › on the last; a project with one clip shows no clip buttons", async ({ page }) => {
  await openEditor(page, `${editorPath(FAKE_CLIP_ID)}?mode=lengkap`, { at: 1 });
  await expect(countText(page)).toHaveText("Klip 1/8");
  await expect(previousButton(page)).toBeDisabled();
  await expect(nextButton(page)).toBeEnabled();
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname, "no clip before the first").toBe(editorPath(FAKE_CLIP_ID));

  const last = await page.context().newPage();
  await openEditor(last, `${editorPath(FAKE_CLIP_ID)}?mode=lengkap`, { at: 8 });
  await expect(countText(last)).toHaveText("Klip 8/8");
  await expect(nextButton(last)).toBeDisabled();
  await expect(previousButton(last)).toBeEnabled();
  await last.close();

  const single = await page.context().newPage();
  await openEditor(single, `${editorPath(FAKE_CLIP_ID)}?mode=lengkap`, { clips: null });
  await expect(bar(single).getByRole("group", { name: "Pindah klip" })).toHaveCount(0);
  await single.close();
});

test("› saves first, then opens the next clip in Lengkap with the same panel; Back returns to this clip", async ({ page }) => {
  await openEditor(page, `${editorPath(FAKE_CLIP_ID)}?mode=lengkap&panel=text`, { saveMs: 800 });
  await page.evaluate((key) => window.sessionStorage.removeItem(key), LOG_KEY);
  await makeDirty(page);
  await expect(page.getByTestId("save-status")).toHaveText("Belum tersimpan");
  await nextButton(page).click();
  await expect(page.getByTestId("save-status")).toHaveText("Menyimpan…");
  await expect(navGroup(page)).toHaveAttribute("aria-busy", "true");
  expect(new URL(page.url()).pathname, "still here while the save runs").toBe(editorPath(FAKE_CLIP_ID));
  await page.waitForURL((url) => url.pathname === editorPath(otherId(4)));
  expect(new URL(page.url()).search).toBe("?mode=lengkap&panel=text");
  expect(await savedLog(page)).toEqual([{ saved: true, at: editorPath(FAKE_CLIP_ID) }]);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(countText(page)).toHaveText("Klip 4/8");
  await expect(page.locator("[data-editor-root]")).toHaveAttribute("data-editor-view", "lengkap");
  await expect(page.locator("#editor-tab-text")).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(countText(page)).toHaveText("Klip 3/8");
});

test("Ctrl+Shift+← in Cepat opens the previous clip with the open card; nothing to save means no wait", async ({ page }) => {
  await openEditor(page, `${editorPath(FAKE_CLIP_ID)}?mode=cepat`);
  await openCard(page, "coldopen");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await page.waitForURL((url) => url.pathname === editorPath(otherId(2)));
  expect(new URL(page.url()).search).toBe("?mode=cepat&card=coldopen");
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#card-coldopen-button")).toHaveAttribute("aria-expanded", "true");
  await expect(countText(page)).toHaveText("Klip 2/8");
});

test("a failed save keeps the editor on the clip with 'Gagal menyimpan' and 'Coba simpan lagi'", async ({ page }) => {
  await openEditor(page, `${editorPath(FAKE_CLIP_ID)}?mode=lengkap`, { save: "fails", saveMs: 200 });
  await makeDirty(page);
  await nextButton(page).click();
  await expect(page.getByTestId("save-status")).toHaveText("Gagal menyimpan; perubahan aman di browser ini");
  await expect(bar(page).getByRole("button", { name: "Coba simpan lagi" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Perubahan belum tersimpan, jadi Anda tetap di klip ini. Coba simpan lagi." }))
    .toBeVisible();
  await page.waitForTimeout(1000);
  expect(new URL(page.url()).pathname).toBe(editorPath(FAKE_CLIP_ID));
  expect(await page.evaluate(() => window.__potonginEditor.store.getState().commands.length), "the edit is kept").toBe(1);
  await expect(nextButton(page)).toBeEnabled();
  await expect(navGroup(page)).toHaveAttribute("aria-busy", "false");
});

test("a conflict keeps the editor on the clip and opens the conflict dialog", async ({ page }) => {
  await openEditor(page, `${editorPath(FAKE_CLIP_ID)}?mode=lengkap`, { save: "conflict", saveMs: 200 });
  await makeDirty(page);
  await nextButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Klip ini diubah di tab lain" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText("Konflik");
  await page.waitForTimeout(1000);
  expect(new URL(page.url()).pathname).toBe(editorPath(FAKE_CLIP_ID));
  // While the dialog is open the clip keys do nothing either.
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe(editorPath(FAKE_CLIP_ID));
});

for (const viewport of [{ width: 1366, height: 650 }, { width: 1920, height: 960 }]) {
  test(`at ${viewport.width}×${viewport.height} the top bar keeps every control on one 64 px row of 44 px targets, the clip buttons too`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openEditor(page, `${editorPath(FAKE_CLIP_ID)}?mode=cepat`);
    await expect(navGroup(page)).toBeVisible();
    const report = await bar(page).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll("a[href], button, [role='radiogroup']")].filter((control) => control.getClientRects().length > 0);
      const name = (control) => control.getAttribute("aria-label") || control.textContent.trim();
      return {
        height: box.height,
        outside: controls.filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5 || rect.right > box.right + 0.5;
        }).map(name),
        small: [...element.querySelectorAll("a[href], button")].filter((control) => control.getClientRects().length > 0)
          .filter((control) => {
            const rect = control.getBoundingClientRect();
            return rect.width < 43.5 || rect.height < 43.5;
          }).map(name),
      };
    });
    expect(report.height).toBe(64);
    expect(report.outside).toEqual([]);
    expect(report.small).toEqual([]);
    const back = await bar(page).getByRole("link", { name: "← Proyek" }).boundingBox();
    const group = await navGroup(page).boundingBox();
    const title = await bar(page).getByRole("heading", { level: 1 }).boundingBox();
    expect(group.x).toBeGreaterThanOrEqual(back.x + back.width);
    expect(title.x).toBeGreaterThanOrEqual(group.x + group.width);
  });
}
