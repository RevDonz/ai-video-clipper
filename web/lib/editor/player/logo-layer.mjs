// Logo layer of the editor player (plan §5.5, §6.2 "Logo layer").
//
// The server derives the logo to its exact pixel box with the opacity baked in
// (preview/derived/<sha16>@<w>x<h>.png) and overlays those same pixels in the export. The
// browser draws the same PNG 1:1 at (x0, y0): drawImage(bitmap, x, y) with no scaling and no
// globalAlpha, decoded without colour-space conversion (the PNG has no colour chunks). The only
// difference left is the blend arithmetic (gate P-LOGO). A bitmap that is not exactly the box is
// refused, because drawing it would scale.

function defaultDecode(blob, options) {
  return createImageBitmap(blob, options);
}

const DECODE_OPTIONS = Object.freeze({ colorSpaceConversion: "none", premultiplyAlpha: "default" });

export function createLogoLayer({ fetchImpl = globalThis.fetch?.bind(globalThis), decode = defaultDecode } = {}) {
  let dto = null;
  let bitmap = null;
  let bitmapUrl = null;
  let pending = null; // the url being loaded

  function release() {
    bitmap?.close?.();
    bitmap = null;
    bitmapUrl = null;
  }

  return {
    /** Loads the logo of a plan DTO (null: no logo). Rejects on a fetch or size failure. */
    async load(next) {
      if (!next) {
        dto = null;
        pending = null;
        release();
        return;
      }
      if (bitmap && bitmapUrl === next.url) {
        if (bitmap.width !== next.box.w || bitmap.height !== next.box.h) {
          dto = null;
          throw new Error("logo_size_mismatch");
        }
        dto = next;
        return;
      }
      dto = null;
      pending = next.url;
      const response = await fetchImpl(next.url);
      if (!response.ok) {
        if (pending === next.url) pending = null;
        throw new Error(`logo_fetch_failed:${response.status}`);
      }
      const decoded = await decode(await response.blob(), DECODE_OPTIONS);
      if (pending !== next.url) {
        decoded?.close?.();
        return;
      }
      pending = null;
      if (decoded.width !== next.box.w || decoded.height !== next.box.h) {
        decoded?.close?.();
        throw new Error("logo_size_mismatch");
      }
      release();
      bitmap = decoded;
      bitmapUrl = next.url;
      dto = next;
    },
    /** True when `next` (a plan's logo, or null) is loaded and can be drawn. */
    readyFor(next) {
      if (!next) return true;
      return Boolean(bitmap && dto && bitmapUrl === next.url && dto.box.x === next.box.x
        && dto.box.y === next.box.y && dto.box.w === next.box.w && dto.box.h === next.box.h);
    },
    draw(ctx) {
      if (!bitmap || !dto) return;
      ctx.drawImage(bitmap, dto.box.x, dto.box.y);
    },
    destroy() {
      dto = null;
      pending = null;
      release();
    },
  };
}
