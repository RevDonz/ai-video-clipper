#!/usr/bin/env python3
"""Kirim item Konteks Tren ke Potongin (POST /api/ingest/trends).

Send trend items from a JSON file to Potongin's token-authenticated ingest endpoint.
Python 3.11+, standard library only, so an agent (Hermes or any other) can run it anywhere.

- Input: a JSON file (or ``-`` for stdin) holding either ``{"items": [...]}`` or ``[...]``.
- Token: environment variable ``POTONGIN_INGEST_TOKEN`` (``ptk_...``). It is sent only in the
  ``Authorization`` header and is never printed, logged or written anywhere.
- Items are sent in batches of at most 100 items and 256 KiB. A 413 splits the batch in two.
- 429 and 5xx responses and network errors are retried with exponential backoff, honouring
  ``Retry-After``. Retrying is safe because the endpoint upserts (``externalId``, or kind and
  normalised title). Other 4xx responses are not retried. Redirects are never followed, so the
  token cannot be forwarded to another address.
- ``--list`` prints the active items (GET) for deduplication; ``--dry-run`` checks the file
  without sending anything and without a token.

Exit codes: 0 every item accepted, 1 some items rejected or not sent, 2 usage or input error,
3 token refused (401/403).
"""

from __future__ import annotations

import argparse
import email.utils
import http.client
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, NoReturn, TextIO

DEFAULT_URL = "https://potongin.revdonz.dev/api/ingest/trends"
TOKEN_ENV = "POTONGIN_INGEST_TOKEN"
URL_ENV = "POTONGIN_INGEST_URL"
CF_ID_ENV = "CF_ACCESS_CLIENT_ID"
CF_SECRET_ENV = "CF_ACCESS_CLIENT_SECRET"

MAX_BATCH_ITEMS = 100
MAX_BATCH_BYTES = 256 * 1024
MAX_ITEMS = 1000
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
BACKOFF_BASE_SECONDS = 2.0
BACKOFF_MAX_SECONDS = 60.0
BACKOFF_JITTER_SECONDS = 0.5
DEFAULT_MAX_RETRIES = 4
DEFAULT_MAX_WAIT_SECONDS = 120.0
DEFAULT_TIMEOUT_SECONDS = 30.0

SERVER_FIELDS = ("id", "source", "createdAt", "updatedAt")
TOKEN_PATTERN = re.compile(r"ptk_[A-Za-z0-9_-]{43}")
HEADER_VALUE_PATTERN = re.compile(r"[\x21-\x7e]{1,512}")
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
USER_AGENT = "potongin-push-trends/1"
ENVELOPE_PREFIX = b'{"items":['
ENVELOPE_SUFFIX = b"]}"
ENVELOPE_BYTES = len(ENVELOPE_PREFIX) + len(ENVELOPE_SUFFIX)
# Control, format (bidi, zero-width), surrogate, private-use and unassigned code points.
UNSAFE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})

EXIT_OK = 0
EXIT_PARTIAL = 1
EXIT_USAGE = 2
EXIT_AUTH = 3

HINTS = {
    "missing_token": "Token tidak dikirim. Isi POTONGIN_INGEST_TOKEN.",
    "invalid_token": (
        "Token ditolak. Buat token baru di halaman Konteks Tren (/trends), lalu perbarui "
        "POTONGIN_INGEST_TOKEN."
    ),
    "revoked_token": (
        "Token sudah dicabut. Buat token baru di halaman Konteks Tren (/trends), lalu perbarui "
        "POTONGIN_INGEST_TOKEN."
    ),
    "insufficient_scope": "Token tidak punya izin trends:write. Buat token ingest baru.",
    "redirect_refused": (
        "Server mengalihkan permintaan (redirect) dan skrip ini tidak mengikutinya. Periksa --url. "
        "Bila domain dilindungi Cloudflare Access, isi CF_ACCESS_CLIENT_ID dan "
        "CF_ACCESS_CLIENT_SECRET (service token) atau buat kebijakan Bypass untuk "
        "/api/ingest/*."
    ),
    "rate_limited": (
        "Batas laju tercapai (60 permintaan/menit dan 600/jam per token). Coba lagi nanti."
    ),
    "invalid_response": (
        "Respons server bukan hasil ingest (mungkin halaman login atau proxy). Periksa --url."
    ),
    "network_error": "Server tidak terjangkau. Periksa koneksi dan --url.",
    "storage_unavailable": "Penyimpanan Potongin sedang tidak bisa ditulis. Coba lagi nanti.",
    "too_many_items": "Server menolak jumlah item per permintaan. Kecilkan --batch-size.",
    "body_too_large": "Item terlalu besar (maks 256 KiB per permintaan). Ringkas isinya.",
}


