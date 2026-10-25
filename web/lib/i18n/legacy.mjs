// The Indonesian text of an error code, from web/messages/id/errors.json (rombak 07 §10.3): the
// "error" field responses keep for old clients and the worker's stageDetail for a coded failure.
// Server only (the catalog is read from disk), and free of next/headers so the worker
// (scripts/run-job.mjs) imports it too. lib/i18n/server.mjs re-exports it.
import { loadNamespaces } from "./catalog.mjs";
import { splitDetail } from "./errors.mjs";
import { SOURCE_LOCALE } from "./locales.mjs";

/** errors.<domain>.<code> in Indonesian, else errors.web.unknown. */
export function legacyMessage(code, domain = "web") {
  const errors = loadNamespaces(SOURCE_LOCALE, ["errors"]).errors;
  return errors?.[domain]?.[splitDetail(code).code] ?? errors.web.unknown;
}
