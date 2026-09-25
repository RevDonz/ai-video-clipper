"use client";

import { useEffect, useRef, useState } from "react";

import { CUSTOM_PROVIDERS, LLM_PRESETS, MAX_DISPLAY_NAME_LENGTH, REASONING_EFFORTS, SERVER_TEMPLATES, isFreeModel } from "../../lib/llm-presets.mjs";
import {
  availableProviders,
  baseUrlHost,
  customServerDraft,
  draftFromSettings,
  draftSignature,
  draftToPayload,
  moveProvider,
  nextCustomProvider,
  parseModelList,
  providerDraft,
  providerLabel,
  providerSignatures,
  providerStatusLine,
  serverTemplateFor,
  subscriptionModels,
} from "../../lib/llm-settings-view.mjs";
import { llmStatusView } from "../../lib/selection-v3-view.mjs";
import "./settings.css";

const SESSION_TEXT = "Sesi login berakhir. Muat ulang halaman untuk masuk lagi.";
const REASONING_LABELS = {
  "": "Bawaan penyedia",
  none: "none — tanpa fase berpikir (paling cepat)",
  minimal: "minimal",
  low: "low — hemat token",
  medium: "medium",
  high: "high — paling teliti, paling lambat",
};
// Draft fields whose edits clear the matching server/validation error.
const ERROR_FIELD = { keyValue: "apiKey", keyAction: "apiKey", fallbackText: "fallbackModels" };

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { ok: response.ok, status: response.status, payload };
}

function keyedErrors(providers, raw) {
  const out = {};
  for (const [field, message] of Object.entries(raw)) {
    const match = /^providers\[(\d+)\]\.(\w+)$/.exec(field);
    if (match && providers[Number(match[1])]) out[`${providers[Number(match[1])].provider}.${match[2]}`] = message;
    else out.general = out.general ? `${out.general} ${message}` : message;
  }
  return out;
}

function formatTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

function formatSeconds(value) {
  if (typeof value !== "number") return "?";
  if (value < 0.001) return "<0,001";
  return value.toLocaleString("id-ID", { maximumFractionDigits: value < 1 ? 3 : 1 });
}

function presetBadges(name, freeOnly) {
  const preset = LLM_PRESETS[name];
  const badges = [];
  if (preset.local) badges.push({ text: "Lokal", tone: "" });
  else if (preset.custom) badges.push({ text: "Server sendiri", tone: "" });
  else if (preset.paidOnly) badges.push({ text: "Berbayar", tone: freeOnly ? "warning" : "" });
  else badges.push({ text: "Gratis", tone: "ok" });
  if (!preset.requiresKey) badges.push({ text: "Key opsional", tone: "" });
  return badges;
}

function FieldError({ id, message }) {
  return message ? <small className="fieldError" id={id}>{message}</small> : null;
}

