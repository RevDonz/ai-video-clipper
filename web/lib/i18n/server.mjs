// The i18n glue for server components and route handlers (rombak 07 §5.4). use-intl has no RSC
// integration: the server translates with createTranslator, client components with
// useTranslations under <I18n> (components/SegmentI18n.jsx, app/layout.jsx).
import { cookies, headers } from "next/headers";
import { createFormatter, createTranslator } from "use-intl/core";

import { loadNamespaces } from "./catalog.mjs";
import { LOCALE_COOKIE } from "./cookie.mjs";
import { splitDetail } from "./errors.mjs";
import { i18nHandlers, strictI18n } from "./handlers.mjs";
import { DEFAULT_LOCALE, SOURCE_LOCALE, enabledLocales, localeEntry } from "./locales.mjs";
import { resolveLocale } from "./resolve.mjs";

// Until users.time_zone exists (i18n M7b) every server render uses this zone; dates that depend
// on the viewer's device are rendered on the client.
export const DEFAULT_TIME_ZONE = "Asia/Jakarta";

/** user.locale > potongin_locale cookie > Accept-Language > "id". Makes the route dynamic. */
export async function getLocale({ user } = {}) {
  const [store, list] = await Promise.all([cookies(), headers()]);
  return resolveLocale({
    user,
    cookie: store.get(LOCALE_COOKIE)?.value,
    acceptLanguage: list.get("accept-language"),
    enabled: enabledLocales(),
  });
}

const intlOf = (locale) => (localeEntry(locale) ?? localeEntry(DEFAULT_LOCALE)).intl;

/** The merged messages of `namespaces` for `locale` (subtrees such as "errors.web" allowed). */
export async function messagesFor(locale, namespaces) {
  return loadNamespaces(localeEntry(locale) ? locale : DEFAULT_LOCALE, ["common", ...namespaces]);
}

/** A translator scoped to one namespace (or subtree): t("root.title") inside "meta". */
export async function getT(locale, namespace) {
  const messages = await messagesFor(locale, [namespace]);
  return createTranslator({
    locale: intlOf(locale),
    messages,
    namespace,
    timeZone: await getTimeZone(),
    ...i18nHandlers({ locale, strict: strictI18n(), unavailable: messages.common?.unavailable }),
  });
}

export function getFormat(locale, timeZone = DEFAULT_TIME_ZONE) {
  return createFormatter({ locale: intlOf(locale), timeZone, now: new Date() });
}

export async function getTimeZone() {
  return DEFAULT_TIME_ZONE;
}

/**
 * A route's title and description from meta.<route> (07 §8.4), plus any fixed fields such as
 * robots. The root layout's title template adds " · Potongin".
 */
export async function routeMetadata(route, extra = {}) {
  const t = await getT(await getLocale(), "meta");
  return { title: t(`${route}.title`), description: t(`${route}.description`), ...extra };
}

/** The Indonesian text of an error code, for the "error" field responses keep (07 §10.3). */
export function legacyMessage(code, domain = "web") {
  const errors = loadNamespaces(SOURCE_LOCALE, ["errors"]).errors;
  return errors?.[domain]?.[splitDetail(code).code] ?? errors.web.unknown;
}

/** The provider props of a server component: locale, messages, zone, clock, strictness. */
export async function providerProps(namespaces) {
  const locale = await getLocale();
  const messages = await messagesFor(locale, namespaces);
  return { locale, messages, timeZone: await getTimeZone(), now: new Date(), strict: strictI18n() };
}
