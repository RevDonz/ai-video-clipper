// The 9:16 preview under "Tampilan klip" on the dashboard (app/dashboard/LookPreview.jsx). It draws
// only what a job option changes in the automatic render: the layout, the subtitle's pack, spot and
// size (CONTRACTS §5.47) and the hook text. With the legacy engine (the rollback switch) the
// subtitle keeps the one spot and size that engine draws. Geometry is in output pixels of the
// dashboard's 720×1280 render; web/tests/look-preview.test.mjs and caption-look.test.mjs keep every
// number equal to the engine's. Pure and DOM-free.
import { CAPTION_POSITION_CHOICES, CAPTION_SIZE_CHOICES, CAPTION_STYLE_CHOICES, LAYOUT_CHOICES, normalizeChoices } from "./dashboard-choices.mjs";
import { PREVIEW_BACKDROP } from "./editor/content-colours.mjs";

/** The dashboard's render size (web/scripts/run-job.mjs, edit_v2/seed.py DEFAULT_RENDER_SIZE). */
export const PREVIEW_FRAME = Object.freeze({ w: 720, h: 1280 });

/** The TikTok button zone at 720×1280 (edit_v2/__init__.py UI_ZONE_720, the editor's Zona aman). */
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
  editor: "Per klip bisa diubah lagi lewat Edit klip.",
  legacyEditor: "Geser atau ubah ukurannya per klip lewat Edit klip.",
});

// The thumbnails are FFmpeg renders on PREVIEW_BACKDROP. Over the stand-in picture that backdrop
// would read as a box no pack draws, so the preview keys it out: two feColorMatrix alpha rows,
// one for pixels brighter and one for pixels darker than the backdrop's luminance, summed into
// the thumbnail's mask (LookPreview.jsx). KEY_GAIN: a luminance step of 1/8 is fully opaque,
// enough for every pack's ink (white, black outline, the highlight and emphasis colours).
const KEY_GAIN = 8;
const LUMA = [0.2126, 0.7152, 0.0722];
const channel = (hex, at) => Number.parseInt(hex.slice(1 + 2 * at, 3 + 2 * at), 16) / 255;
const BACKDROP_LUMA = LUMA.reduce((sum, weight, at) => sum + weight * channel(PREVIEW_BACKDROP, at), 0);
const keyRow = (sign) => [
  ...Array(15).fill(0),
  ...LUMA.map((weight) => sign * KEY_GAIN * weight),
  0,
  -sign * KEY_GAIN * BACKDROP_LUMA,
].map((value) => (value === 0 ? "0" : value.toFixed(4))).join(" ");
export const CAPTION_KEY = Object.freeze({ brighter: keyRow(1), darker: keyRow(-1) });

const HOOK_SAMPLE = "Teks hook";
// A rough advance of a bold sans letter, in font sizes: the bar's width only has to look right.
const SAMPLE_ADVANCE = 0.6;
const LANDSCAPE = 16 / 9;

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * The preview of the next job's clips from the dashboard choices (anything unusable, or a look
 * `engine` does not draw, is the default, like stored choices). `editor` true adds that Edit klip
 * changes it per clip (it exists only while the editor is on). Returns the frame, the picture
 * (`fit`: the whole landscape video in `band` over its blurred copy; `fill`: cropped to the
 * frame), the subtitle thumbnail with its spot and size, the hook bar or null, the TikTok zone,
 * whether each text sits in it, the note and the accessible name.
 */
export function lookPreview(raw, { editor = false, engine } = {}) {
  const choices = normalizeChoices(raw, { engine });
  const { w, h } = PREVIEW_FRAME;
  const layout = LAYOUT_CHOICES.find((entry) => entry.id === choices.renderMode);
  const style = CAPTION_STYLE_CHOICES.find((entry) => entry.id === choices.captionStyle);
  const position = CAPTION_POSITION_CHOICES.find((entry) => entry.id === choices.captionPosition);
  const size = CAPTION_SIZE_CHOICES.find((entry) => entry.id === choices.captionSize);

  const bandHeight = w / LANDSCAPE;
  const picture = layout.id === "fit-blur"
    ? { mode: "fit", band: { x: 0, y: (h - bandHeight) / 2, w, h: bandHeight } }
    : { mode: "fill", band: null };

  // The thumbnail was cut around the subtitle at the pack's own spot; the engine anchors the
  // subtitle block at the middle of its bottom edge (y_e5) and scales it about there (size_pm).
  const seedBottom = (1 - AUTO_TEXT.captionBottom) * h;
  const bottom = round2((position.y_e5 / 100_000) * h);
  const scale = size.size_pm / 1000;
  const image = {
    x: round2(w / 2 + (THUMB_CROP.x - w / 2) * scale),
    y: round2(bottom + (THUMB_CROP.y - seedBottom) * scale),
    w: round2(THUMB_CROP.w * scale),
    h: round2(THUMB_CROP.h * scale),
  };
  const caption = { pack: style.id, name: style.name, position: position.id, size: size.id, image, bottom };

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
  const editorNote = engine === "legacy" ? LOOK_NOTES.legacyEditor : LOOK_NOTES.editor;
  const note = [captionInZone ? LOOK_NOTES.zone : null, editor === true ? editorNote : null].filter(Boolean).join(" ") || null;
  const sized = size.id === "medium" ? "" : ` ${size.name.toLowerCase()}`;
  const label = `Pratinjau klip 9:16: ${layout.name}, subtitle ${style.name}${sized} di ${position.name.toLowerCase()}, ${hook ? "teks hook di atas" : "tanpa teks hook"}.`;

  return { frame: { w, h }, picture, caption, hook, zone, captionInZone, hookInZone, note, label };
}
