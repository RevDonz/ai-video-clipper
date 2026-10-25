"use client";

// The test page's dialog: its own file, so it may hold the one primary action of the overlay.
import { Button } from "@heroui/react";

import Modal from "../../components/ui/Modal.jsx";

export default function HarnessModal() {
  return (
    <Modal>
      <Button variant="secondary">Buka dialog</Button>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Hapus proyek?</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p>Klip dan file hasilnya ikut terhapus.</p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" slot="close">Batal</Button>
              <Button variant="primary" slot="close">Hapus proyek</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
