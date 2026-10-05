"use client";

// Mode Cepat's cards (spec §1.2, §1.3): an accordion over the registry of quick/cards.mjs, one card
// open at a time, Caption open on load unless `initialCard` names another. Clicking the open
// card's header closes it. A body loads when its card first opens and stays mounted while Cepat
// is shown. Every body gets the panel props bundle plus `frameBus` and `showLengkap`.
import { Suspense, lazy, useState } from "react";

import { linesSummary } from "../../../lib/editor/caption-lines.mjs";
import AccordionCard from "../ui/AccordionCard.jsx";
import { CARDS, DEFAULT_CARD, cardById } from "./cards.mjs";
import styles from "./quick.module.css";

const components = new Map();

function lazyCard(card) {
  if (!components.has(card.file)) components.set(card.file, lazy(card.load));
  return components.get(card.file);
}

// Z0 summarises only Teks caption; task B moves every summary into quick/quick-model.mjs (§1.3).
function summaryOf(id, state) {
  if (id === "lines") return linesSummary({ plan: state?.plan ?? null, doc: state?.doc ?? null, words: state?.words ?? null });
  return "";
}

export default function QuickPanel({ initialCard = null, ...props }) {
  const [openId, setOpenId] = useState(() => (cardById(initialCard) ? initialCard : DEFAULT_CARD));
  return (
    <div className={styles.cards} data-quick-panel="">
      {CARDS.map((card) => {
        const Body = lazyCard(card);
        return (
          <AccordionCard key={card.id} id={`card-${card.id}`} label={card.label} summary={summaryOf(card.id, props.state)}
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
