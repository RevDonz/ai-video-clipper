"use client";

// The text panel (plan §11.2 T2.7, §3.3, §5.4; T3.4 §7.1): captions on/off, the four packs
// (thumbnails rendered by FFmpeg from the pack files, pack-thumbs/), position, size, uppercase, and
// the highlight and keyword swatches; the hook on/off, its text with a counter and the fit badge
// from the server's layout ("Muat" / "Akan terpotong"), the hook suggestions under the text field,
// duration and position. Every change is one Appendix B command; sliders and typing merge into
// one undo step through their merge keys. The caption and hook rules (commands, notes, the hint
// that the caption sits near the hook) are caption-model.mjs and hook-model.mjs, shared with Mode
// Cepat's Caption and Hook cards (docs/plans/2026-10-02-editor-mode-cepat.md §1.4, §3).
// Props: { state, dispatch, player, api? } (panels/index.mjs). Without an `api` prop the panel
// uses the fake runtime's client (dev and CI) or its own client for the store's job and clip.
import { useEffect, useRef, useState } from "react";

import HookSuggestions from "../suggestions/index.jsx";
import { runCommands } from "../transcript/actions.mjs";
import Swatches from "../ui/Swatches.jsx";
import Switch from "../ui/Switch.jsx";
import {
  CAPTION_PACKS,
  CAPTION_SWATCHES,
  captionCommand,
  captionPackCommand,
  captionZoneNote,
  captionsEnabledCommand,
  highlightNote,
  hookNearNote,
} from "./caption-model.mjs";
import {
  HOOK_FIT_TEXT,
  HOOK_MAX,
  cleanHookText,
  hookEnableText,
  hookEnabledCommand,
  hookFit,
  hookItemOf,
  hookMissingGlyphs,
  hookPoints,
  hookTextCommand,
} from "./hook-model.mjs";
import { PACK_IMAGES, imageSrc } from "./pack-images.js";
import styles from "./panels.module.css";

