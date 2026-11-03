"use client";

// Tab Teks of the one-layout editor (rombak 06 §8.1, Editor F3). Caption: on/off, the six packs,
// three sizes, three positions (also dragged on the stage), the highlight, and the fix when the
// caption covers a face; the fine controls in Lanjutan. Hook: on/off, its text with the counter and
// the fit badge, the suggestions behind one click (they ask the server, so opening the editor does
// not); design, duration and position in Lanjutan. "Edit per baris" jumps to the transcript in
// Baris and "Pakai di semua klip" takes the captions along. The rules and commands are the ones
// the old views use (caption-model.mjs, hook-model.mjs); the copy is the catalog's.
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import ApplyAll from "../apply-all/ApplyAll.jsx";
import Advanced from "../shell/Advanced.jsx";
import HookSuggestions from "../suggestions/index.jsx";
import { runCommands } from "../transcript/actions.mjs";
import PillButton from "../ui/PillButton.jsx";
import PillGroup from "../ui/PillGroup.jsx";
import Swatches from "../ui/Swatches.jsx";
import Switch from "../ui/Switch.jsx";
import {
  CAPTION_ENTRANCE_OPTIONS, CAPTION_PACKS, CAPTION_POSITIONS, CAPTION_SIZES, CAPTION_SWATCHES, CAPTION_WORDS, CAPTION_Y_RANGE, CAPTION_Y_STEP,
  HIGHLIGHT_PACKS, captionCommand, captionEntranceCommand, captionEntranceId, captionFaceNote, captionPackCommand, captionWordsCommand,
  captionWordsId, captionZoneNote, captionsEnabledCommand, hookNearNote, presetId,
} from "./caption-model.mjs";
import { HOOK_IMAGES } from "./hook-images.js";
import {
  HOOK_DESIGNS, HOOK_MAX, cleanHookText, hookDesignCommand, hookDesignHint, hookDesignId, hookEnableText, hookEnabledCommand, hookFit,
  hookItemOf, hookMissingGlyphs, hookPoints, hookTextCommand,
} from "./hook-model.mjs";
import { PACK_IMAGES, imageSrc } from "./pack-images.js";
import { CardGroup, TabGroup, TabNote, TabSlider } from "./tab-ui.jsx";
import styles from "./tabs.module.css";

const SIZE_RANGE = Object.freeze({ min: 700, max: 1400, step: 50 });
const HOOK_Y_RANGE = Object.freeze({ min: 6000, max: 40000, step: 500 });
const HOOK_MIN_FRAMES = 15;
const HOOK_MAX_MS = 30000;

/** The tab's copy, literal keys only (the catalog guard follows them). */
function useTextCopy() {
  const t = useTranslations("editor.text");
  return {
    t,
    packs: {
      classic: [t("packs.classic"), t("packs.classicNote")], karaoke: [t("packs.karaoke"), t("packs.karaokeNote")],
      bold: [t("packs.bold"), t("packs.boldNote")], box: [t("packs.box"), t("packs.boxNote")],
      sorot: [t("packs.sorot"), t("packs.sorotNote")], sinar: [t("packs.sinar"), t("packs.sinarNote")],
    },
    sizes: { kecil: t("sizes.small"), sedang: t("sizes.medium"), besar: t("sizes.large") },
    positions: { atas: t("positions.top"), tengah: t("positions.middle"), bawah: t("positions.bottom") },
    entrances: { none: t("entrances.none"), fade: t("entrances.fade"), pop: t("entrances.pop"), blur: t("entrances.blur") },
    designs: {
      "legacy-bar": [t("designs.bar"), t("designs.barNote")], kicker: [t("designs.kicker"), t("designs.kickerNote")],
      blok: [t("designs.blok"), t("designs.blokNote")], kotak: [t("designs.kotak"), t("designs.kotakNote")],
    },
    // In the order of CAPTION_SWATCHES (lib/editor/content-colours.mjs).
    colours: [t("colours.yellow"), t("colours.white"), t("colours.green"), t("colours.blue"), t("colours.pink"), t("colours.orange")],
    fit: { checking: t("hook.fitChecking"), overflow: t("hook.fitOverflow"), fits: t("hook.fits") },
    designHints: { kicker: t("designs.kickerHint"), kotak: t("designs.kotakHint") },
  };
}

