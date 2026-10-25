// A segment's use-intl provider (rombak 07 §8.2): a nested provider replaces the messages, so it
// carries the core namespaces plus the segment's own. Server component.
import I18n from "../lib/i18n/client.jsx";
import { CORE } from "../lib/i18n/catalog.mjs";
import { providerProps } from "../lib/i18n/server.mjs";

export default async function SegmentI18n({ namespaces = [], children }) {
  const i18n = await providerProps([...CORE, ...namespaces]);
  return <I18n {...i18n}>{children}</I18n>;
}
