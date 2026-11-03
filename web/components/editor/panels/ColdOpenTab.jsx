"use client";

// Tab Cold open of the one-layout editor (rombak 06 §8.5, Editor F5): on/off, the line and its
// length, Putar and Hapus, the suggestions, one word more or less on each edge; 0,1 s per edge in
// Lanjutan. Transisi: the effect at the join, the whoosh and Putar transisi. Making a cold open from
// the transcript's selection is the transcript's own ("Jadikan cold open", ⋯), so this tab never
// repeats it (06 §2.2 rule 5); the switch still takes the selection when one is there. The word
// rules are transcript/model.mjs; the suggestions and the transition are the old panel's parts.
import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";

import Advanced from "../shell/Advanced.jsx";
import { runCommands } from "../transcript/actions.mjs";
import { buildTranscriptModel, coldOpenCheck, coldOpenInfo, formatDuration, midSf } from "../transcript/model.mjs";
import { clampSelection, selectionRange, selectionStoreFor } from "../transcript/selection.mjs";
import PillButton from "../ui/PillButton.jsx";
import PillGroup from "../ui/PillGroup.jsx";
import Switch from "../ui/Switch.jsx";
import ColdOpenSuggestions from "./ColdOpenSuggestions.jsx";
import { TRANSITION_STYLES, transitionCommands, transitionStatus, transitionView } from "./coldopen-transition.mjs";
import { TabGroup, TabNote } from "./tab-ui.jsx";
import styles from "./tabs.module.css";
import { useAudition } from "./use-audition.js";

// The seed's cold open as words, to turn a removed cold open back on.
function seedWords(seed, words) {
  const segment = seed?.main?.segments?.find((entry) => entry.role === "cold_open");
  if (!segment) return null;
  const fps = seed.output.fps;
  let first = -1;
  let last = -1;
  words.words.forEach((word, index) => {
    const mid = midSf(word, fps);
    if (segment.in_sf <= mid && mid < segment.out_sf) {
      if (first < 0) first = index;
      last = index;
    }
  });
  return first < 0 ? null : [first, last];
}

function Transition({ doc, dispatch, player, readOnly, onError }) {
  const t = useTranslations("editor.coldOpen");
  const view = useMemo(() => transitionView(doc, { readOnly }), [doc, readOnly]);
  const audition = useAudition(player, doc.output.fps);
  const uid = useId();
  const [last, setLast] = useState(null);
  const off = !view.enabled;
  const listening = audition.playing === "transition";
  const reason = view.reason === null ? null : readOnly ? t("transition.readOnly") : t("transition.off");
  const names = { cut: t("transition.cut"), flash_white: t("transition.flash"), dip_black: t("transition.dip") };
  const send = (command, choice) => {
    const result = runCommands(dispatch, [command]);
    onError(result.ok ? null : result.message);
    setLast(result.ok ? choice : null);
  };
  const status = transitionStatus(last, view) ? (last.kind === "style" ? t("transition.statusStyle", { name: names[last.value] ?? last.value })
    : last.value ? t("transition.statusSfxOn") : t("transition.statusSfxOff")) : "";
  return (
    <TabGroup title={t("transition.title")} data-tab-group="transition" data-coldopen-transition="">
      <TabNote id={`${uid}-note`} data-transition-note="">{reason ?? t("transition.note")}</TabNote>
      <PillGroup legend={t("transition.effect")} name={`${uid}-style`} columns={3} disabled={off} value={view.style} describedBy={off ? `${uid}-note` : undefined}
        options={TRANSITION_STYLES.map((option) => ({ id: option.id, label: names[option.id] ?? option.name }))}
        onChange={(style) => send(transitionCommands.style(style), { kind: "style", value: style })} />
      <Switch label={t("transition.whoosh")} checked={view.sfxOn} disabled={off} describedBy={off ? `${uid}-note` : undefined}
        onChange={(on) => send(transitionCommands.sfx(on), { kind: "sfx", value: on })} />
      <PillButton disabled={!view.audition || !player?.seek} aria-describedby={view.audition ? undefined : `${uid}-note`}
        data-transition-audition={view.audition ? `${view.audition.f0}-${view.audition.f1}` : ""}
        onClick={() => (listening ? audition.stop() : audition.start("transition", view.audition))}>
        {listening ? t("transition.stop") : t("transition.play")}
      </PillButton>
      <p className={styles.note} role="status" data-transition-status="">{status}</p>
    </TabGroup>
  );
}

