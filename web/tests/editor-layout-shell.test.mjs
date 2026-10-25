// The one-layout editor's shell (rombak 06 §3.5, Editor F1): its files, the five tabs and their
// registry, the grid areas per breakpoint, and the page handing POTONGIN_EDITOR_SHELL to the
// editor. The browser behaviour (one tab panel, the redirects, the drawer) is
// e2e/editor-layout-shell.spec.mjs's.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PANELS, SHELL_TABS } from "../components/editor/panels/index.mjs";
import { TAB_IDS } from "../lib/editor/url-state.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(path.join(WEB, ...parts), "utf8");
const SHELL = path.join("components", "editor", "shell");

test("the shell's files of §3.5 exist", () => {
  for (const file of ["EditorShell.jsx", "ClipList.jsx", "PanelTabs.jsx", "Advanced.jsx", "editor-shell.module.css"]) {
    assert.ok(existsSync(path.join(WEB, SHELL, file)), file);
  }
  assert.ok(existsSync(path.join(WEB, "lib", "editor", "url-state.mjs")));
  assert.ok(existsSync(path.join(WEB, "lib", "editor", "disclosure.mjs")));
});

test("five tabs in order, Musik renamed Audio and no Transkrip tab; the old shell's registry is untouched", () => {
  assert.deepEqual(SHELL_TABS.map((entry) => entry.id), ["text", "layout", "audio", "logo", "coldopen"]);
  assert.deepEqual(SHELL_TABS.map((entry) => entry.id), [...TAB_IDS], "the address knows the same tabs");
  const byId = Object.fromEntries(SHELL_TABS.map((entry) => [entry.id, entry]));
  assert.equal(byId.audio.file, "panels/MusicPanel.jsx", "Audio shows the music panel until F5 renames it");
  for (const entry of SHELL_TABS) {
    assert.equal(typeof entry.load, "function", entry.id);
    assert.ok(existsSync(path.join(WEB, "components", "editor", entry.file)), entry.file);
    assert.ok(Object.isFrozen(entry), entry.id);
  }
  // Until F10 removes it, the two-view shell keeps its six tabs and their ids (?panel=music links).
  assert.deepEqual(PANELS.map((entry) => entry.id), ["transcript", "text", "coldopen", "layout", "logo", "music"]);
});

test("the grid has the §3.5 areas and the §3.1 breakpoints, and only the clip column and the panel scroll on their own", () => {
  const css = read(SHELL, "editor-shell.module.css");
  for (const area of ["top", "clips", "stage", "transcript", "panel", "timeline"]) {
    assert.match(css, new RegExp(`grid-area: ${area};`), area);
  }
  assert.match(css, /grid-template-areas:/);
  assert.match(css, /@media \(min-width: 1440px\)/, "the transcript beside the stage from 1440 px");
  assert.match(css, /@media \(max-width: 1279px\)/, "the clip column folds into a rail below 1280 px");
  assert.match(css, /height: 100vh;/);
  assert.match(css, /overflow: hidden;/);
  assert.doesNotMatch(css, /--accent\b/, "lime stays on Ekspor (shell.module.css)");
});

test("the tabs are HeroUI Tabs, the clip list a React Aria GridList, Lanjutan a HeroUI Disclosure with its summary", () => {
  const tabs = read(SHELL, "PanelTabs.jsx");
  assert.match(tabs, /import \{[^}]*\bTabs\b[^}]*\} from "@heroui\/react";/);
  assert.match(tabs, /SHELL_TABS/);
  assert.doesNotMatch(tabs, /shouldForceMount/, "an inactive panel is not in the DOM: one tab panel");
  const clips = read(SHELL, "ClipList.jsx");
  assert.match(clips, /import \{[^}]*\bGridList\b[^}]*\} from "react-aria-components";/);
  const advanced = read(SHELL, "Advanced.jsx");
  assert.match(advanced, /import \{[^}]*\bDisclosure\b[^}]*\} from "@heroui\/react";/);
  assert.match(advanced, /readDisclosure/);
  assert.match(advanced, /writeDisclosure/);
  assert.match(advanced, /LIST_SEPARATOR/, "one separator, set in lib/i18n/format.mjs");
});

test("the page hands POTONGIN_EDITOR_SHELL to the editor; the new shell shows no view switch, rail or cards", () => {
  const page = read("app", "projects", "[id]", "clips", "[clipId]", "edit", "page.jsx");
  assert.match(page, /shell=\{flags\.shell\}/);
  const shell = read(SHELL, "EditorShell.jsx");
  assert.doesNotMatch(shell, /ViewSwitch|QuickPanel|Rail\b|view-mode/);
  const app = read("components", "editor", "EditorApp.jsx");
  assert.match(app, /import EditorShell from "\.\/shell\/EditorShell\.jsx";/);
  assert.match(app, /url-state\.mjs/);
});
