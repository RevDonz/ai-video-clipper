"use client";

import { Disclosure } from "@heroui/react";
import { useEffect, useState } from "react";

import styles from "./bantuan.module.css";

const hashOf = (location) => decodeURIComponent((location?.hash ?? "").replace(/^#/, ""));

// The guide: one Disclosure per topic, closed until opened. The topic the address names
// (/bantuan#editor) opens by itself, on load and on every later #topic link. Each topic keeps its
// anchor on a <section> that is always rendered; without JS the panels are shown open
// (bantuan.module.css, scripting: none), so the guide reads without JS too.
export default function HelpGuide({ title, topics }) {
  const [open, setOpen] = useState(() => new Set());

  useEffect(() => {
    const ids = new Set(topics.map((topic) => topic.id));
    function follow() {
      const id = hashOf(window.location);
      if (!ids.has(id)) return;
      setOpen((current) => (current.has(id) ? current : new Set([...current, id])));
    }
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [topics]);

  function toggle(id, expanded) {
    setOpen((current) => {
      const next = new Set(current);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <section className={styles.guide} aria-labelledby="panduan">
      <h2 id="panduan">{title}</h2>
      <div className={styles.topics}>
        {topics.map((topic) => (
          <section key={topic.id} id={topic.id} className={styles.topic} aria-labelledby={`${topic.id}-judul`} tabIndex={-1}>
            <Disclosure isExpanded={open.has(topic.id)} onExpandedChange={(expanded) => toggle(topic.id, expanded)}>
              <Disclosure.Heading id={`${topic.id}-judul`} className={styles.topicHeading}>
                <Disclosure.Trigger className={styles.topicTrigger}>
                  <span>{topic.title}</span>
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content className={styles.topicPanel}>
                <Disclosure.Body className={styles.topicBody}>
                  <p className={styles.topicIntro}>{topic.intro}</p>
                  {topic.steps.length > 0 && (
                    <ol className={styles.guideSteps}>
                      {topic.steps.map((step) => <li key={step}>{step}</li>)}
                    </ol>
                  )}
                  {topic.terms.length > 0 && (
                    <dl className={styles.terms}>
                      {topic.terms.map((term) => (
                        <div key={term.id} className={styles.row}>
                          <dt>{term.title}</dt>
                          <dd>{term.text}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {topic.action && <a className={styles.action} href={topic.action.href}>{topic.action.label}</a>}
                </Disclosure.Body>
              </Disclosure.Content>
            </Disclosure>
          </section>
        ))}
      </div>
    </section>
  );
}
