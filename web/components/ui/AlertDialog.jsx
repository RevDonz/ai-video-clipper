"use client";

// HeroUI's AlertDialog with its close trigger named in Indonesian unless the caller names it
// (05-ui-dashboard.md §3.7). The parts are HeroUI's: AlertDialog.Backdrop > .Container > .Dialog >
// .Header/.Heading/.Body/.Footer. A confirmation (Batalkan, Hapus proyek) lives in its own file,
// so it may hold the one primary action of the overlay (P1).
import { AlertDialog as HeroAlertDialog } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function CloseTrigger(props) {
  return <HeroAlertDialog.CloseTrigger aria-label={ARIA.close} {...props} />;
}

function AlertDialog(props) {
  return <HeroAlertDialog {...props} />;
}

export default Object.assign(AlertDialog, HeroAlertDialog, { CloseTrigger });
