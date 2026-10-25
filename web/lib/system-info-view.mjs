// The rows of Pengaturan "Tentang sistem" from GET /api/settings/system. Browser-safe (no Node
// imports). A value the server could not read, or one that does not look like what it should,
// shows as unknown. Labels are component names (the same in every language); the hint and the
// unknown/custom words are descriptors under the "settings" namespace (rombak 07 §8.3).

export const UNKNOWN = Object.freeze({ key: "system.unknown" });
const CUSTOM_MODEL = Object.freeze({ key: "system.customModel" });

const SHOWN = /^[0-9A-Za-z][0-9A-Za-z.+!~_-]{0,63}$/;

const ROWS = Object.freeze([
  { id: "ytDlp", label: "yt-dlp", hint: "system.hint.ytDlp", field: "ytDlp" },
  { id: "ffmpeg", label: "FFmpeg", hint: "system.hint.ffmpeg", field: "ffmpeg" },
  { id: "libass", label: "libass", hint: "system.hint.libass", field: "libass" },
  { id: "whisper", label: "Whisper", hint: "system.hint.whisper", field: "whisperModel" },
  { id: "commit", label: "Build", hint: "system.hint.commit", field: "commit" },
]);

function shown(value) {
  return typeof value === "string" && SHOWN.test(value) ? value : null;
}

/** `[{id, label, hint, value, known}]` in display order; `value` is a string or a descriptor. */
export function systemInfoRows(info) {
  return ROWS.map(({ id, label, hint, field }) => {
    let value = shown(info?.[field]);
    if (id === "whisper" && value === null && info?.whisperModelCustom === true) value = CUSTOM_MODEL;
    return { id, label, hint: { key: hint }, value: value ?? UNKNOWN, known: value !== null };
  });
}

/** Every key this module can name, for the catalog test and the card's lookup. */
export const SYSTEM_INFO_VIEW_KEYS = Object.freeze([UNKNOWN.key, CUSTOM_MODEL.key, ...ROWS.map((row) => row.hint)]);
