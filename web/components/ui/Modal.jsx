"use client";

// HeroUI's Modal with its close trigger named in Indonesian (05-ui-dashboard.md §3.7). The parts
// are HeroUI's: Modal.Backdrop > Modal.Container > Modal.Dialog > Modal.Header/Heading/Body/Footer.
import { Modal as HeroModal } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function CloseTrigger(props) {
  return <HeroModal.CloseTrigger aria-label={ARIA.close} {...props} />;
}

function Modal(props) {
  return <HeroModal {...props} />;
}

export default Object.assign(Modal, HeroModal, { CloseTrigger });
