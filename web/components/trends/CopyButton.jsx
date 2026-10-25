"use client";

// Copies `text` to the clipboard. The clipboard API needs a secure context (https or
// localhost); when it is missing or refuses, the button says so and the text stays selectable
// next to it. The result is announced politely.
import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

export default function CopyButton({ text, label, variant = "secondary" }) {
  const t = useTranslations("trends.agent");
  const [state, setState] = useState("");
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let next = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "failed";
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(""), 2400);
  }

  return (
    <>
      <Button variant={variant} onPress={copy} isDisabled={!text}>
        {state === "copied" ? t("copied") : state === "failed" ? t("copyFailed") : label}
      </Button>
      <span className="visuallyHidden" role="status" aria-live="polite">
        {state === "copied" ? t("copied") : state === "failed" ? t("copyFailed") : ""}
      </span>
    </>
  );
}
