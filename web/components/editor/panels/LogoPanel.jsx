"use client";

// The Logo panel (plan §11.3 T3.2, §3.3, §5.5, §9.2): upload a PNG, JPEG or WebP, place it with
// the corner presets (or drag it on the stage, LogoGizmo), size, opacity, replace and remove, all
// through Appendix B's commands. The G5 note comes from the plan's `unsafe_zone` warning for the
// logo item (the server's check) and offers to move the logo just out of the TikTok zone.
// Props: { state, dispatch, player } (panels/index.mjs), plus optional `uploadAsset` (Appendix
// A.2) and `uploadsEnabled` (POTONGIN_EDITOR_UPLOADS) when the shell passes them.
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  LOGO_WIDTH_E5, OPACITY_PM, anchorFor, positionFor, resizeTo, transformSteps,
} from "../gizmos/logo-geometry.mjs";
import { LOGO_ACCEPT, logoUploadError, logoUploader } from "../gizmos/logo-upload.mjs";
import styles from "./logo.module.css";
import { logoPanelView, opacityLabel, sizeLabel } from "./logo-model.mjs";

const CORNERS = [
  { id: "top_left", label: "Kiri atas" }, { id: "top_right", label: "Kanan atas" },
  { id: "bottom_left", label: "Kiri bawah" }, { id: "bottom_right", label: "Kanan bawah" },
];
const TOO_TALL = "Logo ini terlalu tinggi untuk video. Pakai gambar yang lebih lebar.";

function commandText(error) {
  if (error?.code === "item_out_of_frame") return TOO_TALL;
  return typeof error?.message === "string" && error.message ? error.message : "Perubahan ini tidak bisa diterapkan.";
}

