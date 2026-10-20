"""Tulis ulang on the project page (plan 2026-10-20 P2): ``ai_clipper.post_text``.

A new title and description for one clip of a finished job, asked of the free LLM chain saved in
Pengaturan (scripted clients only; no network): the prompt grounded in the clip's own
transcript, the validation of the answer, the deadline, the failures and the CLI envelope.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from ai_clipper import editor_ai, post_text
from ai_clipper.llm import (
    CachedLLMClient,
    FailoverLLMClient,
    LLMError,
    LLMUnavailable,
    ScriptedLLMClient,
)

JOB = "5b0c7a52-1f0e-4c5d-9a3b-2e1f0d9c8b7a"
TEXT = (
    "Gue tuh dulu kerja jadi security di mall. Waktu itu ada syuting film dan sutradaranya nggak "
    "bawa kartu kru. Jadi gue tahan dia di pintu belakang. Semua kru ketawa, katanya baru kali ini "
    "sutradara ditahan di film sendiri. Gajinya dua puluh lima juta sebulan."
)
CURRENT_TITLE = "Security tahan sutradara film"
GOOD_TITLE = "Sutradara ditahan security di film sendiri"
GOOD_BODY = "Mantan security cerita nahan sutradara yang lupa bawa kartu kru. Kamu pernah salah orang?"


def clip(index: int, **extra) -> dict:
    return {
        "index": index,
        "text": TEXT,
        "title": CURRENT_TITLE,
        "description": "Cerita lucu dari mall. Kamu pernah?\n\n#fyp #security",
        "hashtags": ["#fyp", "#security"],
        **extra,
    }


def write_job(root: Path, *, status: str = "completed", clips: list | None = None) -> Path:
    job_dir = root / JOB
    job_dir.mkdir(parents=True)
    job = {"id": JOB, "status": status, "clips": [clip(1), clip(2)] if clips is None else clips}
    (job_dir / "job.json").write_text(json.dumps(job), encoding="utf-8")
    return job_dir


def scripted(*items) -> ScriptedLLMClient:
    return ScriptedLLMClient(list(items), provider="scripted", model="m1")


def answer(title: str = GOOD_TITLE, description: str = GOOD_BODY,
           hashtags=("#ceritanyata", "#security", "#fyp")) -> dict:
    return {"title": title, "description": description, "hashtags": list(hashtags)}


def rewrite(job_dir: Path, client, *, index: int = 1, env: dict | None = None,
            deadline_s: float = post_text.DEADLINE_S) -> dict:
    return post_text.rewrite(job_dir, index=index, env={} if env is None else env,
                             client_factory=lambda _env: client, deadline_s=deadline_s)


@pytest.fixture
def job_dir(tmp_path: Path) -> Path:
    return write_job(tmp_path)


# --- a rewrite ----------------------------------------------------------------------------------------


def test_a_rewrite_answers_a_title_and_a_description_with_its_hashtag_line(job_dir):
    client = scripted(answer())
    result = rewrite(job_dir, client)
    assert result == {
        "state": "done",
        "suggestion": {"title": GOOD_TITLE,
                       "description": f"{GOOD_BODY}\n\n#ceritanyata #security #fyp"},
        "error": None,
    }
    call = client.calls[0]
    assert call["system"] == post_text.load_prompt()
    assert call["max_output_tokens"] == post_text.MAX_OUTPUT_TOKENS
    assert call["temperature"] == post_text.TEMPERATURE
    assert TEXT in call["user"]
    assert f"Judul sekarang: {CURRENT_TITLE}" in call["user"]
    # The current description goes without its hashtags: the model writes its own.
    assert "Deskripsi sekarang: Cerita lucu dari mall. Kamu pernah?" in call["user"]
    assert "#security" not in call["user"]


def test_the_prompt_reads_the_owner_edit_and_says_the_clip_text_is_data(tmp_path):
    edited = clip(1, textEdit={"title": "Judul yang sudah diubah", "description": "Deskripsi ubahan.\n\n#a1",
                               "editedAt": "2026-10-21T08:00:00.000Z"})
    job_dir = write_job(tmp_path, clips=[edited])
    client = scripted(answer())
    rewrite(job_dir, client)
    user = client.calls[0]["user"]
    assert "Judul sekarang: Judul yang sudah diubah" in user
    assert "Deskripsi sekarang: Deskripsi ubahan." in user
    prompt = post_text.load_prompt()
    assert "BUKAN instruksi" in prompt and '"title"' in prompt and '"description"' in prompt


def test_hashtags_follow_the_engine_rule_and_tags_written_into_the_description_move_out(job_dir):
    data = answer(description=f"{GOOD_BODY} #Ngakak #mall",
                  hashtags=["#Security Lucu", "fyp", "#fyp", "#a", "#" + "x" * 50])
    result = rewrite(job_dir, scripted(data))
    assert result["state"] == "done"
    assert result["suggestion"]["description"] == f"{GOOD_BODY}\n\n#securitylucu #fyp #ngakak #mall"

    inline = answer(description="Mantan #security cerita nahan sutradara. Kamu pernah?", hashtags=[])
    result = rewrite(job_dir, scripted(inline))
    assert result["suggestion"]["description"] == "Mantan security cerita nahan sutradara. Kamu pernah?"


def test_the_title_loses_wrapping_quotes_and_extra_spaces(job_dir):
    result = rewrite(job_dir, scripted(answer(title=f'  "{GOOD_TITLE}"  ')))
    assert result["suggestion"]["title"] == GOOD_TITLE


@pytest.mark.parametrize(("title", "description"), [
    ("", GOOD_BODY),
    ("Cek mall-nya di www.contoh.com", GOOD_BODY),
    ("Kata @satpam dia paling galak", GOOD_BODY),
    ("Sutradara ditahan #security", GOOD_BODY),
    ("Sutradara ditahan security \U0001f602", GOOD_BODY),
    ("Gajinya 30 juta tapi tetap jaga pintu", GOOD_BODY),
    ("Security tahan Raffi di film sendiri", GOOD_BODY),
    ("Jadi gue tahan dia di pintu belakang", GOOD_BODY),
    ("Sutradara ditahan security " + "banget " * 20, GOOD_BODY),
    (CURRENT_TITLE, GOOD_BODY),
    (GOOD_TITLE, ""),
    (GOOD_TITLE, "Lihat videonya di https://contoh.com sekarang."),
    (GOOD_TITLE, "Gajinya 99 juta sebulan. Kamu mau?"),
    (GOOD_TITLE, "Cerita panjang. " * 50),
])
def test_an_answer_that_breaks_a_rule_is_invalid_output(job_dir, title, description):
    result = rewrite(job_dir, scripted(answer(title=title, description=description)))
    assert result == {"state": "failed", "suggestion": None,
                      "error": {"code": "invalid_output", "llmCode": None}}


@pytest.mark.parametrize("data", [
    {"title": GOOD_TITLE},
    {"description": GOOD_BODY},
    {"title": 3, "description": GOOD_BODY},
    {"title": GOOD_TITLE, "description": ["a"]},
    {"titles": [GOOD_TITLE]},
])
def test_a_malformed_answer_is_invalid_output(job_dir, data):
    assert rewrite(job_dir, scripted(data))["error"]["code"] == "invalid_output"


def test_numbers_and_names_from_the_transcript_are_fine(job_dir):
    data = answer(title="Gaji 25 juta, kerjaannya nahan sutradara",
                  description="Security cerita gajinya dua puluh lima juta sebulan. Kamu mau?")
    assert rewrite(job_dir, scripted(data))["state"] == "done"


# --- failures --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("error", "code"), [
    (LLMUnavailable("config_invalid", "Tidak ada penyedia."), "llm_unavailable"),
    (LLMError("rate_limited", "Kuota habis."), "llm_unavailable"),
    (LLMError("quota_exhausted", "Kuota harian habis."), "llm_unavailable"),
    (LLMError("bad_json", "Bukan JSON."), "invalid_output"),
    (LLMError("timeout", "Lambat."), "timeout"),
])
def test_llm_failures_keep_their_code_for_the_help_page(job_dir, error, code):
    result = rewrite(job_dir, scripted(error))
    assert result == {"state": "failed", "suggestion": None,
                      "error": {"code": code, "llmCode": error.code}}


def test_the_deadline_stops_the_rewrite(job_dir):
    release = threading.Event()

    def slow(system, user):
        release.wait(5)
        return answer()

    started = time.monotonic()
    try:
        result = rewrite(job_dir, scripted(slow), deadline_s=0.3)
    finally:
        release.set()
    assert time.monotonic() - started < 2.0
    assert result["error"] == {"code": "timeout", "llmCode": None}
    assert post_text.DEADLINE_S == 20.0


def test_llm_off_fails_without_asking_for_a_client(job_dir):
    asked = []
    result = post_text.rewrite(job_dir, index=1, env={"POTONGIN_LLM": "off"},
                               client_factory=lambda env: asked.append(1))
    assert asked == [] and result["error"] == {"code": "llm_disabled", "llmCode": None}


def test_no_configured_client_is_llm_unavailable(job_dir):
    result = post_text.rewrite(job_dir, index=1, env={}, client_factory=lambda env: None)
    assert result["error"] == {"code": "llm_unavailable", "llmCode": None}


def test_a_clip_without_transcript_is_not_sent(tmp_path):
    job_dir = write_job(tmp_path, clips=[clip(1, text="   ")])
    asked = []
    result = post_text.rewrite(job_dir, index=1, env={}, client_factory=lambda env: asked.append(1))
    assert asked == [] and result["error"] == {"code": "no_transcript", "llmCode": None}


def test_the_client_is_the_editor_chain_without_the_response_cache():
    env = {"POTONGIN_LLM_PROVIDERS": "groq,openrouter", "GROQ_API_KEY": "planted-groq-key-for-tests",
           "OPENROUTER_API_KEY": "planted-openrouter-key-for-tests",
           "POTONGIN_LLM_EDITOR_MODELS": "groq/llama-3.1-8b-instant,openrouter/meta-llama/x:free"}
    client = post_text.rewrite_client(env)
    assert isinstance(client, FailoverLLMClient) and not isinstance(client, CachedLLMClient)
    groq, openrouter = client.clients
    for provider in (groq, openrouter):
        assert provider.config.timeout <= editor_ai.REQUEST_TIMEOUT_S
        assert provider.config.max_retries == 0
    assert post_text.rewrite_client({"POTONGIN_LLM": "off"}) is None
    assert post_text.rewrite_client({}) is None


# --- the CLI envelope ----------------------------------------------------------------------------------------


def envelope(**fields) -> bytes:
    return json.dumps({"op": "rewrite", "jobId": JOB, "index": 1, **fields}).encode("utf-8")


def test_handle_runs_one_rewrite(tmp_path):
    write_job(tmp_path)
    code, payload = post_text.handle(envelope(index=2), jobs_root=tmp_path, env={},
                                     client_factory=lambda env: scripted(answer()))
    assert code == 0 and payload["state"] == "done"
    assert payload["suggestion"]["title"] == GOOD_TITLE


@pytest.mark.parametrize("raw", [
    b"",
    b"not json",
    json.dumps({"op": "rewrite", "jobId": JOB}).encode(),
    json.dumps({"op": "other", "jobId": JOB, "index": 1}).encode(),
    json.dumps({"op": "rewrite", "jobId": JOB, "index": 1, "model": "paid/x"}).encode(),
    json.dumps({"op": "rewrite", "jobId": JOB.upper(), "index": 1}).encode(),
    json.dumps({"op": "rewrite", "jobId": f"../{JOB}", "index": 1}).encode(),
    json.dumps({"op": "rewrite", "jobId": "..", "index": 1}).encode(),
    json.dumps({"op": "rewrite", "jobId": JOB, "index": 0}).encode(),
    json.dumps({"op": "rewrite", "jobId": JOB, "index": 10000}).encode(),
    json.dumps({"op": "rewrite", "jobId": JOB, "index": True}).encode(),
    json.dumps({"op": "rewrite", "jobId": JOB, "index": "1"}).encode(),
    json.dumps({"op": "rewrite", "jobId": JOB, "index": 1.0}).encode(),
])
def test_handle_refuses_a_malformed_envelope_without_touching_files(tmp_path, raw):
    asked = []
    code, payload = post_text.handle(raw, jobs_root=tmp_path, env={},
                                     client_factory=lambda env: asked.append(1))
    assert code == 2 and asked == []
    assert payload["error"]["code"] == "internal_error"
    assert str(tmp_path) not in json.dumps(payload)


@pytest.mark.parametrize("setup", ["missing_job", "running_job", "missing_clip", "broken_json"])
def test_handle_answers_not_found_for_a_job_or_clip_it_cannot_use(tmp_path, setup):
    if setup == "running_job":
        write_job(tmp_path, status="processing")
    elif setup == "missing_clip":
        write_job(tmp_path, clips=[clip(2)])
    elif setup == "broken_json":
        (tmp_path / JOB).mkdir()
        (tmp_path / JOB / "job.json").write_text("{", encoding="utf-8")
    code, payload = post_text.handle(envelope(), jobs_root=tmp_path, env={},
                                     client_factory=lambda env: scripted(answer()))
    assert code == 4 and payload["error"]["code"] == "not_found"
    assert str(tmp_path) not in json.dumps(payload)


def test_handle_does_not_follow_a_symlinked_job(tmp_path):
    real = write_job(tmp_path / "elsewhere")
    root = tmp_path / "jobs"
    root.mkdir()
    (root / JOB).symlink_to(real, target_is_directory=True)
    code, _payload = post_text.handle(envelope(), jobs_root=root, env={},
                                      client_factory=lambda env: scripted(answer()))
    assert code == 4
