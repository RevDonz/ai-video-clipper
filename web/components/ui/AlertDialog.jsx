"use client";

// HeroUI's AlertDialog with its close trigger named in Indonesian (05-ui-dashboard.md §3.7). The
// parts are HeroUI's: AlertDialog.Backdrop > AlertDialog.Container > AlertDialog.Dialog >
// AlertDialog.Header/Heading/Body/Footer. Open it controlled (isOpen, onOpenChange on the root).
import { AlertDialog as HeroAlertDialog } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function CloseTrigger(props) {
  return <HeroAlertDialog.CloseTrigger aria-label={ARIA.close} {...props} />;
}

function AlertDialog(props) {
  return <HeroAlertDialog {...props} />;
}

export default Object.assign(AlertDialog, HeroAlertDialog, { CloseTrigger });
