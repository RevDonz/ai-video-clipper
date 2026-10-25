// Shared by the i18n tests (rombak 07 §14): the web sources as Babel ASTs, the catalogs as flat
// key maps, and the scanners each test applies. Parser: @babel/parser (devDependency only).
import { parse } from "@babel/parser";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEB = fileURLToPath(new URL("../..", import.meta.url));
export const MESSAGES = path.join(WEB, "messages");
export const SOURCE_DIRS = Object.freeze(["app", "components", "lib", "scripts"]);
const SKIP_DIRS = new Set(["node_modules", ".next"]);

export async function listSources(dirs = SOURCE_DIRS, extensions = [".js", ".jsx", ".mjs"]) {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(WEB, relative), { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (extensions.includes(path.extname(entry.name))) files.push(child);
    }
  }
  for (const dir of dirs) await walk(dir);
  if (dirs === SOURCE_DIRS) files.push("proxy.js", "next.config.mjs");
  return files.sort();
}

export function parseSource(source, file = "source.jsx") {
  return parse(source, {
    sourceType: "module",
    sourceFilename: file,
    plugins: ["jsx", "importAttributes"],
    errorRecovery: false,
  });
}

export async function readParsed(file) {
  const source = await readFile(path.join(WEB, file), "utf8");
  return { file, source, ast: parseSource(source, file) };
}

/** Calls `visit(node, parent)` for every node of a Babel AST. */
export function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value.type === "string") walk(value, visit, node);
  }
}

export const hasUseClient = (ast) => ast.program.directives.some((directive) => directive.value.value === "use client");

// --- catalogs ----------------------------------------------------------------------------------

