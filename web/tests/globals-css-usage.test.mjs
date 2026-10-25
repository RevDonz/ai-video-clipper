// No dead CSS in app/globals.css (08 Fase 3: "Tanpa CSS mati; global-error tetap bergaya"): every
// class it styles is still written by some page or component (in a className, a value named
// *class*, classList, or a :global(.x) of a CSS Module), and the minimal .btn that
// app/global-error.jsx uses stays.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { WEB, listSources, parseSource } from "./support/i18n-scan.mjs";

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The base class names a stylesheet's selectors name: a class that starts a compound selector
 * (".btn", ".appBar .jobBadge"), not a modifier joined to another (".btn.primary" gives only
 * btn), and nothing inside declarations, at-rule preludes or numbers.
 */
export function selectorClasses(css) {
  const names = new Set();
  for (const block of stripComments(css).matchAll(/([^{}]+)\{/g)) {
    const selector = block[1];
    if (/^\s*@/.test(selector) || /:\s*[^,]*;/.test(selector)) continue;
    for (const match of selector.matchAll(/(^|[\s,>+~(])\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[2]);
  }
  return names;
}

const CLASS_HOLDER = /class/i;

// Whether a string sits in a className (or class) attribute, or in a value given to a name that
// says "class" (const rowClass = "…", { className: "…" }, classList.add("…")).
function inClassContext(ancestors) {
  for (const node of ancestors) {
    if (node.type === "JSXAttribute" && CLASS_HOLDER.test(node.name?.name ?? "")) return true;
    if (node.type === "VariableDeclarator" && CLASS_HOLDER.test(node.id?.name ?? "")) return true;
    if (node.type === "ObjectProperty" && CLASS_HOLDER.test(node.key?.name ?? node.key?.value ?? "")) return true;
    if (node.type === "AssignmentExpression" && CLASS_HOLDER.test(node.left?.property?.name ?? node.left?.name ?? "")) return true;
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && node.callee.object?.property?.name === "classList") return true;
  }
  return false;
}

/** Every word of the strings and template parts a source writes where class names go. */
export function classWords(ast, out = new Set()) {
  const stack = [];
  (function visit(node) {
    if (!node || typeof node.type !== "string") return;
    const text = node.type === "StringLiteral" ? node.value : node.type === "TemplateElement" ? (node.value.cooked ?? "") : null;
    if (text !== null && inClassContext(stack)) for (const word of text.split(/\s+/)) if (word) out.add(word);
    stack.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === "string") visit(value);
    }
    stack.pop();
  })(ast.program);
  return out;
}

async function usedClasses() {
  const words = new Set();
  for (const file of await listSources(["app", "components", "lib"])) {
    classWords(parseSource(await readFile(path.join(WEB, file), "utf8"), file), words);
  }
  for (const file of await listSources(["app", "components"], [".css"])) {
    if (!file.endsWith(".module.css")) continue;
    for (const match of (await readFile(path.join(WEB, file), "utf8")).matchAll(/:global\(([^)]*)\)/g)) {
      for (const name of match[1].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) words.add(name[1]);
    }
  }
  return words;
}

test("the scans read base class names from selectors and class words from class places only", () => {
  const found = selectorClasses(`
    /* .commented { color: red; } */
    .a, .b:hover > .c-d { color: var(--x); transition: opacity .2s; }
    .g.modifier { color: var(--y); }
    @media (max-width: 640px) { .e { margin: 1.5px; } }
    html:has(.f[data-x]) { overflow: hidden; }
  `);
  assert.deepEqual([...found].sort(), ["a", "b", "c-d", "e", "f", "g"]);
  const words = [...classWords(parseSource(`
    const rowClass = "row wide";
    const label = "message";
    el.classList.add("open");
    const a = <p className={\`notice \${tone}\`} data-x="hidden">{"text"}</p>;
    const b = { className: "pill", title: "Judul" };
  `))].sort();
  assert.deepEqual(words, ["notice", "open", "pill", "row", "wide"]);
});

test("every class app/globals.css styles is still used by a page or a component", async () => {
  const css = await readFile(path.join(WEB, "app", "globals.css"), "utf8");
  const used = await usedClasses();
  const dead = [...selectorClasses(css)].filter((name) => !used.has(name));
  assert.deepEqual(dead, [], `classes no source writes any more, remove their rules from app/globals.css:\n${dead.join("\n")}`);
});

test("global-error keeps its minimal button styles", async () => {
  const source = await readFile(path.join(WEB, "app", "global-error.jsx"), "utf8");
  assert.match(source, /import "\.\/globals\.css";/);
  assert.match(source, /className="btn primary"/);
  assert.match(source, /className="btn"/);
  const css = stripComments(await readFile(path.join(WEB, "app", "globals.css"), "utf8"));
  const rule = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")} \\{[^}]*\\}`).exec(css)?.[0] ?? "";
  assert.match(rule(".btn"), /min-height:\s*44px/, "a 44 px target");
  assert.match(rule(".btn"), /background:\s*var\(--surface-2\)/);
  assert.match(rule(".btn.primary"), /background:\s*var\(--accent\)/);
  assert.match(css, /\.btn:hover \{/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus\)/, "the focus ring reaches the buttons");
});
