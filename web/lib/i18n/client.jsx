"use client";

// The use-intl provider (rombak 07 §8). A nested provider replaces the messages, so every
// segment passes the core namespaces plus its own (components/SegmentI18n.jsx). Changing the
// language is always a full reload; nothing switches catalogs on the client.
import { IntlProvider } from "use-intl";

import { i18nHandlers } from "./handlers.mjs";
import { DEFAULT_LOCALE, localeEntry } from "./locales.mjs";

export default function I18n({ locale, messages, timeZone, now, strict = false, children }) {
  const entry = localeEntry(locale) ?? localeEntry(DEFAULT_LOCALE);
  const handlers = i18nHandlers({ locale: entry.code, strict, unavailable: messages?.common?.unavailable });
  return (
    <IntlProvider
      locale={entry.intl}
      messages={messages}
      timeZone={timeZone}
      now={now}
      onError={handlers.onError}
      getMessageFallback={handlers.getMessageFallback}
    >
      {children}
    </IntlProvider>
  );
}
