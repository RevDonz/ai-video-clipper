// Screenshots of the one-layout editor for the owner (rombak 06 §1.1, 08 Fase 10): full-page PNGs
// at 1366×768 and 1920×1080 of each panel tab as it opens, the transcript in Baris and a word
// selected with its toolbar. They land in EDITOR_GATES_OUT/screens-shell with a manifest, so a CI
// run uploads them as its artifact. Every shot also checks that the top bar, the stage, the
// transcript and the panel are on screen and that the page does not scroll sideways. The fake
// player draws no video, so the stage itself stays empty.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-shell-screens.spec.mjs'
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TAB_IDS, openPanel } from "./support/editor-panels.mjs";
import { expect, openShell, test, useShellDefaults } from "./support/editor-shell.mjs";

useShellDefaults();

const VIEWPORTS = [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }];
const REGIONS = ["topBar", "stage", "transcript", "panel"];
// A body word of the fakes' clip (support/click-budget.mjs BODY_WORD): a click selects it.
const BODY_WORD = 4;

function outDir() {
  const out = process.env.EDITOR_GATES_OUT;
  if (!out) return null;
  const dir = path.join(out, "screens-shell");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function shot(page, dir, manifest, name) {
  for (const slot of REGIONS) await expect(page.locator(`[data-slot="${slot}"]`), slot).toBeVisible();
  // The panels and the transcript load lazily: shoot them loaded.
  await expect(page.locator('[data-slot="transcript"] section[data-panel="transcript"]')).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-slot="panel"] section[data-panel]')).toHaveCount(1);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways, `${name}: the page scrolls sideways by ${sideways} px`).toBeLessThanOrEqual(0);
  // The status, its help and the stage toggles sit beside the 9:16 frame, never over the video,
  // and inside the stage (06 §3.1; editor-views checks the same for the two-view editor).
  const overlap = await page.evaluate(() => {
    const frame = document.querySelector('[data-slot="stage"] [data-stage="canvas"]').parentElement.getBoundingClientRect();
    const stage = document.querySelector('[data-slot="stage"]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-slot="stage"] [data-stage-overlay] :is(button, [data-testid="stage-badge"])')]
      .map((element) => ({ name: element.textContent.trim(), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0
        && (!(box.right <= frame.left + 0.5 || box.left >= frame.right - 0.5) || box.left < stage.left - 0.5 || box.right > stage.right + 0.5))
      .map(({ name }) => name);
  });
  expect(overlap, `${name}: stage overlays over the frame or outside the stage`).toEqual([]);
  if (!dir) return;
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(dir, file), fullPage: true, animations: "disabled" });
  manifest.push({ file, url: new URL(page.url()).search || "/" });
}

for (const viewport of VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;
  test.describe(`one-layout editor at ${size}`, () => {
    test.use({ viewport });

    test(`screens at ${size}: each tab, Baris and the word toolbar`, async ({ page }) => {
      test.setTimeout(120_000);
      const dir = outDir();
      const manifest = [];
      await openShell(page);
      for (const id of TAB_IDS) {
        await openPanel(page, id);
        await shot(page, dir, manifest, `${size}-tab-${id}`);
      }

      await openPanel(page, TAB_IDS[0]);
      const word = page.locator(`[data-slot="transcript"] [data-transcript-words] [data-w="${BODY_WORD}"]`);
      await word.click();
      await expect(page.locator('[data-slot="transcript"] [role="toolbar"]')).toBeVisible();
      await shot(page, dir, manifest, `${size}-word-toolbar`);

      await openShell(page, "?card=lines");
      await expect(page.locator('[data-slot="transcript"] [data-transcript-mode="lines"]')).toBeVisible();
      await shot(page, dir, manifest, `${size}-transcript-baris`);

      if (dir) writeFileSync(path.join(dir, `manifest-${size}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    });
  });
}