const SECONDS = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function TextPanelBody({ state, dispatch, api }) {
  const { doc, plan } = state;
  const readOnly = state.status !== "ready";
  const fps = doc.output.fps;
  const captions = doc.captions;
  const overrides = captions.overrides;
  const hook = hookItemOf(doc);
  const seedHook = hookItemOf(state.seed);
  const [message, setMessage] = useState(null);
  const [draft, setDraft] = useState(hook?.payload.text ?? seedHook?.payload.text ?? "");
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Undo, redo or a merge changes the hook text from outside: show it unless it is the draft.
  const hookText = hook?.payload.text ?? null;
  useEffect(() => {
    if (hookText !== null && cleanHookText(draftRef.current) !== hookText) setDraft(hookText);
  }, [hookText]);

  const send = (command) => {
    const result = runCommands(dispatch, [command]);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  };
  const run = (type, args, mergeKey = null) => send({ type, args, mergeKey });

  const onHookInput = (value) => {
    setDraft(value);
    const command = hookTextCommand(doc, value);
    if (command) send(command);
  };

  const draftText = cleanHookText(draft);
  const fit = hookFit({ doc, plan, pending: state.pending });
  const maxHookFrames = Math.floor((30000 * fps[0]) / (1000 * fps[1]));
  // unsafe_zone (plan §3.7, K5): the caption's note or warning is caption-model's; the hook's
  // warning carries the hook item id.
  const zone = captionZoneNote(doc, state.seed, plan);
  const nearHook = hookNearNote(doc);
  const unsafeHook = hook !== null && (plan?.warnings ?? []).some((warning) => warning.code === "unsafe_zone"
    && (warning.path ? warning.path.startsWith("/tracks") : warning.ref === hook.id));
  const enableText = hookEnableText(draftText, state.seed);
  const missingGlyphs = hookMissingGlyphs(plan, doc);

  return (
    <section data-panel="text" className={styles.panel} aria-busy={false}>
      {message ? <p className={styles.message} role="alert">{message}</p> : null}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Caption</h3>
          <Switch label="Tampilkan caption" checked={captions.enabled} disabled={readOnly}
            onChange={(on) => send(captionsEnabledCommand(on))} />
        </div>
        <fieldset className={styles.fieldset} disabled={readOnly}>
          <legend className={styles.legend}>Gaya caption</legend>
          <div className={styles.packs}>
            {CAPTION_PACKS.map((pack) => (
              <label key={pack.id} className={styles.pack} data-pack={pack.id}>
                <input type="radio" className={styles.cover} name="caption-pack" value={pack.id}
                  aria-describedby={`pack-note-${pack.id}`} checked={captions.pack.id === pack.id}
                  onChange={() => send(captionPackCommand(pack.id))} />
                <img className={styles.packThumb} src={imageSrc(PACK_IMAGES[pack.id])} width={160} height={40} alt="" draggable={false} />
                <span className={styles.packName}>{pack.name}</span>
                <span className={styles.packNote} id={`pack-note-${pack.id}`}>{pack.note}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className={styles.field}>
          <span>Posisi caption</span>
          <span className={styles.value}>{Math.round(overrides.y_e5 / 1000)}% dari atas</span>
          <input type="range" className={styles.range} min={20000} max={92000} step={500} value={overrides.y_e5}
            disabled={readOnly} onChange={(event) => send(captionCommand("y_e5", Number(event.target.value), { drag: true }))} />
        </label>
        {zone ? (
          <p className={zone.tone === "warning" ? styles.warning : styles.note} data-caption-zone={zone.tone}>{zone.text}</p>
        ) : null}
        {nearHook ? <p className={styles.note} data-hook-near="">{nearHook}</p> : null}
        <label className={styles.field}>
          <span>Ukuran caption</span>
          <span className={styles.value}>{Math.round(overrides.size_pm / 10)}%</span>
          <input type="range" className={styles.range} min={700} max={1400} step={50} value={overrides.size_pm}
            disabled={readOnly} onChange={(event) => send(captionCommand("size_pm", Number(event.target.value), { drag: true }))} />
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={overrides.case === "upper"} disabled={readOnly}
            onChange={(event) => send(captionCommand("case", event.target.checked ? "upper" : "asis"))} />
          <span>Huruf besar semua</span>
        </label>
        <Swatches legend="Warna sorot" name="caption-highlight" value={overrides.highlight} options={CAPTION_SWATCHES}
          disabled={readOnly} onChange={(value) => send(captionCommand("highlight", value))} note={highlightNote(captions.pack.id)} />
        <Swatches legend="Warna kata kunci" name="caption-emphasis" value={overrides.emphasis} options={CAPTION_SWATCHES}
          disabled={readOnly} onChange={(value) => send(captionCommand("emphasis", value))}
          note="Tandai kata kunci di Transkrip (pilih kata, Ctrl+E)." />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Hook</h3>
          <Switch label="Tampilkan hook" checked={hook !== null}
            disabled={readOnly || (hook === null && !enableText)}
            title={hook === null && !enableText ? "Tulis teks hook dulu" : undefined}
            onChange={(on) => send(hookEnabledCommand(on, enableText))} />
        </div>
        <label className={styles.stack}>
          <span>Teks hook</span>
          <textarea className={styles.textarea} rows={2} maxLength={HOOK_MAX} value={draft} disabled={readOnly || hook === null}
            spellCheck={false} onChange={(event) => onHookInput(event.target.value)} />
        </label>
        <div className={styles.meta}>
          <span data-hook-counter="" className={hookPoints(draftText) > HOOK_MAX ? styles.over : undefined}>{hookPoints(draftText)}/{HOOK_MAX}</span>
          {fit ? <span className={styles.badge} data-fit={fit} data-hook-fit="" role="status">{HOOK_FIT_TEXT[fit]}</span> : null}
        </div>
        {fit === "overflow" ? <p className={styles.note}>Hook tidak muat 3 baris; ujungnya akan diganti “…”. Persingkat teksnya.</p> : null}
        {missingGlyphs.length ? (
          <p className={styles.warning} data-hook-glyphs="">
            Font hook tidak punya {missingGlyphs.join(", ")}; karakter ini tidak akan tampil di video.
          </p>
        ) : null}
        <HookSuggestions state={state} dispatch={dispatch} api={api} />
        <label className={styles.field}>
          <span>Durasi hook</span>
          <span className={styles.value}>{hook ? `${SECONDS.format((hook.dur_f * fps[1]) / fps[0])} dtk` : "Mati"}</span>
          <input type="range" className={styles.range} min={15} max={maxHookFrames} step={1} value={hook?.dur_f ?? 15}
            disabled={readOnly || hook === null} onChange={(event) => run("SetHookDuration", { dur_f: Number(event.target.value) }, "hook:dur_f")} />
        </label>
        <label className={styles.field}>
          <span>Posisi hook</span>
          <span className={styles.value}>{hook ? `${Math.round(hook.transform.y_e5 / 1000)}% dari atas` : "Mati"}</span>
          <input type="range" className={styles.range} min={6000} max={40000} step={500} value={hook?.transform.y_e5 ?? 13000}
            disabled={readOnly || hook === null} onChange={(event) => run("SetHookY", { y_e5: Number(event.target.value) }, "hook:y_e5")} />
        </label>
        {unsafeHook ? <p className={styles.warning}>Hook masuk area atas yang tertutup UI aplikasi.</p> : null}
      </div>
    </section>
  );
}

export default function TextPanel({ state, dispatch, api = null }) {
  if (!state?.doc) {
    return (
      <section data-panel="text" className={styles.panel} aria-busy="true">
        <p className={styles.note}>Membuka panel Teks…</p>
      </section>
    );
  }
  return <TextPanelBody state={state} dispatch={dispatch} api={api} />;
}
