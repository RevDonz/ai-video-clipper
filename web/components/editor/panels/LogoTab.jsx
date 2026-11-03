"use client";

// Tab Logo of the one-layout editor (rombak 06 §8.4, Editor F5): add, replace and remove a logo
// (also by dropping a file), the four corners, and the fixes when it sits under the app's buttons
// or over the caption; its size and opacity in Lanjutan. The text watermark: one line, and its
// place, size and opacity in Lanjutan. Dragging the logo happens on the stage (LogoGizmo, shown
// while this tab is open). The upload is the page's (gizmos/logo-upload.mjs); the rules and
// commands are logo-model.mjs and watermark-model.mjs.
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";

import { WATERMARK_OPACITY_RANGE, WATERMARK_SIZE_RANGE } from "../../../lib/editor/doc-model.mjs";
import ApplyAll from "../apply-all/ApplyAll.jsx";
import { LOGO_WIDTH_E5, OPACITY_PM, anchorFor, positionFor, resizeTo, transformSteps } from "../gizmos/logo-geometry.mjs";
import { LOGO_ACCEPT, logoUploader, logoUploads } from "../gizmos/logo-upload.mjs";
import Advanced from "../shell/Advanced.jsx";
import PillButton from "../ui/PillButton.jsx";
import PillGroup from "../ui/PillGroup.jsx";
import {
  LOGO_CORNERS, logoCaptionNote, logoPanelView, logoUploadCommand, logoUploadMessage, opacityLabel, runLogoSteps as apply, sizeLabel,
} from "./logo-model.mjs";
import { TabGroup, TabNote, TabSlider } from "./tab-ui.jsx";
import styles from "./tabs.module.css";
import {
  WATERMARK_MAX, WATERMARK_PLACES, cleanWatermarkText, watermarkDraftOnBlur, watermarkOpacityCommand, watermarkPlaceCommand, watermarkPoints,
  watermarkRemoveCommand, watermarkSizeCommand, watermarkTextCommand, watermarkView,
} from "./watermark-model.mjs";

function useCornerNames() {
  const t = useTranslations("editor.logo");
  return { top_left: t("corners.topLeft"), top_right: t("corners.topRight"), bottom_left: t("corners.bottomLeft"), bottom_right: t("corners.bottomRight") };
}

function usePlaceNames() {
  const t = useTranslations("editor.logo");
  return {
    top_left: t("corners.topLeft"), top_center: t("places.topCenter"), top_right: t("corners.topRight"),
    middle_left: t("places.middleLeft"), middle_center: t("places.middleCenter"), middle_right: t("places.middleRight"),
    bottom_left: t("corners.bottomLeft"), bottom_center: t("places.bottomCenter"), bottom_right: t("corners.bottomRight"),
  };
}

function Watermark({ state, dispatch, locked, reveal }) {
  const t = useTranslations("editor.logo");
  const places = usePlaceNames();
  const view = watermarkView(state);
  const mark = view.watermark;
  const uid = useId();
  const [draft, setDraft] = useState(mark?.text ?? "");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [message, setMessage] = useState(null);

  // Undo, redo or "Hapus teks" changes the text from outside: show it unless it is the draft.
  const stored = mark?.text ?? null;
  useEffect(() => {
    if (cleanWatermarkText(draftRef.current) !== (stored ?? "")) setDraft(stored ?? "");
  }, [stored]);

  if (!view.ready) return null;
  const send = (command) => {
    if (!command) return;
    const refused = apply(dispatch, [command]);
    setMessage(refused?.message ?? null);
  };
  const points = watermarkPoints(cleanWatermarkText(draft));
  const overCaption = mark ? logoCaptionNote(state.plan, "watermark") : null;
  const label = ({ key, values }) => {
    switch (key) {
      case "position": return places[values.pos] ?? null;
      case "size": case "opacity": return t("percent", { percent: values.percent });
      default: return null;
    }
  };
  return (
    <TabGroup title={t("watermark.title")} data-tab-group="watermark" data-watermark="">
      <label className={styles.field}>
        <span>{t("watermark.text")}</span>
        <input type="text" className={styles.input} value={draft} maxLength={WATERMARK_MAX} placeholder={t("watermark.placeholder")} autoComplete="off"
          spellCheck={false} disabled={locked} aria-describedby={`${uid}-note`} data-watermark-text=""
          onChange={(event) => {
            setDraft(event.target.value);
            send(watermarkTextCommand(state.doc, event.target.value));
          }}
          onBlur={() => setDraft((current) => watermarkDraftOnBlur(state.doc, current))} />
      </label>
      <div className={styles.meta} id={`${uid}-note`}>
        <span>{t("watermark.note")}</span>
        <span data-watermark-counter="">{`${points}/${WATERMARK_MAX}`}</span>
      </div>
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
      {mark ? (
        <>
          {view.missingGlyphs.length ? (
            <TabNote tone="warning" data-watermark-glyphs="">{t("watermark.glyphs", { glyphs: view.missingGlyphs.join(", ") })}</TabNote>
          ) : null}
          {overCaption ? (
            <div className={styles.stack} data-logo-caption={overCaption.fix?.id ?? ""} role="status">
              <TabNote tone="warning">{overCaption.text}</TabNote>
              {overCaption.fix && !locked ? <PillButton onClick={() => send(overCaption.fix.command)}>{overCaption.fix.label}</PillButton> : null}
            </div>
          ) : null}
          <PillButton disabled={locked} data-watermark-remove="" onClick={() => send(watermarkRemoveCommand(state.doc))}>{t("watermark.remove")}</PillButton>
          <Advanced group="watermark" doc={state.doc} seed={state.seed} labelFor={label} reveal={reveal}>
            <div className={styles.stack}>
              <PillGroup legend={t("watermark.place")} name={`${uid}-place`} columns={3} disabled={locked} value={mark.pos}
                onChange={(pos) => send(watermarkPlaceCommand(state.doc, pos))}
                options={WATERMARK_PLACES.map((place) => ({ id: place.id, label: places[place.id] ?? place.name }))} />
              <TabSlider label={t("watermark.size")} min={WATERMARK_SIZE_RANGE[0]} max={WATERMARK_SIZE_RANGE[1]} step={50} value={mark.size_pm}
                valueText={view.sizeText} disabled={locked} onChange={(value) => send(watermarkSizeCommand(state.doc, value))} />
              <TabSlider label={t("watermark.opacity")} min={WATERMARK_OPACITY_RANGE[0]} max={WATERMARK_OPACITY_RANGE[1]} step={10} value={mark.opacity_pm}
                valueText={view.opacityText} disabled={locked} onChange={(value) => send(watermarkOpacityCommand(state.doc, value))} />
            </div>
          </Advanced>
        </>
      ) : null}
    </TabGroup>
  );
}

