"use client";

// Mode Cepat's Caption card (docs/plans/2026-10-02-editor-mode-cepat.md §1.4 Caption, §3): the
// "Tampilkan caption" switch, the four packs (the FFmpeg thumbnails), the highlight colour, three
// sizes and three positions. A size or position set off the presets in Mode Lengkap presses no
// pill. The commands, the notes and the hook hint are caption-model.mjs, shared with the Teks
// panel, so both views send the same command and show the same text. Props: the card bundle of
// cards.mjs.
import { useId, useState } from "react";

import {
  CAPTION_PACKS,
  CAPTION_POSITIONS,
  CAPTION_SIZES,
  CAPTION_SWATCHES,
  captionCommand,
  captionPackCommand,
  captionZoneNote,
  captionsEnabledCommand,
  highlightNote,
  hookNearNote,
  presetId,
} from "../panels/caption-model.mjs";
import { PACK_IMAGES, imageSrc } from "../panels/pack-images.js";
import { runCommands } from "../transcript/actions.mjs";
import PillGroup from "../ui/PillGroup.jsx";
import Swatches from "../ui/Swatches.jsx";
import Switch from "../ui/Switch.jsx";
import styles from "./quick.module.css";

const pills = (options) => options.map((option) => ({ id: option.id, label: option.label }));
const valueOf = (options, id) => options.find((option) => option.id === id)?.value;

function CaptionBody({ state, dispatch }) {
  const doc = state.doc;
  const locked = state.status !== "ready";
  const captions = doc.captions;
  const overrides = captions.overrides;
  const [message, setMessage] = useState(null);
  const uid = useId();
  const zone = captionZoneNote(doc, state.seed, state.plan);
  const nearHook = hookNearNote(doc);
  const notes = [zone ? `${uid}-zone` : null, nearHook ? `${uid}-near` : null].filter(Boolean).join(" ") || undefined;

  const send = (command) => {
    const result = runCommands(dispatch, [command]);
    setMessage(result.ok ? null : result.message);
  };

  return (
    <div className={styles.body} data-quick-body="caption">
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
      <Switch label="Tampilkan caption" checked={captions.enabled} disabled={locked}
        onChange={(on) => send(captionsEnabledCommand(on))} />
      <fieldset className={styles.group} disabled={locked}>
        <legend className={styles.legend}>Gaya caption</legend>
        <div className={styles.tiles}>
          {CAPTION_PACKS.map((pack) => (
            <label key={pack.id} className={styles.tile} data-pack={pack.id} title={pack.note}>
              <input type="radio" className={styles.cover} name={`${uid}-pack`} value={pack.id}
                checked={captions.pack.id === pack.id} onChange={() => send(captionPackCommand(pack.id))} />
              <img className={styles.tileThumb} src={imageSrc(PACK_IMAGES[pack.id])} width={160} height={40} alt="" draggable={false} />
              <span className={styles.tileName}>{pack.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Swatches legend="Warna sorot" name={`${uid}-highlight`} value={overrides.highlight} options={CAPTION_SWATCHES}
        disabled={locked} note={highlightNote(captions.pack.id)} onChange={(value) => send(captionCommand("highlight", value))} />
      <PillGroup legend="Ukuran" name={`${uid}-size`} options={pills(CAPTION_SIZES)} value={presetId(CAPTION_SIZES, overrides.size_pm)}
        disabled={locked} onChange={(id) => send(captionCommand("size_pm", valueOf(CAPTION_SIZES, id)))} />
      <div className={styles.stack}>
        <PillGroup legend="Posisi" name={`${uid}-position`} options={pills(CAPTION_POSITIONS)}
          value={presetId(CAPTION_POSITIONS, overrides.y_e5)} disabled={locked} describedBy={notes}
          onChange={(id) => send(captionCommand("y_e5", valueOf(CAPTION_POSITIONS, id)))} />
        {zone ? (
          <p id={`${uid}-zone`} className={zone.tone === "warning" ? styles.warning : styles.note} data-caption-zone={zone.tone}>{zone.text}</p>
        ) : null}
        {nearHook ? <p id={`${uid}-near`} className={styles.note} data-hook-near="">{nearHook}</p> : null}
      </div>
    </div>
  );
}

export default function CaptionCard({ state, dispatch }) {
  if (!state?.doc) return <p className={styles.note} role="status">Membuka caption…</p>;
  return <CaptionBody state={state} dispatch={dispatch} />;
}
