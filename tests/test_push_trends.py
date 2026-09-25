"""Tests for scripts/trends/push_trends.py, the stdlib client of POST /api/ingest/trends.

A local ThreadingHTTPServer plays the Potongin ingest route. Nothing here touches the network
beyond 127.0.0.1, and every test checks, directly or through ``run``, that the token never
reaches stdout or stderr.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "trends" / "push_trends.py"
PROD_URL = "https://potongin.revdonz.dev/api/ingest/trends"
TOKEN = "ptk_" + ("SECRETtoken0123456789-_" * 2)[:43]
CF_SECRET = "cf-access-secret-DO-NOT-PRINT-0123456789"

Reply = tuple[int, dict[str, str], object]


def load_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("potongin_push_trends", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["potongin_push_trends"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def push() -> ModuleType:
    return load_module()


# --- Fake ingest server -------------------------------------------------------------------


def accept_all(request: dict[str, object]) -> Reply:
    items = request["json"]["items"]  # type: ignore[index]
    return 200, {}, {"accepted": len(items), "created": len(items), "updated": 0, "rejected": []}


@dataclass
class FakeIngest:
    url: str = ""
    replies: list[Reply | Callable[[dict[str, object]], Reply]] = field(default_factory=list)
    requests: list[dict[str, object]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def reply(self, *items: Reply | Callable[[dict[str, object]], Reply]) -> None:
        with self.lock:
            self.replies.extend(items)

    def posted_items(self) -> list[list[dict[str, object]]]:
        posts = [r for r in self.requests if r["method"] == "POST"]
        return [r["json"]["items"] for r in posts]  # type: ignore[index]


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def handle_error(self, request, client_address) -> None:
        return


@pytest.fixture
def ingest() -> Iterator[FakeIngest]:
    state = FakeIngest()

    class Handler(BaseHTTPRequestHandler):
        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length else b""
            record: dict[str, object] = {
                "method": self.command,
                "path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "raw": raw,
                "json": json.loads(raw) if raw else None,
            }
            with state.lock:
                state.requests.append(record)
                reply = state.replies.pop(0) if state.replies else accept_all
            if callable(reply):
                reply = reply(record)
            status, headers, body = reply
            payload = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)

        do_GET = _handle
        do_POST = _handle
        do_DELETE = _handle

        def log_message(self, format: str, *args: object) -> None:
            return

    httpd = _QuietServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{httpd.server_address[1]}/api/ingest/trends"
    thread = threading.Thread(
        target=httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    try:
        yield state
    finally:
        httpd.shutdown()
        httpd.server_close()


# --- Helpers ------------------------------------------------------------------------------


def item(n: int, **extra: object) -> dict[str, object]:
    base: dict[str, object] = {
        "externalId": f"test:topic:item-{n}",
        "kind": "topic",
        "title": f"Item {n}",
        "keywords": [f"kata kunci {n}"],
    }
    base.update(extra)
    return base


def write_items(tmp_path: Path, payload: object, name: str = "items.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


@dataclass
class Result:
    code: int
    out: str
    err: str
    sleeps: list[float]


def run(
    push: ModuleType,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    token: str | None = TOKEN,
) -> Result:
    environment = dict(env or {})
    if token is not None:
        environment["POTONGIN_INGEST_TOKEN"] = token
    stdout, stderr = io.StringIO(), io.StringIO()
    sleeps: list[float] = []
    code = push.main(args, env=environment, stdout=stdout, stderr=stderr, sleep=sleeps.append)
    result = Result(code, stdout.getvalue(), stderr.getvalue(), sleeps)
    assert_no_secret(result.out + result.err)
    return result


def assert_no_secret(text: str) -> None:
    assert TOKEN not in text
    assert TOKEN[4:] not in text
    assert TOKEN[4:16] not in text
    assert CF_SECRET not in text


# --- Constants and input ------------------------------------------------------------------


def test_defaults_match_the_ingest_contract(push: ModuleType) -> None:
    assert push.DEFAULT_URL == PROD_URL
    assert push.MAX_BATCH_ITEMS == 100
    assert push.MAX_BATCH_BYTES == 256 * 1024
    assert push.TOKEN_ENV == "POTONGIN_INGEST_TOKEN"


def test_posts_items_with_bearer_token_and_json_content_type(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, {"items": [item(1), item(2)]})

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    assert len(ingest.requests) == 1
    request = ingest.requests[0]
    assert request["method"] == "POST"
    assert request["path"] == "/api/ingest/trends"
    headers = request["headers"]
    assert headers["authorization"] == f"Bearer {TOKEN}"  # type: ignore[index]
    assert headers["content-type"].startswith("application/json")  # type: ignore[index]
    assert request["json"] == {"items": [item(1), item(2)]}


def test_accepts_a_bare_list_of_items(push: ModuleType, ingest: FakeIngest, tmp_path: Path) -> None:
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    assert ingest.posted_items() == [[item(1)]]


def test_reads_items_from_stdin_dash(push: ModuleType, ingest: FakeIngest, monkeypatch) -> None:
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps([item(7)]).encode())))

    result = run(push, ["--url", ingest.url, "-"])

    assert result.code == 0
    assert ingest.posted_items() == [[item(7)]]


def test_url_can_come_from_environment(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, [item(1)])

    result = run(push, [str(path)], env={"POTONGIN_INGEST_URL": ingest.url})

    assert result.code == 0
    assert len(ingest.requests) == 1


def test_splits_into_batches_of_100(push: ModuleType, ingest: FakeIngest, tmp_path: Path) -> None:
    items = [item(n) for n in range(1, 251)]
    path = write_items(tmp_path, {"items": items})

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    batches = ingest.posted_items()
    assert [len(batch) for batch in batches] == [100, 100, 50]
    assert [entry for batch in batches for entry in batch] == items
    assert "250" in result.out


def test_batch_size_option_is_capped_at_100(push: ModuleType, tmp_path: Path) -> None:
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--batch-size", "101", "--dry-run", str(path)], token=None)

    assert result.code == 2


def test_splits_batches_to_stay_under_256_kib(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    items = [item(n, summary="x" * 480, keywords=[f"kata kunci {n} " + "y" * 20] * 12)
             for n in range(1, 101)]
    items = [dict(entry, examples=[{"url": "https://example.com/" + "z" * 470, "note": "n" * 120}]
                  * 5) for entry in items]
    path = write_items(tmp_path, items)

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    batches = ingest.posted_items()
    assert len(batches) >= 2
    assert sum(len(batch) for batch in batches) == 100
    for request in ingest.requests:
        assert len(request["raw"]) <= 256 * 1024  # type: ignore[arg-type]


def test_strips_server_owned_fields(push: ModuleType, ingest: FakeIngest, tmp_path: Path) -> None:
    entry = item(1, id="0b6f2c1e", source="hermes", createdAt="x", updatedAt="y")
    path = write_items(tmp_path, [entry])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    assert ingest.posted_items() == [[item(1)]]


def test_non_object_items_are_rejected_locally(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, [item(1), "bukan objek", item(3)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 1
    assert ingest.posted_items() == [[item(1), item(3)]]
    assert "#2" in result.out
    assert "not_an_object" in result.out


def test_empty_input_sends_nothing(push: ModuleType, ingest: FakeIngest, tmp_path: Path) -> None:
    path = write_items(tmp_path, {"items": []})

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    assert ingest.requests == []


@pytest.mark.parametrize(
    "content",
    ["{not json", json.dumps({"no_items": []}), json.dumps({"items": "x"}), json.dumps(42)],
)
def test_invalid_input_file_exits_2_without_request(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path, content: str
) -> None:
    path = tmp_path / "items.json"
    path.write_text(content, encoding="utf-8")

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 2
    assert ingest.requests == []


def test_more_than_1000_items_is_refused(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, [item(n) for n in range(1001)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 2
    assert ingest.requests == []


# --- Token and URL safety -----------------------------------------------------------------


def test_missing_token_exits_2_without_request(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)], token=None)

    assert result.code == 2
    assert "POTONGIN_INGEST_TOKEN" in result.err
    assert ingest.requests == []


@pytest.mark.parametrize(
    "bad",
    ["not-a-token", "ptk_short", TOKEN + "\r\nX-Evil: 1", TOKEN + "x", "Bearer " + TOKEN],
)
def test_malformed_token_exits_2_and_is_not_echoed(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path, bad: str
) -> None:
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)], token=bad)

    assert result.code == 2
    assert ingest.requests == []
    assert bad not in result.out + result.err


@pytest.mark.parametrize(
    "url",
    [
        "http://potongin.revdonz.dev/api/ingest/trends",
        "ftp://potongin.revdonz.dev/api/ingest/trends",
        "https://user:pass@potongin.revdonz.dev/api/ingest/trends",
        "not a url",
    ],
)
def test_refuses_unsafe_urls(push: ModuleType, tmp_path: Path, url: str) -> None:
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", url, str(path)])

    assert result.code == 2


def test_does_not_follow_redirects(push: ModuleType, ingest: FakeIngest, tmp_path: Path) -> None:
    ingest.reply((307, {"Location": "/elsewhere"}, {}))
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 1
    assert len(ingest.requests) == 1
    assert "redirect" in (result.out + result.err).lower()


def test_sends_cloudflare_access_service_token_when_configured(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, [item(1)])
    env = {"CF_ACCESS_CLIENT_ID": "abc.access", "CF_ACCESS_CLIENT_SECRET": CF_SECRET}

    result = run(push, ["--url", ingest.url, str(path)], env=env)

    assert result.code == 0
    headers = ingest.requests[0]["headers"]
    assert headers["cf-access-client-id"] == "abc.access"  # type: ignore[index]
    assert headers["cf-access-client-secret"] == CF_SECRET  # type: ignore[index]


def test_no_cloudflare_headers_by_default(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, [item(1)])

    run(push, ["--url", ingest.url, str(path)])

    headers = ingest.requests[0]["headers"]
    assert "cf-access-client-id" not in headers  # type: ignore[operator]
    assert "cf-access-client-secret" not in headers  # type: ignore[operator]


# --- Per-item results ---------------------------------------------------------------------


def test_prints_per_item_results_with_input_positions(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply(
        accept_all,
        (200, {}, {"accepted": 49, "created": 40, "updated": 9,
                   "rejected": [{"index": 0, "code": "invalid_field", "field": "keywords"}]}),
    )
    path = write_items(tmp_path, [item(n) for n in range(1, 151)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 1
    lines = result.out.splitlines()
    rejected = [line for line in lines if "#101" in line]
    assert len(rejected) == 1
    assert "DITOLAK" in rejected[0]
    assert "invalid_field" in rejected[0]
    assert "keywords" in rejected[0]
    assert "Item 101" in rejected[0]
    accepted = [line for line in lines if "#100 " in line]
    assert len(accepted) == 1 and "diterima" in accepted[0]
    summary = lines[-1]
    assert "149 diterima" in summary
    assert "1 ditolak" in summary


def test_json_output_is_machine_readable(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply(
        (200, {}, {"accepted": 1, "created": 0, "updated": 1,
                   "rejected": [{"index": 1, "code": "invalid_field", "field": "hashtags"}]}),
    )
    path = write_items(tmp_path, [item(1), item(2)])

    result = run(push, ["--json", "--url", ingest.url, str(path)])

    assert result.code == 1
    report = json.loads(result.out)
    assert report["total"] == 2
    assert report["accepted"] == 1
    assert report["updated"] == 1
    assert report["rejected"] == 1
    assert report["failed"] == 0
    assert report["items"][0] == {
        "index": 1, "status": "accepted", "code": None, "field": None,
        "externalId": "test:topic:item-1", "title": "Item 1",
    }
    assert report["items"][1]["status"] == "rejected"
    assert report["items"][1]["field"] == "hashtags"


def test_untrusted_titles_are_printed_without_control_characters(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    title = "Judul \x1b[31mmerah\x1b[0m \u202eterbalik\u202c\u200b"
    path = write_items(tmp_path, [item(1, title=title)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    for char in ("\x1b", "\u202e", "\u202c", "\u200b"):
        assert char not in result.out
        assert char not in result.err
    assert "merah" in result.out


def test_rejected_codes_from_server_are_sanitized(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply(
        (200, {}, {"accepted": 0, "created": 0, "updated": 0,
                   "rejected": [{"index": 0, "code": "bad\x1b]0;x\x07", "field": "t\x1bitle"}]}),
    )
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 1
    assert "\x1b" not in result.out and "\x07" not in result.out


# --- Retry and failure handling -----------------------------------------------------------


def test_retries_429_honouring_retry_after_seconds(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply((429, {"Retry-After": "7"}, {"error": "Terlalu cepat", "code": "rate_limited"}))
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    assert len(ingest.requests) == 2
    assert result.sleeps == [7.0]


def test_retry_after_http_date_is_honoured(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply((429, {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"}, {"code": "rate_limited"}))
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    assert len(ingest.requests) == 2
    assert result.sleeps == [0.0]


def test_retry_after_longer_than_max_wait_gives_up(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply((429, {"Retry-After": "3600"}, {"code": "rate_limited"}))
    path = write_items(tmp_path, [item(n) for n in range(1, 151)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 1
    assert len(ingest.requests) == 1
    assert all(delay < 3600 for delay in result.sleeps)
    assert "rate_limited" in result.out


def test_retries_5xx_with_exponential_backoff(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply((503, {}, {"code": "storage_unavailable"}), (502, {}, b"<html>bad gateway</html>"))
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    assert len(ingest.requests) == 3
    assert len(result.sleeps) == 2
    assert result.sleeps[0] >= 1.0
    assert result.sleeps[1] >= 2 * push.BACKOFF_BASE_SECONDS


def test_gives_up_after_max_retries(push: ModuleType, ingest: FakeIngest, tmp_path: Path) -> None:
    ingest.reply(*[(503, {}, {"code": "storage_unavailable"})] * 10)
    path = write_items(tmp_path, [item(1), item(2)])

    result = run(push, ["--max-retries", "2", "--url", ingest.url, str(path)])

    assert result.code == 1
    assert len(ingest.requests) == 3
    assert len(result.sleeps) == 2
    assert "storage_unavailable" in result.out
    assert "GAGAL" in result.out


def test_retries_network_errors(push: ModuleType, tmp_path: Path) -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--max-retries", "1", "--url",
                        f"http://127.0.0.1:{port}/api/ingest/trends", str(path)])

    assert result.code == 1
    assert len(result.sleeps) == 1
    assert "network_error" in result.out


@pytest.mark.parametrize(
    ("status", "code"),
    [(401, "invalid_token"), (401, "revoked_token"), (403, "insufficient_scope")],
)
def test_auth_errors_stop_immediately_with_exit_3(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path, status: int, code: str
) -> None:
    ingest.reply((status, {}, {"error": "Token tidak valid", "code": code}))
    path = write_items(tmp_path, [item(n) for n in range(1, 151)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 3
    assert len(ingest.requests) == 1
    assert result.sleeps == []
    assert code in result.out + result.err


def test_client_errors_are_not_retried(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply((400, {}, {"error": "Body tidak valid", "code": "invalid_body"}))
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 1
    assert len(ingest.requests) == 1
    assert result.sleeps == []
    assert "invalid_body" in result.out


def test_413_splits_the_batch_and_resends(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply((413, {}, {"code": "too_many_items"}))
    items = [item(n) for n in range(1, 11)]
    path = write_items(tmp_path, items)

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 0
    batches = ingest.posted_items()
    assert [len(batch) for batch in batches] == [10, 5, 5]
    assert batches[1] + batches[2] == items


def test_invalid_success_body_is_a_failure(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    ingest.reply((200, {}, b"<html>login</html>"))
    path = write_items(tmp_path, [item(1)])

    result = run(push, ["--url", ingest.url, str(path)])

    assert result.code == 1
    assert "invalid_response" in result.out


# --- Other modes --------------------------------------------------------------------------


def test_dry_run_sends_nothing_and_needs_no_token(
    push: ModuleType, ingest: FakeIngest, tmp_path: Path
) -> None:
    path = write_items(tmp_path, [item(n) for n in range(1, 151)])

    result = run(push, ["--dry-run", "--url", ingest.url, str(path)], token=None)

    assert result.code == 0
    assert ingest.requests == []
    assert "2 batch" in result.out


def test_list_mode_gets_active_items(push: ModuleType, ingest: FakeIngest) -> None:
    listing = {"items": [{"id": "1", "externalId": "x:y", "kind": "topic", "title": "A\x1b[2J",
                          "expiresAt": "2026-10-01T00:00:00Z",
                          "updatedAt": "2026-09-25T00:00:00Z"}]}
    ingest.reply((200, {}, listing))

    result = run(push, ["--list", "--url", ingest.url])

    assert result.code == 0
    assert ingest.requests[0]["method"] == "GET"
    headers = ingest.requests[0]["headers"]
    assert headers["authorization"] == f"Bearer {TOKEN}"  # type: ignore[index]
    assert json.loads(result.out) == listing
    assert "\x1b" not in result.out


def test_list_mode_reports_auth_failure(push: ModuleType, ingest: FakeIngest) -> None:
    ingest.reply((401, {}, {"code": "invalid_token"}))

    result = run(push, ["--list", "--url", ingest.url])

    assert result.code == 3
    assert "invalid_token" in result.err


def test_cli_end_to_end_never_prints_the_token(ingest: FakeIngest, tmp_path: Path) -> None:
    ingest.reply(accept_all, (401, {}, {"code": "revoked_token"}))
    path = write_items(tmp_path, [item(n) for n in range(1, 151)])
    env = dict(os.environ, POTONGIN_INGEST_TOKEN=TOKEN, CF_ACCESS_CLIENT_ID="id.access",
               CF_ACCESS_CLIENT_SECRET=CF_SECRET)

    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--url", ingest.url, str(path)],
        env=env, capture_output=True, text=True, timeout=60, check=False,
    )

    assert completed.returncode == 3
    assert_no_secret(completed.stdout + completed.stderr)
    assert "revoked_token" in completed.stdout + completed.stderr


def test_cli_help_works_without_token() -> None:
    env = {key: value for key, value in os.environ.items() if key != "POTONGIN_INGEST_TOKEN"}

    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        env=env, capture_output=True, text=True, timeout=60, check=False,
    )

    assert completed.returncode == 0
    assert "POTONGIN_INGEST_TOKEN" in completed.stdout
    assert PROD_URL in completed.stdout
