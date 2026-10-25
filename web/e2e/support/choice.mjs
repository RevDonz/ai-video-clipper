import { expect } from "@playwright/test";

// HeroUI v3 radios and checkboxes (React Aria) keep their <input> visually hidden inside the
// clickable label, so Playwright's check() hits the label's control instead of the input and
// times out. A person clicks the label; so does this, then the input must read checked.

const label = (input) => input.locator("xpath=ancestor::label[1]");

/** Checks a HeroUI radio or checkbox the way a person does: a click on its label. */
export async function choose(input) {
  if (!(await input.isChecked())) await label(input).click();
  await expect(input).toBeChecked();
}

/** Unchecks a HeroUI checkbox through its label. */
export async function unchoose(input) {
  if (await input.isChecked()) await label(input).click();
  await expect(input).not.toBeChecked();
}
