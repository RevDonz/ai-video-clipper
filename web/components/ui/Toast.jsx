"use client";

// HeroUI's toast region with the region and each close button named in Indonesian
// (05-ui-dashboard.md §3.7). Results of actions go through toast() (P8).
import { Toast as HeroToast, toast } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function ToastItem({ toast: item }) {
  const { title, description, variant } = item.content ?? {};
  return (
    <HeroToast toast={item} variant={variant}>
      <HeroToast.Content>
        {title ? <HeroToast.Title>{title}</HeroToast.Title> : null}
        {description ? <HeroToast.Description>{description}</HeroToast.Description> : null}
      </HeroToast.Content>
      <HeroToast.CloseButton aria-label={ARIA.dismiss} />
    </HeroToast>
  );
}

export function ToastRegion({ placement = "bottom end", ...props }) {
  return (
    <HeroToast.Provider aria-label={ARIA.notifications} placement={placement} {...props}>
      {(renderProps) => <ToastItem toast={renderProps.toast} />}
    </HeroToast.Provider>
  );
}

export { toast };
