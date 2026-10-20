// The rows of Pengaturan "Tentang sistem" from GET /api/settings/system. Browser-safe (no Node
// imports). A value the server could not read, or one that does not look like what it should,
// shows UNKNOWN.

export const UNKNOWN = "tidak diketahui";

const SHOWN = /^[0-9A-Za-z][0-9A-Za-z.+!~_-]{0,63}$/;

const ROWS = Object.freeze([
  { id: "ytDlp", label: "yt-dlp", hint: "Pengunduh video", field: "ytDlp" },
  { id: "ffmpeg", label: "FFmpeg", hint: "Pengolah video", field: "ffmpeg" },
  { id: "libass", label: "libass", hint: "Penggambar caption", field: "libass" },
  { id: "whisper", label: "Whisper", hint: "Model transkripsi", field: "whisperModel" },
  { id: "commit", label: "Build", hint: "Commit yang berjalan", field: "commit" },
]);

function shown(value) {
  return typeof value === "string" && SHOWN.test(value) ? value : null;
}

/** `[{id, label, hint, value, known}]` in display order. */
export function systemInfoRows(info) {
  return ROWS.map(({ id, label, hint, field }) => {
    let value = shown(info?.[field]);
    if (id === "whisper" && value === null && info?.whisperModelCustom === true) value = "Model kustom";
    return { id, label, hint, value: value ?? UNKNOWN, known: value !== null };
  });
}
