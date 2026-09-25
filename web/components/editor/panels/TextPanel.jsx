"use client";

// The text panel (plan §11.2 T2.7, §3.3, §5.4): captions on/off, the four packs (thumbnails
// rendered by FFmpeg from the pack files, pack-thumbs/), position, size, uppercase, and the
// highlight and keyword swatches; the hook on/off, its text with a counter and the fit badge from
// the server's layout ("Muat" / "Akan terpotong"), duration and position. Every change is one
// Appendix B command; sliders and typing merge into one undo step through their merge keys.
// Props: { state, dispatch, player } (panels/index.mjs).
import { useEffect, useRef, useState } from "react";

import { runCommands } from "../transcript/actions.mjs";
import boldThumb from "./pack-thumbs/bold.png";
import boxThumb from "./pack-thumbs/box.png";
import classicThumb from "./pack-thumbs/classic.png";
import karaokeThumb from "./pack-thumbs/karaoke.png";
import styles from "./panels.module.css";

const PACKS = [
  { id: "classic", name: "Klasik", note: "Putih bergaris hitam", thumb: classicThumb },
  { id: "karaoke", name: "Karaoke", note: "Kata terucap menyala", thumb: karaokeThumb },
  { id: "bold", name: "Bold", note: "Tebal, kata aktif berwarna", thumb: boldThumb },
  { id: "box", name: "Box", note: "Teks di kotak gelap", thumb: boxThumb },
];
const SWATCHES = [
  { value: "#FFE14D", name: "Kuning" }, { value: "#FFFFFF", name: "Putih" }, { value: "#3DF5A6", name: "Hijau" },
  { value: "#52C7FF", name: "Biru" }, { value: "#FF5C8A", name: "Merah muda" }, { value: "#FF9F1C", name: "Oranye" },
];
const HIGHLIGHT_PACKS = new Set(["karaoke", "bold"]);
const HOOK_MAX = 90;
const SECONDS = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const srcOf = (image) => (typeof image === "string" ? image : image?.src);
const clean = (text) => text.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
const points = (text) => [...text].length;

function hookItemOf(doc) {
  return doc.tracks?.find((track) => track.kind === "hook")?.items?.[0] ?? null;
}

