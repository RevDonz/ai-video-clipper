// /licenses (plan §11.4 T4.4, R3): the third-party notices name exactly what the app ships. The
// versions follow the pins, every linked licence text is a file in public/licenses, and the copies
// are byte for byte the installed packages' and resources/fonts' files.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FONTS, FREETYPE_CREDIT, JASSUB, MEDIABUNNY, UI, WEB, licenceFiles } from "../app/licenses/notices.mjs";
import { JASSUB_FILES } from "../lib/clip-media.mjs";
import { JASSUB_VERSION } from "../lib/editor/player/text-layer.mjs";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = path.join(WEB_ROOT, "..");
const read = (...parts) => readFile(path.join(...parts));
const json = async (...parts) => JSON.parse(await readFile(path.join(...parts), "utf8"));
const publicFile = (href) => path.join(WEB_ROOT, "public", ...href.split("/").filter(Boolean));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory()
    ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)])));
  return nested.flat();
}

test("the notices name the pinned versions and the exact packages", async () => {
  const pkg = await json(WEB_ROOT, "package.json");
  const lock = (await json(WEB_ROOT, "package-lock.json")).packages;
  assert.equal(JASSUB.version, pkg.dependencies.jassub);
  assert.equal(JASSUB.integrity, lock["node_modules/jassub"].integrity);
  assert.equal(JASSUB.license, lock["node_modules/jassub"].license);
  assert.equal(JASSUB.version, JASSUB_VERSION, "the text layer and the notice name the same JASSUB");
  assert.equal(MEDIABUNNY.version, pkg.dependencies.mediabunny);
  assert.equal(MEDIABUNNY.integrity, lock["node_modules/mediabunny"].integrity);
  assert.equal(MEDIABUNNY.license, lock["node_modules/mediabunny"].license);
  assert.equal(MEDIABUNNY.tag, `v${MEDIABUNNY.version}`);
  const [next, react] = WEB;
  assert.equal(next.version, pkg.dependencies.next);
  assert.equal(react.version, pkg.dependencies.react);
  assert.equal(react.version, pkg.dependencies["react-dom"]);
});

// The UI kit (docs/plans/2026-10-24-rombak/05-ui-dashboard.md §3.1): HeroUI on React Aria, the
// CSS Tailwind generates from its theme and utilities, and the animation utilities it imports.
const UI_PACKAGES = [
  "@heroui/react", "@heroui/styles", "react-aria", "react-aria-components", "@internationalized/date",
  "tailwindcss", "tw-animate-css", "tailwind-variants",
];
// Dependencies that never reach the browser or the generated CSS, so /licenses does not list them.
const SERVER_ONLY = ["busboy"];

test("the UI kit notices name the exact pins and the lockfile's licences", async () => {
  const pkg = await json(WEB_ROOT, "package.json");
  const lock = (await json(WEB_ROOT, "package-lock.json")).packages;
  const listed = UI.flatMap((item) => item.packages);
  assert.deepEqual(listed.map((entry) => entry.name).sort(), [...UI_PACKAGES].sort());
  for (const entry of listed) {
    const locked = lock[`node_modules/${entry.name}`];
    assert.ok(locked, `${entry.name} is in package-lock.json`);
    assert.equal(entry.version, locked.version, entry.name);
    assert.equal(entry.license, locked.license, entry.name);
    const pin = pkg.dependencies[entry.name] ?? pkg.devDependencies[entry.name];
    if (entry.name === "tailwind-variants") {
      assert.equal(pin, undefined, "tailwind-variants comes with HeroUI, it is not a direct dependency");
    } else {
      assert.equal(pin, entry.version, `${entry.name} is pinned exactly`);
    }
  }
  for (const item of UI) assert.ok(item.use && item.source.startsWith("https://"), item.name);
});

test("every dependency the browser receives is named on /licenses", async () => {
  const pkg = await json(WEB_ROOT, "package.json");
  const named = new Set([
    "jassub", "mediabunny", "next", "react", "react-dom",
    ...UI.flatMap((item) => item.packages.map((entry) => entry.name)),
  ]);
  for (const name of Object.keys(pkg.dependencies)) {
    if (SERVER_ONLY.includes(name)) continue;
    assert.ok(named.has(name), `${name} has a notice`);
  }
  for (const name of named) if (pkg.dependencies[name]) assert.doesNotMatch(pkg.dependencies[name], /^[~^]/u, `${name} is pinned`);
});

test("the served JASSUB files are the ones the notice lists", () => {
  assert.deepEqual(JASSUB.files, Object.keys(JASSUB_FILES));
});

