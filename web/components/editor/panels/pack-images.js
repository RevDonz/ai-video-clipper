// The caption packs' thumbnails (FFmpeg renders of the pack files, pack-thumbs/manifest.json), for
// the Teks panel and Mode Cepat's Caption card. Next imports a PNG as `{ src, width, height }`.
import boldThumb from "./pack-thumbs/bold.png";
import boxThumb from "./pack-thumbs/box.png";
import classicThumb from "./pack-thumbs/classic.png";
import karaokeThumb from "./pack-thumbs/karaoke.png";

export const PACK_IMAGES = Object.freeze({ classic: classicThumb, karaoke: karaokeThumb, bold: boldThumb, box: boxThumb });

/** The URL of an imported image (a string in some bundlers, `{ src }` in Next). */
export function imageSrc(image) {
  return typeof image === "string" ? image : image?.src;
}
