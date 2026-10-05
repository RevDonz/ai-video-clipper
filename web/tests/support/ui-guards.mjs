// Source scanners behind tests/ui-guards.test.mjs. Dependency-free: a small JS/JSX lexer and a
// CSS rule reader, enough for this repository's own sources.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Files under `dirs` (relative to `root`) whose names end with one of `extensions`, sorted. */
export async function listFiles(root, dirs, extensions) {
  const found = [];
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(child);
    }
  };
  for (const dir of dirs) await walk(dir);
  return found.sort();
}

export async function readSources(root, files) {
  return Promise.all(files.map(async (file) => ({ file, source: await readFile(path.join(root, file), "utf8") })));
}

const lineAt = (text, index, firstLine) => firstLine + (text.slice(0, index).match(/\n/g)?.length ?? 0);

// JS / JSX

// A "/" after one of these (or after a keyword below) starts a regex literal, not a division.
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%~^"]);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new|throw)\s*$/;

/**
 * Splits a JS or JSX source into the parts a user could ever see: string literals (template
 * literal text included) and code (identifiers, JSX text). Comments and regex literals are
 * dropped. Each segment is { kind: "string" | "code", text, line }.
 */
export function jsSegments(source) {
  const segments = [];
  let code = "";
  let codeLine = 1;
  let line = 1;
  let previous = ""; // last significant character of code, "a" after a literal
  const stack = [{ type: "code", depth: 0 }];

  const flush = () => {
    if (code.trim()) segments.push({ kind: "code", text: code, line: codeLine });
    code = "";
  };
  const addCode = (char) => {
    if (!code) codeLine = line;
    code += char;
    if (!/\s/.test(char)) previous = char;
  };

  let i = 0;
  while (i < source.length) {
    const top = stack.at(-1);
    const char = source[i];
    const next = source[i + 1];

    if (top.type === "template") {
      let text = "";
      const start = line;
      while (i < source.length && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{")) {
        if (source[i] === "\\") { text += source.slice(i, i + 2); i += 2; continue; }
        if (source[i] === "\n") line += 1;
        text += source[i];
        i += 1;
      }
      if (text) segments.push({ kind: "string", text, line: start });
      if (source[i] === "`") { stack.pop(); previous = "a"; i += 1; } else { stack.push({ type: "code", depth: 0 }); i += 2; }
      continue;
    }

    if (char === "\n") { addCode(char); line += 1; i += 1; continue; }
    if (char === "/" && next === "/") {
      flush();
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      flush();
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += source.slice(i, stop).match(/\n/g)?.length ?? 0;
      i = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      // A quote that does not close on its line is JSX text ("Don't"), not a string.
      let j = i + 1;
      while (j < source.length && source[j] !== char && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      if (source[j] === char) {
        flush();
        segments.push({ kind: "string", text: source.slice(i + 1, j), line });
        previous = "a";
        i = j + 1;
        continue;
      }
      addCode(char);
      i += 1;
      continue;
    }
    if (char === "`") { flush(); stack.push({ type: "template" }); i += 1; continue; }
    if (char === "/" && next !== ">" && (REGEX_AFTER.has(previous) || previous === "" || REGEX_AFTER_WORD.test(code))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      if (source[j] === "/") {
        flush();
        j += 1;
        while (/[a-z]/i.test(source[j] || "")) j += 1;
        previous = "a";
        i = j;
        continue;
      }
    }
    if (char === "{") top.depth += 1;
    if (char === "}") {
      if (top.depth === 0 && stack.length > 1) { flush(); stack.pop(); i += 1; continue; }
      top.depth -= 1;
    }
    addCode(char);
    i += 1;
  }
  flush();
  return segments;
}

// The owner's rule (AGENTS.md "Latest only"): no version labels or legacy modes on screen.
// "V1".."V3" is matched as a word and case-sensitively: lowercase "v3" is an API value.
export const VERSION_WORDING = Object.freeze([
  /\bV[1-3]\b/,
  /Selection V/i,
  /Mode lama/i,
  /mesin (?:lama|baru)/i,
  /llm-select/i,
  // Mode Cepat and Mode Lengkap are two views of one editor, never an old and a new one.
  /editor (?:lama|baru)/i,
  /tampilan (?:lama|baru)/i,
]);

/** Version wording in the strings and JSX text of one JS/JSX source. */
export function findVersionWording(file, source) {
  const found = [];
  for (const segment of jsSegments(source)) {
    for (const pattern of VERSION_WORDING) {
      const global = new RegExp(pattern.source, `${pattern.flags}g`);
      for (const match of segment.text.matchAll(global)) {
        found.push({ file, line: lineAt(segment.text, match.index, segment.line), text: match[0], kind: segment.kind });
      }
    }
  }
  return found;
}

// CSS

/**
 * Every rule with declarations, as { selector, at, line, decls: [{ prop, value, line }], backdrop }.
 * `at` lists the enclosing at-rule preludes. A comment "on: --token" inside a rule names the
 * background its text sits on when an ancestor element paints it.
 */
export function cssRules(source) {
  const rules = [];
  const stack = [];
  let buffer = "";
  let bufferLine = 1;
  let line = 1;
  const take = () => {
    const text = buffer.trim();
    const start = bufferLine + (buffer.slice(0, buffer.indexOf(text[0] ?? "")).match(/\n/g)?.length ?? 0);
    buffer = "";
    return { text, start };
  };
  const declaration = () => {
    const { text, start } = take();
    const frame = stack.at(-1);
    if (!frame || !text) return;
    const colon = text.indexOf(":");
    if (colon > 0) frame.decls.push({ prop: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim(), line: start });
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      const comment = source.slice(i + 2, stop - 2);
      const backdrop = /^\s*on:\s*--([a-z0-9-]+)\s*$/.exec(comment);
      if (backdrop && stack.length) stack.at(-1).backdrop = backdrop[1];
      line += comment.match(/\n/g)?.length ?? 0;
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, i + 1);
      const stop = end === -1 ? source.length : end + 1;
      if (!buffer) bufferLine = line;
      buffer += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === "{") {
      const { text, start } = take();
      stack.push({ prelude: text, line: start, decls: [], backdrop: null });
    } else if (char === ";") {
      declaration();
    } else if (char === "}") {
      declaration();
      const frame = stack.pop();
      if (frame && frame.decls.length) {
        rules.push({
          selector: frame.prelude,
          at: stack.filter((outer) => outer.prelude.startsWith("@")).map((outer) => outer.prelude),
          line: frame.line,
          decls: frame.decls,
          backdrop: frame.backdrop,
        });
      }
    } else {
      if (!buffer) bufferLine = line;
      buffer += char;
    }
    if (char === "\n") line += 1;
    i += 1;
  }
  return rules;
}

