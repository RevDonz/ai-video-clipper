"use client";

// The Transisi section (docs/plans/2026-10-02-transisi-cold-open.md §7.1), rendered by the Cold open
// panel and by Mode Cepat's Cold open card, so both views read the same by construction
// (docs/plans/2026-10-02-editor-mode-cepat.md §1.4, §11 Q2): the effect at the join of the cold
// open and the clip (SetJoinStyle), the whoosh (SetJoinSfx), and "Putar transisi", one second on
// each side of the join. Disabled controls point at the note that says why (aria-describedby) and
// repeat it on hover. `touch` gives the controls the card's 44 px targets.
import { useId, useMemo, useState } from "react";

import { runCommands } from "../transcript/actions.mjs";
import css from "./ColdOpenPanel.module.css";
import { TRANSITION_NOTE, TRANSITION_STYLES, transitionCommands, transitionStatus, transitionView } from "./coldopen-transition.mjs";
import styles from "./panels.module.css";
import { useAudition } from "./use-audition.js";

export default function TransitionSection({ doc, dispatch, player, readOnly, onResult, touch = false }) {
  const view = useMemo(() => transitionView(doc, { readOnly }), [doc, readOnly]);
  const audition = useAudition(player, doc.output.fps);
  const uid = useId();
  const noteId = `${uid}-note`;
  const [last, setLast] = useState(null);
  const off = !view.enabled;
  const reasonProps = off ? { "aria-describedby": noteId, title: view.reason } : {};
  const listening = audition.playing === "transition";

  const send = (command, choice) => {
    const result = runCommands(dispatch, [command]);
    onResult?.(result.ok ? null : result.message);
    setLast(result.ok ? choice : null);
  };

  return (
    <div className={styles.section} aria-labelledby={`${uid}-title`} data-coldopen-transition="" data-touch={touch ? "" : undefined}>
      <h3 className={styles.subtitle} id={`${uid}-title`}>Transisi</h3>
      <p className={styles.note} id={noteId} data-transition-note="">{view.reason ?? TRANSITION_NOTE}</p>
      <fieldset className={styles.fieldset} disabled={off}>
        <legend className={styles.legend}>Efek gambar</legend>
        <div className={css.presets}>
          {TRANSITION_STYLES.map((option) => (
            <label key={option.id} className={css.preset} data-transition-style={option.id}>
              <input type="radio" className={styles.cover} name={`${uid}-style`} value={option.id}
                checked={view.style === option.id} {...reasonProps}
                onChange={() => send(transitionCommands.style(option.id), { kind: "style", value: option.id })} />
              <span className={css.presetName}>{option.name}</span>
              <span className={css.presetDetail}>{option.detail}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className={styles.switch} title={off ? view.reason : undefined}>
        <input type="checkbox" role="switch" className={styles.switchInput} checked={view.sfxOn} disabled={off}
          aria-describedby={off ? noteId : undefined}
          onChange={(event) => send(transitionCommands.sfx(event.target.checked), { kind: "sfx", value: event.target.checked })} />
        <span className={styles.switchTrack} aria-hidden="true" />
        <span>Suara whoosh</span>
      </label>
      <div className={styles.row}>
        {/* Playing is not editing: it works in read-only too, as "Putar cold open" does. */}
        <button type="button" className={styles.button} disabled={!view.audition || !player?.seek}
          aria-describedby={view.audition ? undefined : noteId} title={view.audition ? undefined : view.reason}
          data-transition-audition={view.audition ? `${view.audition.f0}-${view.audition.f1}` : ""}
          onClick={() => (listening ? audition.stop() : audition.start("transition", view.audition))}>
          {listening ? "Hentikan" : "Putar transisi"}
        </button>
      </div>
      <p className={css.transitionStatus} role="status" data-transition-status="">{transitionStatus(last, view)}</p>
    </div>
  );
}
