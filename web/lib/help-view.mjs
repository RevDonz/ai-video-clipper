// What the help page (/bantuan) shows, in the viewer's language, and the text its search knows
// in every language (rombak 05 §6.13, 07 i18n M4). Pure builders over translators: `t` for the
// help namespace and `te` for the errors namespace (getT on the server, createTranslator in the
// tests), so the page and the tests read the catalogs through the same code. The catalogs' code
// lists are help-catalog.mjs (entries, groups) and help-guide.mjs (topics, shortcuts);
// tests/help-catalog.test.mjs holds every key named here to both locales.

import { HELP_ENTRIES, HELP_GROUPS, buildHelpIndex, helpAnchors } from "./help-catalog.mjs";
import { GUIDE_APP_SHORTCUTS, GUIDE_SHORTCUTS, GUIDE_TOPICS, KEY_NAMES, SHORTCUTS_ANCHOR, guideValues } from "./help-guide.mjs";
import { LOCALES } from "./i18n/locales.mjs";

// The catalog domain of the messages a group's codes put on screen (07 §10.1): errors.<domain>.<code>.
const MESSAGE_DOMAIN = Object.freeze({ unduhan: "download", penyimpanan: "storage", ai: "llm" });

const numbered = (value) => Object.keys(value ?? {}).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b));
const named = (value) => Object.keys(value ?? {});

/**
 * The messages an entry's codes show on screen in the translator's language: errors.<domain>.<code>
 * where the catalog has it, else the entry's own `shown` (none since every code's text is in the catalog).
 */
export function shownTexts(entry, te) {
  const domain = MESSAGE_DOMAIN[entry.group];
  const fromCatalog = [];
  for (const code of entry.codes) {
    const key = `${domain}.${code}`;
    if (te?.has?.(key)) {
      const text = te.raw(key);
      if (typeof text === "string" && text.trim()) fromCatalog.push(text);
    }
  }
  return [...new Set(fromCatalog.length ? fromCatalog : entry.shown)];
}

function entryText(t, entry) {
  const base = `entries.${entry.id}`;
  return {
    title: t(`${base}.title`),
    cause: t(`${base}.cause`),
    steps: numbered(t.raw(`${base}.fix`)).map((step) => t(`${base}.fix.${step}`)),
  };
}

/** One error entry as the page renders it: anchors, title, the on-screen messages, cause, fix and link. */
export function helpEntryView(t, te, entry) {
  return {
    id: entry.id,
    anchors: helpAnchors(entry),
    ...entryText(t, entry),
    shown: shownTexts(entry, te),
    action: entry.action ? { href: entry.action.href, label: t(`actions.${entry.action.key}`) } : null,
  };
}

/** The error reference: every group in page order with its entries. */
export function helpGroupsView(t, te) {
  return HELP_GROUPS.map((group) => ({
    id: group.id,
    anchor: `grup-${group.id}`,
    title: t(`groups.${group.id}.title`),
    intro: t(`groups.${group.id}.intro`),
    entries: HELP_ENTRIES.filter((entry) => entry.group === group.id).map((entry) => helpEntryView(t, te, entry)),
  }));
}

/** The guide topics: steps or terms, with the limits and presets of the pages filled in. */
export function guideView(t) {
  const values = guideValues();
  return GUIDE_TOPICS.map((topic) => {
    const base = `guide.topics.${topic.id}`;
    const raw = t.raw(base);
    return {
      id: topic.id,
      title: t(`${base}.title`),
      intro: t(`${base}.intro`),
      steps: numbered(raw?.steps).map((step) => t(`${base}.steps.${step}`, values)),
      terms: named(raw?.terms).map((term) => ({
        id: term,
        title: t(`${base}.terms.${term}.title`),
        text: t(`${base}.terms.${term}.text`, values),
      })),
      action: topic.action ? { href: topic.action.href, label: t(`actions.${topic.action.key}`) } : null,
    };
  });
}

/** The shortcut table: the app pages' single keys, then the editor's first keys. */
export function shortcutsView(t) {
  const keyLabel = (key) => (Object.hasOwn(KEY_NAMES, key) ? t(`shortcuts.${KEY_NAMES[key]}`) : key);
  const rows = (list, group) => list.map((shortcut) => ({ id: shortcut.id, keys: shortcut.keys.map(keyLabel), text: t(`shortcuts.${group}.${shortcut.id}`) }));
  return {
    anchor: SHORTCUTS_ANCHOR,
    groups: [
      { id: "app", title: t("shortcuts.app"), note: t("shortcuts.appNote"), rows: rows(GUIDE_APP_SHORTCUTS, "appKeys") },
      { id: "editor", title: t("shortcuts.editor"), note: t("shortcuts.editorNote"), rows: rows(GUIDE_SHORTCUTS, "editorKeys") },
    ],
  };
}

/** What the search knows of one locale: per entry id, its on-screen messages and its words. */
export function helpSearchTexts(t, te) {
  const out = {};
  for (const entry of HELP_ENTRIES) {
    const { title, cause, steps } = entryText(t, entry);
    out[entry.id] = { shown: shownTexts(entry, te), words: [title, cause, ...steps] };
  }
  return out;
}

/**
 * The search index over every registered locale (enabled or not), so a message pasted from any
 * UI language finds its entry. `translator(code, namespace)` returns a translator, sync or async.
 */
export async function helpSearchIndex(translator) {
  const texts = await Promise.all(LOCALES.map(async ({ code }) => {
    const [t, te] = await Promise.all([translator(code, "help"), translator(code, "errors")]);
    return helpSearchTexts(t, te);
  }));
  return buildHelpIndex(texts);
}

/** Entry id → title in the viewer's language, for the search box's result line. */
export function helpTitles(t) {
  return Object.fromEntries(HELP_ENTRIES.map((entry) => [entry.id, t(`entries.${entry.id}.title`)]));
}
