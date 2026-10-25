"use client";

// Mode Cepat's Teks caption card (docs/plans/2026-10-02-editor-mode-cepat.md §2): the caption lines
// of transcript/LinesView.jsx, the view the one-layout editor shows as Baris (rombak 06 §6), in
// the card. With `llmEnabled`, "Cek ejaan" opens the spelling review (spelling/SpellingReview.jsx)
// above the lines; it asks the LLM only when opened. The card goes with the old shell (F10).
import { useMemo, useState } from "react";

import { COPY as SPELLING_COPY } from "../spelling/model.mjs";
import SpellingReview from "../spelling/SpellingReview.jsx";
import { useSpellCheck } from "../spelling/use-spell-check.js";
import LinesView from "../transcript/LinesView.jsx";
import { buildTranscriptModel } from "../transcript/model.mjs";
import PillButton from "../ui/PillButton.jsx";

export default function CaptionLinesCard({ state, dispatch, player, api = null, llmEnabled = false, frameBus, readOnly = false, showLengkap }) {
  const doc = state?.doc ?? null;
  const words = Array.isArray(state?.words?.words) ? state.words : null;
  const model = useMemo(() => (doc && words ? buildTranscriptModel(words, doc) : null), [words, doc]);
  const [spellingOpen, setSpellingOpen] = useState(false);
  const spelling = useSpellCheck({ state, dispatch, api, player, model, open: spellingOpen && llmEnabled });
  const spellingCount = spelling.view.phase === "done" ? spelling.rows.length : null;

  return (
    <LinesView
      state={state}
      dispatch={dispatch}
      player={player}
      frameBus={frameBus}
      readOnly={readOnly}
      variant="card"
      onShowWords={typeof showLengkap === "function" ? () => showLengkap("transcript") : null}
      tools={llmEnabled ? (
        <PillButton variant={spellingOpen ? "strong" : "default"} aria-expanded={spellingOpen}
          aria-controls="spelling-review-card" data-spelling-toggle="" title={SPELLING_COPY.toggleTitle}
          onClick={() => setSpellingOpen((open) => !open)}>
          {spellingCount !== null ? `${SPELLING_COPY.toggle} · ${spellingCount}` : SPELLING_COPY.toggle}
        </PillButton>
      ) : null}
      review={spellingOpen && llmEnabled ? <SpellingReview id="spelling-review-card" check={spelling} /> : null}
    />
  );
}
