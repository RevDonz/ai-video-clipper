// /licenses (plan §11.4 T4.4, R3): the third-party notices name exactly what the app ships. The
// versions follow the pins, every linked licence text is a file in public/licenses, and the copies
// are byte for byte the installed packages' and resources/fonts' files.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FONTS, FREETYPE_CREDIT, JASSUB, MEDIABUNNY, WEB, licenceFiles } from "../app/licenses/notices.mjs";
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

// The UI-language runtime (rombak 07 §2.1): use-intl and every package of its runtime closure
// that reaches the app's bundles. The rest of the closure is named here with the reason it ships
// no code, so a new dependency of use-intl cannot slip in unlisted.
const I18N_NOT_SHIPPED = Object.freeze({
  "node_modules/icu-minify": "message compiler; use-intl's runtime entry does not import it",
  "node_modules/@formatjs/icu-messageformat-parser": "used by icu-minify only",
  "node_modules/@formatjs/icu-skeleton-parser": "used by icu-minify's parser only",
  "node_modules/@schummar/icu-type-parser": "TypeScript types only",
});

function runtimeClosure(lock, start) {
  const seen = new Set();
  const visit = (at) => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const name of Object.keys(lock[at].dependencies ?? {})) {
      // npm's lookup: the nearest node_modules up from the dependant.
      let base = at;
      let found = null;
      while (!found) {
        const candidate = `${base}/node_modules/${name}`;
        if (lock[candidate]) found = candidate;
        else if (base === "node_modules" || !base.includes("/node_modules/")) found = `node_modules/${name}`;
        else base = base.slice(0, base.lastIndexOf("/node_modules/"));
      }
      assert.ok(lock[found], `${found} is in the lock file`);
      visit(found);
    }
  };
  visit(start);
  return seen;
}

test("the UI-language runtime is listed with the exact installed packages and their own licence texts", async () => {
  const pkg = await json(WEB_ROOT, "package.json");
  const lock = (await json(WEB_ROOT, "package-lock.json")).packages;
  const listed = WEB.filter((item) => item.lockPath);
  assert.equal(listed[0].lockPath, "node_modules/use-intl");
  assert.equal(listed[0].version, pkg.dependencies["use-intl"]);
  const closure = runtimeClosure(lock, "node_modules/use-intl");
  assert.deepEqual(new Set([...listed.map((item) => item.lockPath), ...Object.keys(I18N_NOT_SHIPPED)]), closure);
  for (const item of listed) {
    const entry = lock[item.lockPath];
    assert.equal(item.version, entry.version, item.lockPath);
    assert.equal(item.license, entry.license, item.lockPath);
    assert.equal(item.texts.length, 1, item.lockPath);
    const installed = (await readdir(path.join(WEB_ROOT, item.lockPath))).find((name) => /^licen[cs]e(\.md|\.txt)?$/i.test(name));
    assert.ok(installed, `${item.lockPath} ships a licence file`);
    assert.ok((await read(publicFile(item.texts[0]))).equals(await read(WEB_ROOT, item.lockPath, installed)), item.texts[0]);
  }
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
  for (const name of ["JASSUB", "MEDIABUNNY", "FONTS", "WEB", "FREETYPE_CREDIT"]) assert.match(source, new RegExp(`\\b${name}\\b`), name);
  assert.match(source, /<h1[^>]*>Lisensi pihak ketiga<\/h1>/);
  const notices = (await read(WEB_ROOT, "app", "licenses", "notices.mjs")).toString();
  for (const text of [source, notices]) assert.doesNotMatch(text.replace(/\/\/.*$/gm, ""), /—/);
});
