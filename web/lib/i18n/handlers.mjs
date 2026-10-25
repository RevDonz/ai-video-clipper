// What use-intl does with a missing key or a broken message (rombak 07 §7.4), shared by the
// server translator and the client provider. Strict (tests, POTONGIN_I18N_STRICT=1, the e2e
// server): throw, so a missing key fails. Otherwise: warn once per (locale, key) and show the
// neutral common.unavailable text, never the key's name.
const warned = new Set();

export const UNAVAILABLE_FALLBACK = "—";

export function strictI18n(env = process.env) {
  return env?.NODE_ENV === "test" || env?.POTONGIN_I18N_STRICT === "1";
}

export function i18nHandlers({ locale, strict, unavailable }) {
  const text = typeof unavailable === "string" && unavailable ? unavailable : UNAVAILABLE_FALLBACK;
  return {
    onError(error) {
      if (strict) throw error;
      const key = `${locale}\u0000${error?.message ?? error}`;
      if (warned.has(key)) return;
      warned.add(key);
      console.warn(`[i18n] ${locale}: ${error?.message ?? error}`);
    },
    getMessageFallback() {
      return text;
    },
  };
}
