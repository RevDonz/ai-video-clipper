"use client";

// Mode Cepat's Logo & Musik card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Logo & Musik, §4.1):
// what U5 needs and no more. Logo: "Tambah logo" (a file picker), or its thumbnail and "Hapus";
// it is placed by dragging it on the preview. Musik: "Tambah musik" (the copyright notice the
// first time, the same notice as the Musik panel), or the file name, the ducking strength
// ("Saat ada suara": Halus, Sedang, Kuat) and "Hapus". Both uploads live outside the card
// (logoUploads, musicUploadFor), so they survive a card close and a view switch. "Atur detail di
// Mode Lengkap" opens the full panel. Props: the card bundle of cards.mjs.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { LOGO_ACCEPT, logoUploader, logoUploads } from "../gizmos/logo-upload.mjs";
import { logoPanelView, logoUploadCommand, logoUploadMessage, runLogoSteps } from "../panels/logo-model.mjs";
import { DUCK_PRESET_LIST, MUSIC_ACCEPT, musicCommands, musicView } from "../panels/music-model.mjs";
import { markMusicNoticeRead, musicNoticeRead, musicUploadFor } from "../panels/music-upload.mjs";
import Icon from "../ui/icons.jsx";
import PillButton from "../ui/PillButton.jsx";
import PillGroup from "../ui/PillGroup.jsx";
import styles from "./quick.module.css";

const DUCK_OPTIONS = DUCK_PRESET_LIST.map((preset) => ({ id: preset.id, label: preset.name }));

function Message({ message }) {
  if (!message) return null;
  return message.tone === "error"
    ? <p className={styles.message} role="alert">{message.text}</p>
    : <p className={styles.note} role="status">{message.text}</p>;
}

function Progress({ label, text, fraction, onCancel, cancelLabel }) {
  return (
    <div className={styles.upload}>
      <p className={styles.note} aria-live="polite">{text}</p>
      <progress className={styles.progress} max={1} value={fraction ?? undefined} aria-label={label} />
      <PillButton variant="quiet" aria-label={cancelLabel} onClick={onCancel}>Batal</PillButton>
    </div>
  );
}

function LogoSection({ state, dispatch, uploadAsset, uploadsEnabled, showLengkap }) {
  const view = logoPanelView(state);
  const logo = view.logo;
  const locked = !view.ready || view.readOnly;
  const upload = uploadAsset ?? logoUploader();
  const canUpload = Boolean(upload) && uploadsEnabled !== false && Boolean(view.jobId);
  const owner = `${view.jobId}/${state?.clipId ?? ""}`;
  const uploads = useSyncExternalStore(logoUploads.subscribe, logoUploads.getState, logoUploads.getState);
  const progress = uploads.progress?.owner === owner ? uploads.progress : null;
  const uploadMessage = uploads.message?.owner === owner ? uploads.message : null;
  const [refusal, setRefusal] = useState(null);
  const [thumbFailed, setThumbFailed] = useState(null);
  const inputRef = useRef(null);
  const uid = useId();
  const message = refusal ? { tone: "error", text: refusal } : uploadMessage;

  const onFile = (event) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || !canUpload || locked) return;
    setRefusal(null);
    // The store's dispatch outlives this card, so a finished upload still lands after it closes.
    logoUploads.start({
      owner, upload, jobId: view.jobId, file,
      onUploaded: (dto) => logoUploadMessage(runLogoSteps(dispatch, [logoUploadCommand(dto)])),
    });
  };
  const remove = () => {
    const refused = runLogoSteps(dispatch, [{ type: "RemoveLogo", args: {} }]);
    setRefusal(refused?.message ?? null);
    if (!refused) logoUploads.clearMessage();
  };
  const processing = progress?.phase === "processing";
  const percent = progress ? Math.round(progress.fraction * 100) : 0;
  const thumbOk = logo?.thumbUrl && thumbFailed !== logo.thumbUrl;

  return (
    <section className={styles.part} aria-labelledby={`${uid}-title`} data-extras="logo">
      <h3 id={`${uid}-title`} className={styles.partTitle}>Logo</h3>
      {logo ? (
        <div className={styles.asset}>
          <span className={styles.assetThumb}>
            {thumbOk ? <img key={logo.thumbUrl} src={logo.thumbUrl} alt="" draggable={false} onError={() => setThumbFailed(logo.thumbUrl)} /> : null}
          </span>
          <span className={styles.assetText}>
            <span className={styles.assetName}>{uploads.names[logo.assetId] ?? "Logo"}</span>
            <span className={styles.note}>Geser logo di pratinjau untuk menaruhnya.</span>
          </span>
          <PillButton variant="quiet" disabled={locked} aria-label="Hapus logo" onClick={remove}>Hapus</PillButton>
        </div>
      ) : (
        <button type="button" className={styles.addButton} disabled={locked || !canUpload || Boolean(progress)}
          aria-describedby={canUpload ? undefined : `${uid}-off`} onClick={() => inputRef.current?.click()}>
          <Icon name="logo" />
          Tambah logo
        </button>
      )}
      <input ref={inputRef} type="file" accept={LOGO_ACCEPT} hidden tabIndex={-1} aria-hidden="true" onChange={onFile} />
      {!canUpload && !view.readOnly ? <p id={`${uid}-off`} className={styles.note}>Unggah logo belum tersedia di server ini.</p> : null}
      {progress ? (
        <Progress label="Unggahan logo" text={processing ? "Memproses gambar…" : `Mengunggah ${progress.name} · ${percent}%`}
          fraction={processing ? null : progress.fraction} cancelLabel="Batalkan unggahan logo" onCancel={() => logoUploads.cancel()} />
      ) : null}
      <Message message={message} />
      <PillButton variant="quiet" className={styles.start} aria-describedby={`${uid}-title`} onClick={() => showLengkap?.("logo")}>
        Atur detail di Mode Lengkap
      </PillButton>
    </section>
  );
}

