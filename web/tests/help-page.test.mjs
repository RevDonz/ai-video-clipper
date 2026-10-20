// The help page (/bantuan) and the "Cara memperbaiki" links the other pages put under their error
// messages. Source checks: JSX does not run under node --test. The catalogue behind them is
// tested in help-catalog.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

test("the page renders every entry under its anchor, works without JS and sits behind the shared header", async () => {
  const page = await read("app/bantuan/page.jsx");
  assert.match(page, /<AppHeader current="\/bantuan" \/>/);
  assert.doesNotMatch(page, /^"use client"/m, "the entries are rendered on the server");
  assert.match(page, /HELP_ENTRIES/);
  assert.match(page, /id=\{entry\.id\}/);
  assert.match(page, /helpAnchors\(entry\)/);
  // Without JS the form is a GET to /bantuan?q=…; the server sends the browser to the entry.
  assert.match(page, /await searchParams/);
  assert.match(page, /findHelpEntry\(query\)/);
  assert.match(page, /redirect\(`\$\{HELP_PATH\}#\$\{found\.entry\.id\}`\)/);
  const search = await read("app/bantuan/HelpSearch.jsx");
  assert.match(search, /^"use client";/);
  assert.match(search, /<form [^>]*method="get" action="\/bantuan"/, "the search also works as a plain GET form");
  assert.match(search, /name="q"/);
  assert.match(search, /<label htmlFor="bantuan-q"/);
  assert.match(search, /findHelpEntry\(/);
  assert.match(search, /aria-live="polite"/);
  assert.match(search, /\.focus\(/, "the opened entry takes the focus");
  for (const source of [page, search]) assert.doesNotMatch(source, /—|dangerouslySetInnerHTML/);
});

test("the header offers the help page as a quiet link outside the main navigation", async () => {
  const header = await read("components/AppHeader.jsx");
  assert.match(header, /<a [^>]*href="\/bantuan"[^>]*aria-current=\{current === "\/bantuan" \? "page" : undefined\}/);
  assert.equal(header.match(/<nav\b/g)?.length, 1);
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