/** The colour tokens on :root, aliases (`--card: var(--surface)`) resolved to their hex. */
export function rootColourTokens(css) {
  const root = cssRules(css).find((rule) => rule.selector === ":root" && rule.at.length === 0);
  if (!root) throw new Error("no :root block");
  const raw = Object.fromEntries(root.decls.filter((decl) => decl.prop.startsWith("--")).map((decl) => [decl.prop.slice(2), decl.value]));
  const resolve = (name, seen = new Set()) => {
    const value = raw[name];
    if (value === undefined || seen.has(name)) return null;
    const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (alias) return resolve(alias[1], new Set([...seen, name]));
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  };
  return Object.fromEntries(Object.keys(raw).map((name) => [name, resolve(name)]).filter(([, hex]) => hex));
}

// The CSS named colours (CSS Color 4). transparent and currentColor stay allowed.
const NAMED_COLOURS = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ");
const COLOUR_LITERAL = new RegExp(
  [
    "#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])",
    "\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\\(",
    `(?<![\\w-])(?:${NAMED_COLOURS.join("|")})(?![\\w-])`,
  ].join("|"),
  "i",
);

/** Colour literals in CSS declarations, except the custom properties on globals.css's :root. */
export function findCssColourLiterals(file, css, { tokenFile = false } = {}) {
  const found = [];
  for (const rule of cssRules(css)) {
    const definesTokens = tokenFile && rule.selector === ":root" && rule.at.length === 0;
    for (const decl of rule.decls) {
      if (definesTokens && decl.prop.startsWith("--")) continue;
      // Strings (content, font names) and url() are not colours.
      const value = decl.value.replace(/"[^"]*"|'[^']*'|url\([^)]*\)/g, "");
      const match = COLOUR_LITERAL.exec(value);
      if (match) found.push({ file, line: decl.line, text: `${decl.prop}: ${decl.value}`, literal: match[0] });
    }
  }
  return found;
}

const JS_COLOUR = new RegExp(`^\\s*(?:#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\(.*|${NAMED_COLOURS.join("|")})\\s*$`, "i");

/** String literals in a JS/JSX source that are a colour ("#fff", "rgb(...)", "white"). */
export function findJsColourLiterals(file, source) {
  return jsSegments(source)
    .filter((segment) => segment.kind === "string" && JS_COLOUR.test(segment.text))
    .map((segment) => ({ file, line: segment.line, literal: segment.text.trim() }));
}

// Contrast

