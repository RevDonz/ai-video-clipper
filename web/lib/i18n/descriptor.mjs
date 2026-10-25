// Message descriptors (rombak 05 §3.8, 07 §8.3): a view module returns what to show as
// { key, values? } with a full catalog key, and the component turns it into text with
// msg(t, descriptor), t being useTranslations() without a namespace (or getT on the server).
// A value may itself be a descriptor ("Diproses · {stage}"); it is translated first. An API
// error ({ error: { messageId, code, params, legacyText } }) is shown through errorText.
// Pure, so client components and tests use it alike.
import { errorText } from "./errors.mjs";

const isDescriptor = (value) => Boolean(value) && typeof value === "object" && typeof value.key === "string";

/** A descriptor; `values` is left out when there are none. */
export function d(key, values) {
  return values && Object.keys(values).length ? { key, values } : { key };
}

/** The text of a descriptor; a plain string passes through, null/undefined is "". */
export function msg(t, descriptor) {
  if (descriptor === null || descriptor === undefined) return "";
  if (typeof descriptor === "string") return descriptor;
  if (descriptor && typeof descriptor === "object" && descriptor.error && typeof descriptor.error === "object") return errorText(t, descriptor.error);
  if (!isDescriptor(descriptor)) return "";
  if (!descriptor.values) return t(descriptor.key);
  const values = {};
  for (const [name, value] of Object.entries(descriptor.values)) values[name] = isDescriptor(value) ? msg(t, value) : value;
  return t(descriptor.key, values);
}
