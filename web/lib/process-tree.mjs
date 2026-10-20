// Linux /proc helpers the runner uses to stop a job's whole process tree. Signalling the child's
// process group is not enough: the engine starts some FFmpeg runs in their own session, which
// leaves that group. A process is identified by pid plus start time, so a pid reused after
// the process exited is never signalled.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * One /proc/<pid>/stat line as { pid, state, ppid, pgid, start }, or null. The command name can
 * hold spaces and parentheses, so the fields are read after its last ")".
 */
export function parseProcStat(text) {
  if (typeof text !== "string") return null;
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const pid = Number.parseInt(text, 10);
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const start = fields[19];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !/^\d+$/.test(start ?? "")) return null;
  return { pid, state: fields[0], ppid, pgid, start };
}

const exited = (stat) => stat.state === "Z" || stat.state === "X";

export function createProcessTree({ procRoot = "/proc" } = {}) {
  const read = (pid) => {
    try {
      return parseProcStat(readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"));
    } catch {
      return null;
    }
  };
  return {
    /** Every running process below `rootPid` as { pid, pgid, start }, whatever group or session it moved to. */
    descendants(rootPid) {
      let names;
      try {
        names = readdirSync(procRoot);
      } catch {
        return [];
      }
      const children = new Map();
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const stat = read(name);
        if (!stat || exited(stat)) continue;
        if (!children.has(stat.ppid)) children.set(stat.ppid, []);
        children.get(stat.ppid).push(stat);
      }
      const found = [];
      const seen = new Set([rootPid]);
      const pending = [rootPid];
      while (pending.length) {
        for (const stat of children.get(pending.shift()) ?? []) {
          if (seen.has(stat.pid)) continue;
          seen.add(stat.pid);
          found.push({ pid: stat.pid, pgid: stat.pgid, start: stat.start });
          pending.push(stat.pid);
        }
      }
      return found;
    },
    /** Whether `proc` is still that same process and has not exited. */
    alive(proc) {
      const stat = read(proc.pid);
      return Boolean(stat) && stat.start === proc.start && !exited(stat);
    },
  };
}

/** The tree of this machine, or null where there is no /proc (the runner then signals the group only). */
export function systemProcessTree() {
  return existsSync("/proc/self/stat") ? createProcessTree() : null;
}