export default function LogoPanel({ state, dispatch, uploadAsset: uploadProp = null, uploadsEnabled = true }) {
  const view = logoPanelView(state);
  const logo = view.logo;
  const locked = !view.ready || view.readOnly;
  const upload = uploadProp ?? logoUploader();
  const canUpload = Boolean(upload) && uploadsEnabled !== false && Boolean(view.jobId);
  const inputRef = useRef(null);
  const activeRef = useRef(null);
  const [progress, setProgress] = useState(null); // { name, fraction, phase }
  const [message, setMessage] = useState(null); // { tone: "error" | "info", text }
  const [dragOver, setDragOver] = useState(false);
  const [names, setNames] = useState({}); // asset id → the file name it was uploaded as (this session)
  const [thumbFailed, setThumbFailed] = useState(null);
  const ids = { size: useId(), opacity: useId(), corners: useId(), help: useId() };

  useEffect(() => () => activeRef.current?.abort(), []);

  const run = useCallback((steps, mergeKey = null) => {
    try {
      for (const step of steps) dispatch(step.type, step.args, { mergeKey });
      setMessage(null);
      return true;
    } catch (error) {
      setMessage({ tone: "error", text: commandText(error) });
      return false;
    }
  }, [dispatch]);

  const startUpload = useCallback(async (file) => {
    if (!file || !canUpload || locked) return;
    activeRef.current?.abort();
    const controller = new AbortController();
    activeRef.current = controller;
    setMessage(null);
    setProgress({ name: file.name, fraction: 0, phase: "upload" });
    try {
      const dto = await upload(view.jobId, file, "logo", {
        signal: controller.signal,
        onProgress: (fraction, info) => {
          if (activeRef.current !== controller) return;
          setProgress({ name: file.name, fraction: Math.max(0, Math.min(1, Number(fraction) || 0)), phase: info?.phase ?? "upload" });
        },
      });
      if (activeRef.current !== controller) return;
      activeRef.current = null;
      setProgress(null);
      if (run([{ type: "SetLogo", args: { asset: dto.sha256, meta: dto } }])) {
        setNames((current) => ({ ...current, [`sha256:${dto.sha256}`]: dto.name ?? file.name }));
      }
    } catch (error) {
      if (activeRef.current !== controller) return;
      activeRef.current = null;
      setProgress(null);
      const mapped = logoUploadError(error);
      setMessage({ tone: mapped.cancelled ? "info" : "error", text: mapped.message });
    }
  }, [canUpload, locked, upload, view.jobId, run]);

  const onFiles = (files) => {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (file) startUpload(file);
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragOver(false);
    onFiles(event.dataTransfer?.files);
  };
  const onDragOver = (event) => {
    if (locked || !canUpload || !event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    setDragOver(true);
  };

  if (!view.ready) {
    return (
      <section data-panel="logo" className={styles.panel} aria-busy="true">
        <p className={styles.note}>Membuka panel Logo…</p>
      </section>
    );
  }

  const chooseFile = () => inputRef.current?.click();
  const fileInput = (
    <input ref={inputRef} type="file" accept={LOGO_ACCEPT} hidden tabIndex={-1} aria-hidden="true"
      onChange={(event) => onFiles(event.target.files)} />
  );
  const uploading = progress !== null;
  const percent = uploading ? Math.round(progress.fraction * 100) : 0;
  const notice = message && (
    message.tone === "error"
      ? <p className={`${styles.message} ${styles.error}`} role="alert" data-logo-error="">{message.text}</p>
      : <p className={`${styles.message} ${styles.info}`} role="status">{message.text}</p>
  );
  const processing = uploading && progress.phase === "processing";
  const progressView = uploading && (
    <div className={styles.progress} data-logo-upload="">
      <div className={styles.progressHead}>
        <span className={styles.progressName}>{processing ? "Memproses gambar…" : `Mengunggah ${progress.name}`}</span>
        {!processing && <span className={styles.value}>{`${percent}%`}</span>}
      </div>
      <div className={styles.track} role="progressbar" aria-label="Unggahan logo" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent} aria-valuetext={processing ? "Memproses gambar" : `${percent}%`}>
        <div className={styles.bar} style={{ width: `${percent}%` }} />
      </div>
      <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={() => activeRef.current?.abort()}>
        Batalkan unggahan
      </button>
    </div>
  );
  const unavailable = !canUpload && !view.readOnly && (
    <p className={styles.note}>Unggah logo belum tersedia di server ini.</p>
  );

  if (!logo) {
    return (
      <section data-panel="logo" className={styles.panel} aria-busy={uploading} onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <div className={styles.head}>
          <h2 className={styles.title}>Logo</h2>
          <p className={styles.note}>Tampil di atas caption, sepanjang klip.</p>
        </div>
        <div className={styles.drop} data-over={dragOver ? "true" : "false"}>
          <button type="button" className={`${styles.button} ${styles.primary}`} disabled={locked || !canUpload || uploading}
            onClick={chooseFile}>
            Unggah logo
          </button>
          <p className={styles.note}>atau seret file gambar ke sini</p>
          <p className={styles.note}>PNG, JPEG, atau WebP, maksimal 10 MB. PNG berlatar transparan hasilnya paling rapi.</p>
          {fileInput}
        </div>
        {unavailable}
        {progressView}
        {notice}
      </section>
    );
  }

  const { transform, meta, box, output } = { ...logo, output: view.output };
  const thumbOk = logo.thumbUrl && thumbFailed !== logo.thumbUrl;
  const setSize = (value) => {
    const target = resizeTo(transform, meta, output, value, anchorFor(box, output));
    const steps = target ? transformSteps(transform, meta, output, target) : null;
    if (steps?.length) run(steps, "logo:size");
  };
  const moveToSafe = () => {
    if (logo.safeTarget) run([{ type: "MoveLogo", args: positionFor(logo.safeTarget.x, logo.safeTarget.y, box, output) }]);
  };

  return (
    <section data-panel="logo" className={styles.panel} aria-busy={uploading} onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <div className={styles.head}>
        <h2 className={styles.title}>Logo</h2>
        <p className={styles.note}>Tampil di atas caption, sepanjang klip.</p>
      </div>

      <div className={styles.asset} data-over={dragOver ? "true" : "false"}>
        <div className={styles.thumb}>
          {thumbOk && (
            <img key={logo.thumbUrl} src={logo.thumbUrl} alt="" data-logo-thumb="" draggable={false}
              onError={() => setThumbFailed(logo.thumbUrl)} />
          )}
        </div>
        <div className={styles.assetText}>
          <span className={styles.assetName}>{names[logo.assetId] ?? "Logo"}</span>
          <span className={styles.note}>{`${meta.w} × ${meta.h} px`}</span>
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={locked || !canUpload || uploading} onClick={chooseFile}>Ganti logo</button>
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={locked}
              onClick={() => run([{ type: "RemoveLogo", args: {} }])}>
              Hapus logo
            </button>
            {fileInput}
          </div>
        </div>
      </div>
      {unavailable}
      {progressView}
      {notice}

      {logo.unsafe && (
        <div className={styles.warning} data-logo-unsafe="" role="status">
          <p>Logo berada di area yang tertutup tombol TikTok/Reels.</p>
          {logo.safeTarget && !locked && (
            <button type="button" className={styles.button} onClick={moveToSafe}>Geser ke area aman</button>
          )}
        </div>
      )}

      <div className={styles.section}>
        <fieldset className={styles.fieldset} disabled={locked} aria-describedby={ids.help}>
          <legend className={styles.legend}>Posisi cepat</legend>
          <div className={styles.corners}>
            {CORNERS.map((corner) => (
              <label key={corner.id} className={styles.corner}>
                <input type="radio" className={styles.cover} name={ids.corners} value={corner.id}
                  checked={logo.corner === corner.id}
                  onChange={() => run([{ type: "SnapLogo", args: { corner: corner.id } }])} />
                <span className={styles.glyph} data-corner={corner.id} aria-hidden="true" />
                <span>{corner.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className={styles.note} id={ids.help}>
          Seret logo di pratinjau untuk menaruhnya di mana saja; Alt mematikan magnet. Panah menggeser 1 px, Shift+panah 10 px.
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.field}>
          <span id={ids.size}>Ukuran</span>
          <span className={styles.value}>{sizeLabel(transform.w_e5, box)}</span>
          <input type="range" className={styles.range} min={LOGO_WIDTH_E5.min} max={LOGO_WIDTH_E5.max} step={100}
            value={transform.w_e5} disabled={locked} aria-labelledby={ids.size} aria-valuetext={sizeLabel(transform.w_e5, box)}
            onChange={(event) => setSize(Number(event.target.value))} />
        </div>
        <div className={styles.field}>
          <span id={ids.opacity}>Opasitas</span>
          <span className={styles.value}>{opacityLabel(transform.opacity_pm)}</span>
          <input type="range" className={styles.range} min={OPACITY_PM.min} max={OPACITY_PM.max} step={10}
            value={transform.opacity_pm} disabled={locked} aria-labelledby={ids.opacity}
            aria-valuetext={opacityLabel(transform.opacity_pm)}
            onChange={(event) => run([{ type: "SetLogoOpacity", args: { opacity_pm: Number(event.target.value) } }], "logo:opacity")} />
        </div>
      </div>
    </section>
  );
}
