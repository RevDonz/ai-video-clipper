// The public landing (app/page.jsx) and the login page (app/login/page.jsx): Indonesian copy
// without version labels, em dashes or invented claims; every link has a real destination.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loginErrorCode, loginLocaleNext, safeNextPath } from "../lib/login-view.mjs";

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

test("the landing's title and link preview text follow the same copy rules", async () => {
  // Both come from meta.root of every locale's catalog (rombak 07 §8.4).
  const layout = await read("app/layout.jsx");
  assert.match(layout, /export async function generateMetadata\(\)/);
  assert.match(layout, /description: t\("root\.description"\)/);
  for (const locale of ["id", "en"]) {
    const { root } = JSON.parse(await read(`messages/${locale}/meta.json`));
    for (const text of [root.title, root.description]) {
      assert.ok(typeof text === "string" && text.trim(), locale);
      assert.doesNotMatch(text, FORBIDDEN_COPY, locale);
    }
  }
});

test("every landing anchor points at a section that exists, and the CTAs reach the dashboard", async () => {
  const source = await read("app/page.jsx");
  const anchors = [...source.matchAll(/href="#([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(anchors.length >= 3);
  for (const id of anchors) assert.match(source, new RegExp(`id="${id}"`), `#${id}`);
  assert.ok((source.match(/href="\/dashboard"/g) || []).length >= 2);
  assert.ok(anchors.includes("contoh"), "the nav reaches the Sebelum/Sesudah example");
  // The feature drawings are decoration for screen readers; nothing holds a fake status or URL.
  assert.match(source, /aria-hidden="true"/);
  assert.doesNotMatch(source, /potongin\.ai|ONLINE|Export semua/);
});

test("the landing covers Tata letak and the editor, with the editor's screen limit said plainly", async () => {
  const source = await read("app/page.jsx");
  const text = visibleText(source);
  assert.match(text, /"Tata letak"|>Tata letak</);
  assert.match(text, /Ikuti wajah/);
  assert.match(text, /Layar terbagi|layar terbagi/);
  assert.match(text, /"Editor"|>Editor</);
  assert.match(text, /Editor butuh layar minimal 1024 px\./);
  // The example says what it is: an open film, English speech, picked without AI.
  const example = /id="contoh"[\s\S]*?<\/section>/.exec(source)[0];
  assert.match(example, /Sebelum/);
  assert.match(example, /Sesudah/);
  assert.match(example, /bahasa Inggris/);
  assert.match(example, /tanpa AI/);
});

test("the landing makes no claim it cannot back: no badges, ranks, countdowns or round numbers", async () => {
  const text = visibleText(await read("app/page.jsx"));
  assert.doesNotMatch(text, /\bBARU\b|\bNew\b|\bNo\.?\s?1\b|nomor satu|terbaik|tercepat|termudah|\d+\s?\+|ribuan|jutaan|Sisa waktu|hitung mundur|countdown|promo|diskon|viral|\bHot\b/i);
});

test("the privacy section says what leaves the server instead of claiming nothing does", async () => {
  const source = await read("app/page.jsx");
  assert.match(source, /id="privasi"/);
  const privacy = /id="privasi"[\s\S]*?<\/section>/.exec(source)[0];
  assert.match(privacy, /hanya teks transkrip/i);
  // The AI also reads the focus terms and note and the trend items (llm_selection.py): say so.
  assert.match(privacy, /kata kunci fokus/i);
  assert.match(privacy, /\btren\b/i);
  // Transkripsi lewat Groq (Pengaturan, off by default) sends the audio out: say so.
  assert.match(privacy, /Groq/);
  assert.match(privacy, /audio/i);
  assert.doesNotMatch(source, /tidak perlu dikirim ke API AI berbayar|Tidak ada biaya API/);
});

const catalogText = async (locale, namespace, key) => key.split(".").reduce(
  (value, part) => value?.[part],
  JSON.parse(await read(`messages/${locale}/${namespace}.json`)),
);

test("login shows the message for a wrong password and for too many attempts, from the catalog", async () => {
  // The route's ?error= codes (app/api/auth/login/route.js) name a message; the page says it in
  // the visitor's language (05 §6.2). The Indonesian text is the one the page showed before.
  assert.equal(loginErrorCode(undefined), null);
  assert.equal(loginErrorCode("1"), "invalid");
  assert.equal(loginErrorCode("limit"), "limited");
  // Unknown codes show nothing rather than echoing the query.
  for (const code of ["<b>x</b>", "0", ["1"], "toString", "__proto__", "invalid"]) assert.equal(loginErrorCode(code), null, String(code));
  assert.equal(await catalogText("id", "errors", "web.login_invalid"), "Nama pengguna atau kata sandi salah");
  assert.equal(await catalogText("id", "auth", "login.limited"), "Terlalu banyak percobaan. Tunggu beberapa menit, lalu coba lagi.");
  for (const locale of ["id", "en"]) {
    for (const [namespace, key] of [["errors", "web.login_invalid"], ["auth", "login.limited"], ["auth", "locale.failed"]]) {
      assert.ok(await catalogText(locale, namespace, key), `${locale} ${namespace}.${key}`);
    }
  }
  const source = await read("app/login/page.jsx");
  assert.match(source, /loginErrorCode\(params\?\.error\)/);
  assert.match(source, /code === "invalid" \? tErrors\("web\.login_invalid"\)/);
  assert.match(source, /code === "limited" \? t\("login\.limited"\)/);
  assert.match(source, /<p id="login-error" className=\{styles\.error\} role="alert">\{error\}<\/p>/);
  // A refused language change (?bahasa=gagal from POST /api/locale) is said in its own alert.
  assert.match(source, /params\?\.bahasa === "gagal"/);
  assert.match(source, /<p className=\{styles\.error\} role="alert">\{t\("locale\.failed"\)\}<\/p>/);
});

test("the login form posts the same fields to the same route, and works without JavaScript", async () => {
  const source = await read("app/login/page.jsx");
  assert.match(source, /<form className=\{styles\.form\} method="post" action="\/api\/auth\/login" autoComplete="on">/);
  assert.match(source, /<input type="hidden" name="next" value=\{next\} \/>/);
  assert.match(source, /<TextField name="username" type="text" isRequired autoFocus>/);
  assert.match(source, /<TextField name="password" type="password" isRequired>/);
  assert.match(source, /autoComplete="username"/);
  assert.match(source, /autoComplete="current-password"/);
  // A required field the browser refuses says why: React Aria hides the browser's own bubble.
  assert.equal(source.match(/<FieldError \/>/g)?.length, 2);
  assert.match(source, /<Button type="submit" variant="primary" className=\{styles\.submit\}>\{t\("login\.submit"\)\}<\/Button>/);
  // The login page is a card without the shell (05 §6.2): no tagline, note or poster aside.
  assert.doesNotMatch(source, /LANDING_MEDIA|<aside|styles\.note|styles\.intro/);
  // The segment layout loads the auth catalog for the client parts.
  assert.match(await read("app/login/layout.jsx"), /<SegmentI18n namespaces=\{\["auth"\]\}>/);
});

test("the login page carries the language picker as a second native form", async () => {
  const page = await read("app/login/page.jsx");
  assert.match(page, /<LanguageSwitcher variant="form" locales=\{locales\} current=\{locale\} next=\{loginLocaleNext\(params\)\} className=\{styles\.language\} \/>/);
  assert.match(page, /const locales = localeOptions\(\);/);
  const picker = await read("components/LanguageSwitcher.jsx");
  assert.match(picker, /^"use client";/);
  assert.match(picker, /if \(!Array\.isArray\(locales\) \|\| locales\.length < 2\) return null;/, "nothing to pick with one language");
  assert.match(picker, /<form method="post" action="\/api\/locale" className=\{className\}>/);
  assert.match(picker, /<select id=\{id\} name="locale" defaultValue=\{current\}/);
  assert.match(picker, /<option key=\{entry\.code\} value=\{entry\.code\} lang=\{entry\.code\}>\{entry\.label\}<\/option>/);
  assert.match(picker, /<input type="hidden" name="next" value=\{next\} \/>/);
  assert.match(picker, /<Button type="submit" variant="secondary"/);
  assert.match(picker, /t\("locale\.label"\)/);
  assert.match(picker, /t\("locale\.save"\)/);
  // Back to the same login page, keeping where it leads, without the old ?error or ?bahasa.
  assert.equal(loginLocaleNext({}), "/login");
  assert.equal(loginLocaleNext({ next: "/dashboard" }), "/login");
  assert.equal(loginLocaleNext({ next: "/projects/abc?klip=2", error: "1", bahasa: "gagal" }), "/login?next=%2Fprojects%2Fabc%3Fklip%3D2");
  for (const next of ["//evil.example", "https://evil.example", ["/x"], undefined]) assert.equal(loginLocaleNext({ next }), "/login", String(next));
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

test("login copy has no em dash, version label or English marketing label, in any language", async () => {
  const source = await read("app/login/page.jsx");
  assert.doesNotMatch(visibleText(source), FORBIDDEN_COPY);
  assert.doesNotMatch(source, /SELF-HOSTED|Face Tracking/);
  assert.match(source, /import styles from "\.\/login\.module\.css";/);
  // The words now live in the auth catalog: the same rules hold there, in every locale.
  for (const locale of ["id", "en"]) {
    const text = await read(`messages/${locale}/auth.json`);
    assert.doesNotMatch(text, FORBIDDEN_COPY, locale);
    assert.doesNotMatch(text, /SELF-HOSTED|Face Tracking/, locale);
  }
});
