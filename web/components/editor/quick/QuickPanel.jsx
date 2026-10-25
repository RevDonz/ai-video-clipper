"use client";

// Mode Cepat's cards (spec §1.2, §1.3): an accordion over the registry of quick/cards.mjs, one card
// open at a time, Caption open on load unless `initialCard` names another. Clicking the open
// card's header closes it. A body loads when its card first opens and stays mounted while Cepat
// is shown. Every body gets the panel props bundle plus `frameBus` and `showLengkap`. Each header
// sums up its card (quick-model.mjs), the Tata letak line from the clip's face analysis too.
// `onCardChange(id | null)` hears which card is open, so the next clip can open with the same one.
import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { IDLE_ANALYSIS, layoutAnalysisFor } from "../panels/layout-analysis.mjs";
import AccordionCard from "../ui/AccordionCard.jsx";
import { cardModules } from "./card-modules.mjs";
import { CARDS, DEFAULT_CARD, cardById } from "./cards.mjs";
import { cardSummary } from "./quick-model.mjs";
import styles from "./quick.module.css";

const components = new Map();
// Every body is loaded when the cards mount, so an opened card renders it at once instead of
// growing under the pointer when its lazy body arrives (card-modules.mjs).
const MODULES = cardModules();

function lazyCard(card) {
  if (!components.has(card.file)) components.set(card.file, lazy(MODULES.importer(card)));
  return components.get(card.file);
}

const idle = () => IDLE_ANALYSIS;
const quiet = () => () => {};

export default function QuickPanel({ initialCard = null, onCardChange = null, ...props }) {
  const [openId, setOpenId] = useState(() => (cardById(initialCard) ? initialCard : DEFAULT_CARD));
  useEffect(() => {
    MODULES.preload(CARDS);
  }, []);
  useEffect(() => {
    onCardChange?.(openId);
  }, [openId, onCardChange]);
  const analysisStore = layoutAnalysisFor(props.state?.clipId ?? props.state?.doc?.clip_id ?? null);
  const subscribe = useCallback((listener) => (analysisStore ? analysisStore.subscribe(listener) : quiet()), [analysisStore]);
  const snapshot = useCallback(() => (analysisStore ? analysisStore.get() : IDLE_ANALYSIS), [analysisStore]);
  const analysis = useSyncExternalStore(subscribe, snapshot, idle);
  return (
    <div className={styles.cards} data-quick-panel="">
      {CARDS.map((card) => {
        const Body = lazyCard(card);
        return (
          <AccordionCard key={card.id} id={`card-${card.id}`} label={card.label}
            summary={cardSummary(card.id, { state: props.state, analysis })}
            open={openId === card.id} onToggle={() => setOpenId((current) => (current === card.id ? null : card.id))}>
            <Suspense fallback={<p className={styles.note}>Membuka kartu…</p>}>
              <Body {...props} />
            </Suspense>
          </AccordionCard>
        );
      })}
    </div>
  );
}