function TextField({ item, field, label, placeholder, help, errors, onChange, wide = false, type = "text", maxLength }) {
  const id = `${item.provider}-${field}`;
  const error = errors[`${item.provider}.${field}`];
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`settingsField${wide ? " wide" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={item[field]}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange({ [field]: event.target.value })}
      />
      {help && <small id={`${id}-help`}>{help}</small>}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function NumberField({ item, field, label, placeholder, help, min, max, step = 1, errors, onChange }) {
  const id = `${item.provider}-${field}`;
  const error = errors[`${item.provider}.${field}`];
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="settingsField">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode={step === 1 ? "numeric" : "decimal"}
        min={min}
        max={max}
        step={step}
        value={item[field]}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange({ [field]: event.target.value })}
      />
      {help && <small id={`${id}-help`}>{help}</small>}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function KeyField({ item, preset, errors, onChange }) {
  const id = `${item.provider}-apiKey`;
  const error = errors[`${item.provider}.apiKey`];
  const editing = item.keyAction === "replace" || (!item.apiKeySet && item.keyAction !== "clear");
  const label = `API key${preset.requiresKey ? "" : " (opsional)"}`;
  if (!editing) {
    const state = item.keyAction === "clear" ? "warn" : item.apiKeyUnreadable ? "error" : "ok";
    const text = item.keyAction === "clear"
      ? "Akan dihapus saat disimpan"
      : item.apiKeyUnreadable
        ? "Key tersimpan tidak bisa dibuka — isi ulang"
        : `Tersimpan ✓${item.keySource === "env" ? " (dari .env server)" : ""}`;
    return (
      <div className="settingsField">
        <span id={`${id}-label`}>{label}</span>
        <div className={`keyState ${state}`} role="group" aria-labelledby={`${id}-label`} aria-describedby={error ? `${id}-error` : undefined}>
          <span>{text}</span>
          {item.keyAction === "clear" ? (
            <button type="button" onClick={() => onChange({ keyAction: "keep", keyValue: "" })}>Batal</button>
          ) : (
            <>
              <button type="button" onClick={() => onChange({ keyAction: "replace", keyValue: "" })}>{item.apiKeyUnreadable ? "Isi ulang" : "Ganti"}</button>
              <button type="button" onClick={() => onChange({ keyAction: "clear", keyValue: "" })}>Hapus</button>
            </>
          )}
        </div>
        <FieldError id={`${id}-error`} message={error} />
      </div>
    );
  }
  return (
    <div className="settingsField">
      <label htmlFor={id}>{label}</label>
      <div className="inlineRow">
        <input
          id={id}
          type="password"
          value={item.keyValue}
          placeholder={item.apiKeySet ? "Tempel API key baru" : "Belum diisi — tempel API key"}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-help`}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ keyValue: value, keyAction: value || item.apiKeySet ? "replace" : "keep" });
          }}
        />
        {item.apiKeySet && <button type="button" onClick={() => onChange({ keyAction: "keep", keyValue: "" })}>Batal</button>}
      </div>
      {!error && (
        <small id={`${id}-help`}>
          {item.apiKeySet ? "Key lama tetap dipakai sampai Anda menyimpan." : "Belum diisi."} Key disimpan terenkripsi di server dan tidak pernah ditampilkan lagi.
        </small>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function ModelField({ item, preset, label, errors, onChange, models, onFetchModels, freeOnly, locked }) {
  const id = `${item.provider}-model`;
  const error = errors[`${item.provider}.model`];
  const listing = models[item.provider];
  const filterFree = freeOnly && item.provider === "openrouter";
  const shown = listing?.state === "done" ? listing.list.filter((model) => !filterFree || isFreeModel("openrouter", model)) : [];
  return (
    <div className="settingsField">
      <label htmlFor={id}>Model{preset.custom ? " (wajib)" : ""}</label>
      <div className="inlineRow">
        <input
          id={id}
          value={item.model}
          placeholder={preset.defaultModel ? `bawaan: ${preset.defaultModel}` : serverTemplateFor(item) === "9router" ? "mis. nama combo atau kr/glm-5" : "mis. LJNAI-FAST"}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          list={shown.length ? `${id}-options` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange({ model: event.target.value })}
        />
        <button type="button" onClick={onFetchModels} disabled={listing?.state === "loading" || locked} title={locked ? "Simpan dulu untuk memakai nilai baru" : undefined}>
          {listing?.state === "loading" ? "Mengambil…" : "Ambil daftar model"}
        </button>
      </div>
      {shown.length > 0 && <datalist id={`${id}-options`}>{shown.map((model) => <option key={model} value={model} />)}</datalist>}
      {listing?.state === "done" && (shown.length ? (
        <div className="modelPickers">
          <select aria-label={`Pilih model ${label} dari daftar`} value="" onChange={(event) => event.target.value && onChange({ model: event.target.value })}>
            <option value="">Pilih model utama ({shown.length}{listing.truncated ? "+" : ""})…</option>
            {shown.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <select
            aria-label={`Tambah model cadangan ${label} dari daftar`}
            value=""
            onChange={(event) => {
              const picked = event.target.value;
              if (!picked) return;
              const current = parseModelList(item.fallbackText) || [];
              if (!current.includes(picked)) onChange({ fallbackText: [...current, picked].join(", ") });
            }}
          >
            <option value="">+ Tambah ke cadangan…</option>
            {shown.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </div>
      ) : <small>Tidak ada model{filterFree ? " gratis (':free')" : ""} di daftar penyedia.</small>)}
      {listing?.state === "done" && filterFree && shown.length > 0 && <small>Hanya model gratis yang ditampilkan karena mode hanya-gratis aktif.</small>}
      {listing?.state === "error" && <small className="fieldError" role="alert">{listing.message}</small>}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function ProviderCard({ item, index, count, freeOnly, errors, statusLine, locked, test, models, onChange, onMove, onRemove, onTest, onFetchModels }) {
  const preset = LLM_PRESETS[item.provider];
  const label = providerLabel(item);
  const template = serverTemplateFor(item) ? SERVER_TEMPLATES[serverTemplateFor(item)] : null;
  const titleId = `provider-${item.provider}-title`;
  const host = baseUrlHost(item.baseUrl.trim());
  const baseUrlUpFront = Boolean(preset.custom || preset.local);
  let result = null;
  if (test?.state === "running") result = { tone: "muted", text: "Menguji koneksi… (server lambat bisa butuh 1–2 menit)" };
  else if (test?.state === "done" && test.result.status === "ok") {
    result = { tone: "ok", text: `✓ ${test.result.model || "Model"} menjawab dalam ${formatSeconds(test.result.latencyS)} detik.` };
  } else if (test?.state === "done") result = { tone: "error", text: `✗ ${test.result.message}` };
  else if (test?.state === "error") result = { tone: "error", text: test.message };

  return (
    <article id={`provider-${item.provider}`} className={`providerCard${item.enabled ? "" : " off"}`} aria-labelledby={titleId}>
      <header className="providerHead">
        <span className="providerRank" aria-label={`Urutan ${index + 1}`}>{index + 1}</span>
        <div className="providerIdentity">
          <h3 id={titleId}>{label}</h3>
          <small>
            <code>{item.provider}</code>
            {host && <span>{host}</span>}
            {presetBadges(item.provider, freeOnly).map((badge) => <span key={badge.text} className={`chip ${badge.tone}`}>{badge.text}</span>)}
            {statusLine && !locked && <span className={`chip ${statusLine.tone}`}>{statusLine.text}</span>}
          </small>
        </div>
        <div className="providerTools">
          <label className="switch">
            <input type="checkbox" role="switch" checked={item.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
            <span>{item.enabled ? "Aktif" : "Nonaktif"}</span>
          </label>
          <button type="button" className="iconButton" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Naikkan ${label}`} title="Naikkan">↑</button>
          <button type="button" className="iconButton" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Turunkan ${label}`} title="Turunkan">↓</button>
          <button type="button" className="iconButton danger" onClick={onRemove} aria-label={`Hapus ${label} dari daftar`}>Hapus</button>
        </div>
      </header>
      <p className="providerDescription">
        {template ? template.description : preset.description}{" "}
        {preset.keyUrl && <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer">Ambil API key ↗</a>}
        {template?.docsUrl && <a href={template.docsUrl} target="_blank" rel="noopener noreferrer">Dokumentasi ↗</a>}
      </p>
      {template?.warning && <p className="settingsAlert warning">{template.warning}</p>}
      {subscriptionModels(item).length > 0 && (
        <p className="settingsAlert error" role="alert">
          <strong>Model langganan konsumen dipilih</strong>
          <span>{subscriptionModels(item).join(", ")} diteruskan lewat langganan pribadi (Claude/ChatGPT/Copilot/Cursor). Job otomatis Potongin sebaiknya memakai model gratis atau API key resmi.</span>
        </p>
      )}
      {freeOnly && preset.paidOnly && item.enabled && <p className="settingsAlert warning">Mode hanya-gratis aktif: penyedia berbayar ini akan dilewati.</p>}

      <div className="providerFields">
        {preset.custom && (
          <TextField
            item={item}
            field="name"
            label="Nama server"
            placeholder={`mis. Hermes atau 9Router (kosong: ${preset.label})`}
            help="Tampil di daftar failover dan status AI. Tidak dikirim ke server."
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            errors={errors}
            onChange={onChange}
            wide
          />
        )}
        <KeyField item={item} preset={preset} errors={errors} onChange={onChange} />
        {baseUrlUpFront && (
          <TextField
            item={item}
            field="baseUrl"
            label={`Base URL${preset.custom ? " (wajib)" : ""}`}
            type="url"
            placeholder={preset.baseUrl ? `bawaan: ${preset.baseUrl}` : "https://server-anda.example/v1"}
            help={preset.custom
              ? `Alamat API OpenAI-compatible, tanpa /chat/completions. http:// hanya untuk localhost atau host.docker.internal (server di host Docker).${template === SERVER_TEMPLATES["9router"] ? " 9Router: port 20128, mis. http://host.docker.internal:20128/v1." : ""} API key hanya dikirim ke server ini; ganti ke server lain berarti isi ulang key.`
              : "Dari Docker, server Ollama di host: http://host.docker.internal:11434/v1"}
            errors={errors}
            onChange={onChange}
          />
        )}
        <ModelField item={item} preset={preset} label={label} errors={errors} onChange={onChange} models={models} onFetchModels={onFetchModels} freeOnly={freeOnly} locked={locked} />
        <TextField
          item={item}
          field="fallbackText"
          label="Model cadangan"
          placeholder={preset.fallbackModels.length ? `bawaan: ${preset.fallbackModels.join(", ")}` : "tanpa cadangan"}
          help="Dicoba berurutan kalau model utama gagal. Pisahkan dengan koma; kosong = bawaan; tulis none untuk tanpa cadangan."
          errors={{ [`${item.provider}.fallbackText`]: errors[`${item.provider}.fallbackModels`] }}
          onChange={onChange}
        />
      </div>

      <details className="providerAdvanced">
        <summary>Pengaturan lanjutan</summary>
        <div className="advancedGrid">
          <div className="settingsField wide">
            <label htmlFor={`${item.provider}-reasoningEffort`}>Reasoning effort</label>
            <select id={`${item.provider}-reasoningEffort`} value={item.reasoningEffort} aria-describedby={`${item.provider}-reasoningEffort-help`} onChange={(event) => onChange({ reasoningEffort: event.target.value })}>
              {["", ...REASONING_EFFORTS].map((value) => <option key={value || "default"} value={value}>{REASONING_LABELS[value]}</option>)}
            </select>
            <small id={`${item.provider}-reasoningEffort-help`}>
              <b>none</b> mematikan fase “berpikir”. Model reasoning seperti Hermes jadi jauh lebih cepat (±0,4 detik, bukan ±20 detik) dan jawabannya tidak terpotong pada transkrip panjang. Kosongkan kalau server tidak mendukungnya.
            </small>
            <FieldError id={`${item.provider}-reasoningEffort-error`} message={errors[`${item.provider}.reasoningEffort`]} />
          </div>
          {!baseUrlUpFront && (
            <TextField
              item={item}
              field="baseUrl"
              label="Base URL (opsional)"
              type="url"
              placeholder={`bawaan: ${preset.baseUrl}`}
              help="Kosongkan untuk memakai alamat resmi penyedia."
              errors={errors}
              onChange={onChange}
              wide
            />
          )}
          <NumberField item={item} field="contextTokens" label="Konteks token" placeholder={`bawaan: ${preset.contextTokens}`} min={512} max={10000000} help="Anggaran token per permintaan; transkrip dipotong supaya muat." errors={errors} onChange={onChange} />
          <NumberField item={item} field="maxOutputTokens" label="Token output maksimum" placeholder={`bawaan: ${preset.maxOutputTokens}`} min={1} max={1000000} errors={errors} onChange={onChange} />
          <NumberField item={item} field="timeout" label="Timeout (detik)" placeholder={`bawaan: ${preset.timeout}`} min={1} max={3600} step="any" errors={errors} onChange={onChange} />
          <NumberField item={item} field="rpm" label="Batas permintaan/menit" placeholder={preset.rpm ? `bawaan: ${preset.rpm}` : "bawaan: tanpa batas"} min={0} max={100000} step="any" help="0 = tanpa batas." errors={errors} onChange={onChange} />
          <NumberField item={item} field="maxRetries" label="Percobaan ulang" placeholder="bawaan: 3" min={0} max={10} errors={errors} onChange={onChange} />
          <NumberField item={item} field="temperature" label="Temperature" placeholder="bawaan: 0,2" min={0} max={2} step="any" errors={errors} onChange={onChange} />
          <div className="settingsField">
            <label htmlFor={`${item.provider}-jsonMode`}>Mode JSON</label>
            <select id={`${item.provider}-jsonMode`} value={item.jsonMode} onChange={(event) => onChange({ jsonMode: event.target.value })}>
              <option value="">Bawaan (aktif)</option>
              <option value="true">Aktif</option>
              <option value="false">Nonaktif</option>
            </select>
          </div>
          {item.provider === "openrouter" && (
            <>
              <TextField item={item} field="httpReferer" label="HTTP-Referer (atribusi)" placeholder="https://situs-anda.example" errors={errors} onChange={onChange} />
              <TextField item={item} field="appTitle" label="Judul aplikasi" placeholder="bawaan: Potongin" errors={errors} onChange={onChange} />
            </>
          )}
        </div>
      </details>

      <div className="providerFooter">
        <button type="button" className="secondaryAction" onClick={onTest} disabled={test?.state === "running" || locked}>
          {test?.state === "running" ? "Menguji…" : "Tes koneksi"}
        </button>
        <p className={`testResult ${result?.tone || "muted"}`} role="status" aria-live="polite">
          {result ? result.text : locked ? "Simpan dulu untuk mengetes nilai yang baru." : "Kirim ping JSON kecil memakai pengaturan tersimpan."}
        </p>
      </div>
    </article>
  );
}

function AddProvider({ available, serversUsed, serverSlot, freeOnly, open, onAdd, onAddServer }) {
  if (!available.length && !serverSlot) return null;
  const serverLimit = CUSTOM_PROVIDERS.length;
  return (
    <details className="addProvider" open={open || undefined}>
      <summary>Tambah penyedia <small>{available.length} preset · server sendiri {serversUsed}/{serverLimit}</small></summary>
      {serverSlot ? (
        <ul className="presetGrid">
          {Object.entries(SERVER_TEMPLATES).map(([id, template]) => (
            <li key={id} className="presetCard">
              <div className="presetHead">
                <strong>{template.title}</strong>
                <span className="chip">Server sendiri</span>
                <span className="chip">Key opsional</span>
              </div>
              <p>{template.description}</p>
              {template.warning && <p className="presetWarning">{template.warning}</p>}
              <div className="presetActions">
                {template.docsUrl ? <a href={template.docsUrl} target="_blank" rel="noopener noreferrer">Dokumentasi ↗</a> : <span />}
                <button type="button" onClick={() => onAddServer(id)} aria-label={`Tambah ${template.title}`}>+ Tambah</button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="addProviderNote">Sudah {serverLimit} server OpenAI-compatible (batas maksimal). Hapus salah satu untuk menambah yang lain.</p>
      )}
      {available.length > 0 && <ul className="presetGrid">
        {available.map((name) => {
          const preset = LLM_PRESETS[name];
          return (
            <li key={name} className="presetCard">
              <div className="presetHead">
                <strong>{preset.label}</strong>
                {presetBadges(name, freeOnly).map((badge) => <span key={badge.text} className={`chip ${badge.tone}`}>{badge.text}</span>)}
              </div>
              <p>{preset.description}</p>
              <div className="presetActions">
                {preset.keyUrl ? <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer">Ambil API key ↗</a> : <span />}
                <button type="button" onClick={() => onAdd(name)} aria-label={`Tambah ${preset.label}`}>+ Tambah</button>
              </div>
            </li>
          );
        })}
      </ul>}
    </details>
  );
}

export default function SettingsPage() {
  const [loadState, setLoadState] = useState("loading");
  const [loaded, setLoaded] = useState(null);
  const [draft, setDraft] = useState(() => draftFromSettings(null));
  const [baseline, setBaseline] = useState(() => draftSignature(draftFromSettings(null)));
  const [savedProviders, setSavedProviders] = useState({});
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [tests, setTests] = useState({});
  const [models, setModels] = useState({});
  const mounted = useRef(true);

  const dirty = loadState === "ready" && draftSignature(draft) !== baseline;
  const settings = loaded?.settings || null;
  const source = settings?.source || null;

  function applyLoaded(payload) {
    const next = draftFromSettings(payload.settings);
    setLoaded(payload);
    setDraft(next);
    setBaseline(draftSignature(next));
    setSavedProviders(providerSignatures(next));
    setErrors({});
  }

  async function load() {
    setLoadState("loading");
    setNotice(null);
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm");
      if (!mounted.current) return;
      if (!ok || !payload) {
        setLoadState("error");
        setNotice({ tone: "error", text: status === 401 ? SESSION_TEXT : payload?.error || "Pengaturan AI tidak bisa dimuat." });
        return;
      }
      applyLoaded(payload);
      setTests({});
      setModels({});
      setLoadState("ready");
    } catch {
      if (!mounted.current) return;
      setLoadState("error");
      setNotice({ tone: "error", text: "Server tidak bisa dihubungi. Coba muat ulang." });
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function clearErrors(name, patch) {
    setErrors((current) => {
      const next = { ...current };
      for (const field of Object.keys(patch)) delete next[`${name}.${ERROR_FIELD[field] || field}`];
      return next;
    });
  }

  function updateProvider(name, patch) {
    setDraft((current) => ({ ...current, providers: current.providers.map((item) => (item.provider === name ? { ...item, ...patch } : item)) }));
    clearErrors(name, patch);
    if (notice?.tone === "ok") setNotice(null);
  }

  function updateGeneral(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    if (notice?.tone === "ok") setNotice(null);
  }

  function move(index, delta) {
    setDraft((current) => ({ ...current, providers: moveProvider(current.providers, index, delta) }));
  }

  // Test results and model lists belong to one entry: a server removed and
  // added again under the same id starts clean.
  function forget(name) {
    const drop = (current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    };
    setTests(drop);
    setModels(drop);
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => !field.startsWith(`${name}.`))));
  }

  function remove(item) {
    const label = providerLabel(item);
    if (item.apiKeySet && !window.confirm(`Hapus ${label} dari daftar? API key-nya ikut dihapus saat Anda menyimpan.`)) return;
    setDraft((current) => ({ ...current, providers: current.providers.filter((entry) => entry.provider !== item.provider) }));
    forget(item.provider);
  }

  function append(entry) {
    forget(entry.provider);
    setDraft((current) => ({ ...current, providers: [...current.providers, entry] }));
    requestAnimationFrame(() => {
      const card = document.getElementById(`provider-${entry.provider}`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      card?.querySelector("input:not([type=checkbox])")?.focus({ preventScroll: true });
    });
  }

  function add(name) {
    append(providerDraft(name));
  }

  function addServer(templateId) {
    const entry = customServerDraft(draft, templateId);
    if (entry) append(entry);
  }

  function discard() {
    if (loaded) applyLoaded(loaded);
    setNotice(null);
  }

  async function save() {
    const { payload, errors: found } = draftToPayload(draft, source === "ui" ? settings.updatedAt : null);
    const keyed = keyedErrors(draft.providers, found);
    setErrors(keyed);
    if (Object.keys(keyed).length) {
      setNotice({ tone: "error", text: `Periksa ${Object.keys(keyed).length} isian yang ditandai merah.` });
      requestAnimationFrame(() => document.querySelector("[aria-invalid=true]")?.focus());
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const { ok, status, payload: body } = await requestJson("/api/settings/llm", { method: "PUT", body: payload });
      if (!mounted.current) return;
      if (ok) {
        applyLoaded({ ...loaded, settings: body.settings, status: body.status, envImportAvailable: false, envWarnings: [], envError: null, fileError: null });
        setTests({});
        setNotice({ tone: "ok", text: "Pengaturan tersimpan. Job berikutnya langsung memakai konfigurasi ini." });
      } else if (status === 422 && Array.isArray(body?.issues)) {
        setErrors(keyedErrors(draft.providers, Object.fromEntries(body.issues.map((issue) => [issue.field, issue.message]))));
        setNotice({ tone: "error", text: body.error || "Pengaturan belum valid." });
      } else if (status === 409) {
        setNotice({ tone: "error", text: body?.error || "Pengaturan sudah diubah di tempat lain.", reload: true });
      } else {
        setNotice({ tone: "error", text: status === 401 ? SESSION_TEXT : body?.error || "Gagal menyimpan pengaturan." });
      }
    } catch {
      if (mounted.current) setNotice({ tone: "error", text: "Koneksi ke server terputus. Perubahan belum tersimpan." });
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function importEnv() {
    if (dirty && !window.confirm("Perubahan yang belum disimpan akan diganti hasil impor. Lanjutkan?")) return;
    setImporting(true);
    setNotice(null);
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm/import-env", { method: "POST", body: {} });
      if (!mounted.current) return;
      if (ok) {
        applyLoaded({ ...loaded, settings: payload.settings, status: payload.status, envImportAvailable: false, envWarnings: payload.warnings || [], envError: null, fileError: null });
        setTests({});
        setNotice({ tone: "ok", text: `Konfigurasi .env diimpor (${payload.settings.providers.length} penyedia). Mulai sekarang AI diatur dari halaman ini.` });
      } else {
        setNotice({ tone: "error", text: status === 401 ? SESSION_TEXT : payload?.error || "Impor gagal." });
      }
    } catch {
      if (mounted.current) setNotice({ tone: "error", text: "Koneksi ke server terputus. Impor belum terjadi." });
    } finally {
      if (mounted.current) setImporting(false);
    }
  }

  async function runTest(name) {
    setTests((current) => ({ ...current, [name]: { state: "running" } }));
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm/test", { method: "POST", body: { provider: name } });
      if (!mounted.current) return;
      setTests((current) => ({
        ...current,
        [name]: ok && payload?.result
          ? { state: "done", result: payload.result }
          : { state: "error", message: status === 401 ? SESSION_TEXT : payload?.error || "Tes tidak bisa dijalankan." },
      }));
    } catch {
      if (mounted.current) setTests((current) => ({ ...current, [name]: { state: "error", message: "Koneksi ke server terputus." } }));
    }
  }

  async function fetchModels(name) {
    setModels((current) => ({ ...current, [name]: { state: "loading" } }));
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm/models", { method: "POST", body: { provider: name } });
      if (!mounted.current) return;
      setModels((current) => ({
        ...current,
        [name]: ok && Array.isArray(payload?.models)
          ? { state: "done", list: payload.models, truncated: payload.truncated === true }
          : { state: "error", message: status === 401 ? SESSION_TEXT : payload?.error || "Daftar model tidak bisa diambil." },
      }));
    } catch {
      if (mounted.current) setModels((current) => ({ ...current, [name]: { state: "error", message: "Koneksi ke server terputus." } }));
    }
  }

  const statusView = llmStatusView(loaded?.status);
  const statusByName = Object.fromEntries((loaded?.status?.providers || []).map((item) => [item.name, item]));
  const savedTime = source === "ui" ? formatTime(settings?.updatedAt) : null;
  const errorCount = Object.keys(errors).length;
  let bar = { dot: "", text: "Semua perubahan tersimpan", detail: savedTime ? `Terakhir disimpan ${savedTime}` : "Belum ada pengaturan tersimpan di halaman ini." };
  if (saving) bar = { dot: "saving", text: "Menyimpan…", detail: "" };
  else if (notice?.tone === "error") bar = { dot: "error", text: notice.text, detail: dirty ? "Perubahan belum tersimpan." : "" };
  else if (dirty) bar = { dot: "dirty", text: "Ada perubahan yang belum disimpan", detail: "Simpan supaya job berikutnya memakai pengaturan baru." };
  else if (notice?.tone === "ok") bar = { dot: "success", text: notice.text, detail: "" };

  return (
    <main className="settingsPage">
      <nav className="nav shell">
        <a className="brand" href="/"><span>P</span> Potongin AI</a>
        <div className="navActions">
          <div className="navLinks"><a href="/dashboard">Buat Klip</a><a href="/projects">Riwayat</a><a href="/trends">Konteks Tren</a><a className="active" href="/settings" aria-current="page">Pengaturan</a></div>
          <form method="post" action="/api/auth/logout"><button type="submit">Keluar</button></form>
        </div>
      </nav>

      <section className="settingsHero shell">
        <div className="eyebrow">PENGATURAN · AI &amp; LLM</div>
        <h1>Penyedia AI</h1>
        <p>Atur API key, alamat server, dan model LLM langsung dari sini, tanpa mengedit .env di server. Job berikutnya otomatis memakai pengaturan yang tersimpan.</p>
      </section>

      {loadState === "loading" && <div className="shell"><div className="panel settingsLoading" role="status">Memuat pengaturan AI…</div></div>}
      {loadState === "error" && (
        <div className="shell">
          <div className="panel settingsLoading" role="alert">
            <p>{notice?.text || "Pengaturan AI tidak bisa dimuat."}</p>
            <button type="button" className="primaryAction" onClick={load}>Coba lagi</button>
          </div>
        </div>
      )}

      {loadState === "ready" && (
        <div className="settingsLayout shell">
          <div className="settingsTop">
            <section className="panel settingsCard" aria-labelledby="ai-status-title">
              <div className="panelHead compact"><span>01</span><div><h2 id="ai-status-title">Status AI</h2><p>Konfigurasi yang dipakai job berikutnya.</p></div></div>
              <p className={`llmBadge ${statusView.tone}`} role="status" aria-live="polite"><i aria-hidden="true" /><span>{statusView.label}</span></p>
              <p className="settingsSource">
                Sumber: {source === "ui" ? "pengaturan di halaman ini" : loaded.fileError ? "—" : ".env server"}
                {savedTime && ` · disimpan ${savedTime}`}
                {dirty && " · status di atas belum termasuk perubahan yang belum disimpan"}
              </p>
              {!loaded.secretConfigured && (
                <div className="settingsAlert error" role="alert">
                  <strong>Kunci enkripsi belum tersedia</strong>
                  <span>Set APP_SESSION_SECRET (atau POTONGIN_SETTINGS_SECRET) berisi minimal 32 karakter acak di server, bukan contoh dari .env.example. Tanpa itu API key tidak bisa disimpan.</span>
                </div>
              )}
              {loaded.fileError && (
                <div className="settingsAlert error" role="alert"><strong>File pengaturan AI bermasalah</strong><span>{loaded.fileError}</span></div>
              )}
              {loaded.envError && (
                <div className="settingsAlert warning"><strong>Konfigurasi LLM di .env tidak valid</strong><span>{loaded.envError}</span></div>
              )}
              {(loaded.envWarnings || []).map((warning) => <p key={warning} className="settingsAlert warning">{warning}</p>)}
              {source === "env" && loaded.envImportAvailable && (
                <div className="importBanner">
                  <div>
                    <strong>Konfigurasi saat ini dibaca dari .env server</strong>
                    <span>Impor sekali supaya bisa diubah di sini. API key ikut dipindahkan dan disimpan terenkripsi; setelah itu .env tidak perlu disentuh lagi.</span>
                  </div>
                  <button type="button" className="primaryAction" onClick={importEnv} disabled={importing || saving}>
                    {importing ? "Mengimpor…" : "Impor dari konfigurasi server (.env)"}
                  </button>
                </div>
              )}
            </section>

            <section className="panel settingsCard" aria-labelledby="ai-general-title">
              <div className="panelHead compact"><span>02</span><div><h2 id="ai-general-title">Umum</h2><p>Berlaku untuk semua penyedia.</p></div></div>
              <div className="toggleList">
                <label className="shadowToggle">
                  <input type="checkbox" checked={draft.enabled} onChange={(event) => updateGeneral({ enabled: event.target.checked })} />
                  <span><strong>Aktifkan AI (LLM)</strong><small>Matikan untuk selalu memakai pemilih heuristik lokal: tanpa internet, transkrip tidak dikirim ke mana pun. API key tetap tersimpan.</small></span>
                </label>
                <label className="shadowToggle">
                  <input type="checkbox" checked={draft.freeOnly} onChange={(event) => updateGeneral({ freeOnly: event.target.checked })} />
                  <span><strong>Hanya model gratis</strong><small>Penyedia berbayar (DeepSeek, OpenAI) dilewati dan OpenRouter hanya memakai model “:free”. Server OpenAI-compatible Anda sendiri (mis. Hermes, 9Router) dan Ollama dianggap milik Anda dan tidak disaring, jadi pastikan model yang dipilih di sana memang boleh dipakai.</small></span>
                </label>
              </div>
            </section>
          </div>

          <section className="panel settingsCard" aria-labelledby="ai-providers-title">
            <div className="panelHead compact"><span>03</span><div><h2 id="ai-providers-title">Penyedia AI (urutan failover)</h2><p>Dicoba dari atas ke bawah. Kalau satu gagal (kuota habis, key salah, server mati), otomatis pindah ke berikutnya; kalau semua gagal, heuristik lokal dipakai.</p></div></div>
            {!draft.enabled && <p className="settingsAlert muted">AI sedang dimatikan. Daftar ini tetap disimpan tetapi tidak dipakai sampai AI diaktifkan lagi.</p>}
            {errors.general && <p className="settingsAlert error" role="alert">{errors.general}</p>}
            {draft.providers.length === 0 ? (
              <div className="providerEmpty">Belum ada penyedia. Tambahkan minimal satu di bawah, atau biarkan kosong supaya job selalu memakai heuristik lokal.</div>
            ) : (
              <ol className="providerList">
                {draft.providers.map((item, index) => (
                  <li key={item.provider}>
                    <ProviderCard
                      item={item}
                      index={index}
                      count={draft.providers.length}
                      freeOnly={draft.freeOnly}
                      errors={errors}
                      statusLine={providerStatusLine(statusByName[item.provider])}
                      locked={savedProviders[item.provider] !== JSON.stringify(item)}
                      test={tests[item.provider]}
                      models={models}
                      onChange={(patch) => updateProvider(item.provider, patch)}
                      onMove={(delta) => move(index, delta)}
                      onRemove={() => remove(item)}
                      onTest={() => runTest(item.provider)}
                      onFetchModels={() => fetchModels(item.provider)}
                    />
                  </li>
                ))}
              </ol>
            )}
            <AddProvider
              available={availableProviders(draft)}
              serversUsed={draft.providers.filter((item) => LLM_PRESETS[item.provider].custom).length}
              serverSlot={nextCustomProvider(draft) !== null}
              freeOnly={draft.freeOnly}
              open={draft.providers.length === 0}
              onAdd={add}
              onAddServer={addServer}
            />
          </section>
        </div>
      )}

      {loadState === "ready" && (
        <div className="editorSaveBar settingsSaveBar" role="region" aria-label="Simpan pengaturan AI">
          <div>
            <i className={`saveDot ${bar.dot}`} aria-hidden="true" />
            <div>
              <p role="status" aria-live="polite">{bar.text}{errorCount > 0 && notice?.tone !== "error" ? ` · ${errorCount} isian perlu diperbaiki` : ""}</p>
              {bar.detail && <small>{bar.detail}</small>}
            </div>
          </div>
          <div>
            {notice?.reload ? (
              <button type="button" className="discard" onClick={load}>Muat ulang</button>
            ) : (
              <button type="button" className="discard" onClick={discard} disabled={!dirty || saving}>Batalkan</button>
            )}
            <button type="button" className="saveEditor" onClick={save} disabled={!dirty || saving}>{saving ? "Menyimpan…" : "Simpan"}</button>
          </div>
        </div>
      )}
    </main>
  );
}
