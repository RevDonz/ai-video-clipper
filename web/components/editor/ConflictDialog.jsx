"use client";

// The per-part conflict dialog (plan §4.5 "409 rebase", step 3; Appendix C.6 "Conflict"). The store
// (T2.5) replays the pending commands onto the saved document; only when a precondition fails it
// reports the parts that clash as `state.conflict = { groups: [{ id, label, … }], error }` (T2.5;
// the T2.6 specs' `{ parts: [{ id, label }] }` is read too, shell-model conflictParts) ("Teks hook",
// "Potongan 00:12", "Caption kata 'Ijal'"). Each part is answered "Pakai punyaku" / "Pakai yang
// tersimpan" and the choices go back through `onResolve({ [id]: "mine" | "theirs" })`. The draft
// is never discarded, so Escape does not dismiss the question.
import { useEffect, useRef, useState } from "react";

import { conflictParts } from "./shell-model.mjs";
import styles from "./shell.module.css";

export default function ConflictDialog({ conflict, onResolve }) {
  const dialogRef = useRef(null);
  const parts = conflictParts(conflict);
  const problem = typeof conflict?.error?.message === "string" ? conflict.error.message : null;
  const open = parts.length > 0;
  const [choices, setChoices] = useState({});
  const partKey = parts.map((part) => part.id).join("\n");

  useEffect(() => {
    setChoices(Object.fromEntries(partKey.split("\n").filter(Boolean).map((id) => [id, "mine"])));
  }, [partKey]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="editor-conflict-title" onCancel={(event) => event.preventDefault()}>
      {open && (
        <form method="dialog" onSubmit={(event) => { event.preventDefault(); onResolve(choices); }}>
          <div className={styles.dialogHeader}>
            <h2 id="editor-conflict-title">Klip ini diubah di tab lain</h2>
          </div>
          <div className={styles.dialogBody}>
            <p className={styles.muted}>
              Sebagian perubahan Anda bertabrakan dengan versi yang tersimpan. Pilih versi untuk tiap bagian; draf Anda tetap aman
              di browser ini.
            </p>
            {problem && <p className={styles.notice} role="alert">{problem}</p>}
            {parts.map((part, index) => (
              <fieldset key={part.id} className={styles.fieldset}>
                <legend>{part.label}</legend>
                <div className={styles.radioRow}>
                  {[["mine", "Pakai punyaku"], ["theirs", "Pakai yang tersimpan"]].map(([value, label]) => (
                    <label key={value} htmlFor={`conflict-${index}-${value}`}>
                      <input
                        id={`conflict-${index}-${value}`}
                        type="radio"
                        name={`conflict-${index}`}
                        value={value}
                        checked={choices[part.id] === value}
                        onChange={() => setChoices((current) => ({ ...current, [part.id]: value }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <div className={styles.dialogFooter}>
            <button type="submit" className={`${styles.button} ${styles.primary}`}>Terapkan pilihan</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