class UsageError(Exception):
    """Bad arguments, environment or input file. Messages never contain secrets."""


class NetworkError(Exception):
    """The request did not produce an HTTP response."""


# --- Text helpers ---------------------------------------------------------------------------


def display_text(value: object, limit: int) -> str:
    """Untrusted text made safe for a terminal: no control, bidi or zero-width characters."""
    if not isinstance(value, str):
        return ""
    chars: list[str] = []
    for char in unicodedata.normalize("NFC", value):
        category = unicodedata.category(char)
        if char in "\t\n\r" or category in ("Zs", "Zl", "Zp"):
            chars.append(" ")
        elif category not in UNSAFE_CATEGORIES:
            chars.append(char)
    text = " ".join("".join(chars).split())
    if len(text) > limit:
        text = text[: max(limit - 3, 1)] + "..."
    return text


def safe_code(value: object) -> str | None:
    """A server error code reduced to ``[a-z0-9_]``, capped at 40 characters."""
    if not isinstance(value, str):
        return None
    code = re.sub(r"[^a-z0-9_]", "", value.lower())[:40]
    return code or None


def safe_field(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    field = re.sub(r"[^A-Za-z0-9_.\[\]-]", "", value)[:60]
    return field or None


# --- Input ----------------------------------------------------------------------------------


def _reject_constant(name: str) -> NoReturn:
    raise ValueError(f"nilai {name} bukan JSON yang valid")


def load_items(source: str) -> list[Any]:
    try:
        if source == "-":
            stream = getattr(sys.stdin, "buffer", None)
            if stream is not None:
                raw = stream.read(MAX_INPUT_BYTES + 1)
            else:
                raw = sys.stdin.read(MAX_INPUT_BYTES + 1).encode("utf-8")
        else:
            with open(source, "rb") as handle:
                raw = handle.read(MAX_INPUT_BYTES + 1)
    except OSError as error:
        raise UsageError(f"File item tidak bisa dibaca: {error.strerror or 'error'}.") from None
    if len(raw) > MAX_INPUT_BYTES:
        raise UsageError(f"File item lebih dari {MAX_INPUT_BYTES // (1024 * 1024)} MiB.")
    try:
        data = json.loads(raw.decode("utf-8-sig"), parse_constant=_reject_constant)
    except UnicodeDecodeError:
        raise UsageError("File item harus UTF-8.") from None
    except json.JSONDecodeError as error:
        raise UsageError(
            f"File item bukan JSON yang valid (baris {error.lineno}, kolom {error.colno})."
        ) from None
    except ValueError as error:
        raise UsageError(f"File item tidak valid: {error}.") from None
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict) and isinstance(data.get("items"), list):
        items = data["items"]
    else:
        raise UsageError('File harus berisi array item atau objek {"items": [...]}.')
    if len(items) > MAX_ITEMS:
        raise UsageError(
            f"{len(items)} item terlalu banyak; maksimal {MAX_ITEMS} per jalankan "
            "(Potongin menyimpan maksimal 1.000 item aktif)."
        )
    return items


@dataclass
class Entry:
    position: int
    kind: str
    title: str
    external_id: str | None
    encoded: bytes = b""
    status: str = "pending"
    code: str | None = None
    field: str | None = None

    def settle(self, status: str, code: str | None = None, field: str | None = None) -> None:
        self.status, self.code, self.field = status, code, field


def build_entries(items: Sequence[Any]) -> list[Entry]:
    entries: list[Entry] = []
    for position, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            entry = Entry(position, "", "", None)
            entry.settle("rejected", "not_an_object")
            entries.append(entry)
            continue
        entry = Entry(
            position,
            display_text(raw.get("kind"), 10),
            display_text(raw.get("title"), 60),
            display_text(raw.get("externalId"), 120) or None,
        )
        payload = {key: value for key, value in raw.items() if key not in SERVER_FIELDS}
        entry.encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        if len(entry.encoded) + ENVELOPE_BYTES > MAX_BATCH_BYTES:
            entry.settle("rejected", "item_too_large")
        entries.append(entry)
    return entries


