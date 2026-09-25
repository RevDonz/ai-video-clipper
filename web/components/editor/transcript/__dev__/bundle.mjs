// A tiny bundler for the T2.7 e2e harness (Node only; never imported by the app).
//
// The specs mount the real panel components without a Next server: each source file is
// compiled to CommonJS by Next's own SWC binding (the compiler `next build` uses, no new
// dependency), React comes from node_modules as its production CommonJS build, CSS modules get
// scoped class names like Next's, and `.png` imports become Next-style static image objects
// (`{src, width, height}`). The result is one classic script for `page.route`.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(here, "..", "..", "..", "..");
const requireFromWeb = createRequire(path.join(WEB_ROOT, "package.json"));
const EXTENSIONS = ["", ".mjs", ".js", ".jsx", "/index.mjs", "/index.js"];
const REQUIRE = /\brequire\((["'])([^"']+)\1\)/g;

let swcPromise = null;
function swc() {
  swcPromise ??= (async () => {
    const binding = requireFromWeb("next/dist/build/swc/index.js");
    await binding.loadBindings();
    return binding;
  })();
  return swcPromise;
}

function resolve(from, spec) {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = path.resolve(path.dirname(from), spec);
    for (const extension of EXTENSIONS) {
      const candidate = base + extension;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`harness bundle: cannot resolve ${spec} from ${from}`);
  }
  return createRequire(from).resolve(spec);
}

function shortHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 6);
}

/** Scope every class of a CSS module like Next does; returns {css, names}. */
export function scopeCssModule(source, file) {
  const suffix = shortHash(path.relative(WEB_ROOT, file));
  const names = {};
  const scope = (prelude) => prelude.replace(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g, (_, name) => {
    names[name] ??= `${name}__${suffix}`;
    return `.${names[name]}`;
  });
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let css = "";
  let start = 0;
  const atStack = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") {
      const prelude = text.slice(start, i);
      const trimmed = prelude.trim();
      const inKeyframes = atStack.at(-1)?.startsWith("@keyframes");
      css += trimmed.startsWith("@") || inKeyframes ? prelude : scope(prelude);
      css += "{";
      atStack.push(trimmed.startsWith("@") ? trimmed : "");
      start = i + 1;
    } else if (char === "}") {
      css += text.slice(start, i + 1);
      atStack.pop();
      start = i + 1;
    } else if (char === ";") {
      css += text.slice(start, i + 1);
      start = i + 1;
    }
  }
  css += text.slice(start);
  return { css, names };
}

function pngModule(raw) {
  if (raw.subarray(0, 8).toString("binary") !== "\x89PNG\r\n\x1a\n") throw new Error("not a PNG");
  const width = raw.readUInt32BE(16);
  const height = raw.readUInt32BE(20);
  const src = `data:image/png;base64,${raw.toString("base64")}`;
  return `module.exports = ${JSON.stringify({ src, width, height })};`;
}

async function compile(file) {
  const raw = await readFile(file);
  if (file.endsWith(".png")) return pngModule(raw);
  const source = raw.toString("utf8");
  if (file.endsWith(".module.css")) {
    const { css, names } = scopeCssModule(source, file);
    return `(function(){var s=document.createElement("style");s.setAttribute("data-harness-css",${JSON.stringify(path.basename(file))});`
      + `s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();module.exports=${JSON.stringify(names)};`;
  }
  if (file.endsWith(".css")) throw new Error(`harness bundle: global CSS is not supported (${file})`);
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return source;
  const binding = await swc();
  const out = await binding.transform(source, {
    filename: file,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
    sourceMaps: false,
  });
  return out.code;
}

/** Bundle `entry` (default: the harness entry) into one classic script. */
export async function bundleHarness({ entry = path.join(here, "harness-entry.jsx"), nodeEnv = "production" } = {}) {
  const modules = new Map();
  async function add(file) {
    if (modules.has(file)) return modules.get(file).id;
    const record = { id: modules.size, code: "", deps: {} };
    modules.set(file, record);
    const code = await compile(file);
    for (const match of code.matchAll(REQUIRE)) {
      const spec = match[2];
      if (!(spec in record.deps)) record.deps[spec] = await add(resolve(file, spec));
    }
    record.code = code;
    return record.id;
  }
  await add(path.resolve(entry));
  const defs = [...modules.entries()].map(([file, record]) =>
    `${record.id}:[function(module,exports,require){\n// ${path.relative(WEB_ROOT, file)}\n${record.code}\n},${JSON.stringify(record.deps)}]`);
  return `(function(){"use strict";
var process={env:{NODE_ENV:${JSON.stringify(nodeEnv)}}};
var defs={${defs.join(",\n")}};
var cache={};
function load(id){if(cache[id])return cache[id].exports;var def=defs[id];var module={exports:{}};cache[id]=module;
def[0].call(module.exports,module,module.exports,function(spec){var dep=def[1][spec];if(dep===undefined)throw new Error("harness: unresolved "+spec);return load(dep);});
return module.exports;}
load(0);
})();`;
}

/** The harness HTML page. */
export const HARNESS_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Editor harness</title>
<style>html,body{margin:0;height:100%}</style></head><body><div id="root"></div><script src="/harness.js"></script></body></html>`;
