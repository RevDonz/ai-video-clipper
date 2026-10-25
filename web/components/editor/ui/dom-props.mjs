// React Aria hands its element only some of the DOM props it is given (filterDOMProps): ids, the
// labelling aria-* attributes, data-*, events, style. The kit's callers also pass others (title,
// aria-keyshortcuts), which would be dropped; they go onto the element through React Aria's
// `render` prop instead.
import { createElement } from "react";

const PASSED = new Set(["id", "aria-label", "aria-labelledby", "aria-describedby", "aria-details", "dir", "lang", "hidden",
  "inert", "translate", "style", "slot"]);

/** Splits props into those React Aria passes to its element (`rac`) and the rest (`extra`). */
export function splitDomProps(props) {
  const rac = {};
  const extra = {};
  for (const [key, value] of Object.entries(props)) {
    if (PASSED.has(key) || key.startsWith("data-") || /^on[A-Z]/.test(key)) rac[key] = value;
    else extra[key] = value;
  }
  return { rac, extra };
}

/** A `render` prop that draws React Aria's element as `tag` with `extra` added; undefined when there is nothing to add. */
export function renderWith(tag, extra) {
  if (!extra || Object.keys(extra).length === 0) return undefined;
  return (props) => createElement(tag, { ...props, ...extra });
}