function MusicSection({ state, getState, dispatch, uploadAsset, uploadsEnabled, showLengkap }) {
  const view = musicView(state);
  const clipId = state.clipId ?? state.doc.clip_id;
  const music = musicUploadFor(clipId);
  const upload = useSyncExternalStore(music.subscribe, music.get, music.get);
  // The upload outlives this card: it reads the store as it is when the file arrives.
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveState = typeof getState === "function" ? getState : () => stateRef.current;
  const [notice, setNotice] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const inputRef = useRef(null);
  const noticeButtonRef = useRef(null);
  const uid = useId();
  const busy = upload.phase !== "idle";
  const canUpload = !view.readOnly && !busy && uploadsEnabled !== false;
  const message = refusal ? { tone: "error", text: refusal } : upload.message;

  useEffect(() => {
    if (notice) noticeButtonRef.current?.focus();
  }, [notice]);

  const pick = () => {
    setNotice(false);
    inputRef.current?.click();
  };
  const add = () => {
    music.clearMessage();
    setRefusal(null);
    if (musicNoticeRead()) pick();
    else setNotice(true);
  };
  const onFile = (event) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    setRefusal(null);
    music.start({ file, jobId: stateRef.current.doc.base.job_id, upload: uploadAsset, dispatch, getState: liveState });
  };
  const send = (commands) => {
    for (const { type, args, mergeKey } of commands) {
      try {
        dispatch(type, args, { mergeKey });
      } catch (error) {
        setRefusal(error?.message || "Perubahan ini tidak bisa diterapkan.");
        return;
      }
    }
    setRefusal(null);
    music.clearMessage();
  };
  const progressText = upload.phase === "processing"
    ? `Memproses ${upload.name}…` : `Mengunggah ${upload.name} · ${Math.round(upload.progress * 100)}%`;

  return (
    <section className={styles.part} aria-labelledby={`${uid}-title`} data-extras="music">
      <h3 id={`${uid}-title`} className={styles.partTitle}>Musik</h3>
      {view.hasMusic ? (
        <>
          <div className={styles.asset}>
            <span className={styles.assetText}>
              <span className={styles.assetName} data-music-name="">{upload.names[view.assetId] ?? "Musik terunggah"}</span>
              <span className={styles.note}>{view.durationText}</span>
            </span>
            <PillButton variant="quiet" disabled={view.readOnly || busy} aria-label="Hapus musik" onClick={() => send(musicCommands.remove())}>
              Hapus
            </PillButton>
          </div>
          <PillGroup legend="Saat ada suara" name={`${uid}-duck`} options={DUCK_OPTIONS}
            value={view.duck.on && view.duck.preset !== "custom" ? view.duck.preset : null} disabled={view.readOnly}
            onChange={(id) => send(musicCommands.duckPreset(id))} />
        </>
      ) : (
        <button type="button" className={styles.addButton} disabled={!canUpload} aria-describedby={uploadsEnabled === false ? `${uid}-off` : undefined}
          onClick={add}>
          <Icon name="music" />
          Tambah musik
        </button>
      )}
      <input ref={inputRef} type="file" accept={MUSIC_ACCEPT} hidden tabIndex={-1} aria-hidden="true" onChange={onFile} />
      {uploadsEnabled === false ? <p id={`${uid}-off`} className={styles.note}>Unggah file belum diaktifkan di server ini.</p> : null}
      {notice ? (
        <div className={styles.notice} role="group" aria-labelledby={`${uid}-notice`}>
          <p id={`${uid}-notice`} className={styles.noticeText}>
            Pakai musik yang boleh Anda gunakan. Lagu berhak cipta bisa membuat video dibisukan atau diblokir
            oleh pemeriksaan hak cipta di TikTok, Instagram dan YouTube (Content ID).
          </p>
          <div className={styles.row}>
            <PillButton ref={noticeButtonRef} variant="strong" onClick={() => { markMusicNoticeRead(); pick(); }}>Pilih file musik</PillButton>
            <PillButton variant="quiet" onClick={() => setNotice(false)}>Batal</PillButton>
          </div>
        </div>
      ) : null}
      {busy ? (
        <Progress label={`Mengunggah ${upload.name}`} text={progressText} fraction={upload.phase === "processing" ? null : upload.progress}
          cancelLabel="Batalkan unggahan musik" onCancel={() => music.cancel()} />
      ) : null}
      <Message message={message} />
      <PillButton variant="quiet" className={styles.start} aria-describedby={`${uid}-title`} onClick={() => showLengkap?.("music")}>
        Atur detail di Mode Lengkap
      </PillButton>
    </section>
  );
}

export default function ExtrasCard(props) {
  const { state } = props;
  if (!state?.doc) return <p className={styles.note} role="status">Membuka logo dan musik…</p>;
  return (
    <div className={styles.body} data-quick-body="extras">
      <LogoSection {...props} />
      <MusicSection {...props} />
    </div>
  );
}
