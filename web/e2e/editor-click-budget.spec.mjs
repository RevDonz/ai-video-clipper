// The click budget of rombak 06 §2.3 and §10 in the one-layout editor: for every row of the
// table in support/click-budget.mjs, from the editor as it opens (tab Teks), the counted clicks
// reach the row's control, which is then visible, within the row's budget. A row whose control
// moves in a later sub-phase is walked where it sits today; one that cannot be walked yet is
// listed as fixme with that phase and the reason (`gap`).
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-click-budget.spec.mjs'
import { CLICK_BUDGET, clickCount } from "./support/click-budget.mjs";
import { expect, openShell, test, useShellDefaults } from "./support/editor-shell.mjs";
import { shellDoc } from "./support/shell-docs.mjs";

useShellDefaults();

const SCOPES = Object.freeze({
  topBar: (page) => page.locator('[data-slot="topBar"]'),
  clips: (page) => page.locator('[data-slot="clips"]'),
  stage: (page) => page.locator('[data-slot="stage"]'),
  transcript: (page) => page.locator('[data-slot="transcript"]'),
  timeline: (page) => page.locator('[data-slot="timeline-detail"]'),
  panel: (page) => page.locator('[data-slot="panel"]'),
  menu: (page) => page.getByRole("menu"),
  dialog: (page) => page.getByRole("dialog"),
});

function locate(page, descriptor) {
  const scope = SCOPES[descriptor.within](page);
  if (descriptor.testId) return scope.getByTestId(descriptor.testId);
  if (Object.hasOwn(descriptor, "word")) return scope.locator(`[data-transcript-words] [data-w="${descriptor.word}"]`);
  const name = descriptor.regex ? new RegExp(descriptor.name) : descriptor.name;
  const found = scope.getByRole(descriptor.role, { name, exact: descriptor.regex ? undefined : descriptor.exact ?? true });
  return descriptor.first ? found.first() : found;
}

/** Counts every click of the walk (06 §2.3: click, double click and option choice are one each). */
function clickCounter() {
  let clicks = 0;
  return {
    async click(locator) {
      clicks += 1;
      await locator.click();
    },
    get count() { return clicks; },
  };
}

for (const item of CLICK_BUDGET) {
  if (item.excluded) continue;
  const title = `§10 row ${item.row} (${item.docClicks}): ≤ ${item.budget} clicks`;
  if (item.pending && !item.target) {
    test.fixme(`${title}, from ${item.pending}: ${item.gap}`, () => {});
    continue;
  }
  const scenario = { ...item.scenario };
  if (scenario.doc) scenario.doc = shellDoc(scenario.doc);
  test(item.pending ? `${title}, where it sits until ${item.pending}` : title, async ({ page }) => {
    await openShell(page, "", scenario);
    const counter = clickCounter();
    for (const step of item.steps) await counter.click(locate(page, step));
    const target = locate(page, item.target);
    await expect(target).toBeVisible();
    // The control's own click and the counted steps after it (an OS dialog, a confirmation).
    const total = counter.count + 1 + (item.extra ?? 0);
    expect(total).toBe(clickCount(item));
    expect(total).toBeLessThanOrEqual(item.budget);
  });
}