function Body({ state, dispatch, player, api, reveal }) {
  const t = useTranslations("editor.coldOpen");
  const { doc, words } = state;
  const readOnly = state.status !== "ready";
  const model = useMemo(() => buildTranscriptModel(words, doc), [words, doc]);
  const info = coldOpenInfo(model);
  const store = selectionStoreFor(doc.clip_id);
  const rawSelection = useSyncExternalStore(store.subscribe, store.get, store.get);
  const range = selectionRange(clampSelection(rawSelection, model.states.length));
  const candidate = coldOpenCheck(model, range?.[0] ?? -1, range?.[1] ?? -1);
  const fromSeed = useMemo(() => seedWords(state.seed, words), [state.seed, words]);
  const uid = useId();
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState(null);
  const context = useMemo(() => ({ words }), [words]);

  const run = (commands) => {
    const result = runCommands(dispatch, commands);
    setMessage(result.ok ? null : result.message);
    setStatus(null);
    return result.ok;
  };
  const enableFrom = candidate.ok ? range : fromSeed;
  const toggle = (on) => {
    if (!on) run([{ type: "SetColdOpen", args: null, mergeKey: null }]);
    else if (enableFrom) run([{ type: "SetColdOpen", args: { firstWord: words.words[enableFrom[0]].id, lastWord: words.words[enableFrom[1]].id }, mergeKey: null }]);
  };
  const play = async () => {
    if (!player?.seek) return;
    await player.seek(0);
    await player.play?.();
  };
  const wordStep = (edge, words_) => run([{ type: "NudgeColdOpen", args: { edge, words: words_ }, mergeKey: `co:${edge}` }]);
  const fineStep = (edge, ms) => run([{ type: "NudgeEdge", args: { seg: "cold_open", edge, ms }, mergeKey: `edge:cold_open:${edge}` }]);
  const nudge = (key, edge, words_, label) => {
    const entry = info.nudges[key];
    return (
      <button type="button" className={styles.step} disabled={readOnly || !entry.ok} title={entry.ok ? label : entry.reason} aria-label={label}
        onClick={() => wordStep(edge, words_)}>
        {words_ < 0 ? "−" : "+"}
      </button>
    );
  };
  const fine = (edge, ms, label) => (
    <button type="button" className={styles.step} disabled={readOnly} title={label} aria-label={label} onClick={() => fineStep(edge, ms)}>{ms < 0 ? "−" : "+"}</button>
  );
  const coldLabel = ({ key, values }) => {
    if (key === "edgeIn") return t("summary.in", { sign: values.sign, seconds: values.seconds });
    return key === "edgeOut" ? t("summary.out", { sign: values.sign, seconds: values.seconds }) : null;
  };

  return (
    <section data-panel="coldopen" className={styles.tab} aria-busy={false}>
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
      {status ? <p className={styles.note} role="status">{status}</p> : null}
      <TabGroup title={t("title")} data-tab-group="coldopen"
        action={(
          <Switch label={t("on")} checked={info !== null} disabled={readOnly || (info === null && !enableFrom)}
            describedBy={!info && !enableFrom ? `${uid}-pick` : undefined} title={!info && !enableFrom ? t("pickFirst") : undefined} onChange={toggle} />
        )}>
        <TabNote id={!info && !enableFrom ? `${uid}-pick` : undefined}>{!info && !enableFrom ? t("pickFirst") : t("note")}</TabNote>
        {info ? (
          <div className={styles.stack}>
            <p className={styles.line} data-coldopen-line="">{`“${info.text}”`}</p>
            <p className={styles.note}><span data-coldopen-length="">{formatDuration(info.frames, model.fps)}</span>{` · ${t("playsFirst")}`}</p>
            <div className={styles.row}>
              <PillButton disabled={!player?.seek} onClick={play}>{t("play")}</PillButton>
              <PillButton disabled={readOnly} onClick={() => run([{ type: "SetColdOpen", args: null, mergeKey: null }])}>{t("remove")}</PillButton>
            </div>
            <div className={styles.steppers} role="group" aria-label={t("words.label")}>
              <div className={styles.stepper}>
                <span className={styles.stepperLabel}>{t("words.start")}</span>
                {nudge("inEarlier", "in", -1, t("words.addBefore"))}
                {nudge("inLater", "in", 1, t("words.dropFirst"))}
              </div>
              <div className={styles.stepper}>
                <span className={styles.stepperLabel}>{t("words.end")}</span>
                {nudge("outEarlier", "out", -1, t("words.dropLast"))}
                {nudge("outLater", "out", 1, t("words.addAfter"))}
              </div>
            </div>
            <Advanced group="coldOpen" doc={doc} seed={state.seed} context={context} labelFor={coldLabel} reveal={reveal}>
              <div className={styles.steppers} role="group" aria-label={t("fine.label")} data-coldopen-fine="">
                <div className={styles.stepper}>
                  <span className={styles.stepperLabel}>{t("fine.start")}</span>
                  {fine("in", -100, t("fine.startEarlier"))}
                  {fine("in", 100, t("fine.startLater"))}
                </div>
                <div className={styles.stepper}>
                  <span className={styles.stepperLabel}>{t("fine.end")}</span>
                  {fine("out", -100, t("fine.endEarlier"))}
                  {fine("out", 100, t("fine.endLater"))}
                </div>
              </div>
            </Advanced>
          </div>
        ) : null}
      </TabGroup>

      <ColdOpenSuggestions state={state} dispatch={dispatch} player={player} api={api} model={model} readOnly={readOnly} touch
        onResult={(result) => { setMessage(result.error ?? null); setStatus(result.status ?? null); }} />

      <Transition doc={doc} dispatch={dispatch} player={player} readOnly={readOnly} onError={(error) => { setMessage(error); setStatus(null); }} />
    </section>
  );
}

export default function ColdOpenTab({ state, dispatch, player, api = null, reveal = null }) {
  const tShell = useTranslations("editor.shell");
  if (!state?.doc || !state?.words) {
    return <section data-panel="coldopen" className={styles.tab} aria-busy="true"><p className={styles.note}>{tShell("openingPanel")}</p></section>;
  }
  return <Body state={state} dispatch={dispatch} player={player} api={api} reveal={reveal} />;
}