def plan_batches(entries: Sequence[Entry], batch_size: int) -> list[list[Entry]]:
    batches: list[list[Entry]] = []
    current: list[Entry] = []
    size = ENVELOPE_BYTES
    for entry in entries:
        if entry.status != "pending":
            continue
        extra = len(entry.encoded) + (1 if current else 0)
        if current and (len(current) >= batch_size or size + extra > MAX_BATCH_BYTES):
            batches.append(current)
            current, size = [], ENVELOPE_BYTES
            extra = len(entry.encoded)
        current.append(entry)
        size += extra
    if current:
        batches.append(current)
    return batches


def encode_batch(batch: Sequence[Entry]) -> bytes:
    return ENVELOPE_PREFIX + b",".join(entry.encoded for entry in batch) + ENVELOPE_SUFFIX


# --- HTTP -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Response:
    status: int
    headers: Any
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None

    def error_code(self) -> str:
        data = self.json()
        code = safe_code(data.get("code")) if isinstance(data, dict) else None
        if code:
            return code
        if 300 <= self.status < 400:
            return "redirect_refused"
        return f"http_{self.status}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: urllib would copy the Authorization header to the new URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_bounded(stream: Any) -> bytes:
    body = stream.read(MAX_RESPONSE_BYTES + 1)
    return body[:MAX_RESPONSE_BYTES] if isinstance(body, bytes) else b""


def validate_url(url: str) -> str:
    url = url.strip()
    # urlsplit silently drops tabs and newlines; refuse them, spaces and controls up front.
    if not url or any(ord(char) <= 0x20 or ord(char) == 0x7F for char in url):
        raise UsageError("URL tidak valid (memuat spasi atau karakter kontrol).")
    try:
        parts = urllib.parse.urlsplit(url)
        host, _port = parts.hostname, parts.port  # .port raises ValueError when malformed
    except ValueError:
        raise UsageError("URL tidak valid.") from None
    if parts.scheme not in ("https", "http") or not host:
        raise UsageError("URL harus https://... (http:// hanya untuk localhost).")
    if parts.username is not None or parts.password is not None:
        raise UsageError("URL tidak boleh memuat nama pengguna atau kata sandi.")
    if parts.scheme == "http" and host not in LOCAL_HOSTS:
        raise UsageError("URL harus https:// agar token tidak terkirim tanpa enkripsi.")
    if parts.fragment:
        raise UsageError("URL tidak boleh memuat #fragment.")
    return urllib.parse.urlunsplit(parts)


class Client:
    def __init__(self, url: str, headers: Mapping[str, str], timeout: float) -> None:
        self.url = url
        self.headers = dict(headers)
        self.timeout = timeout
        host = urllib.parse.urlsplit(url).hostname or ""
        handlers: list[Any] = [_NoRedirect()]
        if host in LOCAL_HOSTS:
            handlers.append(urllib.request.ProxyHandler({}))
        self.opener = urllib.request.build_opener(*handlers)

    def request(self, method: str, body: bytes | None = None) -> Response:
        headers = dict(self.headers)
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.url, data=body, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return Response(response.status, response.headers, _read_bounded(response))
        except urllib.error.HTTPError as error:
            try:
                payload = _read_bounded(error)
            except (OSError, ValueError, AttributeError, http.client.HTTPException):
                payload = b""
            finally:
                error.close()
            return Response(error.code, error.headers, payload)
        except (OSError, http.client.HTTPException) as error:
            raise NetworkError(type(error).__name__) from None


def parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip()
    if re.fullmatch(r"\d{1,9}(\.\d+)?", value):
        seconds = float(value)
    else:
        try:
            moment = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if moment is None:
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        seconds = (moment - datetime.now(UTC)).total_seconds()
    if not math.isfinite(seconds):
        return None
    return max(0.0, seconds)


def is_retryable(status: int) -> bool:
    return status == 429 or status >= 500


