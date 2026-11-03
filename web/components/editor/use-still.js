"use client";

// The source picture at the playhead that the framing gizmos draw on: a truth frame of
// `sourceFrameDoc` (framing-model.mjs), asked when the playhead rests, through a preview client of
// its own so these stills never cancel the stage's "Frame akhir".
import { useCallback, useEffect, useRef, useState } from "react";

import { createPreviewClient } from "../../lib/editor/preview-client.mjs";
import { sourceFrameDoc, stillKey } from "./framing-model.mjs";

const STILL_REST_MS = 150; // the playhead rests this long before the picture follows it
const RATE_LIMIT_RETRIES = 2; // preview/frame allows 4 per second per session (plan §9.1)
const RATE_LIMIT_WAIT_MS = 350;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** The still's own preview client (or `previewClient`), so its stills never cancel the stage's. */
export function useStillClient(state, previewClient) {
  const own = useRef(null);
  const ids = useLatest({ jobId: state.jobId, clipId: state.clipId });
  useEffect(() => () => {
    own.current?.destroy?.();
    own.current = null;
  }, []);
  return useCallback(() => {
    if (previewClient) return previewClient;
    if (!own.current) {
      try {
        own.current = createPreviewClient({ ...ids.current });
      } catch {
        return null;
      }
    }
    return own.current;
  }, [previewClient, ids]);
}

/**
 * The source picture at `frame`: `{url, state}` with state "loading", "ready" or "failed". The dialogs and
 * "Lihat sumber" (shell/SourceStage.jsx) draw on it.
 */
export function useStill({ client, doc, frame }) {
  const [still, setStill] = useState({ url: null, state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const urlRef = useRef(null);
  const docRef = useLatest(doc);
  const key = stillKey(doc);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => {
    if (!docRef.current) return undefined;
    let alive = true;
    setStill((previous) => ({ ...previous, state: "loading" }));
    const timer = setTimeout(async () => {
      const api = client();
      if (!api || typeof api.frame !== "function") {
        if (alive) setStill((previous) => ({ ...previous, state: "failed" }));
        return;
      }
      try {
        let blob = null;
        for (let tries = 0; ; tries += 1) {
          try {
            blob = await api.frame(sourceFrameDoc(docRef.current), frame);
            break;
          } catch (error) {
            if (error?.code !== "rate_limited" || tries >= RATE_LIMIT_RETRIES) throw error;
            await wait(RATE_LIMIT_WAIT_MS);
            if (!alive) return;
          }
        }
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        const old = urlRef.current;
        urlRef.current = url;
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1000); // once the new picture has taken over
        setStill({ url, state: "ready" });
      } catch (error) {
        if (!alive || error?.name === "AbortError") return;
        setStill((previous) => ({ ...previous, state: "failed" }));
      }
    }, STILL_REST_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, frame, attempt, client, docRef]);

  return { still, retry: () => setAttempt((count) => count + 1) };
}
