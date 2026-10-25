"use client";

// "Batalkan" for a queued or running job (05-ui-dashboard.md §6.4): an AlertDialog "Batalkan
// proses ini?" whose focus starts on [Lanjutkan proses], the safe choice. Escape closes it and
// focus returns to Batalkan (React Aria). A browser dialog would block the page.
// `onSettled(job, note)` gets the job as the server has it afterwards: cancelled, or already
// finished, with a short note in that case.
import { Button } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import { notifyJobsChanged } from "../lib/job-badge.mjs";
import { cancelJob } from "../lib/job-cancel.mjs";
import styles from "./CancelJob.module.css";
import AlertDialog from "./ui/AlertDialog.jsx";

export default function CancelJob({ job, next, onSettled }) {
  const t = useTranslations("project");
  const tAria = useTranslations("aria");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function change(value) {
    if (busy) return;
    setOpen(value);
    if (!value) setError("");
  }

  async function confirmCancel() {
    setBusy(true);
    setError("");
    const result = await cancelJob(job.id, { next });
    if (result.type === "redirect") {
      window.location.assign(result.location);
      return;
    }
    setBusy(false);
    if (result.type === "error") {
      setError(result.message);
      return;
    }
    setOpen(false);
    notifyJobsChanged();
    onSettled(result.job, result.type === "finished" ? result.message : null);
  }

  return (
    <AlertDialog isOpen={open} onOpenChange={change}>
      <Button variant="secondary" className={styles.ask}>{t("cancel.ask")}</Button>
      <AlertDialog.Backdrop isKeyboardDismissDisabled={busy}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.CloseTrigger aria-label={tAria("close")} />
            <AlertDialog.Header>
              <AlertDialog.Heading>{t("cancel.confirm")}</AlertDialog.Heading>
            </AlertDialog.Header>
            {error && (
              <AlertDialog.Body>
                <span className={styles.error} role="alert">{error}</span>
              </AlertDialog.Body>
            )}
            <AlertDialog.Footer>
              <Button variant="secondary" autoFocus isDisabled={busy} onPress={() => change(false)}>{t("cancel.keep")}</Button>
              <Button variant="danger" isPending={busy} onPress={confirmCancel}>{busy ? t("cancel.busy") : t("cancel.yes")}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