/** WCAG 2.x relative luminance and contrast, as in .claude/skills/antislop-human/contrast-check.py. */
export function luminance(hex) {
  const channels = hex.replace("#", "").match(/../g).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Backgrounds text can sit on when a rule sets only its colour: the page, the surfaces and the
// tinted message backgrounds.
export const DARK_BACKDROPS = Object.freeze(["bg", "surface", "surface-2", "surface-3", "info-bg", "danger-bg", "success-bg", "warning-bg"]);
const STATE = /:(?:hover|focus|focus-visible|focus-within|active|disabled|enabled|checked|visited|target)\b|:not\([^)]*\)|\[aria-(?:pressed|current|selected|expanded|invalid)(?:="[^"]*")?\]|\[data-[a-z-]+(?:="[^"]*")?\]/g;

function tokenOf(value) {
  const plain = value.replace(/\s*!important\s*$/, "").trim();
  const only = /^var\(--([a-z0-9-]+)(?:\s*,[^)]*)?\)$/.exec(plain);
  return only ? only[1] : null;
}

function backgroundOf(decls) {
  for (const decl of [...decls].reverse()) {
    if (decl.prop === "background-color") return { token: tokenOf(decl.value) };
    if (decl.prop === "background") {
      if (/gradient\(|url\(/.test(decl.value)) return { token: null };
      const vars = [...decl.value.matchAll(/var\(--([a-z0-9-]+)/g)].map((match) => match[1]);
      return { token: vars.length === 1 ? vars[0] : null };
    }
  }
  return null;
}

function colourOf(decls) {
  const decl = [...decls].reverse().find((item) => item.prop === "color");
  return decl ? { token: tokenOf(decl.value), value: decl.value } : null;
}

/**
 * Every text/background token pair the stylesheet puts on screen, checked against WCAG AA
 * (4.5:1). A rule's missing colour or background comes from its base rule in the same file
 * (the selector without :hover, [aria-pressed] and other states, then without its last class),
 * or from an "on: --token" comment. Text with no background in reach is checked on every dark
 * backdrop. Returns the failing pairs.
 */
export function findContrastFailures(file, css, tokens, { minimum = 4.5 } = {}) {
  const rules = cssRules(css).filter((rule) => !rule.at.some((at) => /keyframes/.test(at)) && rule.selector !== ":root");
  const bySelector = new Map();
  for (const rule of rules) {
    for (const selector of splitSelectors(rule.selector)) {
      const merged = bySelector.get(selector) ?? [];
      bySelector.set(selector, [...merged, ...rule.decls]);
    }
  }
  const lookup = (selector, pick) => {
    for (const base of baseSelectors(selector)) {
      const found = bySelector.has(base) ? pick(bySelector.get(base)) : null;
      if (found) return found;
    }
    return null;
  };

  const failures = [];
  const check = (text, background, where) => {
    const unknown = [text, background].find((name) => !tokens[name]);
    if (unknown) {
      failures.push({ ...where, text, background, ratio: null, reason: `--${unknown} is not a colour token` });
      return;
    }
    const ratio = contrastRatio(tokens[text], tokens[background]);
    if (ratio < minimum) failures.push({ ...where, text, background, ratio: Number(ratio.toFixed(2)) });
  };

  for (const rule of rules) {
    for (const selector of splitSelectors(rule.selector)) {
      const colour = colourOf(rule.decls);
      const background = backgroundOf(rule.decls);
      if (!colour && !background) continue;
      const text = colour ?? lookup(selector, colourOf);
      if (!text?.token) continue;
      const backdrop = rule.backdrop ?? background?.token ?? (background ? null : lookup(selector, backgroundOf)?.token);
      const where = { file, line: rule.line, selector };
      if (backdrop) check(text.token, backdrop, where);
      else if (!background) for (const surface of DARK_BACKDROPS) check(text.token, surface, where);
    }
  }
  return failures;
}

/** `.btn.primary:hover` -> [".btn.primary", ".btn"]: the rules a state or a variant builds on. */
function baseSelectors(selector) {
  const bases = [];
  const stripped = selector.replace(STATE, "").replace(/\s+/g, " ").trim();
  if (stripped !== selector) bases.push(stripped);
  const last = stripped.split(/[\s>+~]+/).at(-1) ?? "";
  const classes = last.match(/\.[\w-]+/g) ?? [];
  if (classes.length >= 2) bases.push(stripped.slice(0, stripped.length - last.length) + last.slice(0, last.lastIndexOf(classes.at(-1))) + last.slice(last.lastIndexOf(classes.at(-1)) + classes.at(-1).length));
  return bases;
}

function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((part) => part.replace(/\s+/g, " "));
}
