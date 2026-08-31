import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function buildRenderWorkerInvocation(env = process.env) {
  return {
    command: env.PYTHON_BIN || "python",
    args: ["-m", "ai_clipper.render_worker", "--jobs-root", path.resolve(env.JOBS_ROOT || "/data/jobs")],
  };
}

export function main(env = process.env) {
  const { command, args } = buildRenderWorkerInvocation(env);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, env });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`render worker failed (${signal || `exit ${code}`})`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
