"use client";

import { TREND_LIMITS } from "../../lib/trend-view.mjs";

export function describedBy(id, help, error) {
  return [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function Field({ id, label, help, error, wide = false, children }) {
  return (
    <div className={`trField${wide ? " wide" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {help && <small id={`${id}-help`}>{help}</small>}
      {error && <small className="trFieldError" id={`${id}-error`}>{error}</small>}
    </div>
  );
}

const HELP = {
  keywordsText: "Pisahkan dengan koma. Tulis seperti orang menyebutnya di video; dipakai untuk mencocokkan transkrip.",
  hashtagsText: "Pisahkan dengan spasi. Tanda # ditambahkan otomatis.",
  sensitivity: "Sensitif: tragedi, bencana, SARA, kekerasan, kesehatan. Tidak dijadikan lelucon atau judul sensasional.",
  summary: `Maks ${TREND_LIMITS.summary} karakter, ${TREND_LIMITS.summaryLines} baris.`,
};

// Draft field → the error key used by validation and by the server.
const ERROR_KEY = { keywordsText: "keywords", hashtagsText: "hashtags", expiresDate: "expiresAt" };

/**
 * The fields the owner can edit on any item (spec §3.2 PATCH): title,
 * keywords, hashtags, sensitivity, summary and expiry. The manual form adds
 * kind, platforms and score around them.
 */
export function EditableTrendFields({ idPrefix, draft, errors, bounds, onChange, expiryHelp }) {
  const help = { ...HELP, expiresDate: expiryHelp };
  const props = (field) => {
    const id = `${idPrefix}-${field}`;
    const error = errors[ERROR_KEY[field] || field];
    return {
      id,
      value: draft[field],
      "aria-invalid": error ? true : undefined,
      "aria-describedby": describedBy(id, help[field], error),
      onChange: (event) => onChange({ [field]: event.target.value }),
    };
  };
  const field = (name, label, control, wide = false) => (
    <Field id={`${idPrefix}-${name}`} label={label} help={help[name]} error={errors[ERROR_KEY[name] || name]} wide={wide}>
      {control}
    </Field>
  );
  return (
    <>
      {field("title", "Judul", <input {...props("title")} autoComplete="off" placeholder="mis. Kabur Aja Dulu" />, true)}
      {field("keywordsText", "Kata kunci", <input {...props("keywordsText")} autoComplete="off" spellCheck={false} placeholder="mis. kabur aja dulu, merantau" />, true)}
      {field("hashtagsText", "Hashtag (opsional)", <input {...props("hashtagsText")} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="#KaburAjaDulu" />)}
      {field("sensitivity", "Sensitivitas", (
        <select {...props("sensitivity")}>
          <option value="normal">Normal</option>
          <option value="sensitive">Sensitif</option>
        </select>
      ))}
      {field("summary", "Ringkasan (opsional)", <textarea {...props("summary")} rows={3} placeholder="Apa trennya, kenapa ramai, bagaimana orang memakainya." />, true)}
      {field("expiresDate", "Kedaluwarsa", <input {...props("expiresDate")} type="date" min={bounds.min} max={bounds.max} />)}
    </>
  );
}
