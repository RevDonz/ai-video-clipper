// The one-layout editor (rombak 06, Editor F1) on the editor fakes, for its specs: a logged-in test
// that fails on any console error, page error or failed request, and openShell(), which picks the
// new shell through the fakes' scenario hook (the server's POTONGIN_EDITOR_SHELL stays legacy for
// the other specs) and can give the clip neighbours or plan warnings.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1.
import { expect, test as base } from "@playwright/test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../../components/editor/__dev__/fakes.mjs";
import { login, settings } from "./harness.mjs";

export { expect };

export const SHELL_PATH = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
export const clipPath = (clipId) => `/projects/${FAKE_JOB_ID}/clips/${clipId}/edit`;
/** The id of clip number `n` of a scenario listing that is not the fakes' own clip. */
export const otherClipId = (n) => `clip_${"0".repeat(23)}${n}`;

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

export const test = base.extend({
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
      // Leaving a clip aborts what the page was still loading; media and documents may abort too.
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

const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();

/** The spec-wide settings: Chrome when installed, 1366×768, the fakes and credentials required. */
export function useShellDefaults() {
  test.use({
    launchOptions: chrome ? { executablePath: chrome } : {},
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
  });
  test.skip(process.env.E2E_EDITOR_FAKES !== "1",
    "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
  test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");
}

// Browser side (serialised by addInitScript, so self-contained; it runs on every page the test
// opens): the shell to show, the clips listing (`clips` clips, the fakes' clip as number `at`)
// and extra plan warnings.
function installShellScenario(config) {
  window.__potonginEditorScenario = {
    shell: config.shell,
    api(api) {
      if (!config.clips) return api;
      return {
        ...api,
        async clips() {
          const [model] = (await api.clips()).clips;
          const list = [];
          for (let n = 1; n <= config.clips; n += 1) {
            const clipId = n === config.at ? model.clipId : `clip_${"0".repeat(23)}${n}`;
            list.push({ ...model, clipId, index: n, title: `Klip nomor ${n}`, durationMs: 10000 + n * 1000,
              edit: n === 2 ? { ...model.edit, state: "edited" } : model.edit });
          }
          return { clips: list };
        },
      };
    },
    previewClient(client) {
      if (!config.planWarnings) return client;
      return {
        ...client,
        async plan(doc) {
          const dto = await client.plan(doc);
          dto.warnings = config.planWarnings;
          return dto;
        },
      };
    },
  };
}

// The controls of the stage and the shortcut dialog keep their names in the components until
// i18n M8a moves them to the catalog; the specs reach them here.
/** The play button of the stage while it shows "Putar" (`playing: false`) or "Jeda". */
export function playButton(page, { playing = false } = {}) {
  return page.locator('[data-slot="stage"]').getByRole("button", { name: playing ? "Jeda" : "Putar", exact: true });
}

/** The "Pintasan keyboard" dialog. */
export function shortcutDialog(page) {
  return page.getByRole("dialog", { name: "Pintasan keyboard" });
}

/** Its "Tutup" button. */
export function closeShortcutDialog(page) {
  return shortcutDialog(page).getByRole("button", { name: "Tutup", exact: true });
}

/**
 * Opens the editor at `SHELL_PATH + query` in the new shell (`shell: "legacy"` for the old one)
 * and waits until it is ready.
 */
export async function openShell(page, query = "", { shell = "v2", clips = null, at = 1, planWarnings = null, path: where = SHELL_PATH } = {}) {
  await page.addInitScript(installShellScenario, { shell, clips, at, planWarnings });
  await page.goto(`${where}${query}`);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
}
