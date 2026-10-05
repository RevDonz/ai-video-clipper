"use client";

// Musik (plan §11.3 T3.3, §5.6, §9.2, Appendix B): add, replace and remove a track; its volume,
// start, loop and fades; ducking with the Halus/Sedang/Kuat presets and the detail sliders; the
// clip's own volume; normalize with the loudness it reached; the peak_reduced and music-shorter
// notes; the one-time copyright notice. Every change is one Appendix B command (sliders merge into
// one undo step through their merge keys); the rules live in music-model.mjs. The upload is the
// clip's (music-upload.mjs `musicUploadFor`), not this panel's: it goes on when the panel closes,
// and Mode Cepat's Logo & Musik card shows and starts the same one.
// Props: { state, dispatch, player } (panels/index.mjs); optional `uploadAsset` (replaces the
// upload) and `uploadsEnabled` (POTONGIN_EDITOR_UPLOADS as a boolean, for the W3 integrator).
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import PillGroup from "../ui/PillGroup.jsx";
import Switch from "../ui/Switch.jsx";
import {
  DUCK_PRESET_LIST,
  MUSIC_ACCEPT,
  RANGES,
  formatFrames,
  formatMs,
  formatPosition,
  musicCommands,
  musicView,
} from "./music-model.mjs";
import { markMusicNoticeRead, musicNoticeRead, musicUploadFor } from "./music-upload.mjs";
import styles from "./MusicPanel.module.css";
import base from "./panels.module.css";

const MINUS = "−";
const DUCK_OPTIONS = DUCK_PRESET_LIST.map((preset) => ({ id: preset.id, label: preset.name, detail: `${MINUS}${preset.depthCdb / 100} dB` }));

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

function MusicPanelBody({ state, dispatch, uploadAsset, uploadsEnabled, music }) {
  const view = musicView(state);
  const uid = useId();
  const fileRef = useRef(null);
  const noticeButtonRef = useRef(null);
  const upload = useSyncExternalStore(music.subscribe, music.get, music.get);
  const [notice, setNotice] = useState(null); // { replace } while the copyright notice shows
  const [message, setMessage] = useState(null); // a refused command: { tone: "error", text }
  const replaceRef = useRef(false);
  // The upload applies to the document as it is when the file arrives.
  const stateRef = useRef(state);
  stateRef.current = state;
  const fps = state.doc.output.fps;
  const readOnly = view.readOnly;
  const busy = upload.phase !== "idle";
  const canUpload = !readOnly && !busy && uploadsEnabled;
  const shown = message ?? upload.message;

  useEffect(() => {
    if (notice) noticeButtonRef.current?.focus();
  }, [notice]);

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
    music.clearMessage();
    return true;
  };

  const openPicker = (replace) => {
    replaceRef.current = replace;
    setNotice(null);
    fileRef.current?.click();
  };

  const start = (replace) => {
    setMessage(null);
    music.clearMessage();
    if (musicNoticeRead()) openPicker(replace);
    else setNotice({ replace });
  };

  const onFile = (event) => {
    const picked = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!picked) return;
    setMessage(null);
    music.start({ file: picked, jobId: stateRef.current.doc.base.job_id, upload: uploadAsset, dispatch,
      getState: () => stateRef.current, replace: replaceRef.current });
  };

  const progressText = busy
    ? upload.phase === "processing" ? `Memproses ${upload.name}…` : `Mengunggah ${upload.name} · ${Math.round(upload.progress * 100)}%`
    : null;

  return (
    <section data-panel="music" className={`${base.panel} ${styles.panel}`} aria-busy={busy}>
      <input ref={fileRef} type="file" accept={MUSIC_ACCEPT} hidden disabled={!canUpload} onChange={onFile} data-music-file="" />

      <div className={base.section}>
        <h2 className={base.title}>Musik latar</h2>
        {view.hasMusic ? (
          <div className={styles.card} data-music-card="">
            <p className={styles.name} data-music-name="">{upload.names[view.assetId] ?? "Musik terunggah"}</p>
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

        {notice ? (
          <div className={styles.notice} role="group" aria-labelledby={`${uid}-notice`}>
            <p id={`${uid}-notice`} className={styles.noticeText}>
              Pakai musik yang boleh Anda gunakan. Lagu berhak cipta bisa membuat video dibisukan atau diblokir
              oleh pemeriksaan hak cipta di TikTok, Instagram dan YouTube (Content ID).
            </p>
            <div className={base.row}>
              <button ref={noticeButtonRef} type="button" className={`${base.button} ${base.primary}`}
                onClick={() => { markMusicNoticeRead(); openPicker(notice.replace); }}>
                Pilih file musik
              </button>
              <button type="button" className={base.button} onClick={() => setNotice(null)}>Batal</button>
            </div>
          </div>
        ) : null}

        {progressText ? (
          <div className={styles.upload}>
            <p className={styles.uploadText} aria-live="polite">{progressText}</p>
            <progress className={styles.progress} max={1} value={upload.phase === "processing" ? undefined : upload.progress}
              aria-label={`Mengunggah ${upload.name}`} />
            <button type="button" className={base.button} aria-label="Batalkan unggahan" onClick={() => music.cancel()}>
              Batal
            </button>
          </div>
        ) : null}

        {shown ? (
          <p className={shown.tone === "error" ? styles.error : styles.info} role={shown.tone === "error" ? "alert" : "status"}>
            {shown.text}
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
          <div className={styles.duckSet}>
            <PillGroup legend="Kekuatan" name={`${uid}-duck`} options={DUCK_OPTIONS} value={view.duck.preset} columns={3}
              disabled={readOnly || !view.duck.on} onChange={(id) => run(musicCommands.duckPreset(id))} />
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
          </div>
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
  const music = musicUploadFor(state?.clipId ?? state?.doc?.clip_id ?? null);
  if (!state?.doc || !music) {
    return (
      <section data-panel="music" className={base.panel} aria-busy="true">
        <p className={base.note}>Membuka panel Musik…</p>
      </section>
    );
  }
  return <MusicPanelBody state={state} dispatch={dispatch} uploadAsset={uploadAsset} uploadsEnabled={uploadsEnabled !== false}
    music={music} />;
}
