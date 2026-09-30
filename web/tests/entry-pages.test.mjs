// The public landing (app/page.jsx) and the login page (app/login/page.jsx): Indonesian copy
// without version labels, em dashes or invented claims; every link has a real destination.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loginErrorMessage, safeNextPath } from "../lib/login-view.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");
const FORBIDDEN_COPY = /—|\bV[1-4]\b|Selection|versi|Mode lama|Get Started|Learn More|workflow|self-hosted|repurposing|ONLINE|AI Powered|Revolusioner/i;

// Visible text of a JSX source: string literals and text between tags, without attributes.
function visibleText(source) {
  return source
    .replace(/\/\/.*$/gm, "")
    .replace(/className=\{[^}]*\}|className="[^"]*"|href="[^"]*"|style=\{\{[^}]*\}\}/g, "");
}

test("landing copy is Indonesian, has no em dash, version label or template buzzword", async () => {
  const source = await read("app/page.jsx");
  assert.doesNotMatch(visibleText(source), FORBIDDEN_COPY);
  assert.match(source, /import Brand from "\.\.\/components\/Brand\.jsx";/);
  assert.match(source, /import styles from "\.\/landing\.module\.css";/);
  assert.doesNotMatch(source, /className="landing/, "landing styles live in the module now");
});

test("every landing anchor points at a section that exists, and the CTAs reach the dashboard", async () => {
  const source = await read("app/page.jsx");
  const anchors = [...source.matchAll(/href="#([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(anchors.length >= 3);
  for (const id of anchors) assert.match(source, new RegExp(`id="${id}"`), `#${id}`);
  assert.ok((source.match(/href="\/dashboard"/g) || []).length >= 2);
  // The product picture is decoration for screen readers and holds no fake status or URL.
  assert.match(source, /aria-hidden="true"/);
  assert.doesNotMatch(source, /potongin\.ai|ONLINE|Export semua/);
});

test("the privacy section says what leaves the server instead of claiming nothing does", async () => {
  const source = await read("app/page.jsx");
  assert.match(source, /id="privasi"/);
  assert.match(source, /hanya teks transkrip/i);
  assert.doesNotMatch(source, /tidak perlu dikirim ke API AI berbayar|Tidak ada biaya API/);
});

test("login shows Indonesian messages for a wrong password and for too many attempts", async () => {
  assert.equal(loginErrorMessage(undefined), null);
  assert.equal(loginErrorMessage("1"), "Nama pengguna atau kata sandi salah.");
  assert.equal(loginErrorMessage("limit"), "Terlalu banyak percobaan. Tunggu beberapa menit, lalu coba lagi.");
  // Unknown codes show nothing rather than echoing the query.
  for (const code of ["<b>x</b>", "0", ["1"], "toString", "__proto__"]) assert.equal(loginErrorMessage(code), null, String(code));
  const source = await read("app/login/page.jsx");
  assert.match(source, /loginErrorMessage\(params\?\.error\)/);
  assert.match(source, /role="alert"/);
});

test("login and its route keep only same-site next paths", async () => {
  assert.equal(safeNextPath("/projects?filter=done"), "/projects?filter=done");
  for (const value of ["//evil.example", "/\\evil.example", "https://evil.example", "/a\u0000b", "", undefined, ["/projects"]]) {
    assert.equal(safeNextPath(value), "/dashboard", JSON.stringify(value));
  }
  const route = await read("app/api/auth/login/route.js");
  assert.match(route, /safeNextPath\(/);
  assert.match(await read("app/login/page.jsx"), /safeNextPath\(params\?\.next\)/);
});

test("login copy has no em dash, version label or English marketing label", async () => {
  const source = await read("app/login/page.jsx");
  assert.doesNotMatch(visibleText(source), FORBIDDEN_COPY);
  assert.doesNotMatch(source, /SELF-HOSTED|Face Tracking/);
  assert.match(source, /import styles from "\.\/login\.module\.css";/);
});