export default function LogoTab({ state, dispatch, uploadAsset: uploadProp = null, logoUpload = null, uploadsEnabled = true, applyAll = null, reveal = null }) {
  const t = useTranslations("editor.logo");
  const tShell = useTranslations("editor.shell");
  const corners = useCornerNames();
  const view = logoPanelView(state);
  const logo = view.logo;
  const locked = !view.ready || view.readOnly;
  const upload = uploadProp ?? logoUpload ?? logoUploader();
  const canUpload = Boolean(upload) && uploadsEnabled !== false && Boolean(view.jobId);
  const owner = `${view.jobId}/${state?.clipId ?? ""}`;
  const uploads = useSyncExternalStore(logoUploads.subscribe, logoUploads.getState, logoUploads.getState);
  const progress = uploads.progress?.owner === owner ? uploads.progress : null;
  const uploadMessage = uploads.message?.owner === owner ? uploads.message : null;
  const inputRef = useRef(null);
  const [commandMessage, setCommandMessage] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(null);
  const uid = useId();
  const message = commandMessage ? { tone: "error", text: commandMessage } : uploadMessage;

  const run = useCallback((steps, mergeKey = null) => {
    const refused = apply(dispatch, steps, mergeKey);
    setCommandMessage(refused?.message ?? null);
    if (!refused) logoUploads.clearMessage();
    return !refused;
  }, [dispatch]);

  const startUpload = useCallback((file) => {
    if (!file || !canUpload || locked) return;
    setCommandMessage(null);
    // The dispatch outlives this tab (it is the store's), so a finished upload still lands.
    logoUploads.start({ owner, upload, jobId: view.jobId, file, onUploaded: (dto) => logoUploadMessage(apply(dispatch, [logoUploadCommand(dto)])) });
  }, [canUpload, locked, owner, upload, view.jobId, dispatch]);

  const onFiles = (files) => {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (file) startUpload(file);
  };

  if (!view.ready) {
    return <section data-panel="logo" className={styles.tab} aria-busy="true"><p className={styles.note}>{tShell("openingPanel")}</p></section>;
  }

  const uploading = progress !== null;
  const processing = uploading && progress.phase === "processing";
  const percent = uploading ? Math.round(progress.fraction * 100) : 0;
  const chooseFile = () => inputRef.current?.click();
  const logoProps = logo ? { ...logo, output: view.output } : null;
  const overCaption = logo ? logoCaptionNote(state?.plan, "logo") : null;
  const thumbOk = logo?.thumbUrl && thumbFailed !== logo.thumbUrl;
  const setSize = (value) => {
    const target = resizeTo(logoProps.transform, logoProps.meta, logoProps.output, value, anchorFor(logoProps.box, logoProps.output));
    const steps = target ? transformSteps(logoProps.transform, logoProps.meta, logoProps.output, target) : null;
    if (steps?.length) run(steps, "logo:size");
  };
  const moveToSafe = () => {
    if (logo.safeTarget) run([{ type: "MoveLogo", args: positionFor(logo.safeTarget.x, logo.safeTarget.y, logo.box, view.output) }]);
  };
  const logoLabel = ({ key, values }) => (key === "size" || key === "opacity" ? t("percent", { percent: values.percent }) : null);

  return (
    <section data-panel="logo" className={styles.tab} aria-busy={uploading}
      onDragOver={(event) => {
        if (locked || !canUpload || !event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        onFiles(event.dataTransfer?.files);
      }}>
      <input ref={inputRef} type="file" accept={LOGO_ACCEPT} hidden tabIndex={-1} aria-hidden="true" onChange={(event) => onFiles(event.target.files)} />
      <TabGroup title={t("title")} data-tab-group="logo">
        {logo ? (
          <div className={`${styles.assetRow} ${styles.drop}`} data-over={dragOver ? "true" : "false"} data-logo-asset="">
            <img key={logo.thumbUrl} className={styles.assetThumb} src={thumbOk ? logo.thumbUrl : undefined} alt="" data-logo-thumb="" draggable={false}
              onError={() => setThumbFailed(logo.thumbUrl)} />
            <div className={styles.assetText}>
              <span className={styles.assetName}>{uploads.names[logo.assetId] ?? (logo.item.origin === "seed" ? t("defaultLogo") : t("title"))}</span>
              <span className={styles.note}>{t("pixels", { w: logo.meta.w, h: logo.meta.h })}</span>
            </div>
          </div>
        ) : (
          <div className={`${styles.stack} ${styles.drop}`} data-over={dragOver ? "true" : "false"}>
            <TabNote>{t("empty")}</TabNote>
          </div>
        )}
        <div className={styles.row}>
          <PillButton variant={logo ? "default" : "strong"} disabled={locked || !canUpload || uploading} onClick={chooseFile}>
            {logo ? t("replace") : t("add")}
          </PillButton>
          {logo ? <PillButton disabled={locked} onClick={() => run([{ type: "RemoveLogo", args: {} }])}>{t("remove")}</PillButton> : null}
        </div>
        {!canUpload && !view.readOnly ? <TabNote>{t("uploadsOff")}</TabNote> : null}
        {uploading ? (
          <div className={styles.stack} data-logo-upload="">
            <span className={styles.note}>{processing ? t("upload.processing") : t("upload.progress", { name: progress.name, percent })}</span>
            <progress className={styles.progress} max={100} value={processing ? undefined : percent} aria-label={t("upload.label")} />
            <PillButton variant="quiet" onClick={() => logoUploads.cancel()}>{t("upload.cancel")}</PillButton>
          </div>
        ) : null}
        {message ? (
          <p className={message.tone === "error" ? styles.message : styles.note} role={message.tone === "error" ? "alert" : "status"}
            data-logo-error={message.tone === "error" ? "" : undefined}>{message.text}</p>
        ) : null}
        {logo ? (
          <>
            {logo.unsafe ? (
              <div className={styles.stack} data-logo-unsafe="" role="status">
                <TabNote tone="warning">{t("unsafe")}</TabNote>
                {logo.safeTarget && !locked ? <PillButton data-control="logo-safe" onClick={moveToSafe}>{t("moveSafe")}</PillButton> : null}
              </div>
            ) : null}
            {overCaption ? (
              <div className={styles.stack} data-logo-caption={overCaption.fix?.id ?? ""} role="status">
                <TabNote tone="warning">{overCaption.text}</TabNote>
                {overCaption.fix && !locked ? <PillButton onClick={() => run([overCaption.fix.command])}>{overCaption.fix.label}</PillButton> : null}
              </div>
            ) : null}
            <PillGroup legend={t("corner")} name={`${uid}-corner`} columns={2} disabled={locked} describedBy={`${uid}-help`} value={logo.corner}
              onChange={(corner) => run([{ type: "SnapLogo", args: { corner } }])}
              options={LOGO_CORNERS.map((corner) => ({ id: corner.id, label: corners[corner.id] ?? corner.label }))} />
            <TabNote id={`${uid}-help`}>{t("dragHelp")}</TabNote>
            <Advanced group="logo" doc={state.doc} seed={state.seed} labelFor={logoLabel} reveal={reveal}>
              <div className={styles.stack}>
                <TabSlider label={t("size")} min={LOGO_WIDTH_E5.min} max={LOGO_WIDTH_E5.max} step={100} value={logo.transform.w_e5}
                  valueText={sizeLabel(logo.transform.w_e5, logo.box)} disabled={locked} onChange={setSize} />
                <TabSlider label={t("opacity")} min={OPACITY_PM.min} max={OPACITY_PM.max} step={10} value={logo.transform.opacity_pm}
                  valueText={opacityLabel(logo.transform.opacity_pm)} disabled={locked}
                  onChange={(value) => run([{ type: "SetLogoOpacity", args: { opacity_pm: value } }], "logo:opacity")} />
              </div>
            </Advanced>
          </>
        ) : null}
      </TabGroup>
      <Watermark state={state} dispatch={dispatch} locked={locked} reveal={reveal} />
      <div className={styles.group}>
        <ApplyAll applyAll={applyAll} group="logo" disabled={locked || uploading} confirm />
      </div>
    </section>
  );
}
