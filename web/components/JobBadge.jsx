"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  INITIAL_BADGE_STATE,
  JOBS_CHANGED_EVENT,
  badgeReducer,
  badgeStateView,
  nextBadgeRequest,
} from "../lib/job-badge.mjs";

// The page's own requests go first: the badge starts reading once the browser is idle.
function whenIdle(callback) {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: 1500 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 300);
  return () => window.clearTimeout(handle);
}

/** One request of the badge, as a badgeReducer event. */
async function read(request) {
  const url = request.kind === "job" ? `/api/jobs/${encodeURIComponent(request.jobId)}` : "/api/jobs";
  const response = await fetch(url, { cache: "no-store", priority: "low", headers: { Accept: "application/json" } });
  if (response.status === 401) return { type: "signed-out" };
  if (request.kind === "job" && response.status === 404) return { type: "missing", jobId: request.jobId };
  if (!response.ok) return { type: "failed" };
  const payload = await response.json().catch(() => null);
  return request.kind === "job" ? { type: "job", job: payload?.job } : { type: "list", jobs: payload?.jobs, at: Date.now() };
}

/**
 * "1 berjalan · 42%" while a job runs, else "Terakhir: 8 klip" for the newest finished job, as a
 * link to that project; nothing without jobs. Reads only while the tab is visible.
 */
export default function JobBadge() {
  const pathname = usePathname();
  const [state, setState] = useState(INITIAL_BADGE_STATE);

  useEffect(() => {
    let current = INITIAL_BADGE_STATE;
    let alive = true;
    let timer = null;
    let busy = false;
    let refreshAfter = false;
    const visible = () => document.visibilityState !== "hidden";
    const stopTimer = () => {
      window.clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      stopTimer();
      const next = nextBadgeRequest(current, { visible: visible(), now: Date.now() });
      if (next) timer = window.setTimeout(() => run(next), next.delayMs);
    };
    // Requests are never aborted (an abort reads as a failed request); a request asked for while
    // one is out waits for it, and an unmounted badge ignores the answer.
    async function run(request) {
      stopTimer();
      if (busy) {
        refreshAfter = true;
        return;
      }
      busy = true;
      let event;
      try {
        event = await read(request);
      } catch {
        event = { type: "failed" };
      }
      busy = false;
      if (!alive) return;
      current = badgeReducer(current, event);
      setState(current);
      if (refreshAfter) {
        refreshAfter = false;
        run({ kind: "list" });
      } else {
        schedule();
      }
    }
    const refresh = () => run({ kind: "list" });
    const onVisibility = () => {
      if (visible()) refresh();
      else stopTimer();
    };
    const cancelStart = whenIdle(() => {
      if (visible()) refresh();
    });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(JOBS_CHANGED_EVENT, refresh);
    return () => {
      alive = false;
      cancelStart();
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(JOBS_CHANGED_EVENT, refresh);
    };
  }, []);

  const view = badgeStateView(state);
  return (
    <>
      {view && (
        <a
          className="jobBadge"
          href={view.href}
          title={view.title}
          data-kind={view.kind}
          data-tone={view.tone ?? undefined}
          data-short={view.short}
          aria-current={pathname === view.href ? "page" : undefined}
        >
          {view.kind === "running" && <span className="jobBadgeDot" aria-hidden="true" />}
          <span className="jobBadgeText">{view.text}</span>
        </a>
      )}
      <span className="visuallyHidden" aria-live="polite" aria-atomic="true">{state.announcement}</span>
    </>
  );
}
