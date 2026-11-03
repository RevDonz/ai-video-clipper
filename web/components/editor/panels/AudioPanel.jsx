"use client";

// Tab Audio of the one-layout editor (rombak 06 §8.3, Editor F5; the old shell's Musik panel stays
// MusicPanel.jsx until F10). Music: add with the one-time copyright notice, replace and remove, its
// volume, and "Kecilkan saat bicara" with its strength; the start, loop, fades and the ducking's
// details in Lanjutan. The clip's own sound: its volume and "Samakan kenyaringan". The upload is
// the clip's (music-upload.mjs), so it goes on when the tab closes; the rules and commands are
// music-model.mjs.
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";

import Advanced from "../shell/Advanced.jsx";
import ConfirmDialog from "../shell/ConfirmDialog.jsx";
import PillButton from "../ui/PillButton.jsx";
import PillGroup from "../ui/PillGroup.jsx";
import Switch from "../ui/Switch.jsx";
import { DUCK_PRESET_LIST, MUSIC_ACCEPT, RANGES, formatFrames, formatMs, formatPosition, musicCommands, musicView } from "./music-model.mjs";
import { markMusicNoticeRead, musicNoticeRead, musicUploadFor } from "./music-upload.mjs";
import { TabGroup, TabNote, TabSlider } from "./tab-ui.jsx";
import styles from "./tabs.module.css";

const MINUS = "−";

