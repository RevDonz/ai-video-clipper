"use client";

// Pengaturan → Sistem → Tentang sistem (CONTRACTS §5.34): the components this server runs, to
// quote when reporting a problem. Read-only and loaded on its own: another card failing to load
// must not hide it, and its own failure must not touch the others.
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { systemInfoRows } from "../../lib/system-info-view.mjs";
import { CardLoadError, CardLoading } from "./CardState.jsx";
import { useViewText } from "./view-text.jsx";

async function requestSystem() {
  const response = await fetch("/api/settings/system", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

export default function SystemCard() {
  const t = useTranslations("settings");
  const text = useViewText();
  const [system, setSystem] = useState({ phase: "loading", info: null, error: null });
  const alive = useRef(true);

  async function loadSystem() {
    setSystem({ phase: "loading", info: null, error: null });
    try {
      const { ok, status, payload } = await requestSystem();
      if (!alive.current) return;
      if (ok && payload) setSystem({ phase: "ready", info: payload, error: null });
      else setSystem({ phase: "error", info: null, error: status === 401 ? t("common.error.session") : t("system.loadFailed") });
    } catch {
      if (alive.current) setSystem({ phase: "error", info: null, error: t("system.loadFailed") });
    }
  }

  useEffect(() => {
    alive.current = true;
    void loadSystem();
    return () => { alive.current = false; };
  }, []);

  return (
    <section className="settingsCard" aria-labelledby="system-title">
      <h2 id="system-title" className="settingsCardTitle">{t("system.about")}</h2>
      {system.phase === "loading" && <CardLoading label={t("common.loading")} lines={3} />}
      {system.phase === "error" && <CardLoadError message={system.error} onRetry={loadSystem} />}
      {system.phase === "ready" && (
        <dl className="settingsSystemList">
          {systemInfoRows(system.info).map((row) => (
            <div key={row.id} className="settingsSystemItem" data-known={row.known ? "true" : "false"}>
              <dt>{row.label} <small>{text(row.hint)}</small></dt>
              <dd>{text(row.value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
