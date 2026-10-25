"use client";

// "Hapus proyek" from the project page's ⋯ menu (05-ui-dashboard.md §6.4): an AlertDialog, then
// DELETE /api/jobs/[id] (the same route the Proyek list uses) and the Proyek list. Deletion is
// permanent and covers running jobs: the server revokes the worker's lease first.
import { Button } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import AlertDialog from "../../../components/ui/AlertDialog.jsx";
import { notifyJobsChanged } from "../../../lib/job-badge.mjs";
import styles from "./project.module.css";

export default function DeleteProject({ job, isOpen, onOpenChange }) {
  const t = useTranslations("project");
  const tAria = useTranslations("aria");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const change = (open) => {
    if (busy) return;
    if (!open) setError("");
    onOpenChange(open);
  };

  async function remove() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE", cache: "no-store", headers: { Accept: "application/json" } });
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent(`/projects/${job.id}`)}`);
        return;
      }
      if (!response.ok) throw new Error("refused");
      notifyJobsChanged();
      window.location.assign("/projects");
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof TypeError ? t("delete.offline") : t("delete.failed"));
    }
  }

  return (
    <AlertDialog.Backdrop isOpen={isOpen} onOpenChange={change} isKeyboardDismissDisabled={busy}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.CloseTrigger aria-label={tAria("close")} />
          <AlertDialog.Header>
            <AlertDialog.Heading>{t("delete.confirm")}</AlertDialog.Heading>
          </AlertDialog.Header>
          {error && (
            <AlertDialog.Body>
              <span className={styles.dialogError} role="alert">{error}</span>
            </AlertDialog.Body>
          )}
          <AlertDialog.Footer>
            <Button variant="secondary" autoFocus isDisabled={busy} onPress={() => change(false)}>{t("delete.keep")}</Button>
            <Button variant="danger" isPending={busy} onPress={remove}>{t("delete.yes")}</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
  </AlertDialog.Backdrop>
  );
}
