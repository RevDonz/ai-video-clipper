"use client";

// HeroUI's CloseButton names itself "Close"; this one says Tutup unless the caller names it.
import { CloseButton as HeroCloseButton } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

export default function CloseButton(props) {
  return <HeroCloseButton aria-label={ARIA.close} {...props} />;
}
