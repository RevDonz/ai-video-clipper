#!/usr/bin/env node
// Manage the LLM settings file from a shell (no secrets are ever printed).
//
//   node scripts/llm-settings.mjs import-env [--force] [--env-file PATH]
//   node scripts/llm-settings.mjs show
//   node scripts/llm-settings.mjs path
//
// import-env seals the current POTONGIN_LLM_* / provider key variables into
// the settings file (the one-time move from .env to the Pengaturan page). It
// refuses to overwrite existing settings unless --force is given. --env-file
// reads the LLM variables from a dotenv file instead of this process; the
// settings location and the sealing secret always come from this process
// (JOBS_ROOT / POTONGIN_SETTINGS_DIR, POTONGIN_SETTINGS_SECRET or
// APP_SESSION_SECRET), so run it where the dashboard runs, e.g.
//   docker compose exec app node scripts/llm-settings.mjs import-env

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LlmSettingsError,
  importEnvToFile,
  isLlmVariable,
  readLlmSettingsView,
  resolveSettingsPaths,
} from "../lib/llm-settings.mjs";

const USAGE = "Pemakaian: node scripts/llm-settings.mjs <import-env [--force] [--env-file PATH] | show | path>\n";
const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KEY=VALUE lines (optional `export`, quotes, and ` #` comments on unquoted values). */
export function parseDotenv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!DOTENV_KEY.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[key] = value;
  }
  return values;
}

function providerLine(provider) {
  const key = provider.apiKeySet ? (provider.apiKeyUnreadable ? "key tidak bisa dibuka" : "key ✓") : "tanpa key";
  // Names are validated (no control characters), so they are safe to print.
  const name = provider.name ? ` "${provider.name}"` : "";
  return `${provider.provider}${name} (${provider.enabled ? "aktif" : "nonaktif"}, ${key})`;
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === "path" && rest.length === 0) {
      stdout.write(`${resolveSettingsPaths(env).file}\n`);
      return 0;
    }
    if (command === "show" && rest.length === 0) {
      const view = await readLlmSettingsView(env);
      stdout.write(`${JSON.stringify({ file: resolveSettingsPaths(env).file, ...view }, null, 2)}\n`);
      return 0;
    }
    if (command === "import-env") {
      let force = false;
      let envFile = null;
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === "--force") force = true;
        else if (rest[index] === "--env-file" && rest[index + 1]) envFile = rest[++index];
        else {
          stderr.write(USAGE);
          return 2;
        }
      }
      let sourceEnv = env;
      if (envFile !== null) {
        const inherited = Object.fromEntries(Object.entries(env).filter(([name]) => !isLlmVariable(name)));
        const fromFile = Object.fromEntries(Object.entries(parseDotenv(await readFile(path.resolve(envFile), "utf8"))).filter(([name]) => isLlmVariable(name)));
        sourceEnv = { ...inherited, ...fromFile };
      }
      const { settings, warnings } = await importEnvToFile({ env, sourceEnv, force });
      const { file } = resolveSettingsPaths(env);
      const providers = settings.providers.map((entry) => providerLine({ provider: entry.provider, name: entry.name, enabled: entry.enabled, apiKeySet: Boolean(entry.apiKey), apiKeyUnreadable: false }));
      stdout.write(`Pengaturan AI diimpor ke ${file}\n`);
      stdout.write(`AI ${settings.enabled ? "aktif" : "dimatikan"}; hanya model gratis: ${settings.freeOnly ? "ya" : "tidak"}.\n`);
      stdout.write(`Urutan penyedia: ${providers.length ? providers.join(" → ") : "(kosong)"}\n`);
      for (const warning of warnings) stdout.write(`Peringatan: ${warning}\n`);
      return 0;
    }
    stderr.write(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof LlmSettingsError) {
      const hint = error.code === "exists" ? " Tambahkan --force untuk menimpa." : "";
      stderr.write(`GAGAL [${error.code}]: ${error.message}${hint}\n`);
      for (const issue of error.issues || []) stderr.write(`  - ${issue.field}: ${issue.message}\n`);
      return 1;
    }
    if (error?.code === "ENOENT") {
      stderr.write("GAGAL: file --env-file tidak ditemukan.\n");
      return 1;
    }
    stderr.write("GAGAL: pengaturan AI tidak bisa diproses.\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
