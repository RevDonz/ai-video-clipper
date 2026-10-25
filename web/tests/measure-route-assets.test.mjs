// scripts/measure-route-assets.mjs, the editor-route build record of 08 Fase 1 (editor CSS
// byte-identical, editor JS growth at most the size of use-intl), on a fake fetch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { assetsOf, measureRoute, packageSize } from "../scripts/measure-route-assets.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const gz = (text) => gzipSync(Buffer.from(text), { level: 9 }).length;

test("it takes the page's own stylesheets and scripts, deduplicated, and nothing from elsewhere", () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/_next/static/chunks/b.css" data-precedence="next"/>
    <link rel="stylesheet" href="/_next/static/chunks/a.css?dpl=x" data-precedence="next"/>
    <link rel="preload" href="/_next/static/media/font.woff2" as="font"/>
    <link rel="stylesheet" href="https://fonts.example/x.css"/>
    <script src="/_next/static/chunks/main.js" async=""></script>
    <script src="/_next/static/chunks/page.js" async=""></script>
    <script src="/_next/static/chunks/main.js" async=""></script>
    <script>self.__next_f.push([1,"\\"/_next/static/chunks/inline.js\\""])</script>
    <script src="https://cdn.example/x.js"></script>
  </head></html>`;
  assert.deepEqual(assetsOf(html), {
    css: ["/_next/static/chunks/a.css?dpl=x", "/_next/static/chunks/b.css"],
    js: ["/_next/static/chunks/main.js", "/_next/static/chunks/page.js"],
  });
});

test("it records each CSS file's hash and the route's JS bytes, signed in, and fails on a non-200 page", async () => {
  const files = {
    "/_next/static/chunks/a.css": ".a{color:red}",
    "/_next/static/chunks/main.js": "console.log(1)",
    "/_next/static/chunks/page.js": "console.log(22)",
  };
  const html = `<link rel="stylesheet" href="/_next/static/chunks/a.css"><script src="/_next/static/chunks/main.js"></script><script src="/_next/static/chunks/page.js"></script>`;
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    seen.push([pathname, init.headers.Cookie]);
    if (pathname === "/projects/j/clips/c/edit") return new Response(html, { status: 200 });
    return new Response(files[pathname], { status: 200 });
  };
  const result = await measureRoute("http://127.0.0.1:3217/x", "/projects/j/clips/c/edit", { cookie: "potongin_session=s", fetchImpl });
  assert.ok(seen.every(([, cookie]) => cookie === "potongin_session=s"));
  assert.deepEqual(result, {
    path: "/projects/j/clips/c/edit",
    status: 200,
    css: {
      files: [{ path: "/_next/static/chunks/a.css", bytes: 13, sha256: sha(".a{color:red}") }],
      bytes: 13,
      digest: sha(`${sha(".a{color:red}")}\n`),
    },
    js: {
      files: 2,
      bytes: 14 + 15,
      gzipBytes: gz("console.log(1)") + gz("console.log(22)"),
    },
  });
  const redirect = async () => new Response(null, { status: 307, headers: { Location: "/login" } });
  await assert.rejects(measureRoute("http://local", "/p", { fetchImpl: redirect }), /\/p answered 307/);
  const missing = async (url) => (new URL(url).pathname === "/p" ? new Response(html, { status: 200 }) : new Response("", { status: 404 }));
  await assert.rejects(measureRoute("http://local", "/p", { fetchImpl: missing }), /\/_next\/static\/chunks\/a\.css answered 404/);
});

test("the use-intl size is its production ESM files, raw and gzip", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-assets-"));
  const dist = join(root, "dist", "esm", "production");
  await mkdir(join(dist, "format-message"), { recursive: true });
  await mkdir(join(root, "dist", "esm", "development"), { recursive: true });
  await writeFile(join(dist, "index.js"), "export const a=1;");
  await writeFile(join(dist, "format-message", "index.js"), "export const b=2;");
  await writeFile(join(root, "dist", "esm", "development", "index.js"), "ignored development build");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "use-intl", version: "9.9.9" }));
  assert.deepEqual(await packageSize(root), {
    name: "use-intl",
    version: "9.9.9",
    files: 2,
    bytes: 17 + 17,
    gzipBytes: gz("export const a=1;") + gz("export const b=2;"),
  });
});

test("editor-gates.yml records the editor route's assets with the TTFB, before any spec runs", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/editor-gates.yml", import.meta.url), "utf8");
  const step = /- name: Record the editor route's CSS and JS\n([\s\S]*?)\n\n/.exec(workflow)?.[1] ?? "";
  assert.match(step, /if: inputs\.suite == 'e2e' && inputs\.ttfb/);
  // The workflow's own copies of both scripts (the asset one imports the sign-in of the other).
  assert.match(step, /git show "FETCH_HEAD:web\/scripts\/measure-route-assets\.mjs" > "\$RUNNER_TEMP\/measure-route-assets\.mjs"/);
  assert.match(step, /git show "FETCH_HEAD:web\/scripts\/measure-ttfb\.mjs" > "\$RUNNER_TEMP\/measure-ttfb\.mjs"/);
  assert.match(step, /> "\$GITHUB_WORKSPACE\/gate-output\/editor-assets\.json"/);
  assert.ok(workflow.indexOf("Record the editor route's CSS and JS") > workflow.indexOf("Start the web app on the editor fakes"));
  assert.ok(workflow.indexOf("Record the editor route's CSS and JS") < workflow.indexOf("Browser specs on the editor fakes"));
});
