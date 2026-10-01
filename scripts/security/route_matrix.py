"""QG-SEC over HTTP against the real app (plan §9.1, §10.2; T4.2), for every editor route.

Run against a disposable standalone server (never the owner's app) that holds planted secret
values in its environment and has recorder wrappers first on its PATH. The checks:

* the session: no cookie and a forged cookie are refused on every route (401);
* the origin: a missing, foreign or cross-site origin is refused on every mutation (403);
* ids and names: path-traversal, upper-case, NUL and over-long values in every dynamic segment
  are refused (400 for ids, 404 for media kinds and names) and never reach a file;
* rate limits: preview/plan, preview/frame, uploads, the `api` bucket and the AI quota each
  refuse a burst with 429 and Retry-After (the AI quota: 202 with Retry-After);
* body caps: one byte over every mutation's cap is a 413;
* the AI route refuses any body field besides task and doc;
* the header set: nosniff and Cross-Origin-Resource-Policy on every answer of a route, the §9.2
  headers on served assets, COOP/COEP/nosniff/frame-ancestors/X-Frame-Options on the editor page;
* no answer carries a server path, the canary file outside the jobs root or a traceback, and no
  answer is a 5xx except a documented 503;
* E11: every child the server started (python, ffmpeg, ffprobe, prlimit), from its own
  /proc/self/environ: allowlisted names only, no planted dashboard secret anywhere, the planted LLM
  key only in the AI task (``python -m ai_clipper.editor_ai`` with LLM variables).

Planted values come from the environment variable QG_PLANTED (JSON ``{"dashboard": [...],
"llm": [...]}``) and are never written to the evidence. Usage (stdlib only)::

    python scripts/security/route_matrix.py recorders DIR --log LOG --python REAL_PYTHON
    python scripts/security/route_matrix.py matrix EVIDENCE.json --base URL --job ID \\
        --jobs-root DIR --environ-log LOG --canary FILE [--stack TEXT]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_upload_fuzz as fuzz

SCHEMA = "potongin.qg-sec-routes/1"
FFMPEG_CHILD_ENV = ("PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "FONTCONFIG_FILE")
TOOLS = ("python", "ffmpeg", "ffprobe", "prlimit")
LLM_NAME = re.compile(r"^POTONGIN_LLM(?:_|$)|_API_KEY$")
TRAVERSAL = ("..%2F..%2Fsecret-canary.txt", "%2e%2e", "..%2F", "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
             "%00", "x%00.json", "%2Fetc%2Fpasswd", "~root", "a" * 300, "%E2%80%AE")


def recorder(*, real: str, tool: str, log: str, interpreter: str) -> str:
    """A wrapper that appends ``{tool, argv, env}`` (its /proc/self/environ) to ``log``, then
    execs ``real`` with the same arguments."""
    return (f"#!{interpreter}\n"
            "import json, os, sys\n"
            "items = open('/proc/self/environ', 'rb').read().split(b'\\0')\n"
            "env = dict(i.decode('utf-8', 'replace').split('=', 1) for i in items if b'=' in i)\n"
            f"with open({log!r}, 'a', encoding='utf-8') as handle:\n"
            f"    handle.write(json.dumps({{'tool': {tool!r}, 'argv': sys.argv[1:4], 'env': env}}) + '\\n')\n"
            f"os.execv({real!r}, [{real!r}, *sys.argv[1:]])\n")


def write_recorders(directory: Path, *, log: str, python: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for tool in TOOLS:
        real = python if tool == "python" else shutil.which(tool)
        if real is None:
            continue
        target = directory / tool
        target.write_text(recorder(real=real, tool=tool, log=log, interpreter="/usr/bin/python3"))
        target.chmod(0o755)


def child_kind(record: dict) -> str:
    argv = record.get("argv") or []
    if record["tool"] == "python" and len(argv) >= 2 and argv[0] == "-m":
        return f"python -m {argv[1]}"
    return record["tool"]


def audit(records: list[dict], *, allowlist: tuple[str, ...], dashboard: list[str],
          llm: list[str]) -> dict:
    """E11 over the recorded children; values are never copied into the result."""
    by_kind: dict[str, int] = {}
    outside: list[dict] = []
    dashboard_hits = 0
    llm_outside_ai = 0
    ai_with_key = 0
    for record in records:
        kind = child_kind(record)
        by_kind[kind] = by_kind.get(kind, 0) + 1
        env = record["env"]
        ai_task = kind == "python -m ai_clipper.editor_ai" and any(LLM_NAME.search(name) for name in env)
        allowed = set(allowlist) if record["tool"] == "python" else set(FFMPEG_CHILD_ENV)
        for name in env:
            if name in allowed or (ai_task and LLM_NAME.search(name)):
                continue
            entry = {"kind": kind, "name": name}
            if entry not in outside:
                outside.append(entry)
        values = list(env.values())
        dashboard_hits += sum(1 for secret in dashboard for value in values if secret in value)
        holds_llm = any(secret in value for secret in llm for value in values)
        if holds_llm and not ai_task:
            llm_outside_ai += 1
        if holds_llm and ai_task:
            ai_with_key += 1
    required = ("python -m ai_clipper.edit_v2.api", "python -m ai_clipper.edit_v2.assets",
                "python -m ai_clipper.editor_ai", "python -m ai_clipper.edit_v2.cleanup",
                "python -m ai_clipper.edit_v2.coldopen", "python -m ai_clipper.render_queue",
                "ffmpeg", "ffprobe")
    preview = any(kind in by_kind for kind in ("python -m ai_clipper.edit_v2.preview_cli",
                                                "python -m ai_clipper.edit_v2.preview_server"))
    missing = [kind for kind in required if kind not in by_kind] + ([] if preview else ["preview"])
    return {"children": len(records), "byKind": dict(sorted(by_kind.items())),
            "namesOutsideAllowlist": outside, "dashboardSecretHits": dashboard_hits,
            "llmKeyOutsideAiTask": llm_outside_ai, "aiTaskChildrenWithKey": ai_with_key,
            "kindsMissing": missing,
            "pass": bool(records) and not outside and dashboard_hits == 0 and llm_outside_ai == 0
            and ai_with_key > 0 and not missing}


class Matrix:
    """Every check appends one row; a row passes when its status is expected and its extras hold."""

    def __init__(self, base: str, job: str, *, leaks: list[str]) -> None:
        self.base = base
        self.job = job
        self.leaks = leaks
        self.rows: list[dict] = []
        self.answers = 0
        self.leaky: list[str] = []
        self.server_errors: list[str] = []

    def send(self, method: str, path: str, *, headers: dict | None = None, body: bytes | None = None,
             label: str = "") -> tuple[int, dict, bytes]:
        status, answer, raw = fuzz._send(self.base, method, path, headers=headers, body=body)
        self.answers += 1
        text = raw.decode("utf-8", "replace")
        for needle in self.leaks:
            if needle and needle in text:
                self.leaky.append(label or path)
        if status >= 500 and status != 503:
            self.server_errors.append(f"{label or path}: {status}")
        return status, answer, raw

    def check(self, case: str, expected: int | tuple[int, ...], status: int, answer: dict,
              raw: bytes, *, route_headers: bool = True, **extra) -> dict:
        allowed = expected if isinstance(expected, tuple) else (expected,)
        row = {"case": case, "expected": list(allowed), "status": status, "code": fuzz._code(raw)}
        if route_headers:
            extra.setdefault("nosniff", answer.get("x-content-type-options") == "nosniff")
            extra.setdefault("corp", answer.get("cross-origin-resource-policy") == "same-origin")
        row.update(extra)
        row["pass"] = status in allowed and all(value is True for key, value in extra.items()
                                                if isinstance(value, bool))
        self.rows.append(row)
        return row


def login(base: str, username: str, password: str) -> str:
    time.sleep(1.1)  # a session token is signed per second: one login per second, one token each
    return fuzz._login(base, username, password)


def cookie(token: str) -> dict:
    return {"Cookie": f"potongin_session={token}"}


def same_origin(base: str, token: str, **extra) -> dict:
    return {"Origin": base, "Sec-Fetch-Site": "same-origin", **cookie(token), **extra}


def wait_openable(m: Matrix, token: str, deadline_s: float = 600) -> dict:
    path = f"/api/jobs/{m.job}/clips"
    status, _answer, raw = m.send("GET", path, headers=cookie(token))
    clips = json.loads(raw).get("clips", []) if status == 200 else []
    if clips and all(clip.get("openable") for clip in clips):
        return clips[0]
    m.send("POST", path, headers=same_origin(m.base, token, **{"Content-Type": "application/json"}), body=b"{}")
    started = time.monotonic()
    while time.monotonic() - started < deadline_s:
        time.sleep(2)
        status, _answer, raw = m.send("GET", path, headers=cookie(token))
        clips = json.loads(raw).get("clips", []) if status == 200 else []
        ready = [clip for clip in clips if clip.get("openable") and clip.get("clipId")]
        if ready:
            return ready[0]
    raise SystemExit("no clip became openable")


def run(args: argparse.Namespace) -> dict:
    planted = json.loads(os.environ.get("QG_PLANTED", "{}"))
    username, password = os.environ["APP_USERNAME"], os.environ["APP_PASSWORD"]
    jobs_root = str(Path(args.jobs_root).resolve())
    canary = Path(args.canary).read_text().strip()
    m = Matrix(args.base, args.job, leaks=[jobs_root, os.path.realpath(jobs_root), canary,
                                           "Traceback (most recent call last)", "/proc/self/"])
    base, job = args.base, args.job
    token = login(base, username, password)
    clip = wait_openable(m, token)
    clip_id = clip["clipId"]
    status, _a, raw = m.send("GET", f"/api/jobs/{job}/clips/{clip_id}/edit", headers=cookie(token))
    edit = json.loads(raw)
    doc = edit["doc"]
    doc_bytes = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    task = str(uuid.uuid4())
    sha = "ab" * 32
    clip_root = f"/api/jobs/{job}/clips/{clip_id}"
    json_type = {"Content-Type": "application/json"}

    # Every route: (name, method, path template, mutation, body factory, extra headers).
    routes = [
        ("GET clips", "GET", "/api/jobs/{id}/clips", False, None, {}),
        ("POST clips", "POST", "/api/jobs/{id}/clips", True, lambda: b"{}", json_type),
        ("GET edit", "GET", "/api/jobs/{id}/clips/{clipId}/edit", False, None, {}),
        ("PUT edit", "PUT", "/api/jobs/{id}/clips/{clipId}/edit", True, lambda: doc_bytes,
         {**json_type, "If-Match": f'"{edit["etag"]}"', "Idempotency-Key": str(uuid.uuid4())}),
        ("GET words", "GET", "/api/jobs/{id}/clips/{clipId}/words", False, None, {}),
        ("POST prepare", "POST", "/api/jobs/{id}/clips/{clipId}/prepare", True, lambda: b"{}", json_type),
        ("POST plan", "POST", "/api/jobs/{id}/clips/{clipId}/preview/plan", True,
         lambda: b'{"doc":' + doc_bytes + b"}", json_type),
        ("POST frame", "POST", "/api/jobs/{id}/clips/{clipId}/preview/frame", True,
         lambda: b'{"doc":' + doc_bytes + b',"f":0}', json_type),
        ("GET media", "GET", "/api/jobs/{id}/clips/{clipId}/media/{kind}/{name}", False, None, {}),
        ("GET renders", "GET", "/api/jobs/{id}/clips/{clipId}/renders", False, None, {}),
        ("POST renders", "POST", "/api/jobs/{id}/clips/{clipId}/renders", True,
         lambda: json.dumps({"editEtag": edit["etag"]}).encode(), {**json_type, "Idempotency-Key": str(uuid.uuid4())}),
        ("POST ai", "POST", "/api/jobs/{id}/clips/{clipId}/ai", True,
         lambda: b'{"task":"hooks","doc":' + doc_bytes + b"}", json_type),
        ("GET ai task", "GET", "/api/jobs/{id}/clips/{clipId}/ai/{taskId}", False, None, {}),
        ("GET cleanup", "GET", "/api/jobs/{id}/clips/{clipId}/cleanup", False, None, {}),
        ("GET coldopen", "GET", "/api/jobs/{id}/clips/{clipId}/coldopen-suggestions", False, None, {}),
        ("POST assets", "POST", "/api/jobs/{id}/assets", True, lambda: b"\x89PNG\r\n\x1a\n",
         {"Content-Type": "image/png", "X-Asset-Kind": "logo", "Idempotency-Key": str(uuid.uuid4())}),
        ("GET asset", "GET", "/api/jobs/{id}/assets/{sha}", False, None, {}),
    ]
    values = {"id": job, "clipId": clip_id, "taskId": task, "sha": sha, "kind": "plates",
              "name": "0123456789abcdef-c0000000.mp4"}

    def fill(template: str, **changes) -> str:
        merged = {**values, **changes}
        return re.sub(r"\{(\w+)\}", lambda match: merged[match.group(1)], template)

    # The session.
    for name, method, template, mutation, body, extra in routes:
        head = {**extra, **({"Origin": base, "Sec-Fetch-Site": "same-origin"} if mutation else {})}
        payload = body() if body else None
        for label, session in (("no cookie", {}), ("forged cookie", {"Cookie": "potongin_session=e30.forged"})):
            status, answer, raw = m.send(method, fill(template), headers={**head, **session}, body=payload,
                                         label=f"{name} {label}")
            # web/proxy.js answers first for every route but the upload (excluded from its matcher)
            m.check(f"{name}: {label}", 401, status, answer, raw, route_headers=name == "POST assets")

    # The origin of every mutation.
    for name, method, template, mutation, body, extra in routes:
        if not mutation:
            continue
        for label, origin in (("no Origin", {"Sec-Fetch-Site": "same-origin"}),
                              ("foreign Origin", {"Origin": "http://evil.example", "Sec-Fetch-Site": "cross-site"}),
                              ("cross-site fetch", {"Origin": base, "Sec-Fetch-Site": "cross-site"}),
                              ("same-site fetch", {"Origin": base, "Sec-Fetch-Site": "same-site"})):
            status, answer, raw = m.send(method, fill(template), headers={**extra, **cookie(token), **origin},
                                         body=body(), label=f"{name} {label}")
            m.check(f"{name}: {label}", 403, status, answer, raw)

    # Ids, shas, kinds and names: traversal and malformed values in every dynamic segment.
    for name, method, template, mutation, body, extra in routes:
        head = {**extra, **(same_origin(base, token) if mutation else cookie(token))}
        for segment in re.findall(r"\{(\w+)\}", template):
            bad_values = [*TRAVERSAL, values[segment].upper()] if segment != "kind" else [*TRAVERSAL, "PLATES", "frames"]
            for value in bad_values:
                if value == values[segment]:
                    continue
                path = fill(template, **{segment: value})
                status, answer, raw = m.send(method, path, headers=head, body=body() if body else None,
                                             label=f"{name} {segment}")
                # 400 from the guard; 404 from the media handler (kind, name) or from the router when
                # an encoded value no longer matches the route; the header set is checked elsewhere
                expected = (404,) if segment in ("kind", "name") else (400, 404)
                m.check(f"{name}: {segment}={value[:24]}", expected, status, answer, raw, route_headers=False)
        # raw dot segments: the router normalises them away from the route, never into a file
        dotted = fill(template).replace(f"/{clip_id}/", f"/{clip_id}/../../../../secret-canary.txt/")
        if dotted != fill(template):
            status, answer, raw = m.send(method, dotted, headers=head, body=body() if body else None,
                                         label=f"{name} dot segments")
            m.check(f"{name}: dot segments", (307, 308, 400, 401, 404, 405), status, answer, raw,
                    route_headers=False)

    # Body caps: one byte over.
    caps = {"POST clips": 1024, "PUT edit": 1 << 20, "POST prepare": 1024, "POST plan": (1 << 20) + 4096,
            "POST frame": (1 << 20) + 4096, "POST renders": 1024, "POST ai": (1 << 20) + 4096,
            "POST assets": 10 * 1024 * 1024}
    for name, method, template, _mutation, body, extra in routes:
        if name not in caps:
            continue
        payload = body() + b" " * (caps[name] + 1 - len(body()))
        head = {**same_origin(base, token), **extra}
        if name in ("PUT edit", "POST renders", "POST assets"):
            head["Idempotency-Key"] = str(uuid.uuid4())
        status, answer, raw = m.send(method, fill(template), headers=head, body=payload, label=f"{name} cap")
        m.check(f"{name}: one byte over {caps[name]} bytes", 413, status, answer, raw)

    # The AI body: {task, doc} and nothing else.
    for field in ("provider", "model", "baseUrl", "url", "apiKey", "endpoint", "headers", "system", "messages"):
        payload = b'{"task":"hooks","doc":' + doc_bytes + b',"' + field.encode() + b'":"http://127.0.0.1:9/v1"}'
        status, answer, raw = m.send("POST", f"{clip_root}/ai", headers={**same_origin(base, token), **json_type},
                                     body=payload, label=f"ai {field}")
        m.check(f"POST ai: extra field {field}", 400, status, answer, raw)

    # The header set on answers that succeed, and the asset and editor page headers.
    for name, path in (("GET clips", f"/api/jobs/{job}/clips"), ("GET edit", f"{clip_root}/edit"),
                       ("GET words", f"{clip_root}/words"), ("GET cleanup", f"{clip_root}/cleanup"),
                       ("GET coldopen", f"{clip_root}/coldopen-suggestions"), ("GET renders", f"{clip_root}/renders")):
        status, answer, raw = m.send("GET", path, headers=cookie(token), label=name)
        m.check(f"{name}: 200 with the header set", 200, status, answer, raw)
    png = fuzz._png([(b"IHDR", fuzz._ihdr(2, 2)), (b"IDAT", zlib.compress(bytes(18))), (b"IEND", b"")])
    status, answer, raw = m.send("POST", f"/api/jobs/{job}/assets", headers={
        **same_origin(base, token), "Content-Type": "image/png", "X-Asset-Kind": "logo",
        "Idempotency-Key": str(uuid.uuid4())}, body=png, label="upload logo")
    m.check("POST assets: a valid logo", 201, status, answer, raw)
    stored = json.loads(raw).get("sha256", sha) if status == 201 else sha
    status, answer, raw = m.send("GET", f"/api/jobs/{job}/assets/{stored}", headers=cookie(token), label="GET asset")
    m.check("GET asset: the §9.2 headers", 200, status, answer, raw,
            csp=answer.get("content-security-policy") == "default-src 'none'; sandbox",
            disposition=answer.get("content-disposition") == 'inline; filename="asset.png"')
    status, answer, raw = m.send("POST", f"{clip_root}/renders", headers={
        **same_origin(base, token), **json_type, "Idempotency-Key": str(uuid.uuid4())},
        body=json.dumps({"editEtag": edit["etag"]}).encode(), label="export")
    m.check("POST renders: an export request", (200, 202), status, answer, raw)
    status, answer, raw = m.send("POST", f"{clip_root}/prepare", headers={**same_origin(base, token), **json_type},
                                 body=b"{}", label="prepare")
    m.check("POST prepare: 202", 202, status, answer, raw)
    status, answer, raw = m.send("POST", f"{clip_root}/preview/plan", headers={**same_origin(base, token), **json_type},
                                 body=b'{"doc":' + doc_bytes + b"}", label="plan")
    m.check("POST plan: 200", 200, status, answer, raw)
    plan = json.loads(raw) if status == 200 else {}
    served = None
    started = time.monotonic()
    while served is None and time.monotonic() - started < 180:
        for cell in (plan.get("plate") or {}).get("cells", []):
            if cell.get("state") == "ready" and cell.get("url"):
                served = cell["url"]
                break
        if served is None:
            time.sleep(2)
            _s, _a, raw = m.send("POST", f"{clip_root}/preview/plan", headers={**same_origin(base, token), **json_type},
                                 body=b'{"doc":' + doc_bytes + b"}", label="plan poll")
            plan = json.loads(raw) if _s == 200 else plan
    if served:
        status, answer, raw = m.send("GET", served, headers=cookie(token), label="GET media")
        m.check("GET media: a plate cell", 200, status, answer, raw,
                immutable=answer.get("cache-control") == "private, max-age=31536000, immutable")
    else:
        m.check("GET media: a plate cell", 200, 0, {}, b"")
    ass = (plan.get("text") or {}).get("url")
    if ass:
        status, answer, raw = m.send("GET", ass, headers=cookie(token), label="GET ass")
        m.check("GET media: the ASS in a CSP sandbox", 200, status, answer, raw,
                sandbox=answer.get("content-security-policy") == "sandbox",
                plain=answer.get("content-type", "").startswith("text/plain"))
    for page in (f"/projects/{job}/clips/{clip_id}/edit", f"/projects/{job}/clips/klip-1/edit"):
        status, answer, raw = m.send("GET", page, headers=cookie(token), label="editor page")
        m.check(f"editor page {page.rsplit('/', 2)[-2]}: isolation and framing headers", 200, status, answer, raw,
                route_headers=False,
                coop=answer.get("cross-origin-opener-policy") == "same-origin",
                coep=answer.get("cross-origin-embedder-policy") == "require-corp",
                nosniff=answer.get("x-content-type-options") == "nosniff",
                frame_ancestors="frame-ancestors 'none'" in answer.get("content-security-policy", ""),
                xfo=answer.get("x-frame-options") == "DENY")

    # Rate limits, each on a session of its own.
    def burst(case: str, count: int, send) -> None:
        """`count` requests at once on a new session; one of them must be a 429."""
        session = login(base, username, password)
        with ThreadPoolExecutor(max_workers=min(count, 32)) as pool:
            answers = list(pool.map(lambda _i: send(session), range(count)))
        refused = next((item for item in answers if item[0] == 429), None)
        if refused is None:
            m.check(case, 429, 0, {}, b"")
            return
        status, answer, raw = refused
        m.check(case, 429, status, answer, raw, retryAfter=bool(re.fullmatch(r"[1-9][0-9]*", answer.get("retry-after", ""))))

    plan_body = b'{"doc":' + doc_bytes + b"}"
    burst("POST plan: 429 after 10 in a second", 24, lambda s: m.send(
        "POST", f"{clip_root}/preview/plan", headers={**same_origin(base, s), **json_type}, body=plan_body, label="plan burst"))
    frame_body = b'{"doc":' + doc_bytes + b',"f":0}'
    burst("POST frame: 429 after 4 in a second", 12, lambda s: m.send(
        "POST", f"{clip_root}/preview/frame", headers={**same_origin(base, s), **json_type}, body=frame_body, label="frame burst"))
    burst("GET renders: 429 after the api burst (60, 20/s)", 120, lambda s: m.send(
        "GET", f"{clip_root}/renders", headers=cookie(s), label="api burst"))
    burst("POST assets: 429 after 30 uploads in a minute", 40, lambda s: m.send(
        "POST", f"/api/jobs/{job}/assets", headers={**same_origin(base, s), "Content-Type": "image/png",
                                                    "X-Asset-Kind": "video", "Idempotency-Key": str(uuid.uuid4())},
        body=b"x", label="upload burst"))
    session = login(base, username, password)
    quota = None
    for _ in range(40):
        status, answer, raw = m.send("POST", f"{clip_root}/ai", headers={**same_origin(base, session), **json_type},
                                     body=b'{"task":"hooks","doc":' + doc_bytes + b"}", label="ai quota")
        body = json.loads(raw) if status == 202 else {}
        if (body.get("llm") or {}).get("state") == "rate_limited":
            quota = (status, answer, raw, body)
            break
    if quota:
        status, answer, raw, body = quota
        m.check("POST ai: the LLM quota answers 202 with Retry-After", 202, status, answer, raw,
                retryAfter=answer.get("retry-after") == str(-(-body["llm"]["retryAfterMs"] // 1000)))
    else:
        m.check("POST ai: the LLM quota answers 202 with Retry-After", 202, 0, {}, b"")

    time.sleep(3)  # the last AI task children start after their 202
    records = fuzz.read_environ_log(Path(args.environ_log))
    environ = audit(records, allowlist=fuzz.child_env_allowlist(), dashboard=planted.get("dashboard", []),
                    llm=planted.get("llm", []))
    failures = [row for row in m.rows if not row["pass"]]
    return {
        "schema": SCHEMA, "gate": "QG-SEC (every editor route over HTTP, E11 child environment)",
        "task": "T4.2", "stack": args.stack, "checks": len(m.rows), "failures": failures,
        "answers": m.answers, "answersWithLeak": sorted(set(m.leaky)), "serverErrors": m.server_errors,
        "environ": environ, "matrix": m.rows,
        "pass": not failures and not m.leaky and not m.server_errors and environ["pass"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    rec = sub.add_parser("recorders")
    rec.add_argument("directory", type=Path)
    rec.add_argument("--log", required=True)
    rec.add_argument("--python", required=True)
    mat = sub.add_parser("matrix")
    mat.add_argument("evidence", type=Path)
    mat.add_argument("--base", required=True)
    mat.add_argument("--job", required=True)
    mat.add_argument("--jobs-root", required=True)
    mat.add_argument("--environ-log", required=True)
    mat.add_argument("--canary", required=True)
    mat.add_argument("--stack", default="")
    args = parser.parse_args(argv)
    if args.command == "recorders":
        write_recorders(args.directory, log=args.log, python=args.python)
        return 0
    report = run(args)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")
    print(f"QG-SEC routes: {report['checks']} checks, {len(report['failures'])} failed; "
          f"{report['environ']['children']} children {report['environ']['byKind']}; "
          f"outside allowlist {report['environ']['namesOutsideAllowlist']}; "
          f"dashboard hits {report['environ']['dashboardSecretHits']}; "
          f"LLM key outside the AI task {report['environ']['llmKeyOutsideAiTask']}; "
          f"missing {report['environ']['kindsMissing']}; pass {report['pass']}")
    for row in report["failures"][:40]:
        print("FAIL", json.dumps(row, ensure_ascii=False))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
