"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";

import {
  buildNextRevision,
  classifyEditorSaveFailure,
  createEditorSaveAttempt,
  currentCaptionCue,
  loadEditorWorkspace,
  shouldWarnUnsaved,
  validateEditorDraft,
  validateSavedEditorResponse,
} from "../../../../../../lib/editor-view.mjs";
import { formatDuration } from "../../../../../../lib/candidate-view.mjs";

const SAVE_DELAY_MS = 1200;
const deepCopy = (value) => structuredClone(value);
const editableJson = (value) => JSON.stringify({ visual: value.visual, caption_style: value.caption_style, captions: value.captions, overlays: value.overlays, audio: value.audio });
const isoNow = () => new Date().toISOString();

function FieldError({ id, message }) { return message ? <small id={id} className="editorFieldError">{message}</small> : null; }

const ERROR_LABELS = {
  "visual.render_mode": "Mode preview", "visual.focal": "Titik fokus",
  "caption_style.font_size": "Ukuran font", "caption_style.background_opacity": "Opasitas latar",
  "caption_style.max_chars_per_line": "Karakter per baris", "caption_style.max_lines": "Maksimum baris",
  "audio.gain_db": "Gain audio", "title.text": "Teks judul", "title.position": "Posisi judul",
};
function validationLabel(key) {
  const cue = /^captions\.(\d+)\.text$/.exec(key);
  if (cue) return `Caption ${Number(cue[1]) + 1}`;
  if (key.startsWith("visual.safe_area.")) return `Margin aman ${key.split(".").at(-1)}`;
  return ERROR_LABELS[key] || key;
}