function Switch({ label, checked, disabled, onChange, title }) {
  return (
    <label className={styles.switch} title={title}>
      <input type="checkbox" role="switch" className={styles.switchInput} checked={checked} disabled={disabled}
        onChange={(event) => onChange(event.target.checked)} />
      <span className={styles.switchTrack} aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

function Swatches({ legend, name, value, disabled, onChange, note }) {
  return (
    <fieldset className={styles.fieldset} disabled={disabled}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.swatchRow}>
        {SWATCHES.map((swatch) => (
          <label key={swatch.value} className={styles.swatch} style={{ "--swatch": swatch.value }} title={swatch.name}>
            <input type="radio" className={styles.cover} name={name} value={swatch.value} aria-label={swatch.name}
              checked={value === swatch.value} onChange={() => onChange(swatch.value)} />
          </label>
        ))}
      </div>
      {note ? <p className={styles.note}>{note}</p> : null}
    </fieldset>
  );
}

function TextPanelBody({ state, dispatch }) {
  const { doc, plan } = state;
  const readOnly = state.status !== "ready";
  const fps = doc.output.fps;
  const captions = doc.captions;
  const overrides = captions.overrides;
  const hook = hookItemOf(doc);
  const seedHook = state.seed ? hookItemOf(state.seed) : null;
  const [message, setMessage] = useState(null);
  const [draft, setDraft] = useState(hook?.payload.text ?? seedHook?.payload.text ?? "");
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Undo, redo or a merge changes the hook text from outside: show it unless it is the draft.
  const hookText = hook?.payload.text ?? null;
  useEffect(() => {
    if (hookText !== null && clean(draftRef.current) !== hookText) setDraft(hookText);
  }, [hookText]);

  const run = (type, args, mergeKey = null) => {
    const result = runCommands(dispatch, [{ type, args, mergeKey }]);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  };

  const onHookInput = (value) => {
    setDraft(value);
    const text = clean(value);
    if (!hook || !text || points(text) > HOOK_MAX || text === hook.payload.text) return;
    run("SetHookText", { text, origin: "user" }, "hook:text");
  };

  const draftText = clean(draft);
  const pendingText = state.pending?.includes("text");
  const overflow = Boolean(plan?.hook?.overflow) || Boolean(plan?.warnings?.some((warning) => warning.code === "hook_overflow"));
  const fit = !hook ? null : pendingText ? "checking" : overflow ? "overflow" : "fits";
  const fitLabel = { checking: "Memeriksa…", overflow: "Akan terpotong", fits: "Muat" }[fit];
  const maxHookFrames = Math.floor((30000 * fps[0]) / (1000 * fps[1]));
  // unsafe_zone (plan §3.7, K5): the caption's carries no ref, the hook's the hook item id.
  const unsafe = (plan?.warnings ?? []).filter((warning) => warning.code === "unsafe_zone");
  const unsafeCaption = unsafe.some((warning) => (warning.path ? warning.path.startsWith("/captions") : !warning.ref));
  const unsafeHook = hook !== null && unsafe.some((warning) => (warning.path ? warning.path.startsWith("/tracks") : warning.ref === hook.id));
  const hookEnableText = draftText || seedHook?.payload.text || "";

  return (
    <section data-panel="text" className={styles.panel} aria-busy={false}>
      {message ? <p className={styles.message} role="alert">{message}</p> : null}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Caption</h3>
          <Switch label="Tampilkan caption" checked={captions.enabled} disabled={readOnly}
            onChange={(on) => run("SetCaptionsEnabled", { on })} />
        </div>
        <fieldset className={styles.fieldset} disabled={readOnly}>
          <legend className={styles.legend}>Gaya caption</legend>
          <div className={styles.packs}>
            {PACKS.map((pack) => (
              <label key={pack.id} className={styles.pack} data-pack={pack.id}>
                <input type="radio" className={styles.cover} name="caption-pack" value={pack.id}
                  aria-describedby={`pack-note-${pack.id}`} checked={captions.pack.id === pack.id}
                  onChange={() => run("SetCaptionPack", { id: pack.id })} />
                <img className={styles.packThumb} src={srcOf(pack.thumb)} width={160} height={40} alt="" draggable={false} />
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
            disabled={readOnly} onChange={(event) => run("SetCaptionOverride", { key: "y_e5", value: Number(event.target.value) }, "cap:y_e5")} />
        </label>
        {unsafeCaption ? <p className={styles.warning}>Caption berada di area tombol TikTok/Reels; geser ke atas bila tertutup.</p> : null}
        <label className={styles.field}>
          <span>Ukuran caption</span>
          <span className={styles.value}>{Math.round(overrides.size_pm / 10)}%</span>
          <input type="range" className={styles.range} min={700} max={1400} step={50} value={overrides.size_pm}
            disabled={readOnly} onChange={(event) => run("SetCaptionOverride", { key: "size_pm", value: Number(event.target.value) }, "cap:size_pm")} />
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={overrides.case === "upper"} disabled={readOnly}
            onChange={(event) => run("SetCaptionOverride", { key: "case", value: event.target.checked ? "upper" : "asis" })} />
          <span>Huruf besar semua</span>
        </label>
        <Swatches legend="Warna sorot" name="caption-highlight" value={overrides.highlight} disabled={readOnly}
          onChange={(value) => run("SetCaptionOverride", { key: "highlight", value })}
          note={HIGHLIGHT_PACKS.has(captions.pack.id) ? "Kata yang sedang diucapkan." : "Dipakai oleh Karaoke dan Bold; tidak tampak di gaya ini."} />
        <Swatches legend="Warna kata kunci" name="caption-emphasis" value={overrides.emphasis} disabled={readOnly}
          onChange={(value) => run("SetCaptionOverride", { key: "emphasis", value })}
          note="Tandai kata kunci di Transkrip (pilih kata, Ctrl+E)." />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Hook</h3>
          <Switch label="Tampilkan hook" checked={hook !== null}
            disabled={readOnly || (hook === null && !hookEnableText)}
            title={hook === null && !hookEnableText ? "Tulis teks hook dulu" : undefined}
            onChange={(on) => run("SetHookEnabled", on ? { on: true, text: hookEnableText } : { on: false })} />
        </div>
        <label className={styles.stack}>
          <span>Teks hook</span>
          <textarea className={styles.textarea} rows={2} maxLength={HOOK_MAX} value={draft} disabled={readOnly || hook === null}
            spellCheck={false} onChange={(event) => onHookInput(event.target.value)} />
        </label>
        <div className={styles.meta}>
          <span data-hook-counter="" className={points(draftText) > HOOK_MAX ? styles.over : undefined}>{points(draftText)}/{HOOK_MAX}</span>
          {fit ? <span className={styles.badge} data-fit={fit} data-hook-fit="" role="status">{fitLabel}</span> : null}
        </div>
        {fit === "overflow" ? <p className={styles.note}>Hook tidak muat 3 baris; ujungnya akan diganti “…”. Persingkat teksnya.</p> : null}
        <label className={styles.field}>
          <span>Durasi hook</span>
          <span className={styles.value}>{hook ? `${SECONDS.format((hook.dur_f * fps[1]) / fps[0])} dtk` : "—"}</span>
          <input type="range" className={styles.range} min={15} max={maxHookFrames} step={1} value={hook?.dur_f ?? 15}
            disabled={readOnly || hook === null} onChange={(event) => run("SetHookDuration", { dur_f: Number(event.target.value) }, "hook:dur_f")} />
        </label>
        <label className={styles.field}>
          <span>Posisi hook</span>
          <span className={styles.value}>{hook ? `${Math.round(hook.transform.y_e5 / 1000)}% dari atas` : "—"}</span>
          <input type="range" className={styles.range} min={6000} max={40000} step={500} value={hook?.transform.y_e5 ?? 13000}
            disabled={readOnly || hook === null} onChange={(event) => run("SetHookY", { y_e5: Number(event.target.value) }, "hook:y_e5")} />
        </label>
        {unsafeHook ? <p className={styles.warning}>Hook masuk area atas yang tertutup UI aplikasi.</p> : null}
      </div>
    </section>
  );
}

export default function TextPanel({ state, dispatch }) {
  if (!state?.doc) {
    return (
      <section data-panel="text" className={styles.panel} aria-busy="true">
        <p className={styles.note}>Membuka panel Teks…</p>
      </section>
    );
  }
  return <TextPanelBody state={state} dispatch={dispatch} />;
}