@dataclass
class Sender:
    client: Client
    max_retries: int
    max_wait: float
    sleep: Callable[[float], None]
    log: Callable[[str], None]

    def send(self, method: str, body: bytes | None = None) -> tuple[Response | None, str | None]:
        """Returns (response, None) on 2xx, otherwise (last response or None, failure code)."""
        attempt = 0
        while True:
            retry_after: float | None = None
            try:
                response: Response | None = self.client.request(method, body)
            except NetworkError:
                response, failure = None, "network_error"
            else:
                if 200 <= response.status < 300:
                    return response, None
                failure = response.error_code()
                if not is_retryable(response.status):
                    return response, failure
                retry_after = parse_retry_after(response.headers.get("Retry-After"))
            if attempt >= self.max_retries:
                return response, failure
            if retry_after is not None:
                if retry_after > self.max_wait:
                    self.log(
                        f"Server minta menunggu {retry_after:.0f} dtk (> --max-wait "
                        f"{self.max_wait:.0f}); berhenti ({failure})."
                    )
                    return response, failure
                delay = retry_after
            else:
                delay = min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2**attempt)
                delay += random.uniform(0.0, BACKOFF_JITTER_SECONDS)
            attempt += 1
            self.log(
                f"  {failure}: coba lagi ke-{attempt}/{self.max_retries} dalam {delay:.1f} dtk"
            )
            self.sleep(delay)


# --- Push -----------------------------------------------------------------------------------


@dataclass
class Totals:
    created: int = 0
    updated: int = 0


def parse_ingest_result(response: Response, size: int) -> tuple[int, int, list[tuple]] | None:
    data = response.json()
    if not isinstance(data, dict):
        return None
    accepted = data.get("accepted")
    if not isinstance(accepted, int) or isinstance(accepted, bool):
        return None
    rejected_raw = data.get("rejected", [])
    if not isinstance(rejected_raw, list):
        return None

    def count(value: object) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0

    rejected: list[tuple[int, str, str | None]] = []
    for record in rejected_raw:
        if not isinstance(record, dict):
            continue
        index = record.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < size:
            continue
        rejected.append(
            (index, safe_code(record.get("code")) or "rejected", safe_field(record.get("field")))
        )
    return count(data.get("created")), count(data.get("updated")), rejected


def push_batches(
    batches: list[list[Entry]], sender: Sender, log: Callable[[str], None]
) -> tuple[Totals, str | None]:
    """Sends every batch; returns the totals and the code that stopped the run, if any."""
    totals = Totals()
    queue = deque(batches)
    sent = 0
    while queue:
        batch = queue.popleft()
        sent += 1
        first, last = batch[0].position, batch[-1].position
        log(f"Batch {sent}: {len(batch)} item (posisi {first}-{last})")
        response, failure = sender.send("POST", encode_batch(batch))
        if failure is None and response is not None:
            parsed = parse_ingest_result(response, len(batch))
            if parsed is None:
                failure = "invalid_response"
            else:
                created, updated, rejected = parsed
                totals.created += created
                totals.updated += updated
                refused = {index: (code, field) for index, code, field in rejected}
                for index, entry in enumerate(batch):
                    if index in refused:
                        entry.settle("rejected", *refused[index])
                    else:
                        entry.settle("accepted")
                log(
                    f"  HTTP {response.status}: {len(batch) - len(refused)} diterima "
                    f"({created} baru, {updated} diperbarui), {len(refused)} ditolak"
                )
                continue
        status = response.status if response is not None else None
        if status == 413 and len(batch) > 1:
            half = len(batch) // 2
            log(f"  HTTP 413 ({failure}): batch dibagi dua ({half} + {len(batch) - half})")
            queue.appendleft(batch[half:])
            queue.appendleft(batch[:half])
            continue
        log(f"  GAGAL: {failure}" + (f" (HTTP {status})" if status is not None else ""))
        for entry in batch:
            entry.settle("failed", failure)
        if status == 413:
            continue
        for remaining in queue:
            for entry in remaining:
                entry.settle("failed", "not_sent")
        return totals, failure if status not in (401, 403) else f"auth:{failure}"
    return totals, None


STATUS_LABELS = {
    "accepted": "diterima",
    "rejected": "DITOLAK",
    "failed": "GAGAL",
    "pending": "siap",
}


def item_line(entry: Entry) -> str:
    detail = ""
    if entry.code:
        detail = f"  [{entry.code}" + (f": {entry.field}" if entry.field else "") + "]"
    label = STATUS_LABELS.get(entry.status, entry.status)
    title = entry.title or "(tanpa judul)"
    return f"  #{entry.position:<4} {label:<9} {entry.kind or '-':<8} {title}{detail}"


