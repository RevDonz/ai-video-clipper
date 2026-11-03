"use client";

// What the two Tata letak panels share (panels/LayoutPanel.jsx and panels/LayoutTab.jsx): the API
// and thumbnail clients, the playhead once it has rested, and the truth-frame thumbnail of the
// document in every layout.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createApiClient } from "../../../lib/editor/api-client.mjs";
import { createPreviewClient } from "../../../lib/editor/preview-client.mjs";
import { LAYOUT_OPTIONS, contentKey, thumbnailFrame, thumbnailOrder, withLayout } from "./layout-model.mjs";

const THUMB_REST_MS = 400; // the playhead rests this long before the thumbnails follow it
const RATE_LIMIT_RETRIES = 2; // preview/frame allows 4 per second per session (plan §9.1)
const RATE_LIMIT_WAIT_MS = 350;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function fakeRuntime() {
  return typeof window !== "undefined" ? window.__potonginEditor ?? null : null;
}

export function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** The API and the thumbnail client: explicit props, else the fake runtime's, else the panel's own. */
export function useServices(state, props) {
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
export function useRestingPlayhead(player) {
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
export function useThumbnails({ state, services, frame, cameraReady }) {
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
