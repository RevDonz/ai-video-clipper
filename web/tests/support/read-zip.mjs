// Reads a ZIP with Python's zipfile (an independent reader): every entry's name, sizes, method,
// stored CRC, data hash and date, plus testzip() (null when every CRC matches the data).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

const READ_ZIP = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = []
    for info in archive.infolist():
        data = archive.read(info)
        entries.append({"name": info.filename, "size": info.file_size, "stored": info.compress_size,
            "method": info.compress_type, "crc": info.CRC, "sha": hashlib.sha256(data).hexdigest(),
            "date": list(info.date_time)})
    print(json.dumps({"bad": archive.testzip(), "entries": entries}))
`;

export function readZip(file) {
  return JSON.parse(execFileSync(python(), ["-I", "-c", READ_ZIP, file], { encoding: "utf8" }));
}
