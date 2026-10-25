"use client";

// Buat klip (05-ui-dashboard.md §6.3): the link (or a file) and [Buat klip] first, then every
// choice as a valued chip whose popover holds its control, then the four newest projects. Enter
// in the link sends the form; a field error opens the chip that holds the field and focuses it.
// After the job is made the page goes to its project (P4), as a full document load (P12).
import { Alert, Button, Label, Radio, RadioGroup, Switch, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import AppShell from "../../components/AppShell.jsx";
import ChoiceChip from "../../components/ChoiceChip.jsx";
import { PACK_IMAGES, imageSrc } from "../../components/editor/panels/pack-images.js";
import { useRenderModeName } from "../../components/layout-names.jsx";
import PageHead from "../../components/ui/PageHead.jsx";
import { CLIP_LIMITS } from "../../lib/clip-limits.mjs";
import {
  CHIPS,
  DEFAULT_CHOICES,
  DURATION_PRESETS,
  LAYOUT_CHOICES,
  RATIO_CHOICES,
  RESOLUTION_CHOICES,
  VIDEO_LANGUAGE_CHOICES,
  browserStorage,
  chipOfField,
  choicesFromJob,
  lookChoices,
  normalizeChoices,
  outputSizeOf,
  readStoredChoices,
  withDuration,
  writeStoredChoices,
} from "../../lib/dashboard-choices.mjs";
import { createStorageStatusRecovery, storageStatusView } from "../../lib/dashboard-storage-status.mjs";
import { failedJobHref, projectAfterSubmit, sendJob, submitPhase } from "../../lib/dashboard-submit.mjs";
import {
  AI_STATUS_UNREADABLE,
  aiAlert,
  focusAiMode,
  jobFormProblemCodes,
  problemText,
  storageMessage,
  subtitleFileCode,
  submitErrorMessage,
  videoFileCode,
} from "../../lib/dashboard-view.mjs";
import { storageHelpHref } from "../../lib/help-catalog.mjs";
import { errorText } from "../../lib/i18n/errors.mjs";
import { notifyJobsChanged } from "../../lib/job-badge.mjs";
import { lookPreview } from "../../lib/look-preview.mjs";
import { typedRangeCount } from "../../lib/time-ranges.mjs";
import { focusFormFields, normalizeFocusText } from "../../lib/selection-v3-view.mjs";
import styles from "./dashboard.module.css";
import FocusField from "./FocusField.jsx";
import LookPreview from "./LookPreview.jsx";
import RecentProjects from "./RecentProjects.jsx";

// Fields in the order the page checks them; the first invalid one gets focus (its chip opens first).
const FIELD_IDS = { youtubeUrl: "youtube-url", video: "video-file", subtitle: "subtitle-file", limit: "clip-limit", minDuration: "min-duration", maxDuration: "max-duration", timeRanges: "time-ranges" };
const FOCUS_INPUT = "focus-terms-input";

const draggingFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
const asSet = (keys) => (keys === "all" ? [] : [...keys]);

/** Every choice's name in the UI language, one literal key each (tests/i18n-usage). */
function useChoiceNames() {
  const t = useTranslations("dashboard");
  return {
    duration: {
      auto: t("duration.auto"), short: t("duration.short"), medium: t("duration.medium"), long: t("duration.long"), custom: t("duration.custom"),
    },
    style: {
      classic: t("style.classic"), karaoke: t("style.karaoke"), bold: t("style.bold"), box: t("style.box"), sorot: t("style.sorot"), sinar: t("style.sinar"),
    },
    position: { top: t("position.top"), middle: t("position.middle"), bottom: t("position.bottom") },
    size: { small: t("size.small"), medium: t("size.medium"), large: t("size.large") },
    language: { id: t("language.id"), en: t("language.en"), auto: t("language.auto") },
  };
}

/** The text of a form problem from lib/dashboard-view.mjs (a time range keeps the job API's text). */
function useProblemText() {
  const t = useTranslations("dashboard");
  return (problem) => {
    if (!problem) return null;
    switch (problem.code) {
      case "linkEmpty": return t("problem.linkEmpty");
      case "linkInvalid": return t("problem.linkInvalid");
      case "videoMissing": return t("problem.videoMissing");
      case "videoFormat": return t("problem.videoFormat");
      case "srtType": return t("problem.srtType");
      case "srtEmpty": return t("problem.srtEmpty");
      case "srtTooLarge": return t("problem.srtTooLarge");
      case "count": return t("problem.count", problem.values);
      case "seconds": return t("problem.seconds", problem.values);
      case "durationOrder": return t("problem.durationOrder");
      default: return problemText(problem);
    }
  };
}

function FieldError({ id, message }) {
  return message ? <span id={id} className={styles.fieldError}>{message}</span> : null;
}

/** A labelled single choice inside a popover (HeroUI RadioGroup). */
function Choices({ label, value, onChange, options, className = "", describedBy }) {
  return (
    <RadioGroup value={value} onChange={onChange} className={`${styles.choices} ${className}`} aria-describedby={describedBy}>
      <Label className={styles.groupLabel}>{label}</Label>
      {options.map((option) => (
        <Radio key={option.id} value={option.id} className={styles.choice}>
          <Radio.Content className={styles.choiceContent}>
            <Radio.Control><Radio.Indicator /></Radio.Control>
            {option.media}
            <span className={styles.choiceName}>{option.name}</span>
          </Radio.Content>
        </Radio>
      ))}
    </RadioGroup>
  );
}

/** A two-or-three way switch inside a popover (HeroUI ToggleButtonGroup, one always chosen). */
function Segmented({ label, value, onChange, options }) {
  return (
    <div className={styles.segmentedField}>
      <span className={styles.groupLabel} id={`segment-${label}`}>{label}</span>
      <ToggleButtonGroup
        aria-labelledby={`segment-${label}`}
        disallowEmptySelection
        selectedKeys={[value]}
        onSelectionChange={(keys) => { const [key] = asSet(keys); if (key) onChange(String(key)); }}
        className={styles.segmented}
      >
        {options.map((option) => <ToggleButton key={option.id} id={option.id}>{option.name}</ToggleButton>)}
      </ToggleButtonGroup>
    </div>
  );
}

function OnOff({ selected, onChange, children }) {
  return (
    <Switch isSelected={selected} onChange={onChange} className={styles.switch}>
      <Switch.Content>
        <Switch.Control><Switch.Thumb /></Switch.Control>
        {children}
      </Switch.Content>
    </Switch>
  );
}

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const tErrors = useTranslations("errors");
  const names = useChoiceNames();
  const layoutName = useRenderModeName();
  const problemTextOf = useProblemText();

  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [video, setVideo] = useState(null);
  const [subtitle, setSubtitle] = useState(null);
  const [reupload, setReupload] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The last choices come back after hydration (the page is prerendered with the defaults).
  const [choices, setChoices] = useState(DEFAULT_CHOICES);
  const { limit, duration, minDuration, maxDuration, renderMode, ratio, resolution, coldOpen, hookOverlay, videoLanguage } = choices;
  const [focusTerms, setFocusTerms] = useState([]);
  const [focusDraft, setFocusDraft] = useState("");
  const [focusNote, setFocusNote] = useState("");
  const [focusError, setFocusError] = useState("");
  const [timeRanges, setTimeRanges] = useState("");
  const [problems, setProblems] = useState({});
  const [openChip, setOpenChip] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const [editorOn, setEditorOn] = useState(false);
  // Which engine renders the automatic clips: with the legacy one (the rollback switch) only the
  // caption looks it draws are offered (CONTRACTS §5.48).
  const [renderEngine, setRenderEngine] = useState("edit-v2");
  const [recent, setRecent] = useState({ state: "loading", jobs: [] });
  const [sending, setSending] = useState(null);
  const [message, setMessage] = useState(null);
  const [storageView, setStorageView] = useState(null);
  const storageRecovery = useRef(null);
  const formRef = useRef(null);
  const pendingFocus = useRef(null);
  const videoChosen = useRef(false);
  videoChosen.current = Boolean(video);

  const offered = lookChoices(renderEngine);
  const { captionStyle, captionPosition, captionSize } = normalizeChoices(choices, { engine: renderEngine });
  const sourceType = video ? "upload" : "youtube";
  const storage = storageView || storageStatusView(null);
  const storageBlocked = storage.submitBlocked;
  const aiMode = focusAiMode(aiStatus);
  const ai = aiAlert(aiStatus);
  const phase = submitPhase({ sending: sending !== null, upload: sourceType === "upload", uploaded: sending?.uploaded });

  function updateChoices(patch) {
    const next = { ...choices, ...patch };
    setChoices(next);
    writeStoredChoices(browserStorage(), next);
  }

  const clearProblem = (...fields) => setProblems((current) => {
    if (!fields.some((field) => current[field])) return current;
    const next = { ...current };
    for (const field of fields) delete next[field];
    return next;
  });

  /** Focuses a field once it is on screen; a field inside a chip opens that chip first. */
  function focusField(id, chip = null) {
    pendingFocus.current = id;
    if (chip) setOpenChip(chip);
    else setOpenChip(null);
  }

  const chooseVideo = useCallback((file) => {
    if (!file) return;
    const code = videoFileCode(file);
    if (code) {
      setProblems((current) => ({ ...current, video: { code } }));
      return;
    }
    setVideo(file);
    setReupload(false);
    setProblems(({ video: _video, youtubeUrl: _url, ...rest }) => rest);
  }, []);

  function clearVideo() {
    setVideo(null);
    setSubtitle(null);
    setProblems(({ video: _video, subtitle: _subtitle, ...rest }) => rest);
    pendingFocus.current = FIELD_IDS.youtubeUrl;
  }

  const chooseSubtitle = useCallback((file) => {
    if (!file) return;
    const code = subtitleFileCode(file);
    if (code) {
      setProblems((current) => ({ ...current, subtitle: { code } }));
      return;
    }
    setSubtitle(file);
    setProblems(({ subtitle: _subtitle, ...rest }) => rest);
  }, []);

  function clearSubtitle() {
    setSubtitle(null);
    clearProblem("subtitle");
    pendingFocus.current = FIELD_IDS.subtitle;
  }

  // The stored choices, or with ?ulang=<id> ("Proses ulang" on a project) that job's options.
  useEffect(() => {
    setChoices(readStoredChoices(browserStorage()));
    const again = new URLSearchParams(window.location.search).get("ulang");
    if (!again || !/^[0-9a-f-]{8,64}$/i.test(again)) return undefined;
    const controller = new AbortController();
    fetch(`/api/jobs/${encodeURIComponent(again)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const filled = choicesFromJob(payload?.job);
        if (!filled || controller.signal.aborted) return;
        setChoices(filled.choices);
        setYoutubeUrl(filled.youtubeUrl);
        setReupload(filled.reupload);
        setFocusTerms(filled.focusTerms);
        setFocusNote(filled.focusNote);
        setTimeRanges(filled.timeRanges);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // A video dropped anywhere in the window becomes the source, instead of the browser opening it.
  // Enter/leave fire for every element crossed, so a depth count tells when the drag left.
  useEffect(() => {
    let depth = 0;
    const enter = (event) => { if (draggingFiles(event)) { depth += 1; setDragging(true); } };
    const leave = (event) => { if (draggingFiles(event) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer.files?.[0] || null;
      // A .srt dropped after the video is its subtitle.
      if (videoChosen.current && /\.srt$/i.test(file?.name || "")) chooseSubtitle(file);
      else chooseVideo(file);
    };
    const listeners = [["dragenter", enter], ["dragleave", leave], ["dragover", over], ["drop", drop]];
    for (const [name, listener] of listeners) window.addEventListener(name, listener);
    return () => { for (const [name, listener] of listeners) window.removeEventListener(name, listener); };
  }, [chooseVideo, chooseSubtitle]);

  // A field waiting for focus (an error, a removed file) takes it once it is on screen; inside a
  // chip that is after its popover opened and moved focus to itself.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return undefined;
    const target = document.getElementById(id);
    if (!target) return undefined;
    pendingFocus.current = null;
    target.focus();
    const frame = requestAnimationFrame(() => { if (document.activeElement !== target) target.focus(); });
    return () => cancelAnimationFrame(frame);
  });

  async function loadRecent(signal) {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store", signal });
      if (!response.ok) throw new Error("jobs");
      const payload = await response.json();
      if (signal?.aborted) return;
      setRecent({ state: "ready", jobs: Array.isArray(payload.jobs) ? payload.jobs.slice(0, 4) : [] });
      setEditorOn(payload.editor === true);
      setRenderEngine(payload.renderEngine === "legacy" ? "legacy" : "edit-v2");
    } catch {
      if (!signal?.aborted) setRecent((current) => (current.state === "ready" ? current : { state: "error", jobs: [] }));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadRecent(controller.signal);
    void (async () => {
      // Informative only: the worker decides at run time which AI (if any) picks the moments.
      let next = AI_STATUS_UNREADABLE;
      try {
        const response = await fetch("/api/llm/status", { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (payload?.llm && typeof payload.llm === "object" && typeof payload.llm.state === "string") next = payload.llm;
      } catch {
        // Fall through to "unreadable" unless the page is gone.
      }
      if (!controller.signal.aborted) setAiStatus(next);
    })();
    const recovery = createStorageStatusRecovery({ fetchImpl: fetch, onChange: setStorageView });
    storageRecovery.current = recovery;
    void recovery.start();
    return () => {
      controller.abort();
      storageRecovery.current = null;
      recovery.dispose();
    };
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (sending) return;
    setMessage(null);
    const found = jobFormProblemCodes({ sourceType, youtubeUrl, video, subtitle, limit, minDuration, maxDuration, timeRanges });
    setProblems(found);
    const firstInvalid = Object.keys(FIELD_IDS).find((name) => found[name]);
    if (firstInvalid) {
      focusField(FIELD_IDS[firstInvalid], chipOfField(firstInvalid));
      return;
    }
    const focus = focusFormFields({ terms: focusTerms, pending: focusDraft, note: focusNote });
    setFocusTerms(focus.terms);
    setFocusDraft(focus.pending);
    if (!focus.fields) {
      setFocusError(focus.error);
      focusField(FOCUS_INPUT, chipOfField("focus"));
      return;
    }
    setOpenChip(null);
    const data = new FormData();
    data.set("renderMode", renderMode);
    data.set("outputSize", outputSizeOf(choices));
    data.set("limit", String(limit).trim());
    data.set("minDuration", String(minDuration).trim());
    data.set("maxDuration", String(maxDuration).trim());
    data.set("coldOpen", String(coldOpen));
    data.set("hookOverlay", String(hookOverlay));
    data.set("captionStyle", captionStyle);
    if (offered.positions) data.set("captionPosition", captionPosition);
    if (offered.sizes) data.set("captionSize", captionSize);
    data.set("videoLanguage", videoLanguage);
    for (const [name, value] of Object.entries(focus.fields)) data.set(name, value);
    if (timeRanges.trim()) data.set("timeRanges", timeRanges.trim());
    if (sourceType === "youtube") data.set("youtubeUrl", youtubeUrl.trim());
    else {
      data.set("video", video);
      if (subtitle) data.set("subtitle", subtitle);
    }
    setSending({ percent: 0, uploaded: false });
    let result;
    try {
      result = await sendJob(data, {
        onProgress: (percent) => setSending((current) => (current ? { ...current, percent: percent ?? current.percent } : current)),
        onUploaded: () => setSending((current) => (current ? { ...current, uploaded: true } : current)),
      });
    } catch {
      setSending(null);
      setMessage({ text: t("submit.offline") });
      return;
    }
    const next = projectAfterSubmit(result);
    if (next) {
      notifyJobsChanged();
      window.location.assign(next);
      return;
    }
    setSending(null);
    const { status, payload } = result;
    if (payload.jobId) notifyJobsChanged();
    if ([507, 503].includes(status)) await storageRecovery.current?.retry();
    const messageId = typeof payload.messageId === "string" ? payload.messageId : typeof payload.code === "string" ? `web.${payload.code}` : null;
    setMessage({
      text: errorText(tErrors, { messageId, legacyText: submitErrorMessage(payload) }),
      help: storageHelpHref(payload.code),
      project: failedJobHref(result),
    });
  }

  const describedBy = (name, extra) => [extra, problems[name] ? `${FIELD_IDS[name]}-error` : null].filter(Boolean).join(" ") || undefined;
  const problem = (name) => problemTextOf(problems[name]);
  const chipProps = (id) => ({
    id,
    isOpen: openChip === id,
    onOpenChange: (open) => setOpenChip((current) => (open ? id : current === id ? null : current)),
  });
  // Enter in a popover field sends the form, as it does in the link field.
  const enterSends = (event) => {
    if (event.key !== "Enter" || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  const look = lookPreview(choices, { editor: editorOn, engine: renderEngine });
  const rangeCount = typedRangeCount(timeRanges);
  const guided = focusTerms.length + rangeCount + (normalizeFocusText(focusNote) ? 1 : 0);
  const durationValue = duration === "custom" ? t("chip.seconds", { min: minDuration || "?", max: maxDuration || "?" }) : names.duration[duration];
  const hookValue = coldOpen && hookOverlay ? t("hook.both") : coldOpen ? t("hook.coldOpen") : hookOverlay ? t("hook.text") : t("hook.none");
  const formatValue = `${ratio} · ${resolution}`;
  const submitText = phase === "uploading" ? t("submit.uploading", { percent: sending?.percent ?? 0 })
    : phase === "checking" ? t("submit.checking") : phase === "preparing" ? t("submit.preparing") : t("submit.idle");
  const lookLabel = t("look.label", { ratio, layout: layoutName(renderMode), style: names.style[captionStyle] });
  // Where the subtitle sits, and (only while the editor is on) that Edit klip changes it per clip.
  const editorNote = !editorOn ? null : renderEngine === "legacy" ? t("look.legacyEditor") : t("look.editor");
  const lookNote = [look.captionInZone ? t("look.inZone") : null, editorNote].filter(Boolean).join(" · ") || null;

  const chips = {
    count: (
      <ChoiceChip {...chipProps("count")} label={t("chip.countLabel")} value={t("chip.count", { count: Number(limit) || 0 })} invalid={Boolean(problems.limit)}>
        <div className={styles.field}>
          <label htmlFor="clip-limit" className={styles.groupLabel}>{t("chip.countLabel")}</label>
          <input id="clip-limit" className={styles.input} type="number" inputMode="numeric" min={CLIP_LIMITS.count.min} max={CLIP_LIMITS.count.max} step="1"
            value={limit} aria-invalid={problems.limit ? "true" : undefined} aria-describedby={describedBy("limit")} onKeyDown={enterSends}
            onChange={(event) => { updateChoices({ limit: event.target.value }); clearProblem("limit", "timeRanges"); }} />
          <FieldError id={`${FIELD_IDS.limit}-error`} message={problem("limit")} />
        </div>
      </ChoiceChip>
    ),
    duration: (
      <ChoiceChip {...chipProps("duration")} label={t("chip.durationLabel")} value={durationValue} text={t("chip.duration", { value: durationValue })}
        invalid={Boolean(problems.minDuration || problems.maxDuration)}>
        <Choices label={t("chip.durationLabel")} value={duration}
          onChange={(id) => { updateChoices(withDuration(choices, id)); clearProblem("minDuration", "maxDuration"); }}
          options={DURATION_PRESETS.map((entry) => ({ id: entry.id, name: entry.id === "custom" ? names.duration.custom : `${names.duration[entry.id]} · ${t("chip.seconds", { min: entry.min, max: entry.max })}` }))} />
        {duration === "custom" && (
          <div className={styles.numbers}>
            <div className={styles.field}>
              <label htmlFor="min-duration" className={styles.groupLabel}>{t("duration.min")}</label>
              <input id="min-duration" className={styles.input} type="number" inputMode="decimal" min={CLIP_LIMITS.seconds.min} max={CLIP_LIMITS.seconds.max}
                value={minDuration} aria-invalid={problems.minDuration ? "true" : undefined} aria-describedby={describedBy("minDuration")} onKeyDown={enterSends}
                onChange={(event) => { updateChoices({ minDuration: event.target.value }); clearProblem("minDuration", "maxDuration"); }} />
              <FieldError id={`${FIELD_IDS.minDuration}-error`} message={problem("minDuration")} />
            </div>
            <div className={styles.field}>
              <label htmlFor="max-duration" className={styles.groupLabel}>{t("duration.max")}</label>
              <input id="max-duration" className={styles.input} type="number" inputMode="decimal" min={CLIP_LIMITS.seconds.min} max={CLIP_LIMITS.seconds.max}
                value={maxDuration} aria-invalid={problems.maxDuration ? "true" : undefined} aria-describedby={describedBy("maxDuration")} onKeyDown={enterSends}
                onChange={(event) => { updateChoices({ maxDuration: event.target.value }); clearProblem("maxDuration"); }} />
              <FieldError id={`${FIELD_IDS.maxDuration}-error`} message={problem("maxDuration")} />
            </div>
          </div>
        )}
      </ChoiceChip>
    ),
    format: (
      <ChoiceChip {...chipProps("format")} label={t("chip.formatLabel")} value={formatValue}>
        <Segmented label={t("format.ratio")} value={ratio} onChange={(id) => updateChoices({ ratio: id })} options={RATIO_CHOICES} />
        <Segmented label={t("format.resolution")} value={resolution} onChange={(id) => updateChoices({ resolution: id })} options={RESOLUTION_CHOICES} />
      </ChoiceChip>
    ),
    layout: (
      <ChoiceChip {...chipProps("layout")} label={t("chip.layoutLabel")} value={layoutName(renderMode)} text={t("chip.layout", { value: layoutName(renderMode) })}>
        <Choices label={t("chip.layoutLabel")} value={renderMode} onChange={(id) => updateChoices({ renderMode: id })}
          options={LAYOUT_CHOICES.map((entry) => ({
            id: entry.id,
            name: layoutName(entry.id),
            media: <span className={`${styles.frame} ${styles[entry.id]} ${ratio === "1:1" ? styles.squareFrame : ""}`} aria-hidden="true"><i /></span>,
          }))} />
      </ChoiceChip>
    ),
    subtitle: (
      <ChoiceChip {...chipProps("subtitle")} label={t("chip.subtitleLabel")} value={names.style[captionStyle]} text={t("chip.subtitle", { value: names.style[captionStyle] })}>
        <div className={styles.look}>
          <LookPreview look={look} label={lookLabel} zoneText={t("look.zone")} />
          <Choices label={t("chip.subtitleLabel")} value={captionStyle} onChange={(id) => updateChoices({ captionStyle: id })} className={styles.styles}
            describedBy={lookNote ? "caption-style-help" : undefined}
            options={offered.styles.map((style) => ({
              id: style.id,
              name: names.style[style.id],
              media: <img className={styles.thumb} src={imageSrc(PACK_IMAGES[style.id])} width={160} height={40} alt="" draggable={false} />,
            }))} />
        </div>
        {lookNote && <span id="caption-style-help" className={styles.hint}>{lookNote}</span>}
        {(offered.positions || offered.sizes) && (
          <details className={styles.advanced}>
            <summary>{t("look.advanced", { position: names.position[captionPosition], size: names.size[captionSize] })}</summary>
            <div className={styles.advancedBody}>
              {offered.positions && (
                <Segmented label={t("look.position")} value={captionPosition} onChange={(id) => updateChoices({ captionPosition: id })}
                  options={offered.positions.map((spot) => ({ id: spot.id, name: names.position[spot.id] }))} />
              )}
              {offered.sizes && (
                <Segmented label={t("look.size")} value={captionSize} onChange={(id) => updateChoices({ captionSize: id })}
                  options={offered.sizes.map((size) => ({ id: size.id, name: names.size[size.id] }))} />
              )}
            </div>
          </details>
        )}
      </ChoiceChip>
    ),
    hook: (
      <ChoiceChip {...chipProps("hook")} label={t("chip.hookLabel")} value={hookValue} text={t("chip.hook", { value: hookValue })}>
        <OnOff selected={coldOpen} onChange={(on) => updateChoices({ coldOpen: on })}>{t("hook.coldOpen")}</OnOff>
        <OnOff selected={hookOverlay} onChange={(on) => updateChoices({ hookOverlay: on })}>{t("hook.text")}</OnOff>
      </ChoiceChip>
    ),
    focus: (
      <ChoiceChip {...chipProps("focus")} label={t("chip.focus")} value={guided ? t("chip.focusCount", { count: guided }) : t("chip.focusAuto")}
        text={guided ? `${t("chip.focus")} · ${guided}` : t("chip.focus")} invalid={Boolean(problems.timeRanges || focusError)}>
        <FocusField terms={focusTerms} draft={focusDraft} note={focusNote} error={focusError} aiMode={aiMode}
          onTermsChange={setFocusTerms} onDraftChange={setFocusDraft} onNoteChange={setFocusNote} onErrorChange={setFocusError} />
        <div className={styles.field}>
          <label htmlFor="time-ranges" className={styles.groupLabel}>{t("focus.ranges")}</label>
          <textarea id="time-ranges" className={`${styles.input} ${styles.ranges}`} rows={2} value={timeRanges} autoComplete="off" spellCheck={false}
            placeholder="10.30-12.05, 1:02:10-1:03:00" aria-invalid={problems.timeRanges ? "true" : undefined}
            aria-describedby={describedBy("timeRanges", "time-ranges-help")}
            onChange={(event) => { setTimeRanges(event.target.value); clearProblem("timeRanges"); }} />
          <span id="time-ranges-help" className={styles.hint}>{t("focus.rangesHint", { min: CLIP_LIMITS.seconds.min, max: CLIP_LIMITS.seconds.max })}</span>
          <FieldError id={`${FIELD_IDS.timeRanges}-error`} message={problem("timeRanges")} />
        </div>
      </ChoiceChip>
    ),
    language: (
      <ChoiceChip {...chipProps("language")} label={t("chip.languageLabel")} value={names.language[videoLanguage]}>
        <Choices label={t("chip.languageLabel")} value={videoLanguage} onChange={(id) => updateChoices({ videoLanguage: id })}
          options={VIDEO_LANGUAGE_CHOICES.map((language) => ({ id: language.id, name: names.language[language.id] }))} />
      </ChoiceChip>
    ),
  };

  return (
    <AppShell current="/dashboard">
      <div className={`shell ${styles.page}`}>
        <PageHead title={t("title")} id="create-title" />

        {storageView && storage.warning && (
          <Alert status={storageBlocked ? "danger" : "warning"} className={styles.alert} role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{storageBlocked ? t("storage.blocked") : t("storage.unknown")}</Alert.Title>
              <Alert.Description>{errorText(tErrors, { messageId: `storage.${storage.admission.code}`, legacyText: storageMessage(storage.admission.code) })}</Alert.Description>
            </Alert.Content>
            <div className={styles.alertActions}>
              <a className={styles.textLink} href={storageHelpHref(storage.admission.code) || storageHelpHref("storage_admission_unavailable")}>{t("help")}</a>
              <Button variant="secondary" onPress={() => storageRecovery.current?.retry()}>{t("storage.check")}</Button>
            </div>
          </Alert>
        )}
        {ai && (
          <Alert status="warning" className={styles.alert}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{ai === "missing" ? t("ai.missing") : t("ai.notReady")}</Alert.Title>
            </Alert.Content>
            <div className={styles.alertActions}>
              <a className={styles.textLink} href="/settings#ai">{t("ai.setup")}</a>
            </div>
          </Alert>
        )}

        <form ref={formRef} className={styles.composer} data-dragging={dragging || undefined} onSubmit={submit} noValidate aria-labelledby="create-title">
          <div className={styles.sourceRow}>
            {video ? (
              <div className={styles.fileBox}>
                <span title={video.name}>{video.name}</span>
                <button type="button" className={styles.remove} aria-label={t("source.remove", { name: video.name })} onClick={clearVideo}>×</button>
              </div>
            ) : (
              <div className={styles.linkField}>
                <label htmlFor="youtube-url" className="visuallyHidden">{t("source.link")}</label>
                <input id="youtube-url" className={`${styles.input} ${styles.url}`} type="url" inputMode="url" autoComplete="off" enterKeyHint="go"
                  placeholder={t("source.link")} value={youtubeUrl} aria-invalid={problems.youtubeUrl ? "true" : undefined}
                  aria-describedby={describedBy("youtubeUrl")}
                  onChange={(event) => { setYoutubeUrl(event.target.value); clearProblem("youtubeUrl"); }} />
              </div>
            )}
            <Button type="submit" variant="primary" className={styles.submit} isPending={sending !== null} isDisabled={storageBlocked}
              aria-describedby={message ? "submit-message" : undefined}>
              {submitText}
            </Button>
          </div>
          <FieldError id={`${FIELD_IDS.youtubeUrl}-error`} message={problem("youtubeUrl")} />

          <div className={styles.fileRow}>
            <label className={styles.pick} data-invalid={problems.video ? "true" : undefined}>
              <input id="video-file" type="file" accept="video/mp4,video/quicktime,video/webm,.mkv,.m4v"
                aria-invalid={problems.video ? "true" : undefined} aria-describedby={describedBy("video")}
                onChange={(event) => { chooseVideo(event.target.files?.[0] || null); event.target.value = ""; }} />
              {video ? t("source.replace") : t("source.file")}
            </label>
            {video && (
              <>
                {subtitle && (
                  <div className={styles.fileBox}>
                    <span title={subtitle.name}>{subtitle.name}</span>
                    <button type="button" className={styles.remove} aria-label={t("source.remove", { name: subtitle.name })} onClick={clearSubtitle}>×</button>
                  </div>
                )}
                <label className={styles.pick} data-invalid={problems.subtitle ? "true" : undefined}>
                  <input id="subtitle-file" type="file" accept=".srt,application/x-subrip"
                    aria-invalid={problems.subtitle ? "true" : undefined} aria-describedby={describedBy("subtitle")}
                    onChange={(event) => { chooseSubtitle(event.target.files?.[0] || null); event.target.value = ""; }} />
                  {subtitle ? t("source.replaceSrt") : t("source.srt")}
                </label>
              </>
            )}
            {reupload && !video && <span className={styles.hint}>{t("source.reupload")}</span>}
          </div>
          <FieldError id={`${FIELD_IDS.video}-error`} message={problem("video")} />
          {video && <FieldError id={`${FIELD_IDS.subtitle}-error`} message={problem("subtitle")} />}

          <div className={styles.chips} role="group" aria-label={t("chip.group")}>
            {CHIPS.map((id) => <div key={id} className={styles.chipSlot}>{chips[id]}</div>)}
          </div>

          {message && (
            <div id="submit-message" className={styles.submitError} role="alert">
              <span>{message.text}</span>
              {message.help && <a className={styles.textLink} href={message.help}>{t("help")}</a>}
              {message.project && <a className={styles.textLink} href={message.project}>{t("openProject")}</a>}
            </div>
          )}
          {dragging && <div className={styles.dropOverlay} aria-hidden="true"><span>{t("source.drop")}</span></div>}
        </form>

        <RecentProjects recent={recent} onRetry={() => { setRecent({ state: "loading", jobs: [] }); void loadRecent(); }} />
      </div>
    </AppShell>
  );
}
