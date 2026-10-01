"use client";

// Musik (plan §11.3 T3.3, §5.6, §9.2, Appendix B): add, replace and remove a track; its volume,
// start, loop and fades; ducking with the Halus/Sedang/Kuat presets and the detail sliders; the
// clip's own volume; normalize with the loudness it reached; the peak_reduced and music-shorter
// notes; the one-time copyright notice. Every change is one Appendix B command (sliders merge into
// one undo step through their merge keys); the rules live in music-model.mjs.
// Props: { state, dispatch, player } (panels/index.mjs); optional `uploadAsset` (replaces the
// upload) and `uploadsEnabled` (POTONGIN_EDITOR_UPLOADS as a boolean, for the W3 integrator).
import { useEffect, useId, useRef, useState } from "react";

import {
  DUCK_PRESET_LIST,
  FILE_PROBLEM_TEXT,
  MUSIC_ACCEPT,
  RANGES,
  formatDb,
  formatFrames,
  formatMs,
  formatPosition,
  musicCommands,
  musicFileProblem,
  musicFileType,
  musicView,
  uploadErrorText,
} from "./music-model.mjs";
import { resolveUploadAsset } from "./music-upload.mjs";
import styles from "./MusicPanel.module.css";
import base from "./panels.module.css";

const NOTICE_KEY = "potongin-editor-music-notice";
const NAMES_KEY = "potongin-editor-music-names";
const MINUS = "−";