export async function catalogLocales() {
  return (await readdir(MESSAGES, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function catalogFiles(locale) {
  return (await readdir(path.join(MESSAGES, locale))).filter((name) => name.endsWith(".json")).sort();
}

export async function readCatalog(locale) {
  const catalog = {};
  for (const file of await catalogFiles(locale)) {
    catalog[file.slice(0, -".json".length)] = JSON.parse(await readFile(path.join(MESSAGES, locale, file), "utf8"));
  }
  return catalog;
}

/** "ns.a.b" → message, for every string leaf; non-string leaves are reported as such. */
export function flatten(value, prefix = "", out = new Map()) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

/** Every object key path of a catalog, with the raw key, for the key-shape rules. */
export function keyPaths(value, prefix = "", out = []) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      out.push({ path: prefix ? `${prefix}.${key}` : key, key });
      keyPaths(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

// --- translator calls ----------------------------------------------------------------------------

const TRANSLATOR_FACTORIES = Object.freeze({
  useTranslations: 0, // useTranslations("ns")
  getT: 1, // getT(locale, "ns")
});
const TRANSLATOR_METHODS = new Set(["rich", "markup", "raw", "has"]);

const unwrapAwait = (node) => (node?.type === "AwaitExpression" ? node.argument : node);

function factoryNamespace(init) {
  const call = unwrapAwait(init);
  if (call?.type !== "CallExpression" || call.callee.type !== "Identifier") return undefined;
  const index = TRANSLATOR_FACTORIES[call.callee.name];
  if (index === undefined) return undefined;
  const arg = call.arguments[index];
  if (arg === undefined) return { namespace: "", literal: true };
  return arg.type === "StringLiteral" ? { namespace: arg.value, literal: true } : { namespace: null, literal: false };
}

/**
 * Translator bindings and their calls in one file: `{ factories, calls }`. A call is
 * `{ key, dynamic, method, line }`; `key` is the full catalog path when the namespace and the
 * argument are literals, else null with `dynamic: true`.
 */
export function translatorCalls(ast) {
  const bindings = new Map();
  const factories = [];
  walk(ast.program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
    const found = factoryNamespace(node.init);
    if (!found) return;
    bindings.set(node.id.name, found);
    factories.push({ name: node.id.name, ...found, line: node.loc.start.line });
  });
  const calls = [];
  walk(ast.program, (node) => {
    if (node.type !== "CallExpression") return;
    let name = null;
    let method = null;
    if (node.callee.type === "Identifier") name = node.callee.name;
    else if (node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier"
      && node.callee.property.type === "Identifier" && TRANSLATOR_METHODS.has(node.callee.property.name)) {
      name = node.callee.object.name;
      method = node.callee.property.name;
    }
    const binding = name ? bindings.get(name) : undefined;
    if (!binding) return;
    const arg = node.arguments[0];
    const literal = arg?.type === "StringLiteral" && binding.literal;
    const key = literal ? (binding.namespace ? `${binding.namespace}.${arg.value}` : arg.value) : null;
    calls.push({ key, dynamic: !literal, method, line: node.loc.start.line });
  });
  return { factories, calls };
}

// --- hard-coded copy -----------------------------------------------------------------------------

export const COPY_ATTRIBUTES = new Set(["aria-label", "placeholder", "title", "alt", "label"]);
const LETTER = /\p{L}/u;
// Words that are the same in every language (rombak 07 §7.5 keeps the product name).
const NEUTRAL = new Set(["Potongin"]);

const isCopy = (text) => {
  const trimmed = String(text).replace(/\s+/gu, " ").trim();
  return LETTER.test(trimmed) && !NEUTRAL.has(trimmed);
};

// A sentence in a view module: several words, starting with a capital letter.
const SENTENCE = /^\p{Lu}[\p{L}\p{N}'’,.:;!?(){}\-–… ]*\s[\p{L}{]/u;

const templateText = (node) => node.quasis.map((quasi) => quasi.value.cooked).join(" ");

/**
 * The strings an expression can render, as `{ text, line }`: a literal, a template, or the value branches of
 * `a ? "x" : "y"` and `a && "x"` / `a || "x"` / `a ?? "x"`, nested. Conditions are not copy.
 */
export function renderedStrings(expression, out = []) {
  if (!expression) return out;
  const line = expression.loc?.start.line;
  if (expression.type === "StringLiteral") out.push({ text: expression.value, line });
  else if (expression.type === "TemplateLiteral") out.push({ text: templateText(expression), line });
  else if (expression.type === "ConditionalExpression") {
    renderedStrings(expression.consequent, out);
    renderedStrings(expression.alternate, out);
  } else if (expression.type === "LogicalExpression") {
    if (expression.operator !== "&&") renderedStrings(expression.left, out);
    renderedStrings(expression.right, out);
  } else if (expression.type === "ParenthesizedExpression") renderedStrings(expression.expression, out);
  return out;
}

function attributeCopy(value) {
  if (!value) return [];
  if (value.type === "StringLiteral") return [{ text: value.value, line: value.loc?.start.line }];
  if (value.type === "JSXExpressionContainer") return renderedStrings(value.expression);
  return [];
}

/**
 * Hard-coded UI copy in one file: JSX text, copy attributes with a literal value, toast("…")
 * (including the value branches of ?: and &&/||/??) and, in view modules (07 §8.3), sentence-like
 * string literals.
 */
export function hardcodedCopy(ast, { viewModule = false } = {}) {
  const found = [];
  walk(ast.program, (node, parent) => {
    if (node.type === "JSXText" && isCopy(node.value)) {
      found.push({ kind: "jsx-text", text: node.value.trim(), line: node.loc.start.line });
    } else if (node.type === "JSXExpressionContainer" && (parent?.type === "JSXElement" || parent?.type === "JSXFragment")) {
      for (const { text, line } of renderedStrings(node.expression)) {
        if (isCopy(text)) found.push({ kind: "jsx-text", text, line });
      }
    } else if (node.type === "JSXAttribute" && node.name.type === "JSXIdentifier" && COPY_ATTRIBUTES.has(node.name.name)) {
      for (const { text, line = node.loc.start.line } of attributeCopy(node.value)) {
        if (isCopy(text)) found.push({ kind: `attr:${node.name.name}`, text, line });
      }
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "toast") {
      for (const { text, line } of renderedStrings(node.arguments[0])) {
        if (isCopy(text)) found.push({ kind: "toast", text, line });
      }
    } else if (viewModule && node.type === "StringLiteral" && parent?.type !== "ImportDeclaration"
      && parent?.type !== "ExportNamedDeclaration" && parent?.type !== "ExportAllDeclaration" && SENTENCE.test(node.value)) {
      found.push({ kind: "view-sentence", text: node.value, line: node.loc.start.line });
    } else if (viewModule && node.type === "TemplateLiteral") {
      const text = node.quasis.map((quasi) => quasi.value.cooked).join("{}");
      if (SENTENCE.test(text.trim())) found.push({ kind: "view-sentence", text, line: node.loc.start.line });
    }
  });
  return found;
}

// --- locale literals -----------------------------------------------------------------------------

const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString", "toLocaleLowerCase", "toLocaleUpperCase"]);

const literalLocale = (node) => node?.type === "StringLiteral"
  || node?.type === "TemplateLiteral"
  || (node?.type === "ArrayExpression" && node.elements.some((element) => element?.type === "StringLiteral" || element?.type === "TemplateLiteral"));

/** Locale literals handed to Intl.*, toLocale*() or localeCompare(): `{ call, line }`. */
export function localeLiterals(ast) {
  const found = [];
  walk(ast.program, (node) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return;
    const method = callee.property.name;
    if (callee.object.type === "Identifier" && callee.object.name === "Intl") {
      if (literalLocale(node.arguments[0])) found.push({ call: `Intl.${method}`, line: node.loc.start.line });
    } else if (LOCALE_METHODS.has(method)) {
      if (literalLocale(node.arguments[0])) found.push({ call: method, line: node.loc.start.line });
    } else if (method === "localeCompare") {
      if (literalLocale(node.arguments[1])) found.push({ call: method, line: node.loc.start.line });
    }
  });
  return found;
}
