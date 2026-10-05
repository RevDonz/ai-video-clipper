"use client";

// The layout panel "Tata letak" (plan §11.3 T3.6, §5.7, §3.3 `layout.default.mode`, Appendix B
// `SetLayout`, Appendix C.1/C.6): fit-blur, face-track or center-crop for the whole clip.
//
// - Each card shows the truth frame (plan §4.2 `preview/frame`, the export's own graph) of the
//   current document in that layout at the resting playhead. The panel keeps its own preview
//   client for them, so they never cancel the stage's "Frame akhir".
// - Face-track needs the clip's camera plan (§5.7): choosing it runs `prepare {layout: "camera"}`
//   first (instant when the plan exists), with its progress on the card, and only then
//   `SetLayout`. The stage keeps the current layout meanwhile, a failure keeps it too, and another
//   choice made during the analysis wins. A face-track document whose plan is missing is analysed
//   on its own. The run is the clip's (layout-analysis.mjs `layoutAnalysisFor`), not this
//   panel's: it goes on when the panel closes, and Mode Cepat's Tata letak card shows it too.
// - Under face-track the runs without a face (the plan's `no_face` warnings) are listed with a
//   jump-to button each; the video is centred there (§3.7).
//
// Props: { state, dispatch, player } (panels/index.mjs), plus the optional seams `api` (prepare
// and `cameraProgress()`) and `previewClient` (thumbnails). Without them the fake runtime's
// objects (window.__potonginEditor) are used, and in the app the panel's own clients.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createApiClient } from "../../../lib/editor/api-client.mjs";
import { createPreviewClient } from "../../../lib/editor/preview-client.mjs";
import { formatClock, frameToMs, rejectionText } from "../shell-model.mjs";
import { analysisBusy, analysisForView, layoutAnalysisFor } from "./layout-analysis.mjs";
import styles from "./layout.module.css";
import {
  ANALYSIS_TEXT,
  LAYOUT_OPTIONS,
  analysisRangeMs,
  analysisView,
  cameraReadyFromState,
  contentKey,
  layoutCommand,
  noFaceList,
  rangeText,
  switchSteps,
  thumbnailFrame,
  thumbnailOrder,
  withLayout,
} from "./layout-model.mjs";

const THUMB_REST_MS = 400; // the playhead rests this long before the thumbnails follow it
const RATE_LIMIT_RETRIES = 2; // preview/frame allows 4 per second per session (plan §9.1)
const RATE_LIMIT_WAIT_MS = 350;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function fakeRuntime() {
  return typeof window !== "undefined" ? window.__potonginEditor ?? null : null;
}

function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** The API and the thumbnail client: explicit props, else the fake runtime's, else the panel's own. */
function useServices(state, props) {
  const own = useRef({ api: null, preview: null });
  const ids = useLatest({ jobId: state.jobId, clipId: state.clipId });
  const propsRef = useLatest(props);
  useEffect(() => () => {
    own.current.preview?.destroy?.();
    own.current = { api: null, preview: null };
  }, []);
  const api = useCallback(() => {
    if (propsRef.current.api) return propsRef.current.api;
    const fake = fakeRuntime();
    if (fake) return fake.api ?? null;
    if (!own.current.api) {
      try {
        own.current.api = createApiClient({ ...ids.current });
      } catch {
        return null;
      }
    }
    return own.current.api;
  }, [ids, propsRef]);
  const preview = useCallback(() => {
    if (propsRef.current.previewClient) return propsRef.current.previewClient;
    const fake = fakeRuntime();
    if (fake) return fake.previewClient ?? null; // the fake runtime makes no API call
    if (!own.current.preview) {
      try {
        own.current.preview = createPreviewClient({ ...ids.current });
      } catch {
        return null;
      }
    }
    return own.current.preview;
  }, [ids, propsRef]);
  return useMemo(() => ({ api, preview }), [api, preview]);
}

