// The settings view modules return descriptors (rombak 07 §8.3); app/settings/view-text.jsx turns
// them into words with one literal t("…") per key, which is what the catalog scans see. Every key
// a module can name must be in both catalogs and written out in view-text.jsx, or a message would
// render empty.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_LOGO_VIEW_KEYS } from "../lib/default-logo-view.mjs";
import { DEFAULT_WATERMARK_VIEW_KEYS } from "../lib/default-watermark-view.mjs";
import { loadNamespace } from "../lib/i18n/catalog.mjs";
import { LLM_SETTINGS_VIEW_KEYS } from "../lib/llm-settings-view.mjs";
import { SYSTEM_INFO_VIEW_KEYS } from "../lib/system-info-view.mjs";
import { TRANSCRIPTION_VIEW_KEYS } from "../lib/transcription-settings-view.mjs";
import { YOUTUBE_COOKIES_VIEW_KEYS } from "../lib/youtube-cookies-view.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const MODULES = {
  "llm-settings-view": LLM_SETTINGS_VIEW_KEYS,
  "transcription-settings-view": TRANSCRIPTION_VIEW_KEYS,
  "default-logo-view": DEFAULT_LOGO_VIEW_KEYS,
  "default-watermark-view": DEFAULT_WATERMARK_VIEW_KEYS,
  "youtube-cookies-view": YOUTUBE_COOKIES_VIEW_KEYS,
  "system-info-view": SYSTEM_INFO_VIEW_KEYS,
};

const lookup = (messages, key) => key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), messages);

test("every key a settings view module names is in both catalogs", () => {
  for (const code of ["id", "en"]) {
    const messages = loadNamespace(code, "settings");
    for (const [module, keys] of Object.entries(MODULES)) {
      assert.ok(keys.length > 0, module);
      for (const key of keys) assert.equal(typeof lookup(messages, key), "string", `${code}: ${module} names settings.${key}`);
    }
  }
});

test("view-text.jsx writes out every key the view modules name, each in its own case", async () => {
  const source = await readFile(path.join(WEB, "app", "settings", "view-text.jsx"), "utf8");
  for (const [module, keys] of Object.entries(MODULES)) {
    for (const key of keys) {
      const escaped = key.replaceAll(".", "\\.");
      assert.match(source, new RegExp(`case "${escaped}": return t\\("${escaped}"[,)]`), `${module}: ${key}`);
    }
  }
});
