// The hook rules both editor views share (docs/plans/2026-10-02-editor-mode-cepat.md §1.2 HOOK,
// AC5): the text as stored (cleaned, at most 90 code points), the commands of the text field and
// the on/off switch, the fit badge from the plan, and the characters the hook font lacks. Mode
// Cepat's Hook card and Mode Lengkap's Teks panel both call these. Pure; no DOM.
import { LIMITS } from "../../../lib/editor/doc-model.mjs";

export const HOOK_MAX = LIMITS.hookText;

export const HOOK_FIT_TEXT = Object.freeze({ checking: "Memeriksa…", overflow: "Akan terpotong", fits: "Muat" });

/** The text as the store keeps it: NFC, control characters as spaces, trimmed. */
export function cleanHookText(text) {
  return String(text ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

/** Code points, the unit of the 90 limit (an emoji counts once). */
export function hookPoints(text) {
  return [...String(text ?? "")].length;
}

export function hookItemOf(doc) {
  return doc?.tracks?.find((track) => track.kind === "hook")?.items?.[0] ?? null;
}

/**
 * The command for typing `value` into the hook field, merged into one undo step (`hook:text`);
 * null when there is no hook, the text is empty or over the limit, or nothing changes.
 */
export function hookTextCommand(doc, value) {
  const hook = hookItemOf(doc);
  const text = cleanHookText(value);
  if (!hook || !text || hookPoints(text) > HOOK_MAX || text === hook.payload.text) return null;
  return { type: "SetHookText", args: { text, origin: "user" }, mergeKey: "hook:text" };
}

export function hookEnabledCommand(on, text = "") {
  return { type: "SetHookEnabled", args: on ? { on: true, text } : { on: false }, mergeKey: null };
}

/** The text "Tampilkan hook" turns the hook on with: the draft, else the seed's hook. */
export function hookEnableText(draftText, seed) {
  return cleanHookText(draftText) || hookItemOf(seed)?.payload?.text || "";
}

/** "checking" while the text plans, "overflow" when the server's layout cuts it, else "fits"; null without a hook. */
export function hookFit({ doc, plan, pending }) {
  if (!hookItemOf(doc)) return null;
  if (Array.isArray(pending) && pending.includes("text")) return "checking";
  const overflow = Boolean(plan?.hook?.overflow) || Boolean(plan?.warnings?.some((warning) => warning?.code === "hook_overflow"));
  return overflow ? "overflow" : "fits";
}

/** The plan's `glyph_unsupported:U+XXXX` warnings for the hook, as "😂 (U+1F602)" (plan §3.7). */
export function hookMissingGlyphs(plan, doc) {
  const hook = hookItemOf(doc);
  if (!hook) return [];
  return (Array.isArray(plan?.warnings) ? plan.warnings : [])
    .filter((warning) => typeof warning?.code === "string" && warning.code.startsWith("glyph_unsupported:") && warning.ref === hook.id)
    .map((warning) => warning.code.slice("glyph_unsupported:".length))
    .filter((code, index, all) => /^U\+[0-9A-F]{4,6}$/.test(code) && all.indexOf(code) === index)
    .map((code) => `${String.fromCodePoint(Number.parseInt(code.slice(2), 16))} (${code})`);
}
