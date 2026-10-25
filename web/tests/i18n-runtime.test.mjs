// The i18n runtime pieces (rombak 07 §7.4, §10.3, §13.1): formatters per locale that keep the
// Indonesian output the literals gave, 24-hour clocks everywhere, the error-key helpers, and the
// missing-key handlers (strict in tests, a neutral text and one warning per key otherwise).
import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "use-intl/core";

import { loadNamespaces } from "../lib/i18n/catalog.mjs";
import { errorKey, errorText, helpAnchor, hintText, splitDetail } from "../lib/i18n/errors.mjs";
import { dateTimeFormat, displayNames, formatDateTime, formatNumber, intlOf, languageName, numberFormat, secondsFormat } from "../lib/i18n/format.mjs";
import { UNAVAILABLE_FALLBACK, i18nHandlers, strictI18n } from "../lib/i18n/handlers.mjs";

const MOMENT = new Date(Date.UTC(2026, 9, 25, 7, 5));
const UTC = { timeZone: "UTC" };

test("intlOf maps codes and tags, and falls back to Indonesian", () => {
  assert.equal(intlOf("id"), "id-ID");
  assert.equal(intlOf("en"), "en-US");
  assert.equal(intlOf("en-US"), "en-US");
  assert.equal(intlOf(), "id-ID");
  assert.equal(intlOf("xx"), "id-ID");
  assert.equal(intlOf(null), "id-ID");
});

test("Indonesian output is what the fixed id-ID calls gave", () => {
  const medium = { dateStyle: "medium", timeStyle: "short", ...UTC };
  assert.equal(formatDateTime(MOMENT, "id", medium), MOMENT.toLocaleString("id-ID", medium));
  assert.equal(dateTimeFormat("id", { hour: "2-digit", minute: "2-digit", ...UTC }).format(MOMENT),
    new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", ...UTC }).format(MOMENT));
  assert.equal(dateTimeFormat("id", { day: "numeric", month: "short", ...UTC }).format(MOMENT),
    new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", ...UTC }).format(MOMENT));
  for (const value of [0, 7, 1234567.891, 0.0004]) {
    assert.equal(formatNumber(value), value.toLocaleString("id-ID"));
    assert.equal(formatNumber(value, "id", { maximumFractionDigits: 1 }), value.toLocaleString("id-ID", { maximumFractionDigits: 1 }));
    assert.equal(secondsFormat("id").format(value), new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value));
  }
  assert.equal(displayNames("id", { type: "language" }).of("en"), new Intl.DisplayNames(["id"], { type: "language" }).of("en"));
});

test("clock times are 24-hour in every locale (Q8)", () => {
  assert.equal(dateTimeFormat("en", { hour: "2-digit", minute: "2-digit", ...UTC }).format(new Date(Date.UTC(2026, 0, 1, 15, 4))), "15:04");
  assert.doesNotMatch(formatDateTime(new Date(Date.UTC(2026, 0, 1, 15, 4)), "en", { dateStyle: "medium", timeStyle: "short", ...UTC }), /PM|AM/);
  // A caller that asks for a 12-hour clock explicitly still gets it.
  assert.match(dateTimeFormat("en", { hour: "numeric", hour12: true, ...UTC }).format(new Date(Date.UTC(2026, 0, 1, 15))), /PM/);
});

test("formatters follow the locale and are built once per locale and options", () => {
  assert.equal(formatNumber(1234.5, "en"), "1,234.5");
  assert.equal(formatNumber(1234.5, "id"), "1.234,5");
  assert.equal(numberFormat("en", { maximumFractionDigits: 1 }), numberFormat("en-US", { maximumFractionDigits: 1 }));
  assert.notEqual(numberFormat("en"), numberFormat("id"));
  assert.equal(languageName("en", "en"), "English");
  assert.equal(languageName("en", "id"), "Inggris");
  assert.equal(languageName("!!", "id"), null);
});

test("error keys: the messageId under errors., the detail split off", () => {
  assert.equal(errorKey("web.unauthorized"), "errors.web.unauthorized");
  assert.equal(errorKey("edit.glyph_unsupported:U+1F602"), "errors.edit.glyph_unsupported");
  assert.deepEqual(splitDetail("glyph_unsupported:U+1F602"), { code: "glyph_unsupported", detail: "U+1F602" });
  assert.deepEqual(splitDetail("rate_limited"), { code: "rate_limited", detail: null });
  assert.equal(helpAnchor({ code: "glyph_unsupported:U+1F602" }), "/bantuan#glyph_unsupported");
});

function translator(locale, strict = true) {
  const messages = loadNamespaces(locale, ["common", "errors.web", "errors.http"]);
  return createTranslator({ locale: intlOf(locale), messages, ...i18nHandlers({ locale, strict, unavailable: messages.common.unavailable }) });
}

test("errorText: the catalog text, else the server's own text, else the generic one", () => {
  const t = translator("en");
  assert.equal(errorText(t, { messageId: "web.unauthorized", legacyText: "Sesi login diperlukan" }), "Sign-in required");
  assert.equal(errorText(t, { messageId: "web.nope", legacyText: "Teks server" }), "Teks server");
  assert.equal(errorText(t, {}), "Something went wrong");
  assert.equal(errorText(translator("id"), { messageId: "http.s404" }), "Halaman tidak ditemukan");
  assert.equal(hintText(t, { messageId: "web.unauthorized" }), null);
});

test("a missing key throws when strict, else shows the neutral text and warns once", () => {
  assert.equal(strictI18n({ NODE_ENV: "test" }), true);
  assert.equal(strictI18n({ POTONGIN_I18N_STRICT: "1" }), true);
  assert.equal(strictI18n({ NODE_ENV: "production" }), false);
  assert.throws(() => translator("id")("errors.web.nope"));
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const t = translator("en", false);
    assert.equal(t("errors.web.nope"), UNAVAILABLE_FALLBACK);
    assert.equal(t("errors.web.nope"), UNAVAILABLE_FALLBACK);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[i18n\] en: /);
});
