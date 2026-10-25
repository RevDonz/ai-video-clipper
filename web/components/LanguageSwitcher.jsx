"use client";

// The UI language picker (rombak 07 §9.1). Both forms post to /api/locale, which sets the
// potongin_locale cookie and answers 303, so a change is always a full reload (07 §8.6).
// - default export, variant="form": a native <select> and a Simpan button, for /login (and the
//   invite, password-reset and /akun pages later). It works without JavaScript.
// - LanguageMenuForm: the hidden form behind the account menu's Bahasa section
//   (components/AccountMenu.jsx); the menu calls submit(code) on it.
// The language names are endonyms from the registry and are never translated. With one enabled
// language nothing is rendered.
import { Button } from "@heroui/react";
import { useId, useImperativeHandle, useRef } from "react";
import { useTranslations } from "use-intl";

import { menuNext } from "../lib/i18n/locales.mjs";

export default function LanguageSwitcher({ variant = "form", locales, current, next = "/", className }) {
  const t = useTranslations("auth");
  const id = useId();
  if (variant !== "form") throw new Error(`Unknown LanguageSwitcher variant: ${variant}`);
  if (!Array.isArray(locales) || locales.length < 2) return null;
  return (
    <form method="post" action="/api/locale" className={className}>
      <label htmlFor={id}>{t("locale.label")}</label>
      <select id={id} name="locale" defaultValue={current}>
        {locales.map((entry) => (
          <option key={entry.code} value={entry.code} lang={entry.code}>{entry.label}</option>
        ))}
      </select>
      <input type="hidden" name="next" value={next} />
      <Button type="submit" variant="secondary">{t("locale.save")}</Button>
    </form>
  );
}

/** The account menu's hidden form: `ref.current.submit(code)` posts it, back to this page. */
export function LanguageMenuForm({ ref }) {
  const formRef = useRef(null);
  const localeRef = useRef(null);
  const nextRef = useRef(null);
  useImperativeHandle(ref, () => ({
    submit(code) {
      if (!formRef.current) return;
      localeRef.current.value = code;
      nextRef.current.value = menuNext(window.location);
      formRef.current.requestSubmit();
    },
  }), []);
  return (
    <form ref={formRef} method="post" action="/api/locale" hidden>
      <input ref={localeRef} type="hidden" name="locale" />
      <input ref={nextRef} type="hidden" name="next" />
    </form>
  );
}
