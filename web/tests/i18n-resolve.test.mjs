// Which UI language a request gets (rombak 07 §5): user > cookie > Accept-Language > id, each
// only when enabled; the potongin_locale cookie and the header parser.
import assert from "node:assert/strict";
import test from "node:test";

import { LOCALE_COOKIE, localeCookie, readLocaleCookie } from "../lib/i18n/cookie.mjs";
import { parseAcceptLanguage, resolveLocale } from "../lib/i18n/resolve.mjs";

const BOTH = ["id", "en"];

test("Accept-Language: q-values order, ties keep the header's order, the primary subtag counts", () => {
  assert.equal(parseAcceptLanguage("en-GB,en;q=0.9", BOTH), "en");
  assert.equal(parseAcceptLanguage("fr-FR", BOTH), null);
  assert.equal(parseAcceptLanguage("fr;q=1, en;q=0.5, id;q=0.8", BOTH), "id");
  assert.equal(parseAcceptLanguage("en, id", BOTH), "en");
  assert.equal(parseAcceptLanguage("id, en", BOTH), "id");
  assert.equal(parseAcceptLanguage("EN-us", BOTH), "en");
  assert.equal(parseAcceptLanguage("id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7", BOTH), "id");
});

test("Accept-Language: \"in\" is Indonesian", () => {
  assert.equal(parseAcceptLanguage("ms-MY,in;q=0.8", BOTH), "id");
  assert.equal(parseAcceptLanguage("in-ID", BOTH), "id");
  assert.equal(parseAcceptLanguage("in", ["id"]), "id");
});

test("Accept-Language: q=0 and * are dropped, a broken q counts as 1", () => {
  assert.equal(parseAcceptLanguage("en;q=0, id", BOTH), "id");
  assert.equal(parseAcceptLanguage("en;q=0.000", BOTH), null);
  assert.equal(parseAcceptLanguage("*", BOTH), null);
  assert.equal(parseAcceptLanguage("*, en;q=0.1", BOTH), "en");
  assert.equal(parseAcceptLanguage("id;q=0.5, en;q=abc", BOTH), "en");
  assert.equal(parseAcceptLanguage("id;q=0.5, en;q=2", BOTH), "en");
  assert.equal(parseAcceptLanguage("id;q=0.5, en;q=-1", BOTH), "en");
});

test("Accept-Language: only enabled codes, and nothing from an absent, empty or oversized header", () => {
  assert.equal(parseAcceptLanguage("en-GB,en;q=0.9", ["id"]), null);
  assert.equal(parseAcceptLanguage(undefined, BOTH), null);
  assert.equal(parseAcceptLanguage(null, BOTH), null);
  assert.equal(parseAcceptLanguage("", BOTH), null);
  assert.equal(parseAcceptLanguage(`en,${"x".repeat(510)}`, BOTH), null);
  assert.equal(parseAcceptLanguage(`en,${"x".repeat(509)}`, BOTH), "en");
  // At most 32 entries are read.
  const many = [...Array.from({ length: 32 }, () => "fr"), "en"].join(",");
  assert.equal(parseAcceptLanguage(many, BOTH), null);
  assert.equal(parseAcceptLanguage([...Array.from({ length: 31 }, () => "fr"), "en"].join(","), BOTH), "en");
});

test("resolution order: user, then cookie, then Accept-Language, then id", () => {
  const all = { user: { locale: "en" }, cookie: "id", acceptLanguage: "en", enabled: BOTH };
  assert.equal(resolveLocale(all), "en");
  assert.equal(resolveLocale({ ...all, user: { locale: "id" }, cookie: "en" }), "id");
  assert.equal(resolveLocale({ ...all, user: null }), "id");
  assert.equal(resolveLocale({ ...all, user: null, cookie: "en", acceptLanguage: "id" }), "en");
  assert.equal(resolveLocale({ user: null, cookie: null, acceptLanguage: "en-US,en;q=0.9", enabled: BOTH }), "en");
  assert.equal(resolveLocale({ user: null, cookie: undefined, acceptLanguage: "fr", enabled: BOTH }), "id");
  assert.equal(resolveLocale({ enabled: BOTH }), "id");
});

test("a disabled or unknown candidate falls through to the next step", () => {
  assert.equal(resolveLocale({ user: { locale: "en" }, cookie: "en", acceptLanguage: "en", enabled: ["id"] }), "id");
  assert.equal(resolveLocale({ user: { locale: "xx" }, cookie: "en", acceptLanguage: "id", enabled: BOTH }), "en");
  assert.equal(resolveLocale({ user: { locale: null }, cookie: "fr", acceptLanguage: "en", enabled: BOTH }), "en");
  assert.equal(resolveLocale({ user: { locale: "__proto__" }, cookie: "toString", acceptLanguage: "constructor", enabled: BOTH }), "id");
});

test("the cookie: name, one year, Lax, always Secure, readable by the page", () => {
  assert.equal(LOCALE_COOKIE, "potongin_locale");
  assert.equal(localeCookie("en"), "potongin_locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.doesNotMatch(localeCookie("id"), /HttpOnly/i);
  assert.throws(() => localeCookie("xx"), /Unknown locale/);
  assert.throws(() => localeCookie("en; Domain=evil"), /Unknown locale/);
});

test("reading the cookie keeps only registered codes", () => {
  assert.equal(readLocaleCookie("potongin_locale=en"), "en");
  assert.equal(readLocaleCookie("a=1; potongin_locale=id; b=2"), "id");
  assert.equal(readLocaleCookie("potongin_locale=xx"), null);
  assert.equal(readLocaleCookie("potongin_locale="), null);
  assert.equal(readLocaleCookie("other_potongin_locale=en"), null);
  assert.equal(readLocaleCookie("potongin_locale=en-US"), null);
  assert.equal(readLocaleCookie(""), null);
  assert.equal(readLocaleCookie(undefined), null);
});