test("JASSUB's source and build scripts point at one exact commit", () => {
  assert.match(JASSUB.commit, /^[0-9a-f]{40}$/);
  assert.equal(JASSUB.source, `${JASSUB.repository}/tree/${JASSUB.commit}`);
  assert.deepEqual(JASSUB.buildScripts.map((script) => script.href), [
    `${JASSUB.repository}/blob/${JASSUB.commit}/Makefile`,
    `${JASSUB.repository}/blob/${JASSUB.commit}/Dockerfile`,
    `${JASSUB.repository}/blob/${JASSUB.commit}/run-docker-build.sh`,
  ]);
  for (const component of JASSUB.components) {
    assert.match(component.source, /^https:\/\/[^\s]+\/(tree\/[0-9a-f]{40}|tree\/6\.0\.4|-\/tree\/[0-9a-f]{40})$/, component.name);
  }
  const licences = JASSUB.components.map((component) => component.license).join(" ");
  for (const spdx of ["LGPL-2.1-or-later", "FTL", "MIT", "ISC", "MIT-Modern-Variant"]) assert.ok(licences.includes(spdx), spdx);
  assert.match(FREETYPE_CREDIT, /^Portions of this software are copyright © 2021 The FreeType Project \(www\.freetype\.org\)\. All rights reserved\.$/);
});

test("every licence text the page links is in public/licenses, and nothing else is", async () => {
  const linked = licenceFiles();
  assert.ok(linked.every((href) => href.startsWith("/licenses/")));
  const present = (await filesUnder(path.join(WEB_ROOT, "public", "licenses"))).map((file) => path.relative(path.join(WEB_ROOT, "public"), file).split(path.sep).join("/"));
  assert.deepEqual([...new Set(linked)].map((href) => href.slice(1)).sort(), present.sort());
  for (const href of linked) assert.ok((await read(publicFile(href))).length > 0, href);
});

test("the licence copies are the shipped packages' and fonts' own files", async () => {
  const pairs = [
    ["/licenses/jassub/LICENSE.txt", path.join(WEB_ROOT, "node_modules", "jassub", "LICENSE")],
    ["/licenses/mediabunny/LICENSE.txt", path.join(WEB_ROOT, "node_modules", "mediabunny", "LICENSE")],
    ["/licenses/web/next-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "next", "license.md")],
    ["/licenses/web/react-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "react", "LICENSE")],
    ["/licenses/ui/heroui-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "@heroui", "react", "LICENSE")],
    ["/licenses/ui/heroui-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "@heroui", "styles", "LICENSE")],
    ["/licenses/ui/react-aria-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "react-aria", "LICENSE")],
    ["/licenses/ui/react-aria-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "react-aria-components", "LICENSE")],
    ["/licenses/ui/react-aria-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "@internationalized", "date", "LICENSE")],
    ["/licenses/ui/tailwindcss-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "tailwindcss", "LICENSE")],
    ["/licenses/ui/tw-animate-css-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "tw-animate-css", "LICENSE")],
    ["/licenses/ui/tailwind-variants-LICENSE.txt", path.join(WEB_ROOT, "node_modules", "tailwind-variants", "LICENSE")],
    ["/licenses/fonts/Montserrat-OFL.txt", path.join(REPO, "resources", "fonts", "OFL.txt")],
    ["/licenses/fonts/DejaVu-LICENSE.txt", path.join(REPO, "resources", "fonts", "LICENSE-DejaVu.txt")],
    ["/licenses/fonts/Anton-OFL.txt", path.join(REPO, "resources", "fonts", "OFL-Anton.txt")],
    ["/licenses/fonts/DMSerifDisplay-OFL.txt", path.join(REPO, "resources", "fonts", "OFL-DMSerifDisplay.txt")],
  ];
  for (const [href, original] of pairs) {
    assert.ok((await read(publicFile(href))).equals(await read(original)), href);
  }
  const fonts = await json(REPO, "resources", "fonts", "fonts.json");
  assert.deepEqual(new Set(fonts.licenses.map((entry) => entry.file)), new Set(["OFL.txt", "LICENSE-DejaVu.txt", "OFL-Anton.txt", "OFL-DMSerifDisplay.txt"]));
  assert.equal(FONTS.length, 5);
  assert.match((await read(publicFile("/licenses/fonts/DMSans-OFL.txt"))).toString(), /^Copyright 2014 The DM Sans Project Authors/);
  assert.match((await read(publicFile("/licenses/jassub/fribidi-COPYING.txt"))).toString(), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/);
  assert.match((await read(publicFile("/licenses/jassub/freetype-FTL.txt"))).toString(), /The FreeType Project LICENSE/);
});

test("the page renders the notices with Indonesian copy and no em dash", async () => {
  const source = (await read(WEB_ROOT, "app", "licenses", "page.jsx")).toString();
  assert.match(source, /from "\.\/notices\.mjs"/);
  for (const name of ["JASSUB", "MEDIABUNNY", "FONTS", "WEB", "UI", "FREETYPE_CREDIT"]) assert.match(source, new RegExp(`\\b${name}\\b`), name);
  assert.match(source, /<h1[^>]*>Lisensi pihak ketiga<\/h1>/);
  const notices = (await read(WEB_ROOT, "app", "licenses", "notices.mjs")).toString();
  for (const text of [source, notices]) assert.doesNotMatch(text.replace(/\/\/.*$/gm, ""), /—/);
});