function highlightText(t, packId) {
  if (packId === "sinar") return t("caption.highlightGlow");
  return HIGHLIGHT_PACKS.includes(packId) ? t("caption.highlightOn") : t("caption.highlightOff");
}

function TextTabBody({ state, dispatch, api, applyAll, onEditLines, reveal }) {
  const copy = useTextCopy();
  const { t } = copy;
  const { doc, plan, seed } = state;
  const readOnly = state.status !== "ready";
  const fps = doc.output.fps;
  const captions = doc.captions;
  const overrides = captions.overrides;
  const hook = hookItemOf(doc);
  const [message, setMessage] = useState(null);
  const [draft, setDraft] = useState(hook?.payload.text ?? hookItemOf(seed)?.payload.text ?? "");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const uid = useId();

  // Undo, redo or a suggestion changes the hook text from outside: show it unless it is the draft.
  const hookText = hook?.payload.text ?? null;
  useEffect(() => {
    if (hookText !== null && cleanHookText(draftRef.current) !== hookText) setDraft(hookText);
  }, [hookText]);

  const send = (command) => {
    const result = runCommands(dispatch, [command]);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  };
  const onHookInput = (value) => {
    setDraft(value);
    const command = hookTextCommand(doc, value);
    if (command) send(command);
  };

  const zone = captionZoneNote(doc, seed, plan);
  const nearHook = hookNearNote(doc);
  const face = captionFaceNote(plan);
  const draftText = cleanHookText(draft);
  const enableText = hookEnableText(draftText, seed);
  const fit = hookFit({ doc, plan, pending: state.pending });
  const glyphs = hookMissingGlyphs(plan, doc);
  const designId = hookDesignId(doc);
  const designHint = hookDesignHint(designId) ? copy.designHints[designId] : null;
  const unsafeHook = hook !== null && (plan?.warnings ?? []).some((warning) => warning.code === "unsafe_zone"
    && (warning.path ? warning.path.startsWith("/tracks") : warning.ref === hook.id));
  const maxHookFrames = Math.floor((HOOK_MAX_MS * fps[0]) / (1000 * fps[1]));
  const count = hookPoints(draftText);
  const swatches = CAPTION_SWATCHES.map(({ value }, index) => ({ value, name: copy.colours[index] }));
  const pills = (options, names) => options.map((option) => ({ id: option.id, label: names[option.id] }));

  const captionLabel = ({ key, values }) => {
    switch (key) {
      case "entrance": return copy.entrances[values.entrance];
      case "wordsMax": return t("summary.words", { count: values.count });
      case "size": return t("summary.size", { percent: values.percent });
      case "position": return t("summary.position", { percent: values.percent });
      case "case": return values.case === "upper" ? t("summary.upper") : t("summary.asWritten");
      case "emphasis": return t("summary.emphasis");
      default: return null;
    }
  };
  const hookLabel = ({ key, values }) => {
    switch (key) {
      case "design": return copy.designs[values.design]?.[0] ?? null;
      case "duration": return t("summary.duration", { seconds: values.seconds });
      case "position": return t("summary.position", { percent: values.percent });
      default: return null;
    }
  };

  return (
    <section data-panel="text" className={styles.tab} aria-busy={false}>
      {message ? <p className={styles.message} role="alert">{message}</p> : null}

      <TabGroup title={t("caption.title")} data-tab-group="caption"
        action={<Switch label={t("caption.show")} checked={captions.enabled} disabled={readOnly} onChange={(on) => send(captionsEnabledCommand(on))} />}>
        <CardGroup label={t("caption.style")} name="caption-pack" value={captions.pack.id} disabled={readOnly}
          options={CAPTION_PACKS.map((pack) => ({ id: pack.id, name: copy.packs[pack.id][0], note: copy.packs[pack.id][1], image: imageSrc(PACK_IMAGES[pack.id]) }))}
          onChange={(id) => send(captionPackCommand(id))} />
        <PillGroup legend={t("caption.size")} name={`${uid}-size`} options={pills(CAPTION_SIZES, copy.sizes)} disabled={readOnly}
          value={presetId(CAPTION_SIZES, overrides.size_pm)}
          onChange={(id) => send(captionCommand("size_pm", CAPTION_SIZES.find((option) => option.id === id).value))} />
        <PillGroup legend={t("caption.position")} name={`${uid}-position`} options={pills(CAPTION_POSITIONS, copy.positions)} disabled={readOnly}
          value={presetId(CAPTION_POSITIONS, overrides.y_e5)}
          onChange={(id) => send(captionCommand("y_e5", CAPTION_POSITIONS.find((option) => option.id === id).value))} />
        {zone ? (
          <TabNote tone={zone.tone === "warning" ? "warning" : "note"} data-caption-zone={zone.tone}>
            {zone.tone === "warning" ? t("caption.zoneMoved") : t("caption.zoneAtSeed")}
          </TabNote>
        ) : null}
        {nearHook ? <TabNote data-hook-near="">{t("caption.hookNear")}</TabNote> : null}
        {face ? (
          <div className={styles.stack} data-caption-face={face.fix?.id ?? ""}>
            <TabNote tone="warning">{face.fix ? t("caption.overFace") : t("caption.overFaceNoFix")}</TabNote>
            {face.fix ? (
              <PillButton disabled={readOnly} onClick={() => send(face.fix.command)}>
                {t("caption.moveTo", { place: copy.positions[face.fix.id] })}
              </PillButton>
            ) : null}
          </div>
        ) : null}
        <Swatches legend={t("caption.highlight")} name={`${uid}-highlight`} value={overrides.highlight} options={swatches} disabled={readOnly}
          note={highlightText(t, captions.pack.id)} onChange={(value) => send(captionCommand("highlight", value))} />
        <Advanced group="caption" doc={doc} seed={seed} labelFor={captionLabel} reveal={reveal}>
          <div className={styles.stack}>
            <TabSlider label={t("caption.fineSize")} {...SIZE_RANGE} value={overrides.size_pm} valueText={`${Math.round(overrides.size_pm / 10)}%`}
              disabled={readOnly} data-control="caption-size" onChange={(value) => send(captionCommand("size_pm", value, { drag: true }))} />
            <TabSlider label={t("caption.finePosition")} min={CAPTION_Y_RANGE[0]} max={CAPTION_Y_RANGE[1]} step={CAPTION_Y_STEP} value={overrides.y_e5}
              valueText={t("fromTop", { percent: Math.round(overrides.y_e5 / 1000) })} disabled={readOnly} data-control="caption-position"
              onChange={(value) => send(captionCommand("y_e5", value, { drag: true }))} />
            <PillGroup legend={t("caption.wordsPerLine")} name={`${uid}-words`} options={CAPTION_WORDS.map(({ id, label }) => ({ id, label }))}
              value={captionWordsId(doc)} disabled={readOnly} columns={4} onChange={(id) => send(captionWordsCommand(id))} />
            <PillGroup legend={t("caption.entrance")} name={`${uid}-entrance`} options={pills(CAPTION_ENTRANCE_OPTIONS, copy.entrances)}
              value={captionEntranceId(doc)} disabled={readOnly} columns={4} onChange={(id) => send(captionEntranceCommand(id))} />
            <Switch label={t("caption.upper")} checked={overrides.case === "upper"} disabled={readOnly}
              onChange={(on) => send(captionCommand("case", on ? "upper" : "asis"))} />
            <Swatches legend={t("caption.emphasis")} name={`${uid}-emphasis`} value={overrides.emphasis} options={swatches} disabled={readOnly}
              note={t("caption.emphasisNote")} onChange={(value) => send(captionCommand("emphasis", value))} />
          </div>
        </Advanced>
      </TabGroup>

      <TabGroup title={t("hook.title")} data-tab-group="hook"
        action={(
          <Switch label={t("hook.show")} checked={hook !== null} disabled={readOnly || (hook === null && !enableText)}
            describedBy={hook === null && !enableText ? `${uid}-hook-empty` : undefined}
            title={hook === null && !enableText ? t("hook.writeFirst") : undefined} onChange={(on) => send(hookEnabledCommand(on, enableText))} />
        )}>
        {hook === null && !enableText ? <TabNote id={`${uid}-hook-empty`}>{t("hook.writeFirst")}</TabNote> : null}
        <label className={styles.field}>
          <span>{t("hook.text")}</span>
          <textarea className={styles.input} rows={2} maxLength={HOOK_MAX} value={draft} disabled={readOnly} spellCheck={false}
            data-control="hook-text" onChange={(event) => onHookInput(event.target.value)} />
        </label>
        <div className={styles.meta}>
          <span data-hook-counter="" className={count > HOOK_MAX ? styles.over : undefined}>{`${count}/${HOOK_MAX}`}</span>
          {fit ? <span data-fit={fit} data-hook-fit="" role="status">{copy.fit[fit]}</span> : null}
        </div>
        {fit === "overflow" ? <TabNote>{t("hook.overflowNote")}</TabNote> : null}
        {glyphs.length ? <TabNote tone="warning" data-hook-glyphs="">{t("hook.glyphs", { glyphs: glyphs.join(", ") })}</TabNote> : null}
        {unsafeHook ? <TabNote tone="warning">{t("hook.unsafe")}</TabNote> : null}
        <button type="button" className={styles.textButton} aria-expanded={suggestionsOpen} data-hook-suggestions-toggle=""
          onClick={() => setSuggestionsOpen((open) => !open)}>
          {t("hook.suggestions")}
          <span aria-hidden="true">{suggestionsOpen ? "▾" : "▸"}</span>
        </button>
        {suggestionsOpen ? <HookSuggestions state={state} dispatch={dispatch} api={api} /> : null}
        {hook ? (
          <Advanced group="hook" doc={doc} seed={seed} labelFor={hookLabel} reveal={reveal}>
            <div className={styles.stack}>
              <CardGroup label={t("hook.design")} name="hook-design" value={designId} columns={2} disabled={readOnly}
                describedBy={designHint ? `${uid}-design-hint` : undefined}
                options={HOOK_DESIGNS.map((design) => ({ id: design.id, name: copy.designs[design.id][0], note: copy.designs[design.id][1], image: imageSrc(HOOK_IMAGES[design.id]) }))}
                onChange={(id) => {
                  const command = hookDesignCommand(doc, id);
                  if (command) send(command);
                }} />
              {designHint ? <TabNote id={`${uid}-design-hint`} data-hook-design-hint="">{designHint}</TabNote> : null}
              <TabSlider label={t("hook.duration")} min={HOOK_MIN_FRAMES} max={maxHookFrames} value={hook.dur_f} disabled={readOnly}
                valueText={t("seconds", { seconds: Math.round(((hook.dur_f * fps[1]) / fps[0]) * 10) / 10 })}
                onChange={(value) => send({ type: "SetHookDuration", args: { dur_f: value }, mergeKey: "hook:dur_f" })} />
              <TabSlider label={t("hook.position")} {...HOOK_Y_RANGE} value={hook.transform.y_e5} disabled={readOnly} data-control="hook-position"
                valueText={t("fromTop", { percent: Math.round(hook.transform.y_e5 / 1000) })}
                onChange={(value) => send({ type: "SetHookY", args: { y_e5: value }, mergeKey: "hook:y_e5" })} />
            </div>
          </Advanced>
        ) : null}
      </TabGroup>

      <div className={styles.group}>
        <PillButton onClick={onEditLines} disabled={!onEditLines} data-edit-lines="">{t("editLines")}</PillButton>
        <ApplyAll applyAll={applyAll} group="captions" disabled={readOnly} confirm />
      </div>
    </section>
  );
}

export default function TextTab({ state, dispatch, api = null, applyAll = null, onEditLines = null, reveal = null }) {
  const tShell = useTranslations("editor.shell");
  if (!state?.doc) {
    return <section data-panel="text" className={styles.tab} aria-busy="true"><p className={styles.note}>{tShell("openingPanel")}</p></section>;
  }
  return <TextTabBody state={state} dispatch={dispatch} api={api} applyAll={applyAll} onEditLines={onEditLines} reveal={reveal} />;
}
