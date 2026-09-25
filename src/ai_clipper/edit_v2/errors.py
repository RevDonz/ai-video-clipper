"""Stable error codes, exceptions and Indonesian messages of Editor V3 (plan §3.7, Appendix A).

Every failure or degraded path carries a fixed ``code`` (never a path or user text) and an
Indonesian message with the id ``edit.<code>`` (gate G-FAIL). A code may carry a detail after a
colon, e.g. ``glyph_unsupported:U+1F602`` or ``engine_fallback:3``; the message of the base code
is used and the detail is appended.

CLI exit codes (``python -m ai_clipper.edit_v2.api`` and every other edit_v2 CLI, T1.1):
0 ok, 1 internal error, 2 usage, 3 invalid (parse level), 4 not found, 5 revision conflict,
6 semantic, 7 schema too new, 8 analysis missing, 9 idempotency conflict, and (T1.0 additions
for render CLIs) 10 render failed, 11 verification failed, 12 cancelled.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from types import MappingProxyType
from typing import Any, ClassVar

EXIT_OK = 0
EXIT_INTERNAL = 1
EXIT_USAGE = 2
EXIT_INVALID = 3
EXIT_NOT_FOUND = 4
EXIT_CONFLICT = 5
EXIT_SEMANTIC = 6
EXIT_TOO_NEW = 7
EXIT_ANALYSIS_MISSING = 8
EXIT_IDEMPOTENCY = 9
EXIT_RENDER_FAILED = 10
EXIT_VERIFICATION_FAILED = 11
EXIT_CANCELLED = 12

# Plan §3.7, parse level: DocInvalid (422).
PARSE_CODES = frozenset(
    {
        "invalid_json",
        "float_not_allowed",
        "duplicate_key",
        "unknown_key",
        "too_large",
        "not_nfc",
        "control_char",
    }
)
# Plan §3.7, semantic and blocking: DocSemanticInvalid (422).
SEMANTIC_CODES = frozenset(
    {
        "base_changed",
        "outside_window",
        "range_invalid",
        "cold_open_invalid",
        "duration_out_of_bounds",
        "removal_outside_segment",
        "removal_overlap",
        "unknown_word",
        "asset_missing",
        "pack_unknown",
        "op_disabled",
        "item_out_of_frame",
        "revision_mismatch",
        "parent_mismatch",
    }
)
# Plan §3.7, warnings: saving is allowed; export asks for acknowledgement ("Perlu dicek").
WARNING_CODES = frozenset(
    {
        "tight_cut",
        "laughter_cut",
        "hook_overflow",
        "glyph_unsupported",
        "no_face",
        "unsafe_zone",
        "loudness_clamped",
        "peak_reduced",
        "music_shorter_than_clip",
    }
)
# Store, API and protocol outcomes (plan §4.2, §4.4).
PROTOCOL_CODES = frozenset(
    {
        "schema_too_new",
        "revision_conflict",
        "idempotency_conflict",
        "not_found",
        "analysis_missing",
        "internal_error",
    }
)
# Render and verification outcomes (plan §4.6, §5.9, §10.2 G-FAIL).
RENDER_CODES = frozenset(
    {
        "render_failed",
        "render_timeout",
        "render_stalled",
        "verification_failed",
        "cancelled",
        "auto_file_unavailable",
        "engine_fallback",
    }
)
# ``GET /clips`` reasons a clip cannot be opened (plan §1.1 item 1, §4.2, Appendix C.6).
CLIP_REASONS = frozenset(
    {
        "needs_prepare",
        "source_missing",
        "selection_unreadable",
        "transcript_missing",
        "analysis_incomplete",
        "not_v3",
    }
)
# ``GET …/edit`` readOnlyReason values (plan §3.6).
READ_ONLY_REASONS = frozenset({"transcript_changed"})
# Informational notices shown by the editor (plan §4.4, Appendix C.6).
NOTICE_CODES = frozenset({"legacy_engine", "markers_unavailable"})

_MESSAGES = {
    # Parse level.
    "invalid_json": "Dokumen edit tidak bisa dibaca (JSON tidak valid)",
    "float_not_allowed": "Dokumen edit memuat angka desimal; semua nilai harus bilangan bulat",
    "duplicate_key": "Dokumen edit memuat kolom ganda",
    "unknown_key": "Dokumen edit memuat kolom yang tidak dikenal",
    "too_large": "Dokumen edit terlalu besar (maksimal 1 MiB)",
    "not_nfc": "Teks harus dalam bentuk Unicode NFC",
    "control_char": "Teks memuat karakter kontrol yang tidak diizinkan",
    # Semantic, blocking.
    "base_changed": "Data dasar klip tidak boleh diubah",
    "outside_window": "Potongan berada di luar jendela analisis klip (±60 detik)",
    "range_invalid": "Ada nilai yang tidak valid atau di luar rentang yang diizinkan",
    "cold_open_invalid": (
        "Cold open tidak valid: harus 0,5–8 detik, di urutan pertama, dan tidak mengulang "
        "pembuka klip"
    ),
    "duration_out_of_bounds": "Durasi klip harus antara 3 detik dan 5 menit",
    "removal_outside_segment": "Bagian yang dihapus berada di luar potongannya",
    "removal_overlap": "Bagian yang dihapus saling tumpang tindih",
    "unknown_word": "Kata yang dirujuk tidak ada di transkrip klip",
    "asset_missing": "File logo atau musik tidak ditemukan; unggah ulang",
    "pack_unknown": "Gaya caption tidak dikenal",
    "op_disabled": "Fitur ini belum tersedia di Editor V3 Esensial",
    "item_out_of_frame": "Logo keluar dari bingkai video",
    "revision_mismatch": "Nomor revisi tidak cocok dengan versi yang tersimpan",
    "parent_mismatch": "Dokumen ini tidak dibuat dari versi yang tersimpan",
    # Warnings.
    "tight_cut": "Potongan sangat rapat dengan kata di sebelahnya; dengarkan hasilnya",
    "laughter_cut": "Potongan memotong tawa",
    "hook_overflow": "Teks hook terlalu panjang dan akan dipendekkan dengan \"…\"",
    "glyph_unsupported": "Ada karakter yang tidak tersedia di font caption dan tidak akan tampil",
    "no_face": "Tidak ada wajah terdeteksi di bagian ini; video dipusatkan",
    "unsafe_zone": "Caption, hook, atau logo masuk ke area tombol TikTok",
    "loudness_clamped": "Target kenyaringan tidak tercapai tanpa pecah; volume dibatasi",
    "peak_reduced": "Volume diturunkan agar audio tidak pecah",
    "music_shorter_than_clip": "Musik lebih pendek dari klip dan tidak diulang",
    # Store, API and protocol.
    "schema_too_new": "Dokumen ini dibuat versi editor yang lebih baru; muat ulang editor",
    "revision_conflict": "Klip ini diubah di tab lain",
    "idempotency_conflict": "Permintaan simpan ganda dengan isi yang berbeda",
    "not_found": "Data tidak ditemukan",
    "analysis_missing": "Analisis klip belum siap",
    "internal_error": "Terjadi kesalahan di server",
    # Render and verification.
    "render_failed": "Render gagal",
    "render_timeout": "Render melebihi batas waktu",
    "render_stalled": "Render berhenti merespons",
    "verification_failed": "Hasil render tidak lolos pemeriksaan mutu",
    "cancelled": "Render dibatalkan",
    "auto_file_unavailable": "File klip otomatis tidak tersedia; klip dirender ulang",
    "engine_fallback": "Klip dirender dengan mesin lama",
    # Clip reasons (Appendix C.6 copy).
    "needs_prepare": "Klip perlu disiapkan dulu",
    "source_missing": "Video sumber sudah tidak ada",
    "selection_unreadable": "Hasil seleksi tidak terbaca",
    "transcript_missing": "Transkrip tidak ditemukan",
    "analysis_incomplete": "Analisis job belum selesai",
    "not_v3": "Job ini bukan job V3",
    # Read-only reasons and notices.
    "transcript_changed": "Transkrip berubah sejak klip diedit",
    "legacy_engine": (
        "Klip ini dibuat dengan mesin lama; ekspor dari editor memakai mesin baru "
        "(tampilan teks bisa sedikit berbeda)"
    ),
    "markers_unavailable": "Penanda tawa/jeda tidak tersedia untuk job ini",
}

MESSAGES: Mapping[str, str] = MappingProxyType(_MESSAGES)


def base_code(code: str) -> str:
    """The code without its detail: ``glyph_unsupported:U+1F602`` -> ``glyph_unsupported``."""
    return code.split(":", 1)[0]


def message_id(code: str) -> str:
    """The Indonesian message id of a code, ``edit.<base code>``."""
    return f"edit.{base_code(code)}"


def message(code: str) -> str:
    """The Indonesian message of a code; a detail after ``:`` is appended in parentheses.

    Raises ``KeyError`` for an unknown code, so a new code cannot ship without its message.
    """
    base, _, detail = code.partition(":")
    text = MESSAGES[base]
    return f"{text} ({detail})" if detail else text


class EditV2Error(Exception):
    """Base error: ``.code`` (stable), ``.path`` (JSON pointer) or None, ``.ref`` (an id) or None.

    ``.issues`` optionally holds every ``doc.Issue`` found (a 422 lists them all).
    """

    default_code: ClassVar[str] = "internal_error"
    http_status: ClassVar[int] = 500
    exit_code: ClassVar[int] = EXIT_INTERNAL

    def __init__(
        self,
        code: str | None = None,
        *,
        path: str | None = None,
        ref: str | None = None,
        issues: Sequence[object] = (),
    ) -> None:
        self.code = self.default_code if code is None else code
        self.path = path
        self.ref = ref
        self.issues = tuple(issues)
        super().__init__(self.code if path is None else f"{self.code} at {path}")

    @property
    def message_id(self) -> str:
        return message_id(self.code)

    def user_message(self) -> str:
        return message(self.code)


class DocInvalid(EditV2Error):
    """Parse level (plan §3.7) → 422."""

    default_code = "invalid_json"
    http_status = 422
    exit_code = EXIT_INVALID


class DocSemanticInvalid(EditV2Error):
    """Semantic level, blocking (plan §3.7) → 422."""

    default_code = "range_invalid"
    http_status = 422
    exit_code = EXIT_SEMANTIC


class RevisionConflict(EditV2Error):
    """``If-Match`` is not the current etag → 409 with the current document and etag."""

    default_code = "revision_conflict"
    http_status = 409
    exit_code = EXIT_CONFLICT

    def __init__(
        self,
        code: str | None = None,
        *,
        current: Mapping[str, Any] | None = None,
        etag: str | None = None,
        path: str | None = None,
        ref: str | None = None,
    ) -> None:
        super().__init__(code, path=path, ref=ref)
        self.current = current
        self.etag = etag


class IdempotencyConflict(EditV2Error):
    """Same ``Idempotency-Key`` with a different payload digest → 409."""

    default_code = "idempotency_conflict"
    http_status = 409
    exit_code = EXIT_IDEMPOTENCY


class NotFound(EditV2Error):
    default_code = "not_found"
    http_status = 404
    exit_code = EXIT_NOT_FOUND


class AnalysisMissing(EditV2Error):
    """The words artifact (or another analysis file) does not exist yet → 409."""

    default_code = "analysis_missing"
    http_status = 409
    exit_code = EXIT_ANALYSIS_MISSING


class SchemaTooNew(EditV2Error):
    """``schema_minor`` newer than this server → 426 "muat ulang editor"."""

    default_code = "schema_too_new"
    http_status = 426
    exit_code = EXIT_TOO_NEW


class RenderFailed(EditV2Error):
    default_code = "render_failed"
    http_status = 500
    exit_code = EXIT_RENDER_FAILED


class VerificationFailed(EditV2Error):
    """A blocking gate (G1–G3, G3b) failed on the rendered file (plan §5.9)."""

    default_code = "verification_failed"
    http_status = 500
    exit_code = EXIT_VERIFICATION_FAILED


class Cancelled(EditV2Error):
    default_code = "cancelled"
    http_status = 409
    exit_code = EXIT_CANCELLED


def exit_code_for(error: BaseException) -> int:
    """The fixed CLI exit code for an exception (1 for anything that is not an EditV2Error)."""
    if isinstance(error, EditV2Error):
        return error.exit_code
    return EXIT_INTERNAL


__all__ = [
    "CLIP_REASONS",
    "MESSAGES",
    "NOTICE_CODES",
    "PARSE_CODES",
    "PROTOCOL_CODES",
    "READ_ONLY_REASONS",
    "RENDER_CODES",
    "SEMANTIC_CODES",
    "WARNING_CODES",
    "AnalysisMissing",
    "Cancelled",
    "DocInvalid",
    "DocSemanticInvalid",
    "EditV2Error",
    "IdempotencyConflict",
    "NotFound",
    "RenderFailed",
    "RevisionConflict",
    "SchemaTooNew",
    "VerificationFailed",
    "base_code",
    "exit_code_for",
    "message",
    "message_id",
]