def report(entries: Sequence[Entry], totals: Totals, url: str) -> dict[str, Any]:
    return {
        "url": url,
        "total": len(entries),
        "accepted": sum(entry.status == "accepted" for entry in entries),
        "created": totals.created,
        "updated": totals.updated,
        "rejected": sum(entry.status == "rejected" for entry in entries),
        "failed": sum(entry.status == "failed" for entry in entries),
        "items": [
            {
                "index": entry.position,
                "status": entry.status,
                "code": entry.code,
                "field": entry.field,
                "externalId": entry.external_id,
                "title": entry.title,
            }
            for entry in entries
        ],
    }


# --- CLI ------------------------------------------------------------------------------------

EPILOG = f"""\
Token dibaca dari variabel lingkungan {TOKEN_ENV} (ptk_...), tidak pernah dari argumen,
dan tidak pernah dicetak. Buat token di halaman Konteks Tren (/trends) di Potongin.

URL bawaan: {DEFAULT_URL}
(ganti dengan --url atau {URL_ENV}; http:// hanya untuk localhost)

Opsional, bila domain dilindungi Cloudflare Access: {CF_ID_ENV} dan {CF_SECRET_ENV}.

Kode keluar: 0 semua diterima, 1 sebagian ditolak/gagal, 2 salah pakai/input,
3 token ditolak (401/403).

Contoh:
  {TOKEN_ENV}=ptk_... python3 push_trends.py items.json
  python3 push_trends.py --dry-run items.json
  python3 push_trends.py --list > aktif.json
"""


