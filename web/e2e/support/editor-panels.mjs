// The right-hand panel of the one-layout editor (rombak 06 §8, §18.4): five tabs, one panel shown.
// Specs open a tab with openPanel(page, id) instead of clicking its name, so only this file
// changes when a label does. The names come from the catalog in the project's UI language.
import { expect } from "@playwright/test";

import { L } from "./i18n.mjs";

/** The tab ids in the panel's order. */
export const TAB_IDS = Object.freeze(["text", "layout", "audio", "logo", "coldopen"]);

const TAB_KEYS = Object.freeze({
  text: "editor.shell.tabs.text", layout: "editor.shell.tabs.layout", audio: "editor.shell.tabs.audio",
  logo: "editor.shell.tabs.logo", coldopen: "editor.shell.tabs.coldOpen",
});

/** The name of the tab `id` on screen. */
export function tabName(id) {
  if (!Object.hasOwn(TAB_KEYS, id)) throw new Error(`unknown tab: ${id}`);
  return L(TAB_KEYS[id]);
}

/** The panel region (tabs and the shown panel). */
export function panelRegion(page) {
  return page.locator('[data-slot="panel"]');
}

/** The tab of `id` in the panel's tab list. */
export function panelTab(page, id) {
  return panelRegion(page).getByRole("tab", { name: tabName(id), exact: true });
}

/**
 * Opens the tab of `id` and waits until its panel is the one shown and has loaded (panels load
 * lazily: until then the tab panel holds only the "opening" note); returns the panel.
 */
export async function openPanel(page, id) {
  const tab = panelTab(page, id);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const panel = panelRegion(page).getByRole("tabpanel");
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id")) ?? "");
  await expect(panel.locator("section[data-panel]")).toHaveCount(1, { timeout: 30_000 });
  return panel;
}