/** The playhead once it has rested (the frame bus of the player facade; not while playing). */
function useRestingPlayhead(player) {
  const [frame, setFrame] = useState(() => (typeof player?.frame === "function" ? player.frame() : 0));
  useEffect(() => {
    if (typeof player?.subscribeFrame !== "function") return undefined;
    let timer = null;
    const unsubscribe = player.subscribeFrame((next) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (player.state?.()?.playing === true) return;
        setFrame(next);
      }, THUMB_REST_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [player]);
  return frame;
}

/** Truth-frame thumbnails of the document in every layout at `frame`, current layout first. */
function useThumbnails({ state, services, frame, cameraReady }) {
  const [thumbs, setThumbs] = useState({});
  const urls = useRef(new Map());
  const generation = useRef(0);
  const doc = state.doc;
  const docKey = contentKey(doc);
  const docRef = useLatest(doc);
  const at = thumbnailFrame(frame, state.plan);
  const layoutRef = useLatest(doc?.layout?.default?.mode ?? null);

  useEffect(() => () => {
    generation.current += 1;
    for (const url of urls.current.values()) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);

  useEffect(() => {
    const current = docRef.current;
    if (!current || at === null) return undefined;
    const client = services.preview();
    const run = ++generation.current;
    if (!client || typeof client.frame !== "function") {
      setThumbs(Object.fromEntries(LAYOUT_OPTIONS.map((entry) => [entry.id, { status: "unavailable" }])));
      return undefined;
    }
    setThumbs((previous) => Object.fromEntries(LAYOUT_OPTIONS.map((entry) => [entry.id,
      { ...(previous[entry.id] ?? {}), status: previous[entry.id]?.url ? "refreshing" : "loading" }])));
    (async () => {
      for (const mode of thumbnailOrder(layoutRef.current)) {
        if (run !== generation.current) return;
        let next;
        try {
          let blob = null;
          for (let attempt = 0; ; attempt += 1) {
            try {
              blob = await client.frame(withLayout(current, mode), at);
              break;
            } catch (error) {
              if (error?.code !== "rate_limited" || attempt >= RATE_LIMIT_RETRIES) throw error;
              await wait(RATE_LIMIT_WAIT_MS);
              if (run !== generation.current) return;
            }
          }
          if (run !== generation.current) return;
          const url = URL.createObjectURL(blob);
          const old = urls.current.get(mode);
          urls.current.set(mode, url);
          if (old) setTimeout(() => URL.revokeObjectURL(old), 1000); // once the new image has taken over
          next = { status: "ready", url, frame: at };
        } catch (error) {
          if (run !== generation.current || error?.name === "AbortError") return;
          next = { status: error?.code === "analysis_missing" ? "needs_analysis" : "unavailable" };
        }
        setThumbs((previous) => ({ ...previous, [mode]: next }));
      }
    })();
    return undefined;
  }, [docKey, at, cameraReady, services, docRef, layoutRef]);

  return { thumbs, at };
}

function Thumbnail({ option, thumb, fps, rangeLabel, busy }) {
  if (thumb?.url) {
    const time = formatClock(frameToMs(thumb.frame ?? 0, fps));
    return (
      <img key={thumb.url} className={`${styles.thumb} ${thumb.status === "refreshing" ? styles.thumbStale : ""}`} src={thumb.url}
        width={90} height={160} alt={`Contoh ${option.name} di ${time}`} data-layout-thumb={option.id} draggable={false} />
    );
  }
  if (busy) return <span className={styles.thumbEmpty} data-layout-thumb-empty={option.id} />; // the card progress says it
  const text = thumb?.status === "needs_analysis"
    ? `${ANALYSIS_TEXT.needed}${rangeLabel ? ` (${rangeLabel})` : ""}`
    : thumb?.status === "unavailable" ? ANALYSIS_TEXT.unavailable : "Memuat contoh…";
  return <span className={styles.thumbEmpty} data-layout-thumb-empty={option.id}>{text}</span>;
}

/** The analysis on the face-track card: a percentage and its bar, or the seconds and a moving bar. */
function CardProgress({ view }) {
  const determinate = view?.determinate === true;
  return (
    <span className={styles.cardProgress} data-layout-card-progress="camera" aria-hidden="true">
      <span className={styles.cardProgressText}>{determinate ? `${view.percent}%` : `${view?.seconds ?? 0} dtk`}</span>
      <span className={styles.cardTrack}>
        <span className={`${styles.cardFill} ${determinate ? "" : styles.cardFillUnknown}`}
          style={determinate ? { width: `${view.percent}%` } : undefined} />
      </span>
    </span>
  );
}

function LayoutPanelBody({ state, dispatch, player, api: apiProp, previewClient, analysisStore }) {
  const doc = state.doc;
  const readOnly = state.status !== "ready";
  const layout = doc.layout.default.mode;
  const fps = doc.output.fps;
  const services = useServices(state, { api: apiProp, previewClient });
  // The clip's face analysis (layout-analysis.mjs): it outlives this panel and Mode Cepat's
  // Tata letak card, so either shows a run the other started.
  const run = useSyncExternalStore(analysisStore.subscribe, analysisStore.get, analysisStore.get);
  const [message, setMessage] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useLatest(state);
  const dispatchRef = useLatest(dispatch);
  const frame = useRestingPlayhead(player);
  const cameraReady = run.cameraReady || cameraReadyFromState(state);
  const { thumbs, at } = useThumbnails({ state, services, frame, cameraReady });
  const choice = analysisBusy(run) && run.target === "camera" ? "camera" : null; // face-track while its analysis runs
  const running = run.phase === "running";

  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const switchTo = (mode) => {
    const { type, args, mergeKey } = layoutCommand(mode);
    try {
      dispatchRef.current(type, args, { mergeKey });
      setMessage(null);
    } catch (error) {
      setMessage(rejectionText(error));
    }
  };

  const analyse = useCallback(({ switchAfter = true, auto = false } = {}) => {
    setMessage(null);
    return analysisStore.start({ api: services.api(), dispatch: (...args) => dispatchRef.current(...args),
      getState: () => stateRef.current, switchAfter, auto });
  }, [analysisStore, services, dispatchRef, stateRef]);

  const choose = (mode) => {
    if (readOnly) return;
    const steps = switchSteps({ target: mode, current: layout, cameraReady });
    if (steps === "analyze") {
      analyse();
      return;
    }
    // any other choice ends a pending face-track switch (its analysis finishes on the server)
    analysisStore.cancelSwitch();
    if (steps === "dispatch") switchTo(mode);
  };

  // A face-track document whose camera plan is missing (the plan request says so): analyse it,
  // once per clip.
  const missing = state.previewError?.code === "analysis_missing" && layout === "camera";
  useEffect(() => {
    if (missing) analyse({ switchAfter: false, auto: true });
  }, [missing, analyse]);

  const view = analysisView(analysisForView(run), now);
  const refused = message ?? (run.phase !== "failed" ? run.message : null);
  const shownLayout = choice ?? layout;
  const shown = LAYOUT_OPTIONS.find((entry) => entry.id === shownLayout) ?? LAYOUT_OPTIONS[0];
  const pending = choice !== null && choice !== layout;
  const rangeLabel = rangeText(analysisRangeMs(doc));
  const planCurrent = !(state.pending ?? []).includes("text") && !state.previewError && Boolean(state.plan);
  const noFace = noFaceList(state.plan);

  return (
    <section data-panel="layout" className={styles.panel} aria-busy={running}>
      {refused ? <p className={styles.message} role="alert">{refused}</p> : null}
      <div className={styles.section}>
        <div className={styles.head}>
          <h3 className={styles.title}>Tata letak video</h3>
          <p className={styles.note}>Berlaku untuk seluruh klip.</p>
        </div>
        <fieldset className={styles.fieldset} disabled={readOnly}>
          <legend className={styles.srOnly}>Pilih tata letak</legend>
          <div className={styles.options}>
            {LAYOUT_OPTIONS.map((option) => (
              <label key={option.id} className={styles.option} data-layout-option={option.id}
                data-current={option.id === layout ? "true" : undefined}>
                <input type="radio" className={styles.cover} name="layout-mode" value={option.id}
                  aria-labelledby={`layout-name-${option.id}`} aria-describedby={`layout-note-${option.id}`}
                  checked={shownLayout === option.id} onChange={() => choose(option.id)} />
                <span className={styles.thumbBox}>
                  <Thumbnail option={option} thumb={thumbs[option.id]} fps={fps} busy={option.id === "camera" && running}
                    rangeLabel={option.id === "camera" && !cameraReady ? rangeLabel : null} />
                  {option.id === "camera" && running ? <CardProgress view={view} /> : null}
                </span>
                <span className={styles.name} id={`layout-name-${option.id}`}>{option.name}</span>
                {pending && option.id === layout ? <span className={styles.badge}>Dipakai</span> : null}
                <span className={styles.srOnly} id={`layout-note-${option.id}`}>{option.note}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className={styles.about} data-layout-about="" aria-hidden="true">
          <strong>{`${shown.name}:`}</strong>{` ${shown.note}`}
        </p>
        {view && running ? (
          <div className={styles.analysis} data-layout-analysis="" role="status">
            <progress className={styles.progress} aria-label="Analisis wajah"
              max={view.determinate ? view.max : undefined} value={view.determinate ? view.value : undefined} />
            <span data-layout-analysis-text="">{view.text}</span>
            {run.target === "camera" ? (
              <span className={styles.note}>Tata letak berganti setelah analisis selesai. Pilih yang lain untuk membatalkan.</span>
            ) : null}
          </div>
        ) : null}
        {view && run.phase === "failed" ? (
          <div className={styles.failure} role="alert" data-layout-analysis-error="">
            <span>{view.text}</span>
            <button type="button" className={styles.button} disabled={readOnly && layout !== "camera"}
              onClick={() => analyse({ switchAfter: layout !== "camera" })}>Coba lagi</button>
          </div>
        ) : null}
        <p className={styles.note}>{`Contoh diambil dari frame akhir di posisi ${formatClock(frameToMs(at ?? 0, fps))}.`}</p>
      </div>
      {layout === "camera" ? (
        <div className={styles.section} data-layout-noface="">
          {!planCurrent ? (
            <p className={styles.note}>Memeriksa hasil analisis wajah…</p>
          ) : noFace.length === 0 ? (
            <p className={styles.note}>Wajah terdeteksi di seluruh klip.</p>
          ) : (
            <>
              <h4 className={styles.subtitle}>{`Tanpa wajah terdeteksi (${noFace.length})`}</h4>
              <p className={styles.note}>Di bagian ini video dipusatkan.</p>
              <ul className={styles.jumps}>
                {noFace.map((entry) => (
                  <li key={entry.f}>
                    <button type="button" className={styles.jump} onClick={() => player?.seek?.(entry.f)}>
                      {`Lompat ke ${entry.time}`}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default function LayoutPanel(props) {
  const { state } = props;
  const analysisStore = layoutAnalysisFor(state?.clipId ?? state?.doc?.clip_id ?? null);
  if (!state?.doc || !analysisStore) {
    return (
      <section data-panel="layout" className={styles.panel} aria-busy={state?.status === "loading"}>
        <p className={styles.note}>Membuka tata letak…</p>
      </section>
    );
  }
  return <LayoutPanelBody {...props} analysisStore={analysisStore} />;
}
