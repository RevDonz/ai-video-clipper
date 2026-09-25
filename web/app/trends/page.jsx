"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import TrendAgentPanel from "../../components/trends/TrendAgentPanel.jsx";
import TrendItemCard from "../../components/trends/TrendItemCard.jsx";
import TrendManualForm from "../../components/trends/TrendManualForm.jsx";
import { createTrendApi } from "../../components/trends/trend-api.mjs";
import {
  TREND_KINDS,
  TREND_KIND_LABELS,
  TREND_STATUS_FILTERS,
  filterTrendItems,
  formatDateTime,
  groupTrendItems,
  normalizeTrendItem,
  relativeTime,
  trendCounts,
} from "../../lib/trend-view.mjs";
import "./trends.css";

const CLOCK_MS = 60_000;

export default function TrendsPage() {
  const api = useMemo(() => createTrendApi(), []);
  const [loadState, setLoadState] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [items, setItems] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [lastIngestAt, setLastIngestAt] = useState(null);
  const [pendingEnabled, setPendingEnabled] = useState(null); // optimistic while the PUT is in flight
  const [tokensState, setTokensState] = useState({ state: "loading", tokens: [], error: "" });
  const [origin, setOrigin] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [notice, setNotice] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const mounted = useRef(true);
  const listHeading = useRef(null);

  async function loadTrends({ quiet = false } = {}) {
    if (!quiet) setLoadState("loading");
    const result = await api.loadTrends();
    if (!mounted.current) return;
    if (!result.ok) {
      if (quiet) setNotice({ tone: "error", text: result.error });
      else {
        setLoadError(result.status === 404 ? "Fitur Konteks Tren belum tersedia di server ini." : result.error);
        setLoadState("error");
      }
      return;
    }
    setItems(result.data.items);
    if (!quiet && result.data.items.length === 0) setAddOpen(true);
    setEnabled(result.data.enabled);
    setLastIngestAt(result.data.lastIngestAt);
    setNow(Date.now());
    setLoadState("ready");
  }

  async function loadTokens({ quiet = false } = {}) {
    if (!quiet) setTokensState((current) => ({ ...current, state: "loading", error: "" }));
    const result = await api.loadTokens();
    if (!mounted.current) return;
    setTokensState(result.ok
      ? { state: "ready", tokens: result.data, error: "" }
      : { state: "error", tokens: [], error: result.error });
  }

  useEffect(() => {
    mounted.current = true;
    setOrigin(window.location.origin);
    void loadTrends();
    void loadTokens();
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      mounted.current = false;
      clearInterval(clock);
    };
  }, []);

  // Shows the new state at once and reverts on failure; never disabled, so
  // keyboard focus stays on the switch.
  async function toggleEnabled(event) {
    if (pendingEnabled !== null) return;
    const next = event.target.checked;
    setPendingEnabled(next);
    setNotice(null);
    const result = await api.setEnabled(next);
    if (!mounted.current) return;
    setPendingEnabled(null);
    if (result.ok) {
      setEnabled(result.data.enabled);
      setNotice({
        tone: "ok",
        text: result.data.enabled
          ? "Konteks tren dipakai lagi mulai job berikutnya."
          : "Konteks tren dimatikan. Job berikutnya berjalan persis seperti tanpa tren; item tetap tersimpan.",
      });
    } else {
      setNotice({ tone: "error", text: result.error });
    }
  }

  async function createItem(payload) {
    const result = await api.createTrend(payload);
    if (!mounted.current) return result;
    if (result.ok) {
      if (result.data) setItems((current) => [result.data, ...current.filter((entry) => entry.id !== result.data.id)]);
      else await loadTrends({ quiet: true });
      setNow(Date.now());
    }
    return result;
  }

  async function updateItem(item, patch) {
    const result = await api.updateTrend(item.id, patch);
    if (!mounted.current) return result;
    if (result.ok) {
      const next = result.data || normalizeTrendItem({ ...item, ...patch });
      setItems((current) => current.map((entry) => (entry.id === item.id ? next : entry)));
      setNow(Date.now());
    } else if (result.status === 404) {
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setNotice({ tone: "error", text: `“${item.title}” sudah tidak ada di server; daftar diperbarui.` });
    }
    return result;
  }

  async function deleteItem(item) {
    const result = await api.deleteTrend(item.id);
    if (!mounted.current) return result;
    if (result.ok || result.status === 404) {
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setNotice({ tone: "ok", text: `“${item.title}” dihapus.` });
      requestAnimationFrame(() => listHeading.current?.focus());
      return { ...result, ok: true };
    }
    return result;
  }

  async function createToken(label) {
    const result = await api.createToken(label);
    if (mounted.current && (result.ok || result.status === 409)) await loadTokens({ quiet: true });
    return result;
  }

  async function revokeToken(id) {
    const result = await api.revokeToken(id);
    if (mounted.current && (result.ok || result.status === 404)) await loadTokens({ quiet: true });
    return result;
  }

  const switchOn = pendingEnabled ?? enabled;
  const counts = trendCounts(items, now);
  const visible = filterTrendItems(items, { query, kind, status }, now);
  const groups = groupTrendItems(visible, now);
  const filtered = query.trim() !== "" || kind !== "all" || status !== "all";
  const lastIngestRelative = relativeTime(lastIngestAt, now);

  return (
    <main className="trendsPage">
      <nav className="nav shell">
        <a className="brand" href="/"><span>P</span> Potongin AI</a>
        <div className="navActions">
          <div className="navLinks"><a href="/dashboard">Buat Klip</a><a href="/projects">Riwayat</a><a className="active" href="/trends" aria-current="page">Konteks Tren</a><a href="/settings">Pengaturan</a></div>
          <form method="post" action="/api/auth/logout"><button type="submit">Keluar</button></form>
        </div>
      </nav>

      <section className="trHero shell">
        <div className="eyebrow">KONTEKS · TREN TERKINI</div>
        <h1>Konteks Tren</h1>
        <p>
          Topik, orang, jokes, meme, sound, dan hashtag yang sedang ramai, dikirim agen Anda atau ditambah manual.
          Dipakai untuk judul, teks hook, deskripsi, dan hashtag klip, serta sedikit menaikkan peringkat momen yang
          <b> benar-benar menyebut</b> tren itu di transkripnya. Momen bagus tanpa tren tetap menang.
        </p>
      </section>

      {notice && (
        <div className="shell">
          <p className={`trAlert page ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            <span>{notice.text}</span>
            <button type="button" className="trDismiss" onClick={() => setNotice(null)} aria-label="Tutup pesan">×</button>
          </p>
        </div>
      )}

      {loadState === "loading" && <div className="shell"><div className="panel trLoading" role="status">Memuat konteks tren…</div></div>}
      {loadState === "error" && (
        <div className="shell">
          <div className="panel trLoading" role="alert">
            <p>{loadError || "Konteks tren tidak bisa dimuat."}</p>
            <button type="button" className="trPrimary" onClick={() => loadTrends()}>Coba lagi</button>
          </div>
        </div>
      )}

      {loadState === "ready" && (
        <div className="trLayout shell">
          <section className="panel trCard" aria-labelledby="tr-status-title">
            <div className="panelHead compact"><span>01</span><div><h2 id="tr-status-title">Pemakaian</h2><p>Berlaku untuk job V3 berikutnya.</p></div></div>
            <div className="trUsage">
              <label className="trMainSwitch">
                <input type="checkbox" role="switch" checked={switchOn} onChange={toggleEnabled} aria-busy={pendingEnabled !== null || undefined} aria-describedby="tr-switch-help" />
                <span>
                  <strong>Pakai konteks tren di pemilihan klip</strong>
                  <small id="tr-switch-help">
                    {switchOn
                      ? "Aktif. Tren hanya dipakai kalau transkrip klip menyebut kata kuncinya; tanpa tren aktif, hasil job sama persis seperti biasa."
                      : "Mati. Job berjalan persis seperti tanpa tren. Item tetap tersimpan dan agen tetap bisa mengirim."}
                  </small>
                </span>
              </label>
              <dl className="trStats">
                <div><dt>Aktif</dt><dd>{counts.active}</dd></div>
                <div><dt>Nonaktif</dt><dd>{counts.disabled}</dd></div>
                <div><dt>Kedaluwarsa</dt><dd>{counts.expired}</dd></div>
                <div><dt>Sensitif</dt><dd>{counts.sensitive}</dd></div>
              </dl>
            </div>
            <p className="trFootnote">
              {lastIngestAt
                ? <>Kiriman agen terakhir <span title={formatDateTime(lastIngestAt) || undefined}>{lastIngestRelative}</span>.</>
                : "Belum ada kiriman dari agen. Hubungkan agen di bagian Integrasi agen di bawah."}
              {" "}Item kedaluwarsa tidak dipakai dan dihapus otomatis 7 hari kemudian.
            </p>
          </section>

          <section className="panel trCard" aria-labelledby="tr-list-title">
            <div className="panelHead compact">
              <span>02</span>
              <div>
                <h2 id="tr-list-title" ref={listHeading} tabIndex={-1}>Daftar tren</h2>
                <p>{counts.all} item · aktif dan kedaluwarsa ≤ 7 hari. Teks dari agen hanya data: tidak pernah dijalankan sebagai perintah.</p>
              </div>
            </div>

            <details className="trAdd" open={addOpen} onToggle={(event) => setAddOpen(event.currentTarget.open)}>
              <summary>
                <span>+ Tambah tren manual</span>
                <small>Untuk tren yang Anda tahu tapi belum dikirim agen</small>
              </summary>
              <TrendManualForm now={now} onCreate={createItem} />
            </details>

            <div className="trFilters" role="search">
              <div className="trField trSearch">
                <label htmlFor="tr-search">Cari</label>
                <input id="tr-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Judul, kata kunci, hashtag…" autoComplete="off" />
              </div>
              <div className="trField">
                <label htmlFor="tr-kind">Jenis</label>
                <select id="tr-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="all">Semua jenis ({counts.all})</option>
                  {TREND_KINDS.map((entry) => <option key={entry} value={entry}>{TREND_KIND_LABELS[entry]} ({counts.byKind[entry] || 0})</option>)}
                  {counts.byKind.other > 0 && <option value="other">Lainnya ({counts.byKind.other})</option>}
                </select>
              </div>
              <div className="trStatusFilter" role="group" aria-label="Filter status">
                {TREND_STATUS_FILTERS.map((entry) => (
                  <button key={entry.id} type="button" aria-pressed={status === entry.id} className={status === entry.id ? "active" : ""} onClick={() => setStatus(entry.id)}>
                    {entry.label} <span>{entry.id === "all" ? counts.all : counts[entry.id]}</span>
                  </button>
                ))}
              </div>
            </div>
            <p className="visuallyHidden" role="status" aria-live="polite">{filtered ? `${visible.length} tren cocok` : ""}</p>

            {items.length === 0 ? (
              <div className="trEmpty big">
                <strong>Belum ada tren</strong>
                <p>Hubungkan agen di bagian Integrasi agen, atau tambah tren manual di atas.</p>
              </div>
            ) : groups.length === 0 ? (
              <div className="trEmpty big">
                <strong>Tidak ada tren yang cocok</strong>
                <p>Ubah kata pencarian atau filter.</p>
                <button type="button" className="trSecondary" onClick={() => { setQuery(""); setKind("all"); setStatus("all"); }}>Reset filter</button>
              </div>
            ) : (
              groups.map((group) => (
                <section key={group.kind} className="trGroup" aria-labelledby={`tr-group-${group.kind}`}>
                  <h3 id={`tr-group-${group.kind}`}>{group.label} <span>{group.items.length}</span></h3>
                  <div className="trGrid">
                    {group.items.map((item) => (
                      <TrendItemCard
                        key={item.id}
                        item={item}
                        now={now}
                        onUpdate={(patch) => updateItem(item, patch)}
                        onDelete={() => deleteItem(item)}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </section>

          <section className="panel trCard" aria-labelledby="tr-agent-title">
            <div className="panelHead compact"><span>03</span><div><h2 id="tr-agent-title">Integrasi agen (Hermes)</h2><p>Endpoint dan token supaya agen luar mengisi konteks tren otomatis.</p></div></div>
            <TrendAgentPanel
              origin={origin}
              tokensState={tokensState}
              now={now}
              onCreateToken={createToken}
              onRevokeToken={revokeToken}
              onReloadTokens={() => loadTokens()}
            />
          </section>
        </div>
      )}
    </main>
  );
}