// Per-viewer conveniences only: the notice was read, and the file names of uploaded tracks (the
// document keeps only the asset's sha). Storage may be missing (private mode); nothing depends on it.
function noticeRead() {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

function markNoticeRead() {
  try {
    window.localStorage.setItem(NOTICE_KEY, "1");
  } catch {
    // the notice shows again next time
  }
}

function storedNames() {
  try {
    const names = JSON.parse(window.localStorage.getItem(NAMES_KEY) || "{}");
    return names && typeof names === "object" ? names : {};
  } catch {
    return {};
  }
}

function rememberName(assetId, name) {
  try {
    const names = storedNames();
    delete names[assetId];
    names[assetId] = name;
    const keys = Object.keys(names);
    for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete names[key];
    window.localStorage.setItem(NAMES_KEY, JSON.stringify(names));
  } catch {
    // the card falls back to "Musik terunggah"
  }
}

function Switch({ label, checked, disabled, onChange }) {
  return (
    <label className={base.switch}>
      <input type="checkbox" role="switch" className={base.switchInput} checked={checked} disabled={disabled}
        onChange={(event) => onChange(event.target.checked)} />
      <span className={base.switchTrack} aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

function Slider({ label, value, min, max, step, valueText, disabled, onChange, extra = null, note = null }) {
  const id = useId();
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <label htmlFor={id} className={styles.label}>{label}</label>
        <output htmlFor={id} className={styles.value}>{valueText}</output>
        {extra}
      </div>
      <input id={id} type="range" className={styles.range} min={min} max={max} step={step} value={value}
        aria-valuetext={valueText} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
      {note ? <p className={styles.hint}>{note}</p> : null}
    </div>
  );
}

function presetDb(cdb) {
  return `${MINUS}${cdb / 100} dB`;
}

function MusicPanelBody({ state, dispatch, uploadAsset, uploadsEnabled }) {
  const view = musicView(state);
  const uid = useId();
  const fileRef = useRef(null);
  const noticeButtonRef = useRef(null);
  const [upload, setUpload] = useState(null); // {phase: "notice"|"uploading"|"processing", replace, name, progress}
  const [message, setMessage] = useState(null); // {tone: "error"|"info", text}
  const [names, setNames] = useState(() => storedNames());
  const controllerRef = useRef(null);
  const replaceRef = useRef(false);
  // An upload outlives this panel (switching tabs does not cancel it); it applies to the
  // document as it is when the file arrives.
  const stateRef = useRef(state);
  stateRef.current = state;
  const fps = state.doc.output.fps;
  const readOnly = view.readOnly;
  const busy = upload !== null && upload.phase !== "notice";
  const canUpload = !readOnly && !busy && uploadsEnabled;

  useEffect(() => {
    if (upload?.phase === "notice") noticeButtonRef.current?.focus();
  }, [upload?.phase]);

  const run = (commands) => {
    for (const { type, args, mergeKey } of commands) {
      try {
        dispatch(type, args, { mergeKey });
      } catch (error) {
        setMessage({ tone: "error", text: error?.message || "Perubahan ini tidak bisa diterapkan." });
        return false;
      }
    }
    setMessage(null);
    return true;
  };

  const openPicker = (replace) => {
    replaceRef.current = replace;
    setUpload(null);
    fileRef.current?.click();
  };

  const start = (replace) => {
    setMessage(null);
    if (noticeRead()) openPicker(replace);
    else setUpload({ phase: "notice", replace });
  };

  const onFile = async (event) => {
    const picked = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!picked) return;
    const problem = musicFileProblem(picked);
    if (problem) {
      setMessage({ tone: "error", text: FILE_PROBLEM_TEXT[problem] });
      return;
    }
    const type = musicFileType(picked);
    const file = picked.type === type ? picked : new File([picked], picked.name, { type });
    const controller = new AbortController();
    controllerRef.current = controller;
    const replace = replaceRef.current;
    setMessage(null);
    setUpload({ phase: "uploading", replace, name: picked.name, progress: 0 });
    try {
      const send = uploadAsset ?? (await resolveUploadAsset());
      const dto = await send(stateRef.current.doc.base.job_id, file, "music", {
        signal: controller.signal,
        onProgress: (value) => setUpload((current) => (current && current.phase !== "notice"
          ? { ...current, progress: value, phase: value >= 1 ? "processing" : "uploading" } : current)),
      });
      const current = replace ? musicCommands.replace(stateRef.current.doc, dto) : musicCommands.add(dto);
      if (run(current)) {
        const assetId = `sha256:${String(dto.sha256).replace(/^sha256:/, "")}`;
        rememberName(assetId, picked.name);
        setNames((previous) => ({ ...previous, [assetId]: picked.name }));
      }
    } catch (error) {
      const text = uploadErrorText(error);
      setMessage(text === null ? { tone: "info", text: "Unggahan dibatalkan." } : { tone: "error", text });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setUpload(null);
    }
  };

  const progressText = upload && upload.phase !== "notice"
    ? upload.phase === "processing" ? `Memproses ${upload.name}…` : `Mengunggah ${upload.name} · ${Math.round(upload.progress * 100)}%`
    : null;

  return (
    <section data-panel="music" className={`${base.panel} ${styles.panel}`} aria-busy={busy}>
      <input ref={fileRef} type="file" accept={MUSIC_ACCEPT} hidden disabled={!canUpload} onChange={onFile} data-music-file="" />

      <div className={base.section}>
        <h2 className={base.title}>Musik latar</h2>
        {view.hasMusic ? (
          <div className={styles.card} data-music-card="">
            <p className={styles.name} data-music-name="">{names[view.assetId] ?? "Musik terunggah"}</p>
            <p className={styles.meta}>
              <span data-music-duration="">{view.durationText}</span>
              {view.lufsText ? <span>{` · kenyaringan lagu ${view.lufsText}`}</span> : null}
            </p>
            <div className={base.row}>
              <button type="button" className={base.button} disabled={!canUpload} onClick={() => start(true)}>Ganti musik</button>
              <button type="button" className={base.button} disabled={readOnly || busy} onClick={() => run(musicCommands.remove())}>Hapus musik</button>
            </div>
          </div>
        ) : (
          <>
            <p className={base.note}>
              Belum ada musik. Tambahkan lagu dari komputer: MP3, M4A, WAV, OGG atau FLAC, paling besar 50 MB dan 15 menit.
            </p>
            <button type="button" className={`${base.button} ${base.primary}`} disabled={!canUpload} onClick={() => start(false)}>
              Tambah musik
            </button>
          </>
        )}
        {uploadsEnabled ? null : <p className={styles.hint}>Unggah file belum diaktifkan di server ini.</p>}

        {upload?.phase === "notice" ? (
          <div className={styles.notice} role="group" aria-labelledby={`${uid}-notice`}>
            <p id={`${uid}-notice`} className={styles.noticeText}>
              Pakai musik yang boleh Anda gunakan. Lagu berhak cipta bisa membuat video dibisukan atau diblokir
              oleh pemeriksaan hak cipta di TikTok, Instagram dan YouTube (Content ID).
            </p>
            <div className={base.row}>
              <button ref={noticeButtonRef} type="button" className={`${base.button} ${base.primary}`}
                onClick={() => { markNoticeRead(); openPicker(upload.replace); }}>
                Pilih file musik
              </button>
              <button type="button" className={base.button} onClick={() => setUpload(null)}>Batal</button>
            </div>
          </div>
        ) : null}

        {progressText ? (
          <div className={styles.upload}>
            <p className={styles.uploadText} aria-live="polite">{progressText}</p>
            <progress className={styles.progress} max={1} value={upload.phase === "processing" ? undefined : upload.progress}
              aria-label={`Mengunggah ${upload.name}`} />
            <button type="button" className={base.button} aria-label="Batalkan unggahan"
              onClick={() => controllerRef.current?.abort()}>
              Batal
            </button>
          </div>
        ) : null}

        {message ? (
          <p className={message.tone === "error" ? styles.error : styles.info} role={message.tone === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        ) : null}

        {view.hasMusic ? (
          <>
            <Slider label="Volume musik" value={view.gainCdb} {...RANGES.gain_cdb} valueText={view.gainText} disabled={readOnly}
              onChange={(value) => run(musicCommands.gain(value))}
              extra={view.gainCdb !== view.defaultGainCdb ? (
                <button type="button" className={styles.reset} aria-label="Kembalikan volume musik" disabled={readOnly}
                  onClick={() => run(musicCommands.gain(view.defaultGainCdb))}>
                  Kembalikan
                </button>
              ) : null}
              note="Awalnya diatur dari kenyaringan lagu, supaya tidak menutupi suara." />
            <Slider label="Mulai dari" value={view.offsetSmp} min={0} max={view.maxOffsetSmp} step={RANGES.offset_step_smp}
              valueText={formatPosition(Math.floor(view.offsetSmp / 48))} disabled={readOnly}
              onChange={(value) => run(musicCommands.offset(value))}
              extra={<span className={styles.value}>{`/ ${view.durationText}`}</span>} />
            <Switch label="Ulangi sampai klip selesai" checked={view.loop} disabled={readOnly}
              onChange={(on) => run(musicCommands.loop(on))} />
            {view.shorter ? (
              <p className={styles.warning} role="status">
                Musik lebih pendek dari klip, jadi bagian akhir klip tanpa musik. Nyalakan &quot;Ulangi sampai klip selesai&quot;
                untuk mengisinya.
              </p>
            ) : null}
            <Slider label="Muncul perlahan" value={view.fadeInF} min={0} max={view.fadeMaxF} step={1}
              valueText={formatFrames(view.fadeInF, fps)} disabled={readOnly}
              onChange={(value) => run(musicCommands.fadeIn(value))} />
            <Slider label="Hilang perlahan" value={view.fadeOutF} min={0} max={view.fadeMaxF} step={1}
              valueText={formatFrames(view.fadeOutF, fps)} disabled={readOnly}
              onChange={(value) => run(musicCommands.fadeOut(value))} />
          </>
        ) : null}
      </div>

      {view.hasMusic ? (
        <div className={base.section}>
          <div className={base.sectionHead}>
            <h2 className={base.title}>Kecilkan saat bicara</h2>
          </div>
          <Switch label="Kecilkan musik saat ada suara" checked={view.duck.on} disabled={readOnly}
            onChange={(on) => run(musicCommands.duckOn(on))} />
          <fieldset className={`${base.fieldset} ${styles.duckSet}`} disabled={readOnly || !view.duck.on}>
            <legend className={base.legend}>Kekuatan</legend>
            <div className={styles.presets}>
              {DUCK_PRESET_LIST.map((preset) => (
                <label key={preset.id} className={styles.preset}>
                  <input type="radio" className={base.cover} name={`${uid}-duck`} value={preset.id}
                    checked={view.duck.preset === preset.id} onChange={() => run(musicCommands.duckPreset(preset.id))} />
                  <span className={styles.presetName}>{preset.name}</span>
                  <span className={styles.presetValue}>{presetDb(preset.depthCdb)}</span>
                </label>
              ))}
            </div>
            {view.duck.preset === "custom" ? <p className={styles.hint}>{`Kustom: ${view.duck.depthText}`}</p> : null}
            <details className={styles.details}>
              <summary className={styles.summary}>Atur detail</summary>
              <div className={styles.detailBody}>
                <Slider label="Kedalaman" value={view.duck.depth_cdb} {...RANGES.depth_cdb} valueText={view.duck.depthText}
                  disabled={readOnly || !view.duck.on} onChange={(value) => run(musicCommands.duckParam("depth_cdb", value))} />
                <Slider label="Waktu turun" value={view.duck.attack_ms} {...RANGES.attack_ms} valueText={formatMs(view.duck.attack_ms)}
                  disabled={readOnly || !view.duck.on} onChange={(value) => run(musicCommands.duckParam("attack_ms", value))}
                  note="Musik mulai turun sebelum kata pertama." />
                <Slider label="Waktu naik" value={view.duck.release_ms} {...RANGES.release_ms} valueText={formatMs(view.duck.release_ms)}
                  disabled={readOnly || !view.duck.on} onChange={(value) => run(musicCommands.duckParam("release_ms", value))} />
                <Slider label="Jeda tahan" value={view.duck.hold_ms} {...RANGES.hold_ms} valueText={formatMs(view.duck.hold_ms)}
                  disabled={readOnly || !view.duck.on} onChange={(value) => run(musicCommands.duckParam("hold_ms", value))}
                  note="Jeda bicara yang lebih pendek dari ini tidak membuat musik naik lagi." />
              </div>
            </details>
          </fieldset>
        </div>
      ) : null}

      <div className={base.section}>
        <h2 className={base.title}>Suara klip</h2>
        <Slider label="Volume suara asli" value={view.sourceGainCdb} {...RANGES.source_gain_cdb} valueText={view.sourceGainText}
          disabled={readOnly} onChange={(value) => run(musicCommands.sourceGain(value))} />
        <Switch label={`Samakan kenyaringan ke ${view.loudness.targetText}`} checked={view.loudness.on} disabled={readOnly}
          onChange={(on) => run(musicCommands.loudness(on))} />
        <div aria-live="polite" className={styles.statusBlock}>
          {view.loudness.achievedText ? <p className={styles.status} data-loudness="">{view.loudness.achievedText}</p> : null}
          {view.loudness.suggest ? <p className={styles.hint}>Disarankan saat ada musik agar volume stabil di semua klip.</p> : null}
          {view.peakText ? <p className={styles.warning} role="status">{view.peakText}</p> : null}
          {view.audioPending && !view.loudness.measuring ? <p className={styles.status}>Menyiapkan audio…</p> : null}
        </div>
      </div>
    </section>
  );
}

export default function MusicPanel({ state, dispatch, uploadAsset = null, uploadsEnabled = true }) {
  if (!state?.doc) {
    return (
      <section data-panel="music" className={base.panel} aria-busy="true">
        <p className={base.note}>Membuka panel Musik…</p>
      </section>
    );
  }
  return <MusicPanelBody state={state} dispatch={dispatch} uploadAsset={uploadAsset} uploadsEnabled={uploadsEnabled !== false} />;
}
