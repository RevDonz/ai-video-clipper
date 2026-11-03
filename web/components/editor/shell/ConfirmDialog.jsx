"use client";

// A small confirmation of the one-layout editor (rombak 06 §10 #51, #61): React Aria's modal
// alert dialog. Escape cancels and focus goes back to the control that opened it. The actions are
// the caller's, so a file picker can open inside their click.
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";

import styles from "../panels/tabs.module.css";

export default function ConfirmDialog({ open, title, children, actions, onCancel }) {
  return (
    <ModalOverlay className={styles.confirmBackdrop} isOpen={open} isDismissable onOpenChange={(next) => { if (!next) onCancel?.(); }}>
      <Modal>
        <Dialog className={styles.confirm} role="alertdialog">
          <Heading slot="title" className={styles.confirmTitle}>{title}</Heading>
          {children}
          <div className={styles.confirmActions}>{actions}</div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