class _Parser(argparse.ArgumentParser):
    def __init__(self, *args: Any, out: TextIO, err: TextIO, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._out, self._err = out, err

    def _print_message(self, message: str, file: Any = None) -> None:
        if message:
            (self._out if file is None or file is sys.stdout else self._err).write(message)


def _batch_size(value: str) -> int:
    try:
        size = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("harus bilangan bulat") from None
    if not 1 <= size <= MAX_BATCH_ITEMS:
        raise argparse.ArgumentTypeError(f"harus 1..{MAX_BATCH_ITEMS}")
    return size


def _non_negative(kind: type) -> Callable[[str], Any]:
    def parse(value: str) -> Any:
        try:
            number = kind(value)
        except ValueError:
            raise argparse.ArgumentTypeError("harus angka") from None
        if not math.isfinite(float(number)) or number < 0:
            raise argparse.ArgumentTypeError("harus >= 0")
        return number

    return parse


def build_parser(out: TextIO, err: TextIO) -> _Parser:
    parser = _Parser(
        prog="push_trends.py",
        description="Kirim item Konteks Tren (file JSON) ke endpoint ingest Potongin.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        out=out,
        err=err,
    )
    add = parser.add_argument
    add("file", nargs="?", help='file JSON ({"items": [...]} atau [...]); - = stdin')
    add("--url", help="endpoint ingest (lihat URL bawaan di bawah)")
    add("--list", action="store_true", help="tampilkan item aktif (GET) sebagai JSON")
    add("--dry-run", action="store_true", help="periksa dan bagi batch tanpa mengirim")
    add("--json", action="store_true", help="cetak hasil akhir sebagai JSON di stdout")
    add("--batch-size", type=_batch_size, default=MAX_BATCH_ITEMS,
        help=f"item per permintaan, 1..{MAX_BATCH_ITEMS} (bawaan {MAX_BATCH_ITEMS})")
    add("--max-retries", type=_non_negative(int), default=DEFAULT_MAX_RETRIES,
        help=f"percobaan ulang untuk 429/5xx/jaringan (bawaan {DEFAULT_MAX_RETRIES})")
    add("--max-wait", type=_non_negative(float), default=DEFAULT_MAX_WAIT_SECONDS,
        help="Retry-After terpanjang yang mau ditunggu, detik (bawaan 120)")
    add("--timeout", type=_non_negative(float), default=DEFAULT_TIMEOUT_SECONDS,
        help="batas waktu per permintaan, detik (bawaan 30)")
    return parser


def resolve_headers(env: Mapping[str, str]) -> dict[str, str]:
    token = (env.get(TOKEN_ENV) or "").strip()
    if not token:
        raise UsageError(
            f"{TOKEN_ENV} belum diisi. Buat token di halaman Konteks Tren (/trends)."
        )
    if not TOKEN_PATTERN.fullmatch(token):
        raise UsageError(f"{TOKEN_ENV} bukan token ingest Potongin (ptk_ + 43 karakter).")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    cf_id = (env.get(CF_ID_ENV) or "").strip()
    cf_secret = (env.get(CF_SECRET_ENV) or "").strip()
    if cf_id or cf_secret:
        if not (cf_id and cf_secret):
            raise UsageError(f"Isi keduanya: {CF_ID_ENV} dan {CF_SECRET_ENV}.")
        if not all(HEADER_VALUE_PATTERN.fullmatch(value) for value in (cf_id, cf_secret)):
            raise UsageError(f"{CF_ID_ENV}/{CF_SECRET_ENV} memuat karakter yang tidak sah.")
        headers["CF-Access-Client-Id"] = cf_id
        headers["CF-Access-Client-Secret"] = cf_secret
    return headers


def main(
    argv: Sequence[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    env = os.environ if env is None else env
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    parser = build_parser(out, err)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        return exit_.code if isinstance(exit_.code, int) else EXIT_USAGE

    def say(message: str) -> None:
        print(message, file=out)

    def warn(message: str) -> None:
        print(message, file=err)

    progress = warn if (args.json or args.list) else say

    try:
        if args.list and args.file:
            raise UsageError("--list tidak memakai file item.")
        if not args.list and not args.file:
            raise UsageError("Sebutkan file item JSON (atau - untuk stdin), atau pakai --list.")
        url = validate_url(args.url or env.get(URL_ENV) or DEFAULT_URL)
        headers = None if args.dry_run and not args.list else resolve_headers(env)
        items = None if args.list else load_items(args.file)
    except UsageError as error:
        warn(f"Error: {error}")
        return EXIT_USAGE

    if args.list:
        return list_items(url, headers or {}, args, sleep, say, warn)

    entries = build_entries(items or [])
    batches = plan_batches(entries, args.batch_size)
    pending = sum(len(batch) for batch in batches)
    if not entries:
        progress("Tidak ada item untuk dikirim.")
    if args.dry_run:
        progress(
            f"Dry run: {pending} dari {len(entries)} item siap dalam {len(batches)} batch "
            f"ke {url}. Tidak ada yang dikirim."
        )
        totals, stop = Totals(), None
    elif batches:
        progress(f"Mengirim {pending} item ke {url} dalam {len(batches)} batch.")
        sender = Sender(Client(url, headers or {}, args.timeout), args.max_retries,
                        args.max_wait, sleep, progress)
        totals, stop = push_batches(batches, sender, progress)
    else:
        totals, stop = Totals(), None

    summary = report(entries, totals, url)
    if args.json:
        print(json.dumps(summary, ensure_ascii=True, indent=2), file=out)
    else:
        for entry in entries:
            if not args.dry_run or entry.status != "pending":
                say(item_line(entry))
        if args.dry_run:
            say(
                f"Ringkasan (dry run): {summary['total']} item, {pending} siap, "
                f"{summary['rejected']} ditolak."
            )
        else:
            say(
                f"Ringkasan: {summary['total']} item, {summary['accepted']} diterima "
                f"({summary['created']} baru, {summary['updated']} diperbarui), "
                f"{summary['rejected']} ditolak, {summary['failed']} gagal."
            )
    code = stop.split(":", 1)[-1] if stop else None
    if code and code in HINTS:
        warn(HINTS[code])
    if stop and stop.startswith("auth:"):
        return EXIT_AUTH
    if summary["rejected"] or summary["failed"]:
        return EXIT_PARTIAL
    return EXIT_OK


def list_items(
    url: str,
    headers: Mapping[str, str],
    args: argparse.Namespace,
    sleep: Callable[[float], None],
    say: Callable[[str], None],
    warn: Callable[[str], None],
) -> int:
    sender = Sender(Client(url, headers, args.timeout), args.max_retries, args.max_wait,
                    sleep, warn)
    response, failure = sender.send("GET")
    data = response.json() if failure is None and response is not None else None
    if failure is None and not (isinstance(data, dict) and isinstance(data.get("items"), list)):
        failure = "invalid_response"
    if failure is not None:
        status = response.status if response is not None else None
        warn(f"GAGAL: {failure}" + (f" (HTTP {status})" if status is not None else ""))
        if failure in HINTS:
            warn(HINTS[failure])
        return EXIT_AUTH if status in (401, 403) else EXIT_PARTIAL
    say(json.dumps(data, ensure_ascii=True, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
