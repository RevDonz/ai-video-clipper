"use client";

// Pengaturan "Teks watermark bawaan" (CONTRACTS §5.43): one line of text with its place, size and
// opacity, written into the clips of every new job. Loaded on its own, like "Logo bawaan".
import { useEffect, useId, useRef, useState } from "react";

import { WATERMARK_MAX, WATERMARK_PLACES, percentLabel, watermarkPoints } from "../../components/editor/panels/watermark-model.mjs";
import {
  defaultWatermarkCopy,
  defaultWatermarkForm,
  defaultWatermarkPayload,
  defaultWatermarkState,
  formMatches,
} from "../../lib/default-watermark-view.mjs";
import { WATERMARK_OPACITY_RANGE, WATERMARK_SIZE_RANGE } from "../../lib/editor/doc-model.mjs";

const ENDPOINT = "/api/settings/watermark";
const SESSION_TEXT = "Sesi login berakhir. Muat ulang halaman untuk masuk lagi.";
const LOAD_FAILED = "Teks watermark bawaan tidak bisa dimuat.";

async function send(method, body) {
  const response = await fetch(ENDPOINT, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

export default function DefaultWatermarkCard() {
  const [phase, setPhase] = useState("loading");
  const [state, setState] = useState(() => defaultWatermarkState(null));
  const [form, setForm] = useState(() => defaultWatermarkForm(null));
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const alive = useRef(true);
  const id = useId();

  async function load() {
    setPhase("loading");
    setMessage(null);
    try {
      const answer = await send("GET");
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        const next = defaultWatermarkState(answer.payload);
        setState(next);
        setForm(defaultWatermarkForm(next.watermark));
        setPhase("ready");
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? SESSION_TEXT : LOAD_FAILED });
        setPhase("error");
      }
    } catch {
      if (!alive.current) return;
      setMessage({ tone: "error", text: LOAD_FAILED });
      setPhase("error");
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, []);

  const copy = defaultWatermarkCopy({ autoClips: state.autoClips });
  const saved = state.watermark;
  const unchanged = formMatches(form, saved);
  const points = watermarkPoints(form.text.trim());
  const edit = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setMessage(null);
  };

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const result = defaultWatermarkPayload(form);
    if (result.error) {
      setMessage({ tone: "error", text: result.error });
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const answer = await send("PUT", result.payload);
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        const next = defaultWatermarkState(answer.payload);
        setState(next);
        setForm(defaultWatermarkForm(next.watermark));
        setMessage({ tone: "ok", text: "Teks watermark bawaan tersimpan." });
      } else {
        const text = answer.status === 401 ? SESSION_TEXT : answer.payload?.error ?? "Teks watermark gagal disimpan. Coba lagi.";
        setMessage({ tone: "error", text });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: "Koneksi terputus. Coba lagi." });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function remove() {
    if (busy || !saved) return;
    setBusy("remove");
    setMessage(null);
    try {
      const answer = await send("DELETE");
      if (!alive.current) return;
      if (answer.ok && answer.payload) {
        setState(defaultWatermarkState(answer.payload));
        setForm(defaultWatermarkForm(null));
        setMessage({ tone: "ok", text: "Teks watermark bawaan dihapus. Klip yang sudah dibuat tetap memakai teksnya." });
      } else {
        setMessage({ tone: "error", text: answer.status === 401 ? SESSION_TEXT : "Teks watermark bawaan gagal dihapus. Coba lagi." });
      }
    } catch {
      if (alive.current) setMessage({ tone: "error", text: "Koneksi terputus. Coba lagi." });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  return (
    <section className="panel settingsCard watermarkCard" aria-labelledby={`${id}-title`} aria-busy={Boolean(busy) || phase === "loading"}>
      <div className="settingsCardHead">
        <h2 id={`${id}-title`}>Teks watermark bawaan</h2>
        <p>{copy.where}</p>
      </div>

      {phase === "loading" && <p className="systemState" role="status">Memuat teks watermark bawaan…</p>}
      {phase === "error" && (
        <div className="systemState error" role="alert">
          <p>{message?.text}</p>
          <button type="button" className="btn" onClick={() => void load()}>Coba lagi</button>
        </div>
      )}

      {phase === "ready" && (
        <form onSubmit={save} noValidate>
          <div className="providerFields">
            <div className="settingsField wide">
              <label htmlFor={`${id}-text`}>Teks</label>
              <input id={`${id}-text`} type="text" value={form.text} maxLength={WATERMARK_MAX} placeholder="@akun"
                autoComplete="off" spellCheck={false} aria-describedby={`${id}-count`} onChange={(event) => edit({ text: event.target.value })} />
              <small id={`${id}-count`}>{`${points}/${WATERMARK_MAX} karakter, satu baris.`}</small>
            </div>
            <div className="settingsField">
              <label htmlFor={`${id}-pos`}>Posisi</label>
              <select id={`${id}-pos`} value={form.pos} aria-describedby={`${id}-pos-help`} onChange={(event) => edit({ pos: event.target.value })}>
                {WATERMARK_PLACES.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
              </select>
              <small id={`${id}-pos-help`}>Setiap posisi ada di luar area tombol TikTok/Reels.</small>
            </div>
            <div className="settingsField">
              <span id={`${id}-size`}>{`Ukuran ${percentLabel(form.size_pm)}`}</span>
              <input type="range" min={WATERMARK_SIZE_RANGE[0]} max={WATERMARK_SIZE_RANGE[1]} step={50} value={form.size_pm}
                aria-labelledby={`${id}-size`} aria-valuetext={percentLabel(form.size_pm)}
                onChange={(event) => edit({ size_pm: Number(event.target.value) })} />
            </div>
            <div className="settingsField">
              <span id={`${id}-opacity`}>{`Opasitas ${percentLabel(form.opacity_pm)}`}</span>
              <input type="range" min={WATERMARK_OPACITY_RANGE[0]} max={WATERMARK_OPACITY_RANGE[1]} step={10} value={form.opacity_pm}
                aria-labelledby={`${id}-opacity`} aria-valuetext={percentLabel(form.opacity_pm)}
                onChange={(event) => edit({ opacity_pm: Number(event.target.value) })} />
            </div>
          </div>
          <div className="watermarkActions">
            <button type="submit" className="btn" disabled={Boolean(busy) || unchanged}>{busy === "save" ? "Menyimpan…" : "Simpan"}</button>
            {saved && (
              <button type="button" className="btn danger" onClick={remove} disabled={Boolean(busy)}>
                {busy === "remove" ? "Menghapus…" : "Hapus"}
              </button>
            )}
          </div>

          {message && (message.tone === "error"
            ? <p className="notice error settingsNotice" role="alert">{message.text}</p>
            : <p className="logoStatus ok" role="status">{message.text}</p>)}

          <ul className="logoFacts">
            <li>{copy.reach}</li>
            <li>{copy.perClip}</li>
          </ul>
        </form>
      )}
    </section>
  );
}
