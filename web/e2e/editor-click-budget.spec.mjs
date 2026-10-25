// The click budget of rombak 06 §2.3 and §10 in the one-layout editor: for every row of the
// table in support/click-budget.mjs, from the editor as it opens (tab Teks), the counted clicks
// reach the row's control, which is then visible, within the row's budget. Rows whose control
// arrives with a later sub-phase are listed as fixme with that phase.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-click-budget.spec.mjs'
import { CLICK_BUDGET, clickCount } from "./support/click-budget.mjs";
import { expect, openShell, test, useShellDefaults } from "./support/editor-shell.mjs";

useShellDefaults();

const SCOPES = Object.freeze({
  topBar: (page) => page.locator('[data-slot="topBar"]'),
  clips: (page) => page.locator('[data-slot="clips"]'),
  stage: (page) => page.locator('[data-slot="stage"]'),
  panel: (page) => page.locator('[data-slot="panel"]'),
  menu: (page) => page.getByRole("menu"),
  dialog: (page) => page.getByRole("dialog"),
});

function locate(page, descriptor) {
  const scope = SCOPES[descriptor.within](page);
  if (descriptor.testId) return scope.getByTestId(descriptor.testId);
  const name = descriptor.regex ? new RegExp(descriptor.name) : descriptor.name;
  return scope.getByRole(descriptor.role, { name, exact: descriptor.regex ? undefined : descriptor.exact ?? true });
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
  if (item.pending) {
    test.fixme(`${title}, from ${item.pending}`, () => {});
    continue;
  }
  test(title, async ({ page }) => {
    await openShell(page, "", item.scenario ?? {});
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
