"use client";

import { useEffect, useRef, useState } from "react";

import {
  GUIDE_URL,
  INGEST_PATH,
  TOKEN_ENV,
  TREND_LIMITS,
  activeTokenCount,
  curlExample,
  ingestEndpoint,
  tokenView,
  validateTokenLabel,
} from "../../lib/trend-view.mjs";
import CopyButton from "./CopyButton.jsx";
import { describedBy } from "./TrendFields.jsx";

/**
 * "Integrasi agen (Hermes)": the ingest endpoint for this deployment, token
 * creation (the value is shown once, then only kept in this component's
 * state until dismissed), the token list and revocation with an in-page
 * confirmation.
 */
export default function TrendAgentPanel({ origin, tokensState, now, onCreateToken, onRevokeToken, onReloadTokens }) {
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null); // { token, record } — never persisted
  const [confirmingId, setConfirmingId] = useState(null);
  const [revokingId, setRevokingId] = useState(null);
  const [notice, setNotice] = useState(null);
  const createdBox = useRef(null);
  const createButton = useRef(null);
  const listHeading = useRef(null);

  const endpoint = ingestEndpoint(origin) || INGEST_PATH;
  const tokens = tokensState.tokens || [];
  const active = activeTokenCount(tokens);
  const full = active >= TREND_LIMITS.maxActiveTokens;

  useEffect(() => {
    if (created) createdBox.current?.focus();
  }, [created]);

  async function create(event) {
    event.preventDefault();
    const checked = validateTokenLabel(label);
    if (checked.error) {
      setLabelError(checked.error);
      return;
    }
    setCreating(true);
    setNotice(null);
    const result = await onCreateToken(checked.label);
    setCreating(false);
    if (result.ok) {
      setCreated({ token: result.data.token, label: result.data.record?.label || checked.label });
      setLabel("");
      setLabelError("");
    } else if (result.field === "label") {
      setLabelError(result.error);
    } else {
      setNotice({ tone: "error", text: result.error });
    }
  }

  function dismissCreated() {
    setCreated(null);
    createButton.current?.focus();
  }

  async function revoke(token) {
    setRevokingId(token.id);
    setNotice(null);
    const result = await onRevokeToken(token.id);
    setRevokingId(null);
    setConfirmingId(null);
    listHeading.current?.focus();
    setNotice(result.ok
      ? { tone: "ok", text: `Token “${token.label}” dicabut. Agen yang memakainya tidak bisa mengirim lagi.` }
      : { tone: "error", text: result.error });
  }

  return (
    <div className="trAgent">
      <div className="trAgentIntro">
        <p>
          Potongin <b>tidak men-scrape</b> TikTok, Instagram, atau YouTube sendiri. Agen milik Anda (mis. Hermes yang men-scroll
          Shorts dan FYP) merangkum tren lalu mengirimnya ke endpoint di bawah dengan token. Item dari agen muncul di daftar
          atas dengan sumber “Agen: &lt;label token&gt;”.
        </p>
        <a className="trGuideLink" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">Panduan integrasi Hermes ↗</a>
      </div>

      <div className="trEndpoint">
        <label htmlFor="trend-endpoint">URL endpoint</label>
        <div className="trInlineRow">
          <input id="trend-endpoint" readOnly value={endpoint} onFocus={(event) => event.target.select()} spellCheck={false} aria-describedby="trend-endpoint-help" />
          <CopyButton text={endpoint} label="Salin URL" announce="URL endpoint" />
        </div>
        <small id="trend-endpoint-help">
          <code>POST</code> kirim item (maks 100 per permintaan) · <code>GET</code> daftar ringkas untuk dedupe · <code>DELETE ?externalId=…</code> hapus item sumber itu.
          Header <code>Authorization: Bearer ptk_…</code>, isi <code>application/json</code>.
        </small>
      </div>

      <form className="trTokenForm" onSubmit={create} noValidate>
        <div className="trField">
          <label htmlFor="token-label">Label token baru</label>
          <div className="trInlineRow">
            <input
              id="token-label"
              value={label}
              maxLength={TREND_LIMITS.tokenLabel + 10}
              placeholder="mis. Hermes VPS"
              autoComplete="off"
              aria-invalid={labelError ? true : undefined}
              aria-describedby={describedBy("token-label", true, labelError)}
              onChange={(event) => { setLabel(event.target.value); setLabelError(""); }}
            />
            <button type="submit" ref={createButton} className="trPrimary" disabled={creating || full || tokensState.state !== "ready"}>
              {creating ? "Membuat…" : "Buat token"}
            </button>
          </div>
          <small id="token-label-help">
            {full
              ? `Sudah ${TREND_LIMITS.maxActiveTokens} token aktif (batas). Cabut yang tidak dipakai untuk membuat yang baru.`
              : "Satu token per agen/mesin. Label tampil sebagai sumber item. Nilai token hanya ditampilkan sekali."}
          </small>
          {labelError && <small className="trFieldError" id="token-label-error">{labelError}</small>}
        </div>
      </form>

      {created && (
        <section className="trNewToken" ref={createdBox} tabIndex={-1} aria-labelledby="new-token-title">
          <strong id="new-token-title">Token “{created.label}” dibuat — salin sekarang</strong>
          <p>Token ini <b>hanya ditampilkan sekali</b>. Server hanya menyimpan hash-nya; kalau hilang, cabut lalu buat token baru. Simpan di secret agen (variabel <code>{TOKEN_ENV}</code>), jangan di chat atau repo.</p>
          <label htmlFor="new-token-value">Token</label>
          <div className="trInlineRow">
            <input id="new-token-value" readOnly value={created.token} onFocus={(event) => event.target.select()} spellCheck={false} autoComplete="off" />
            <CopyButton text={created.token} label="Salin token" announce="Token" className="trPrimary" />
          </div>
          <div className="trCurlHead">
            <span id="curl-title">Contoh kirim satu item (curl)</span>
            <CopyButton text={curlExample({ origin, token: created.token })} label="Salin contoh curl" announce="Contoh curl" />
          </div>
          <pre className="trCurl" aria-labelledby="curl-title" tabIndex={0}><code>{curlExample({ origin, token: created.token })}</code></pre>
          <small>Contoh ini membuat item “Tren uji coba” dengan <code>externalId</code> contoh; hapus dari daftar setelah uji coba.</small>
          <div className="trActions">
            <button type="button" className="trSecondary" onClick={dismissCreated}>Sudah saya simpan — sembunyikan token</button>
          </div>
        </section>
      )}

      {notice && <p className={`trAlert ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}

      <div className="trTokens">
        <div className="trTokensHead">
          <h3 id="token-list-title" ref={listHeading} tabIndex={-1}>Token</h3>
          <span>{active} aktif dari maks {TREND_LIMITS.maxActiveTokens}</span>
        </div>
        {tokensState.state === "loading" && <p className="trEmpty" role="status">Memuat token…</p>}
        {tokensState.state === "error" && (
          <div className="trAlert error" role="alert">
            <span>{tokensState.error}</span>
            <button type="button" className="trSecondary" onClick={onReloadTokens}>Coba lagi</button>
          </div>
        )}
        {tokensState.state === "ready" && tokens.length === 0 && <p className="trEmpty">Belum ada token. Buat satu untuk agen Anda.</p>}
        {tokensState.state === "ready" && tokens.length > 0 && (
          <ul className="trTokenList" aria-labelledby="token-list-title">
            {tokens.map((token) => {
              const view = tokenView(token, now);
              return (
                <li key={token.id} className={view.status}>
                  <div className="trTokenIdentity">
                    <strong>{token.label}</strong>
                    <code>{view.prefixText}</code>
                    <span className={`trBadge ${view.status === "active" ? "ok" : "expired"}`}>{view.statusLabel}</span>
                  </div>
                  <dl>
                    <div><dt>Dibuat</dt><dd>{view.createdText}</dd></div>
                    <div><dt>Terakhir dipakai</dt><dd title={view.lastUsedAbsolute || undefined}>{view.lastUsedText}</dd></div>
                  </dl>
                  {view.status === "active" && confirmingId !== token.id && (
                    <button type="button" className="trSecondary danger" onClick={() => { setNotice(null); setConfirmingId(token.id); }} aria-label={`Cabut token ${token.label}`}>Cabut</button>
                  )}
                  {confirmingId === token.id && (
                    <div className="trConfirm" role="group" aria-label={`Konfirmasi cabut token ${token.label}`} onKeyDown={(event) => { if (event.key === "Escape" && !revokingId) setConfirmingId(null); }}>
                      <strong>Cabut “{token.label}”?</strong>
                      <p>Agen yang memakai token ini langsung ditolak (401). Item yang sudah masuk tetap ada.</p>
                      <div>
                        <button type="button" className="confirmDelete" onClick={() => revoke(token)} disabled={revokingId === token.id}>{revokingId === token.id ? "Mencabut…" : "Ya, cabut"}</button>
                        <button type="button" onClick={() => setConfirmingId(null)} disabled={revokingId === token.id} autoFocus>Batal</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
