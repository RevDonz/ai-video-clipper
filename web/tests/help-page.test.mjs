// The help page (/bantuan) and the "Cara memperbaiki" links the other pages put under their error
// messages. Source checks (JSX does not run under node --test) for the parts that must work
// without JS, and the page's data in both languages from the same builders the page calls. The
// catalogue behind them is tested in help-catalog.test.mjs, the guide in help-guide.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTranslator } from "use-intl/core";

import { HELP_ENTRIES, findHelpEntry } from "../lib/help-catalog.mjs";
import { GUIDE_TOPICS } from "../lib/help-guide.mjs";
import { guideView, helpGroupsView, helpSearchIndex, shortcutsView } from "../lib/help-view.mjs";
import { loadNamespaces } from "../lib/i18n/catalog.mjs";
import { LOCALES } from "../lib/i18n/locales.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");
const INTL = Object.fromEntries(LOCALES.map((entry) => [entry.code, entry.intl]));
const translator = (code, namespace) => createTranslator({ locale: INTL[code], messages: loadNamespaces(code, [namespace]), namespace });

test("the page renders every entry under its anchor, works without JS and sits behind the shared header", async () => {
  const page = await read("app/bantuan/page.jsx");
  assert.match(page, /<AppShell current="\/bantuan" \{\.\.\.shellData\(\)\}>/);
  assert.doesNotMatch(page, /^"use client"/m, "the entries are rendered on the server");
  assert.match(page, /helpGroupsView\(t, te\)/);
  assert.match(page, /<article id=\{entry\.id\}/);
  assert.match(page, /entry\.anchors/);
  // The entries are never folded: only the guide uses a Disclosure on this page.
  assert.doesNotMatch(page, /Disclosure/);
  // Without JS the form is a GET to /bantuan?q=…; the server sends the browser to the entry,
  // searching the same index of every locale's text the box gets.
  assert.match(page, /await searchParams/);
  assert.match(page, /findHelpEntry\(query, index\)/);
  assert.match(page, /redirect\(`\$\{HELP_PATH\}#\$\{found\.entry\.id\}`\)/);
  assert.match(page, /<HelpSearch [^>]*index=\{index\}/);
  // The head is the title alone (05 §6.13: the sentence under it is gone).
  assert.match(page, /<PageHead title=\{t\("title"\)\} \/>/);
  assert.doesNotMatch(page, /className="pageHead"/);
  const search = await read("app/bantuan/HelpSearch.jsx");
  assert.match(search, /^"use client";/);
  assert.match(search, /<form [^>]*method="get" action=\{HELP_PATH\}/, "the search also works as a plain GET form");
  assert.match(search, /<SearchField\s[^>]*id="bantuan-q"\s[^>]*name="q"/);
  assert.match(search, /<Label [^>]*>\{labels\.label\}<\/Label>/);
  assert.match(search, /<Button type="submit"/, "a real submit button, so Enter and the button work without JS");
  assert.match(search, /findHelpEntry\(query, index\)/);
  assert.match(search, /aria-live="polite"/);
  assert.match(search, /\.focus\(/, "the opened entry takes the focus");
  const guide = await read("app/bantuan/HelpGuide.jsx");
  assert.match(guide, /^"use client";/);
  assert.match(guide, /<Disclosure /);
  assert.match(guide, /hashchange/, "a later #topic link opens its topic");
  const css = await read("app/bantuan/bantuan.module.css");
  assert.match(css, /@media \(scripting: none\) \{\s*\.topicPanel,\s*\.topicPanel\[hidden\] \{\s*display: block;/, "without JS the topics read open");
  for (const source of [page, search, guide]) assert.doesNotMatch(source, /—|dangerouslySetInnerHTML/);
});

test("in both languages the page has every entry, its anchors, its words and a working search", async () => {
  const index = await helpSearchIndex(translator);
  const views = {};
  for (const { code } of LOCALES) {
    const groups = helpGroupsView(translator(code, "help"), translator(code, "errors"));
    const entries = groups.flatMap((group) => group.entries);
    assert.deepEqual(entries.map((entry) => entry.id), HELP_ENTRIES.map((entry) => entry.id), code);
    for (const entry of entries) {
      assert.ok(entry.title && entry.cause && entry.steps.length, `${code}: ${entry.id}`);
      assert.equal(entry.anchors[0], entry.id);
    }
    const topics = guideView(translator(code, "help"));
    assert.deepEqual(topics.map((topic) => topic.id), GUIDE_TOPICS.map((topic) => topic.id), code);
    assert.ok(shortcutsView(translator(code, "help")).groups.every((group) => group.rows.length), code);
    views[code] = { entries, topics };
  }
  // The English page is English; the anchors (and so every /bantuan#<code> link) are the same.
  assert.notEqual(views.en.entries[0].title, views.id.entries[0].title);
  assert.deepEqual(views.en.entries.map((entry) => entry.anchors), views.id.entries.map((entry) => entry.anchors));
  // An Indonesian message pasted into the English page still opens its entry, and the other way round.
  const shown = views.id.entries.find((entry) => entry.id === "download_bot_check").shown[0];
  assert.equal(findHelpEntry(shown, index)?.entry.id, "download_bot_check");
  const english = views.en.entries.find((entry) => entry.id === "download_stalled").cause;
  assert.equal(findHelpEntry(english, index)?.entry.id, "download_stalled");
});

// The groups (Kerja, Sistem) are gone from the flat sidebar (05 §4.1): Bantuan is its last entry.
test("the sidebar offers the help page as its last entry, marked current on the help page", async () => {
  const { navLinks } = await import("../lib/app-nav.mjs");
  const links = navLinks("/bantuan");
  assert.deepEqual([links.at(-1).href, links.at(-1).labelKey], ["/bantuan", "shell.nav.help"]);
  assert.equal(JSON.parse(await read("messages/id/shell.json")).nav.help, "Bantuan");
  assert.deepEqual(links.filter((item) => item.current).map((item) => item.href), ["/bantuan"]);
  const list = await read("components/NavList.jsx");
  assert.equal(list.match(/<nav\b/g)?.length, 1);
});

test("the project page, the dashboard and the settings test result link their errors to the help page", async () => {
  const project = await read("app/projects/[id]/page.jsx");
  assert.match(project, /const help = jobHelpHref\(job\);/);
  assert.match(project, /\{help && <a [^>]*href=\{help\}/);
  assert.match(project, /\{notice\.help && <a [^>]*href=\{notice\.help\}/);
  const dashboard = await read("app/dashboard/page.jsx");
  assert.match(dashboard, /const failureHelp = jobHelpHref\(activeJob\);/);
  assert.match(dashboard, /\{failureHelp && <a [^>]*href=\{failureHelp\}/);
  assert.match(dashboard, /storageHelpHref\(storage\.admission\.code\)/);
  assert.match(dashboard, /help: storageHelpHref\(payload\.code\)/);
  assert.match(dashboard, /message\.help && <a [^>]*href=\{message\.help\}/);
  const settings = await read("app/settings/page.jsx");
  assert.match(settings, /helpHref\(test\.result\.code\)/);
  assert.match(settings, /result\?\.help && <>\{" "\}<a [^>]*href=\{result\.help\}/);
});