function AudioBody({ state, getState, dispatch, uploadAsset, uploadsEnabled, music, reveal }) {
  const t = useTranslations("editor.audio");
  const view = musicView(state);
  const uid = useId();
  const fileRef = useRef(null);
  const upload = useSyncExternalStore(music.subscribe, music.get, music.get);
  const [notice, setNotice] = useState(null); // { replace } while the copyright notice shows
  const [message, setMessage] = useState(null);
  const replaceRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveState = typeof getState === "function" ? getState : () => stateRef.current;
  const fps = state.doc.output.fps;
  const { readOnly } = view;
  const busy = upload.phase !== "idle";
  const canUpload = !readOnly && !busy && uploadsEnabled;
  const shown = message ?? upload.message;
  const duckNames = { halus: t("duck.soft"), sedang: t("duck.medium"), kuat: t("duck.strong") };
  const duckOptions = DUCK_PRESET_LIST.map((preset) => ({ id: preset.id, label: duckNames[preset.id] ?? preset.name, detail: `${MINUS}${preset.depthCdb / 100} dB` }));

  const run = (commands) => {
    for (const { type, args, mergeKey } of commands) {
      try {
        dispatch(type, args, { mergeKey });
      } catch (error) {
        setMessage({ tone: "error", text: error?.message || t("refused") });
        return false;
      }
    }
    setMessage(null);
    music.clearMessage();
    return true;
  };
  const openPicker = (replace) => {
    replaceRef.current = replace;
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
    music.start({ file: picked, jobId: stateRef.current.doc.base.job_id, upload: uploadAsset, dispatch, getState: liveState, replace: replaceRef.current });
  };

  const musicLabel = ({ key, values }) => {
    switch (key) {
      case "loop": return values.on ? t("summary.loop") : t("summary.noLoop");
      case "fade": return t("summary.fade", { inSeconds: values.inSeconds, outSeconds: values.outSeconds });
      case "offset": return t("summary.offset", { seconds: values.seconds });
      case "duck": return t("summary.duck", { count: values.count });
      default: return null;
    }
  };

  return (
    <section data-panel="audio" className={styles.tab} aria-busy={busy}>
      <input ref={fileRef} type="file" accept={MUSIC_ACCEPT} hidden disabled={!canUpload} onChange={onFile} data-music-file="" />

      <TabGroup title={t("music.title")} data-tab-group="music">
        {view.hasMusic ? (
          <div className={styles.stack} data-music-card="">
            <div className={styles.assetText}>
              <span className={styles.assetName} data-music-name="">{upload.names[view.assetId] ?? t("music.uploaded")}</span>
              <span className={styles.note}>
                <span data-music-duration="">{view.durationText}</span>
                {view.lufsText ? ` · ${t("music.loudness", { value: view.lufsText })}` : null}
              </span>
            </div>
            <div className={styles.row}>
              <PillButton disabled={!canUpload} onClick={() => start(true)}>{t("music.replace")}</PillButton>
              <PillButton disabled={readOnly || busy} onClick={() => run(musicCommands.remove())}>{t("music.remove")}</PillButton>
            </div>
          </div>
        ) : (
          <div className={styles.stack}>
            <TabNote>{t("music.empty")}</TabNote>
            <PillButton variant="strong" disabled={!canUpload} onClick={() => start(false)}>{t("music.add")}</PillButton>
          </div>
        )}
        {uploadsEnabled ? null : <TabNote>{t("music.uploadsOff")}</TabNote>}

        <ConfirmDialog open={notice !== null} title={t("notice.title")} onCancel={() => setNotice(null)}
          actions={(
            <>
              <PillButton variant="quiet" onClick={() => setNotice(null)}>{t("notice.cancel")}</PillButton>
              <PillButton variant="strong" autoFocus onClick={() => {
                markMusicNoticeRead();
                openPicker(notice?.replace === true);
                setNotice(null);
              }}>{t("notice.agree")}</PillButton>
            </>
          )}>
          <p className={styles.note}>{t("notice.text")}</p>
        </ConfirmDialog>

        {busy ? (
          <div className={styles.stack} data-music-upload="">
            <p className={styles.note} aria-live="polite">
              {upload.phase === "processing" ? t("upload.processing", { name: upload.name })
                : t("upload.progress", { name: upload.name, percent: Math.round(upload.progress * 100) })}
            </p>
            <progress className={styles.progress} max={1} value={upload.phase === "processing" ? undefined : upload.progress}
              aria-label={t("upload.label", { name: upload.name })} />
            <PillButton variant="quiet" aria-label={t("upload.cancelLabel")} onClick={() => music.cancel()}>{t("upload.cancel")}</PillButton>
          </div>
        ) : null}

        {shown ? (
          <p className={shown.tone === "error" ? styles.message : styles.note} role={shown.tone === "error" ? "alert" : "status"}>{shown.text}</p>
        ) : null}

        {view.hasMusic ? (
          <>
            <TabSlider label={t("music.volume")} value={view.gainCdb} {...RANGES.gain_cdb} valueText={view.gainText} disabled={readOnly}
              note={t("music.volumeNote")} onChange={(value) => run(musicCommands.gain(value))}
              extra={view.gainCdb !== view.defaultGainCdb ? (
                <button type="button" className={styles.textButton} aria-label={t("music.resetLabel")} disabled={readOnly}
                  onClick={() => run(musicCommands.gain(view.defaultGainCdb))}>{t("music.reset")}</button>
              ) : null} />
            <Switch label={t("duck.on")} checked={view.duck.on} disabled={readOnly} onChange={(on) => run(musicCommands.duckOn(on))} />
            <PillGroup legend={t("duck.strength")} name={`${uid}-duck`} options={duckOptions} value={view.duck.preset} columns={3}
              disabled={readOnly || !view.duck.on} onChange={(id) => run(musicCommands.duckPreset(id))} />
            {view.duck.preset === "custom" ? <TabNote>{t("duck.custom", { depth: view.duck.depthText })}</TabNote> : null}
            {view.shorter ? <TabNote tone="warning" role="status">{t("music.shorter")}</TabNote> : null}
            <Advanced group="music" doc={state.doc} seed={state.seed} labelFor={musicLabel} reveal={reveal}>
              <div className={styles.stack}>
                <TabSlider label={t("fine.offset")} value={view.offsetSmp} min={0} max={view.maxOffsetSmp} step={RANGES.offset_step_smp}
                  valueText={`${formatPosition(Math.floor(view.offsetSmp / 48))} / ${view.durationText}`} disabled={readOnly}
                  onChange={(value) => run(musicCommands.offset(value))} />
                <Switch label={t("fine.loop")} checked={view.loop} disabled={readOnly} onChange={(on) => run(musicCommands.loop(on))} />
                <TabSlider label={t("fine.fadeIn")} value={view.fadeInF} min={0} max={view.fadeMaxF} valueText={formatFrames(view.fadeInF, fps)}
                  disabled={readOnly} onChange={(value) => run(musicCommands.fadeIn(value))} />
                <TabSlider label={t("fine.fadeOut")} value={view.fadeOutF} min={0} max={view.fadeMaxF} valueText={formatFrames(view.fadeOutF, fps)}
                  disabled={readOnly} onChange={(value) => run(musicCommands.fadeOut(value))} />
                <TabSlider label={t("fine.depth")} value={view.duck.depth_cdb} {...RANGES.depth_cdb} valueText={view.duck.depthText}
                  disabled={readOnly || !view.duck.on} onChange={(value) => run(musicCommands.duckParam("depth_cdb", value))} />
                <TabSlider label={t("fine.attack")} value={view.duck.attack_ms} {...RANGES.attack_ms} valueText={formatMs(view.duck.attack_ms)}
                  disabled={readOnly || !view.duck.on} note={t("fine.attackNote")} onChange={(value) => run(musicCommands.duckParam("attack_ms", value))} />
                <TabSlider label={t("fine.release")} value={view.duck.release_ms} {...RANGES.release_ms} valueText={formatMs(view.duck.release_ms)}
                  disabled={readOnly || !view.duck.on} onChange={(value) => run(musicCommands.duckParam("release_ms", value))} />
                <TabSlider label={t("fine.hold")} value={view.duck.hold_ms} {...RANGES.hold_ms} valueText={formatMs(view.duck.hold_ms)}
                  disabled={readOnly || !view.duck.on} note={t("fine.holdNote")} onChange={(value) => run(musicCommands.duckParam("hold_ms", value))} />
              </div>
            </Advanced>
          </>
        ) : null}
      </TabGroup>

      <TabGroup title={t("source.title")} data-tab-group="source">
        <TabSlider label={t("source.volume")} value={view.sourceGainCdb} {...RANGES.source_gain_cdb} valueText={view.sourceGainText} disabled={readOnly}
          onChange={(value) => run(musicCommands.sourceGain(value))} />
        <Switch label={t("source.loudness", { target: view.loudness.targetText })} checked={view.loudness.on} disabled={readOnly}
          onChange={(on) => run(musicCommands.loudness(on))} />
        <div aria-live="polite" className={styles.stack}>
          {view.loudness.achievedText ? <TabNote data-loudness="">{view.loudness.achievedText}</TabNote> : null}
          {view.loudness.suggest ? <TabNote>{t("source.suggest")}</TabNote> : null}
          {view.peakText ? <TabNote tone="warning" role="status">{view.peakText}</TabNote> : null}
          {view.audioPending && !view.loudness.measuring ? <TabNote>{t("source.preparing")}</TabNote> : null}
        </div>
      </TabGroup>
    </section>
  );
}

export default function AudioPanel({ state, getState = null, dispatch, uploadAsset = null, uploadsEnabled = true, reveal = null }) {
  const tShell = useTranslations("editor.shell");
  const music = musicUploadFor(state?.clipId ?? state?.doc?.clip_id ?? null);
  if (!state?.doc || !music) {
    return <section data-panel="audio" className={styles.tab} aria-busy="true"><p className={styles.note}>{tShell("openingPanel")}</p></section>;
  }
  return <AudioBody state={state} getState={getState} dispatch={dispatch} uploadAsset={uploadAsset} uploadsEnabled={uploadsEnabled !== false} music={music} reveal={reveal} />;
}
