// The 9:16 preview under "Tampilan klip" on the dashboard (app/dashboard/LookPreview.jsx). It draws
// only what a job option changes in the automatic render: the layout, the subtitle style and the
// hook text. The subtitle's spot and size are fixed there, so the preview shows them as they are
// and points to the editor for changing them per clip. Geometry is in output pixels of the
// dashboard's 720×1280 render; web/tests/look-preview.test.mjs keeps every number equal to the
// engine's. Pure and DOM-free.
import { CAPTION_STYLE_CHOICES, LAYOUT_CHOICES, normalizeChoices } from "./dashboard-choices.mjs";

/** The dashboard's render size (web/scripts/run-job.mjs, edit_v2/seed.py DEFAULT_RENDER_SIZE). */
export const PREVIEW_FRAME = Object.freeze({ w: 720, h: 1280 });

/** The TikTok button zone at 720×1280 (edit_v2/plan.py UI_ZONE_720, the editor's Zona aman). */
export const TIKTOK_ZONE = Object.freeze({ top: 93, bottom: 280, right: 93 });

/**
 * Where the automatic render puts text (captions_ass.py), as fractions of the output: the
 * subtitle's bottom margin, the hook's top margin, the side margin of both, and the hook's largest
 * font size and box padding.
 */
export const AUTO_TEXT = Object.freeze({ captionBottom: 0.17, hookTop: 0.13, side: 0.06, hookFont: 0.046, hookPadding: 0.011 });

/** The part of the 720×1280 frame each subtitle thumbnail shows (pack-thumbs/manifest.json "crop"). */
export const THUMB_CROP = Object.freeze({ x: 80, y: 950, w: 560, h: 140 });

export const LOOK_NOTES = Object.freeze({
  zone: "Subtitle ada di bawah, dekat area tombol TikTok.",
  editor: "Geser atau ubah ukurannya per klip lewat Edit klip.",
});

const HOOK_SAMPLE = "Teks hook";
// A rough advance of a bold sans letter, in font sizes: the bar's width only has to look right.
const SAMPLE_ADVANCE = 0.6;
const LANDSCAPE = 16 / 9;

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * The preview of the next job's clips from the dashboard choices (anything unusable is the
 * default, like stored choices). `editor` true adds where to move the subtitle (Edit klip exists
 * only while the editor is on). Returns the frame, the picture (`fit`: the whole landscape video
 * in `band` over its blurred copy; `fill`: cropped to the frame), the subtitle thumbnail and its
 * spot, the hook bar or null, the TikTok zone, whether each text sits in it, the note and the
 * accessible name.
 */
export function lookPreview(raw, { editor = false } = {}) {
  const choices = normalizeChoices(raw);
  const { w, h } = PREVIEW_FRAME;
  const layout = LAYOUT_CHOICES.find((entry) => entry.id === choices.renderMode);
  const style = CAPTION_STYLE_CHOICES.find((entry) => entry.id === choices.captionStyle);

  const bandHeight = w / LANDSCAPE;
  const picture = layout.id === "fit-blur"
    ? { mode: "fit", band: { x: 0, y: (h - bandHeight) / 2, w, h: bandHeight } }
    : { mode: "fill", band: null };

  const caption = { pack: style.id, name: style.name, image: { ...THUMB_CROP }, bottom: round2((1 - AUTO_TEXT.captionBottom) * h) };

  let hook = null;
  if (choices.hookOverlay) {
    const fontSize = round2(AUTO_TEXT.hookFont * h);
    const padding = round2(AUTO_TEXT.hookPadding * h);
    const width = Math.min(w - 2 * AUTO_TEXT.side * w, round2(HOOK_SAMPLE.length * SAMPLE_ADVANCE * fontSize + 2 * padding));
    hook = {
      text: HOOK_SAMPLE,
      fontSize,
      box: { x: round2((w - width) / 2), y: round2(AUTO_TEXT.hookTop * h), w: width, h: round2(fontSize + 2 * padding) },
    };
  }

  const zone = { ...TIKTOK_ZONE };
  const captionInZone = caption.bottom > h - zone.bottom;
  const hookInZone = hook !== null && hook.box.y < zone.top;
  const note = [captionInZone ? LOOK_NOTES.zone : null, editor === true ? LOOK_NOTES.editor : null].filter(Boolean).join(" ") || null;
  const label = `Pratinjau klip 9:16: ${layout.name}, subtitle ${style.name} di bawah, ${hook ? "teks hook di atas" : "tanpa teks hook"}.`;

  return { frame: { w, h }, picture, caption, hook, zone, captionInZone, hookInZone, note, label };
}
