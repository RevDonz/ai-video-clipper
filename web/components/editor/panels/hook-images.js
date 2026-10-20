// The hook designs' thumbnails (FFmpeg renders of the design files, hook-thumbs/manifest.json), for
// Mode Cepat's Hook card and the Teks panel. Next imports a PNG as `{ src, width, height }`.
import blokThumb from "./hook-thumbs/blok.png";
import kickerThumb from "./hook-thumbs/kicker.png";
import kotakThumb from "./hook-thumbs/kotak.png";
import barThumb from "./hook-thumbs/legacy-bar.png";

export const HOOK_IMAGES = Object.freeze({ "legacy-bar": barThumb, kicker: kickerThumb, blok: blokThumb, kotak: kotakThumb });
