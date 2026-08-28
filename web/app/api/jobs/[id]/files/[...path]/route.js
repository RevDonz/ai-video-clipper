import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";

import { requireAuth } from "../../../../../../lib/auth.mjs";
import { parseByteRange, safeJobFile } from "../../../../../../lib/jobs.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = {
  ".mp4": "video/mp4",
  ".srt": "application/x-subrip; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export async function GET(request, { params }) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const resolved = await params;
  if (!UUID.test(resolved.id)) return new Response("Bad job ID", { status: 400 });
  const relative = resolved.path.join("/");
  if (!relative.startsWith("output/")) return new Response("Forbidden", { status: 403 });
  try {
    const root = path.resolve(process.env.JOBS_ROOT || "/data/jobs", resolved.id);
    const target = safeJobFile(root, relative);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    const extension = path.extname(target).toLowerCase();
    const download = new URL(request.url).searchParams.get("download") === "1";
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": TYPES[extension] || "application/octet-stream",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${path.basename(target)}"`,
      "Cache-Control": "private, max-age=3600",
    };
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    const range = request.headers.get("range");
    if (range) {
      try {
        ({ start, end } = parseByteRange(range, info.size));
      } catch {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}` },
        });
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    const stream = createReadStream(target, { start, end });
    return new Response(Readable.toWeb(stream), { status, headers });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}
