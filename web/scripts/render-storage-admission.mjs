import process from "node:process";

import {
  heartbeatRenderStorage,
  releaseRenderStorage,
} from "../lib/render-storage-admission.mjs";
import { parseStorageAdmissionConfig } from "../lib/storage-admission.mjs";

const MAX_INPUT_BYTES = 64 * 1024;

async function readCommand() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new Error();
    chunks.push(chunk);
  }
  if (total === 0) throw new Error();
  const command = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error();
  return command;
}

async function main() {
  const command = await readCommand();
  const root = process.env.JOBS_ROOT;
  if (typeof root !== "string" || root.length === 0) throw new Error();
  let ok = false;
  if (command.operation === "heartbeat"
      && Object.keys(command).sort().join(",") === "operation,reservationId,token") {
    ok = await heartbeatRenderStorage(
      root,
      command.reservationId,
      command.token,
      parseStorageAdmissionConfig(process.env),
    );
  } else if (command.operation === "release"
      && Object.keys(command).sort().join(",") === "operation,reservationId,terminalState,token") {
    ok = await releaseRenderStorage(
      root,
      command.reservationId,
      command.token,
      command.terminalState,
    );
  }
  if (!ok) throw new Error();
  process.stdout.write('{"ok":true}\n');
}

main().catch(() => {
  process.stderr.write("render_storage_failed\n");
  process.exitCode = 1;
});