function EditorWorkspace({ id, candidateId, loaded }) {
  const [draft, setDraft] = useState(() => deepCopy(loaded.manifest));
  const [snapshot, setSnapshot] = useState(() => deepCopy(loaded.manifest));
  const [etag, setEtag] = useState(loaded.etag);
  const [dirty, setDirty] = useState(false);
  const [locked, setLocked] = useState(false);
  const [saveState, setSaveState] = useState({ status: "idle", message: "Semua perubahan tersimpan." });
  const [activeCueId, setActiveCueId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const mainVideo = useRef(null);
  const backgroundVideo = useRef(null);
  const mounted = useRef(false);
  const lifecycleGeneration = useRef(0);
  const navigationApproved = useRef(false);
  const saveController = useRef(null);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const retryAttempt = useRef(null);
  const draftRef = useRef(draft);
  const snapshotRef = useRef(snapshot);
  const etagRef = useRef(etag);
  const dirtyRef = useRef(false);
  const lockedRef = useRef(false);
  const saveRef = useRef(null);

  useEffect(() => {
    mounted.current = true;
    lifecycleGeneration.current += 1;
    return () => { mounted.current = false; saveController.current?.abort(); };
  }, []);
  useEffect(() => {
    const warnBeforeUnload = (event) => {
      if (navigationApproved.current || !shouldWarnUnsaved(dirtyRef.current, inFlight.current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);
  const onBack = (event) => {
    if (!shouldWarnUnsaved(dirtyRef.current, inFlight.current)) return;
    if (!window.confirm("Ada perubahan yang belum selesai disimpan. Yakin ingin kembali dan meninggalkan perubahan?")) {
      event.preventDefault();
      return;
    }
    navigationApproved.current = true;
  };

  const applyDraft = useCallback((mutate) => {
    setDraft((current) => {
      const next = deepCopy(current);
      mutate(next);
      draftRef.current = next;
      const changed = editableJson(next) !== editableJson(snapshotRef.current);
      dirtyRef.current = changed;
      setDirty(changed);
      if (changed) setSaveState((state) => state.status === "saving" ? state : { status: "dirty", message: "Perubahan belum disimpan." });
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (lockedRef.current || !dirtyRef.current) return;
    const validation = validateEditorDraft(draftRef.current);
    if (!validation.valid) {
      setSaveState({ status: "error", message: "Perbaiki isian yang ditandai sebelum menyimpan." });
      return;
    }
    if (inFlight.current) { queued.current = true; return; }
    inFlight.current = true;
    const saveGeneration = lifecycleGeneration.current;
    queued.current = false;
    const sourceDraft = deepCopy(draftRef.current);
    let body;
    try { body = buildNextRevision(snapshotRef.current, sourceDraft, etagRef.current, isoNow()); }
    catch (error) {
      inFlight.current = false;
      setSaveState({ status: "error", message: error.message });
      return;
    }
    const attempt = createEditorSaveAttempt(retryAttempt.current, body, etagRef.current, () => crypto.randomUUID());
    const controller = new AbortController();
    saveController.current = controller;
    setSaveState({ status: "saving", message: "Menyimpan perubahan…" });
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/candidates/${encodeURIComponent(candidateId)}/edit`, {
        method: "PUT", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", "If-Match": attempt.etag, "Idempotency-Key": attempt.idempotencyKey },
        body: attempt.serialized,
      });
      let payload = {};
      try { payload = await response.json(); } catch { payload = {}; }
      if (!mounted.current || lifecycleGeneration.current !== saveGeneration) return;
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent(`/projects/${encodeURIComponent(id)}/candidates/${encodeURIComponent(candidateId)}/edit`)}`);
        return;
      }
      if (!response.ok) {
        const failure = classifyEditorSaveFailure(response.status, payload);
        retryAttempt.current = failure.retryable ? { ...attempt, retryable: true } : null;
        if (failure.lock) { lockedRef.current = true; setLocked(true); }
        setSaveState({ status: failure.kind, message: failure.message });
        return;
      }
      const nextEtag = response.headers.get("etag");
      const savedValidation = validateSavedEditorResponse(payload, nextEtag, attempt.manifest);
      if (!savedValidation.valid) {
        queued.current = false;
        const error = new Error("Respons simpan tidak dapat diverifikasi. Server mungkin sudah menyimpan; muat ulang direkomendasikan sebelum mencoba lagi.");
        error.name = "EditorSaveResponseInvalid";
        throw error;
      }
      retryAttempt.current = null;
      snapshotRef.current = deepCopy(payload);
      etagRef.current = nextEtag;
      setSnapshot(deepCopy(payload));
      setEtag(nextEtag);
      const unchangedSinceSave = editableJson(draftRef.current) === editableJson(sourceDraft);
      if (unchangedSinceSave) {
        const clean = deepCopy(payload);
        draftRef.current = clean;
        dirtyRef.current = false;
        setDraft(clean);
        setDirty(false);
        setSaveState({ status: "success", message: `Tersimpan sebagai revisi ${payload.revision}.` });
      } else {
        dirtyRef.current = true;
        setDirty(true);
        queued.current = true;
        setSaveState({ status: "dirty", message: "Revisi tersimpan; perubahan terbaru menunggu giliran." });
      }
    } catch (error) {
      if (!mounted.current || lifecycleGeneration.current !== saveGeneration || error?.name === "AbortError") return;
      retryAttempt.current = { ...attempt, retryable: true };
      setSaveState({ status: "retry", message: error?.name === "EditorSaveResponseInvalid"
        ? error.message
        : "Jaringan terputus; simpan ulang akan memakai ID permintaan yang sama." });
    } finally {
      if (lifecycleGeneration.current === saveGeneration) {
        inFlight.current = false;
        if (mounted.current && queued.current && dirtyRef.current && !lockedRef.current) {
          queued.current = false;
          queueMicrotask(() => saveRef.current?.());
        }
      }
    }
  }, [candidateId, id]);
  saveRef.current = save;

  const validation = validateEditorDraft(draft);
  const errorAttributes = (key, id) => validation.errors[key]
    ? { "aria-invalid": true, "aria-describedby": id } : {};
  useEffect(() => {
    if (!dirty || locked || !validation.valid || saveState.status === "retry") return undefined;
    const timer = window.setTimeout(() => saveRef.current?.(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, locked, validation.valid, draft, saveState.status]);

  const timeline = draft.timeline;
  const previewSrc = `/api/jobs/${encodeURIComponent(id)}/preview-source`;
  const syncBackground = () => {
    const primary = mainVideo.current;
    const backdrop = backgroundVideo.current;
    if (!primary || !backdrop) return;
    if (Math.abs(backdrop.currentTime - primary.currentTime) > .12) backdrop.currentTime = primary.currentTime;
    backdrop.playbackRate = primary.playbackRate;
  };
  const updatePlayback = () => {
    const video = mainVideo.current;
    if (!video) return;
    if (video.currentTime < timeline.start) video.currentTime = timeline.start;
    if (video.currentTime >= timeline.end) { video.currentTime = timeline.end; video.pause(); }
    syncBackground();
    setActiveCueId(currentCaptionCue(draft.captions, video.currentTime - timeline.start, timeline.start)?.cue_id || "");
  };
  const onLoadedMetadata = () => {
    const video = mainVideo.current;
    if (!video) return;
    video.currentTime = timeline.start;
    if (backgroundVideo.current) backgroundVideo.current.currentTime = timeline.start;
    updatePlayback();
  };
  const playBackdrop = () => { syncBackground(); backgroundVideo.current?.play().catch(() => {}); };
  const pauseBackdrop = () => backgroundVideo.current?.pause();
  const activeCue = draft.captions.find((cue) => cue.cue_id === activeCueId);
  const title = draft.overlays.find((overlay) => overlay.kind === "title");
  const logo = draft.overlays.find((overlay) => overlay.kind === "logo");
  const safe = draft.visual.safe_area;
  const objectPosition = `${(draft.visual.focal_x ?? .5) * 100}% ${(draft.visual.focal_y ?? .5) * 100}%`;
  const captionPosition = { top: "12%", center: "50%", bottom: "78%" }[draft.caption_style.position];

  const setTitleEnabled = (enabled) => applyDraft((next) => {
    next.overlays = next.overlays.filter((overlay) => overlay.kind !== "title");
    if (enabled) next.overlays.unshift({ kind: "title", text: Array.from(next.captions[0]?.text || "Judul klip").slice(0, 100).join("") || "Judul klip", x: .5, y: .1, max_width: .8 });
  });
  const updateTitle = (key, value) => applyDraft((next) => { const overlay = next.overlays.find((item) => item.kind === "title"); if (overlay) overlay[key] = value; });

  return (
    <main className="clipEditorPage">
      <nav className="nav editorNav shell"><a className="brand" href="/"><span>P</span> Potongin AI</a><a href={`/projects/${encodeURIComponent(id)}`} onClick={onBack}>← Kembali ke kandidat</a></nav>
      <header className="editorHeader shell"><div><div className="eyebrow">CUSTOM CLIP EDITOR · REVISI {snapshot.revision}</div><h1>Poles kandidat sebelum render</h1><p>{loaded.candidate.text}</p></div><div className="immutableTiming" aria-label="Batas klip tidak dapat diubah"><span>Mulai <b>{formatDuration(timeline.start)}</b></span><span>Selesai <b>{formatDuration(timeline.end)}</b></span><small>Batas mengikuti kandidat dan tidak dapat di-trim.</small></div></header>

      {locked && <section className="editorConflict shell" role="alert"><strong>Editor dikunci karena konflik.</strong><span>{saveState.message}</span><button type="button" onClick={() => window.location.reload()}>Muat ulang versi terbaru</button><p>Salin perubahan teks Anda terlebih dahulu bila perlu, lalu terapkan kembali setelah memuat ulang.</p></section>}

      <div className="editorLayout shell">
        <section className="previewColumn" aria-labelledby="preview-title">
          <div className="previewHeading"><div><span className="editorPill">9:16</span><h2 id="preview-title">Preview perkiraan</h2></div><p>Tampilan browser mendekati hasil render; detail font, blur, dan komposisi akhir dapat berbeda.</p></div>
          <div className={`editorStage ${draft.visual.render_mode}`} style={{ "--safe-top": `${safe.top * 100}%`, "--safe-right": `${safe.right * 100}%`, "--safe-bottom": `${safe.bottom * 100}%`, "--safe-left": `${safe.left * 100}%` }}>
            <video ref={backgroundVideo} className="previewBackdrop" src={previewSrc} muted playsInline preload="metadata" aria-hidden="true" tabIndex="-1" />
            <video ref={mainVideo} className="previewMain" style={{ objectPosition }} src={previewSrc} controls playsInline preload="metadata" aria-label="Preview video kandidat" onLoadedMetadata={onLoadedMetadata} onTimeUpdate={updatePlayback} onSeeking={updatePlayback} onPlay={playBackdrop} onPause={pauseBackdrop} onRateChange={syncBackground} />
            <div className="safeArea" aria-hidden="true" />
            {title && <div className="previewTitle" style={{ left: `${title.x * 100}%`, top: `${title.y * 100}%`, maxWidth: `${title.max_width * 100}%` }}>{title.text}</div>}
            {logo && <div className="previewLogo" aria-label="Placeholder logo tersimpan" style={{ left: `${logo.x * 100}%`, top: `${logo.y * 100}%`, width: `${logo.scale * 100}%`, aspectRatio: "1", opacity: logo.opacity, transform: "translate(-50%, -50%)" }}>LOGO</div>}
            {activeCue && <div className={`previewCaption ${draft.caption_style.preset}`} style={{ top: captionPosition, color: draft.caption_style.color, backgroundColor: `${draft.caption_style.background_color}${Math.round(draft.caption_style.background_opacity * 255).toString(16).padStart(2, "0")}`, fontFamily: draft.caption_style.font_family, fontSize: `${draft.caption_style.font_size / 3}px`, WebkitLineClamp: draft.caption_style.max_lines }}>{activeCue.text}</div>}
          </div>
          <p className="previewHint">Gunakan kontrol video untuk memutar kandidat. Playback otomatis berhenti pada batas selesai.</p>
        </section>

        <section className="editorControls" aria-labelledby="controls-title">
          <h2 id="controls-title">Pengaturan klip</h2>
          {!validation.valid && <section className="editorValidationSummary" role="alert" aria-labelledby="validation-title"><strong id="validation-title">Periksa semua error berikut:</strong><ul>{Object.entries(validation.errors).map(([key, message]) => <li key={key}><b>{validationLabel(key)}:</b> {message}</li>)}</ul></section>}
          <fieldset disabled={locked}><legend>Komposisi video</legend><div className="editorChoiceGrid">
            {[ ["fit-blur", "Fit + blur", "Video utuh dengan latar blur"], ["center-crop", "Center crop", "Isi frame dari titik fokus"] ].map(([value, label, help]) => <label key={value} className={draft.visual.render_mode === value ? "selected" : ""}><input type="radio" name="render-mode" checked={draft.visual.render_mode === value} onChange={() => applyDraft((next) => { next.visual.render_mode = value; next.visual.focal_x = value === "center-crop" ? .5 : null; next.visual.focal_y = value === "center-crop" ? .5 : null; })} /><span><b>{label}</b><small>{help}</small></span></label>)}
          </div><label className="disabledControl"><input type="radio" disabled /><span><b>Face-track belum didukung</b><small>Renderer menerima mode ini, tetapi preview dan kontrol pelacakan belum tersedia sehingga sengaja dinonaktifkan.</small></span></label>
          {draft.visual.render_mode === "center-crop" && <div className="rangePair"><label>Fokus horizontal <output>{Math.round(draft.visual.focal_x * 100)}%</output><input type="range" min="0" max="1" step="0.01" value={draft.visual.focal_x} {...errorAttributes("visual.focal", "focal-error")} onChange={(event) => applyDraft((next) => { next.visual.focal_x = Number(event.target.value); })} /></label><label>Fokus vertikal <output>{Math.round(draft.visual.focal_y * 100)}%</output><input type="range" min="0" max="1" step="0.01" value={draft.visual.focal_y} {...errorAttributes("visual.focal", "focal-error")} onChange={(event) => applyDraft((next) => { next.visual.focal_y = Number(event.target.value); })} /></label><FieldError id="focal-error" message={validation.errors["visual.focal"]} /></div>}</fieldset>

          <fieldset disabled={locked}><legend>Gaya caption</legend><div className="formGrid">
            <label>Preset<select value={draft.caption_style.preset} onChange={(event) => applyDraft((next) => { next.caption_style.preset = event.target.value; })}>{["clean", "bold-keyword", "karaoke", "podcast", "minimal"].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Font<select value={draft.caption_style.font_family} onChange={(event) => applyDraft((next) => { next.caption_style.font_family = event.target.value; })}>{["Inter", "Noto Sans", "DejaVu Sans", "sans-serif"].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Posisi<select value={draft.caption_style.position} onChange={(event) => applyDraft((next) => { next.caption_style.position = event.target.value; })}>{[["top", "Atas"], ["center", "Tengah"], ["bottom", "Bawah"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Ukuran font<input type="number" min="18" max="96" value={draft.caption_style.font_size} {...errorAttributes("caption_style.font_size", "font-size-error")} onChange={(event) => applyDraft((next) => { next.caption_style.font_size = Number(event.target.value); })} /><FieldError id="font-size-error" message={validation.errors["caption_style.font_size"]} /></label>
            {[ ["color", "Warna teks"], ["keyword_color", "Warna kata kunci"], ["background_color", "Warna latar"] ].map(([key, label]) => <label key={key}>{label}<input type="color" value={draft.caption_style[key]} onChange={(event) => applyDraft((next) => { next.caption_style[key] = event.target.value.toUpperCase(); })} /></label>)}
            <label>Opasitas latar <output>{Math.round(draft.caption_style.background_opacity * 100)}%</output><input type="range" min="0" max="1" step="0.05" value={draft.caption_style.background_opacity} {...errorAttributes("caption_style.background_opacity", "opacity-error")} onChange={(event) => applyDraft((next) => { next.caption_style.background_opacity = Number(event.target.value); })} /><FieldError id="opacity-error" message={validation.errors["caption_style.background_opacity"]} /></label>
            <label>Karakter per baris<input type="number" min="8" max="80" value={draft.caption_style.max_chars_per_line} {...errorAttributes("caption_style.max_chars_per_line", "chars-error")} onChange={(event) => applyDraft((next) => { next.caption_style.max_chars_per_line = Number(event.target.value); })} /><FieldError id="chars-error" message={validation.errors["caption_style.max_chars_per_line"]} /></label>
            <label>Maksimum baris<select value={draft.caption_style.max_lines} {...errorAttributes("caption_style.max_lines", "lines-error")} onChange={(event) => applyDraft((next) => { next.caption_style.max_lines = Number(event.target.value); })}>{[1, 2, 3].map((value) => <option key={value}>{value}</option>)}</select><FieldError id="lines-error" message={validation.errors["caption_style.max_lines"]} /></label>
          </div><label className="disabledControl"><input type="checkbox" disabled /><span><b>Penekanan kata kunci nonaktif</b><small>Manifest disimpan dengan emphasis “none” agar kompatibel dengan renderer saat ini.</small></span></label></fieldset>

          <fieldset disabled={locked}><legend>Teks caption</legend><div className="cueEditorList">{draft.captions.map((cue, index) => { const cueError = validation.errors[`captions.${index}.text`]; return <label key={cue.cue_id} className={activeCueId === cue.cue_id ? "active" : ""}><span><b>Caption {index + 1}</b><small>{formatDuration(cue.start - timeline.start)}–{formatDuration(cue.end - timeline.start)}</small></span><textarea value={cue.text} aria-invalid={!!cueError} aria-describedby={`cue-help-${index}`} onChange={(event) => applyDraft((next) => { next.captions[index].text = event.target.value; })} /><small id={`cue-help-${index}`} className={cueError ? "editorFieldError" : ""}>{cueError || `${Array.from(cue.text).length}/500 · tanpa baris baru atau karakter kontrol`}</small></label>; })}</div></fieldset>

          <fieldset disabled={locked}><legend>Judul & logo</legend><label className="toggleRow"><input type="checkbox" checked={!!title} onChange={(event) => setTitleEnabled(event.target.checked)} /><span>Tampilkan judul</span></label>{title && <div className="formGrid"><label className="wide">Teks judul<input value={title.text} {...errorAttributes("title.text", "title-text-error")} onChange={(event) => updateTitle("text", event.target.value)} /><FieldError id="title-text-error" message={validation.errors["title.text"]} /></label><label>Posisi<select value={title.y < .3 ? "top" : title.y > .7 ? "bottom" : "center"} {...errorAttributes("title.position", "title-position-error")} onChange={(event) => updateTitle("y", { top: .1, center: .5, bottom: .85 }[event.target.value])}><option value="top">Atas</option><option value="center">Tengah</option><option value="bottom">Bawah</option></select></label><label>Lebar maksimum <output>{Math.round(title.max_width * 100)}%</output><input type="range" min="0.1" max="0.9" step="0.05" value={title.max_width} {...errorAttributes("title.position", "title-position-error")} onChange={(event) => updateTitle("max_width", Number(event.target.value))} /><FieldError id="title-position-error" message={validation.errors["title.position"]} /></label></div>}<label className="disabledControl"><input type="checkbox" checked={!!logo} disabled readOnly /><span><b>Upload logo belum tersedia</b><small>Editor mempertahankan logo yang sudah ada, tetapi API aset upload belum tersedia. Placeholder posisi/ukuran menunjukkan geometri dan opasitas tersimpan.</small></span></label></fieldset>

          <fieldset disabled={locked}><legend>Audio</legend><div className="formGrid"><label>Gain <output>{draft.audio.gain_db > 0 ? "+" : ""}{draft.audio.gain_db} dB</output><input type="range" min="-24" max="12" step="0.5" value={draft.audio.gain_db} {...errorAttributes("audio.gain_db", "gain-error")} onChange={(event) => applyDraft((next) => { next.audio.gain_db = Number(event.target.value); })} /><FieldError id="gain-error" message={validation.errors["audio.gain_db"]} /></label><label className="toggleRow"><input type="checkbox" checked={draft.audio.normalize} onChange={(event) => applyDraft((next) => { next.audio.normalize = event.target.checked; })} /><span>Normalisasi loudness</span></label></div><label className="disabledControl"><input type="checkbox" disabled /><span><b>Mute tidak tersedia</b><small>Kontrak audio saat ini hanya mendukung gain_db dan normalize; mute tidak akan dipalsukan dengan gain minimum.</small></span></label></fieldset>

          <div className="advancedPanel"><button type="button" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>Margin aman lanjutan {advanced ? "−" : "+"}</button>{advanced && <fieldset disabled={locked}><legend>Margin aman kanvas</legend><div className="formGrid">{["top", "right", "bottom", "left"].map((edge) => <label key={edge}>{({ top: "Atas", right: "Kanan", bottom: "Bawah", left: "Kiri" })[edge]} <output>{Math.round(safe[edge] * 100)}%</output><input type="range" min="0" max="0.25" step="0.01" value={safe[edge]} {...errorAttributes(`visual.safe_area.${edge}`, `safe-${edge}-error`)} onChange={(event) => applyDraft((next) => { next.visual.safe_area[edge] = Number(event.target.value); })} /><FieldError id={`safe-${edge}-error`} message={validation.errors[`visual.safe_area.${edge}`]} /></label>)}</div></fieldset>}</div>
        </section>
      </div>

      <div className="editorSaveBar"><div><span className={`saveDot ${saveState.status}`} aria-hidden="true" /><p role={saveState.status === "error" || saveState.status === "conflict" ? "alert" : "status"} aria-live="polite">{saveState.message}</p><small>{validation.valid ? "Autosave aktif setelah 1200 ms untuk perubahan valid." : "Penyimpanan diblokir; lihat daftar error di atas."}</small></div><div><button type="button" className="renderSoon" disabled>Render final segera tersedia</button><button type="button" className="saveEditor" disabled={locked || !dirty || !validation.valid || saveState.status === "saving"} onClick={() => saveRef.current?.()}>{saveState.status === "saving" ? "Menyimpan…" : "Simpan"}</button></div></div>
    </main>
  );
}

export default function ClipEditorPage({ params }) {
  const { id, candidateId } = use(params);
  const [state, setState] = useState({ loading: true, loaded: null, error: "", kind: "" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ loading: true, loaded: null, error: "", kind: "" });
    (async () => {
      try {
        const result = await loadEditorWorkspace(id, candidateId, { signal: controller.signal });
        if (!active) return;
        if (result.type === "redirect") { window.location.assign(result.location); return; }
        setState({ loading: false, loaded: result, error: "", kind: "" });
      } catch (error) {
        if (!active || error?.name === "AbortError") return;
        setState({ loading: false, loaded: null, error: error?.message || "Editor tidak dapat dimuat.", kind: error?.kind || "request" });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [id, candidateId, generation]);

  if (state.loading) return <main><section className="detailState shell" role="status" aria-live="polite"><div className="pulse" /><h1>Menyiapkan editor…</h1><p>Preview, kandidat, cue caption, dan revisi edit sedang dimuat.</p></section></main>;
  if (state.error) return <main><section className="detailState detailError shell" role="alert"><div className="emptyIcon">!</div><h1>{state.kind === "not-found" ? "Kandidat tidak ditemukan" : "Editor tidak tersedia"}</h1><p>{state.error}</p><div><button type="button" onClick={() => setGeneration((value) => value + 1)}>Coba lagi</button><a href={`/projects/${encodeURIComponent(id)}`}>Kembali ke proyek</a></div></section></main>;
  return <EditorWorkspace key={`${id}:${candidateId}:${generation}`} id={id} candidateId={candidateId} loaded={state.loaded} />;
}
