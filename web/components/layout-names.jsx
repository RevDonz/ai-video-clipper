"use client";

// The layout names of the catalog (layout.names.<mode>, lib/layout-names.mjs), one literal key
// each so tests/i18n-usage can follow them. Buat klip and the project page read them from here.
import { useTranslations } from "use-intl";

import { renderModeLayout } from "../lib/layout-names.mjs";

export function useLayoutNames() {
  const t = useTranslations("layout");
  return {
    auto: t("names.auto"),
    camera: t("names.camera"),
    fill_center: t("names.fill_center"),
    fit_blur: t("names.fit_blur"),
    split: t("names.split"),
  };
}

/** The name of a job's render mode ("fit-blur"), or null for an unknown one. */
export function useRenderModeName() {
  const names = useLayoutNames();
  return (renderMode) => names[renderModeLayout(renderMode)] ?? null;
}
