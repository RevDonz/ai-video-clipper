from __future__ import annotations

import dataclasses
import io
import json
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from ai_clipper import llm
from ai_clipper.llm import (
    NUDGE,
    PRESETS,
    PROVIDERS,
    CachedLLMClient,
    FailoverLLMClient,
    LLMConfig,
    LLMError,
    LLMResponse,
    LLMUnavailable,
    OpenAICompatibleClient,
    RateLimiter,
    ScriptedLLMClient,
    create_llm_client,
    create_llm_client_from_env,
    extract_json_object,
    load_llm_config,
    load_llm_configs,
)

SECRET = "sk-test-SECRETSECRETSECRET-0123456789abcdef"

Reply = tuple[int, dict[str, str], object]


@dataclass
class FakeServer:
    base_url: str
    replies: list[Reply | Callable[[dict[str, object]], Reply] | str] = field(default_factory=list)
    requests: list[dict[str, object]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def reply(self, *items: Reply | Callable[[dict[str, object]], Reply] | str) -> None:
        with self.lock:
            self.replies.extend(items)

    def bodies(self) -> list[dict[str, object]]:
        return [request["json"] for request in self.requests]  # type: ignore[misc]


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def handle_error(self, request, client_address) -> None:
        return


@pytest.fixture
def server() -> Iterator[FakeServer]:
    state = FakeServer(base_url="")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            record = {
                "path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "json": json.loads(raw),
            }
            with state.lock:
                state.requests.append(record)
                reply = state.replies.pop(0) if state.replies else (599, {}, {"error": "none"})
            if reply == "HANG":
                time.sleep(0.6)
                return
            if callable(reply):
                reply = reply(record)
            status, headers, body = reply  # type: ignore[misc]
            payload = body if isinstance(body, bytes) else (
                body.encode() if isinstance(body, str) else json.dumps(body).encode()
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            return

    httpd = _QuietServer(("127.0.0.1", 0), Handler)
    state.base_url = f"http://127.0.0.1:{httpd.server_address[1]}/v1"
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01},
                              daemon=True)
    thread.start()
    try:
        yield state
    finally:
        httpd.shutdown()
        httpd.server_close()


def chat(
    content: object,
    *,
    finish: str = "stop",
    usage: dict[str, int] | None = None,
    model: str | None = None,
    message_extra: dict[str, object] | None = None,
) -> Reply:
    message: dict[str, object] = {"role": "assistant", "content": content}
    message.update(message_extra or {})
    body: dict[str, object] = {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
    }
    if model is not None:
        body["model"] = model
    if usage is not None:
        body["usage"] = usage
    return 200, {}, body


def error_reply(status: int, message: str, headers: dict[str, str] | None = None) -> Reply:
    return status, headers or {}, {"error": {"message": message, "code": status}}


def make_config(base_url: str, **overrides: object) -> LLMConfig:
    values: dict[str, object] = {
        "provider": "custom",
        "base_url": base_url,
        "model": "m1",
        "api_key": SECRET,
        "fallback_models": (),
        "timeout": 5.0,
        "max_retries": 2,
        "temperature": 0.2,
        "max_output_tokens": 256,
        "json_mode": True,
        "requests_per_minute": None,
        "context_tokens": 8000,
    }
    values.update(overrides)
    return LLMConfig(**values)  # type: ignore[arg-type]


def make_client(config: LLMConfig, sleeps: list[float] | None = None) -> OpenAICompatibleClient:
    recorded = sleeps if sleeps is not None else []
    return OpenAICompatibleClient(config, sleep=recorded.append, rng=lambda: 0.0)


def call(client: object, user: str = "Return a JSON object.") -> LLMResponse:
    return client.complete_json(system="You extract JSON.", user=user)  # type: ignore[attr-defined]


# --- JSON extraction ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('{"a": 1}', {"a": 1}),
        ('  \n{"a": {"b": [1, 2]}}\n', {"a": {"b": [1, 2]}}),
        ('```json\n{"a": 1}\n```', {"a": 1}),
        ('Berikut hasilnya:\n```\n{"a": "x}y"}\n```\nSemoga membantu', {"a": "x}y"}),
        ('Sure! {"a": "kurung { dan } di string", "b": "\\"q\\""} done', {
            "a": "kurung { dan } di string", "b": '"q"'}),
        ('<think>maybe {"draft": 1}</think>\n{"final": true}', {"final": True}),
        ('note {not json} then {"ok": true}', {"ok": True}),
        ('{"a": 1} {"b": 2}', {"a": 1}),
    ],
)
def test_extract_json_object_accepts_common_model_outputs(text: str, expected: dict) -> None:
    assert extract_json_object(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "", "   ", "no json here", '[{"a": 1}]', '{"a": NaN}', '{"a": Infinity}', '{"a": 1',
        "{'a': 1}",
    ],
)
def test_extract_json_object_rejects_non_objects(text: str) -> None:
    with pytest.raises(ValueError):
        extract_json_object(text)


# --- client: success paths ------------------------------------------------------------------


def test_success_sends_openai_compatible_request_and_parses_usage(server: FakeServer) -> None:
    server.reply(chat('{"ok": true}', usage={"prompt_tokens": 12, "completion_tokens": 3},
                      model="m1-2026"))
    client = make_client(make_config(server.base_url))

    response = client.complete_json(system="Sistem JSON.", user="Halo", temperature=0.5,
                                    max_output_tokens=99)

    assert response.data == {"ok": True}
    assert response.text == '{"ok": true}'
    assert response.provider == "custom"
    assert response.model == "m1-2026"
    assert (response.input_tokens, response.output_tokens) == (12, 3)
    assert response.cached is False
    assert response.latency_s >= 0.0
    [request] = server.requests
    assert request["path"] == "/v1/chat/completions"
    headers = request["headers"]
    assert headers["authorization"] == f"Bearer {SECRET}"
    assert headers["content-type"] == "application/json"
    body = request["json"]
    assert body["model"] == "m1"
    assert body["messages"] == [
        {"role": "system", "content": "Sistem JSON."},
        {"role": "user", "content": "Halo"},
    ]
    assert body["temperature"] == 0.5
    assert body["max_tokens"] == 99
    assert body["response_format"] == {"type": "json_object"}


def test_defaults_come_from_config_and_missing_usage_is_none(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'))
    client = make_client(make_config(server.base_url, temperature=0.7, max_output_tokens=321))

    response = call(client)

    body = server.bodies()[0]
    assert body["temperature"] == 0.7
    assert body["max_tokens"] == 321
    assert response.model == "m1"
    assert response.input_tokens is None and response.output_tokens is None


def test_json_hint_is_added_only_when_prompts_never_mention_json(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'), chat('{"a": 1}'))
    client = make_client(make_config(server.base_url))

    client.complete_json(system="Kamu editor.", user="Pilih momen.")
    client.complete_json(system="Kamu editor. Jawab JSON.", user="Pilih momen.")

    first, second = server.bodies()
    assert "json" in first["messages"][0]["content"].lower()
    assert first["messages"][0]["content"].startswith("Kamu editor.")
    assert second["messages"][0]["content"] == "Kamu editor. Jawab JSON."


def test_json_mode_off_sends_no_response_format(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'))
    client = make_client(make_config(server.base_url, json_mode=False))

    call(client)

    assert "response_format" not in server.bodies()[0]


def test_fenced_json_is_extracted(server: FakeServer) -> None:
    server.reply(chat('Berikut JSON:\n```json\n{"moments": [{"id": "S0001"}]}\n```'))

    response = call(make_client(make_config(server.base_url)))

    assert response.data == {"moments": [{"id": "S0001"}]}


def test_list_of_parts_content_is_joined(server: FakeServer) -> None:
    server.reply(chat([{"type": "text", "text": '{"a": '}, {"type": "text", "text": "1}"}]))

    assert call(make_client(make_config(server.base_url))).data == {"a": 1}


@pytest.mark.parametrize("field_name", ["reasoning_content", "reasoning"])
def test_empty_content_falls_back_to_reasoning_fields(server: FakeServer, field_name: str) -> None:
    server.reply(chat("", message_extra={field_name: 'thinking... {"a": 2}'}))

    assert call(make_client(make_config(server.base_url))).data == {"a": 2}


def test_no_authorization_header_without_key(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'))

    call(make_client(make_config(server.base_url, provider="ollama", api_key=None)))

    assert "authorization" not in server.requests[0]["headers"]


def test_openrouter_sends_optional_attribution_headers(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'))
    config = make_config(server.base_url, provider="openrouter",
                         http_referer="https://potongin.test", app_title="Potongin")

    call(make_client(config))

    headers = server.requests[0]["headers"]
    assert headers["http-referer"] == "https://potongin.test"
    assert headers["x-title"] == "Potongin"


def test_other_providers_do_not_send_openrouter_headers(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'))

    call(make_client(make_config(server.base_url, http_referer="https://potongin.test")))

    assert "http-referer" not in server.requests[0]["headers"]
    assert "x-title" not in server.requests[0]["headers"]


def test_openai_preset_uses_max_completion_tokens(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'))

    call(make_client(make_config(server.base_url, provider="openai")))

    body = server.bodies()[0]
    assert body["max_completion_tokens"] == 256
    assert "max_tokens" not in body


# --- client: retries, adaptation, fallbacks --------------------------------------------------


def test_429_honors_retry_after_then_succeeds(server: FakeServer) -> None:
    server.reply(error_reply(429, "slow down", {"Retry-After": "2"}), chat('{"a": 1}'))
    sleeps: list[float] = []

    response = call(make_client(make_config(server.base_url), sleeps))

    assert response.data == {"a": 1}
    assert sleeps == [2.0]
    assert len(server.requests) == 2


def test_retry_after_is_capped_and_gemini_retry_delay_is_read(server: FakeServer) -> None:
    gemini_429 = (429, {}, [{"error": {
        "code": 429, "status": "RESOURCE_EXHAUSTED", "message": "quota per minute",
        "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "7s"}],
    }}])
    server.reply(gemini_429, chat('{"a": 1}'))
    sleeps: list[float] = []

    call(make_client(make_config(server.base_url), sleeps))

    assert sleeps == [7.0]


def test_long_or_daily_429_skips_to_fallback_without_sleeping(server: FakeServer) -> None:
    server.reply(
        error_reply(429, "Rate limit exceeded: free-models-per-day", {"Retry-After": "3600"}),
        chat('{"a": 1}'),
        chat('{"b": 2}'),
    )
    sleeps: list[float] = []
    client = make_client(make_config(server.base_url, fallback_models=("m2",)), sleeps)

    first = call(client)
    second = call(client)

    assert sleeps == []
    assert (first.model, second.model) == ("m2", "m2")
    assert [body["model"] for body in server.bodies()] == ["m1", "m2", "m2"]


def test_500_is_retried_with_backoff(server: FakeServer) -> None:
    server.reply(error_reply(500, "boom"), error_reply(503, "busy"), chat('{"a": 1}'))
    sleeps: list[float] = []

    response = call(make_client(make_config(server.base_url), sleeps))

    assert response.data == {"a": 1}
    assert len(sleeps) == 2
    assert 0 < sleeps[0] < sleeps[1] <= 60


def test_exhausted_retries_move_to_next_fallback(server: FakeServer) -> None:
    server.reply(*(error_reply(502, "bad gateway") for _ in range(3)), chat('{"a": 1}'))
    client = make_client(make_config(server.base_url, fallback_models=("m2",)))

    response = call(client)

    assert response.model == "m2"
    assert [body["model"] for body in server.bodies()] == ["m1", "m1", "m1", "m2"]


def test_all_models_failing_raises_last_code_with_attempts(server: FakeServer) -> None:
    server.reply(error_reply(404, "no such model"), error_reply(404, "no such model"))
    client = make_client(make_config(server.base_url, fallback_models=("m2",)))

    with pytest.raises(LLMError) as caught:
        call(client)

    assert caught.value.code == "model_not_found"
    assert caught.value.attempts == (("m1", "model_not_found"), ("m2", "model_not_found"))
    assert "m1" in caught.value.message and "m2" in caught.value.message


def test_404_moves_to_fallback_model(server: FakeServer) -> None:
    server.reply(error_reply(404, "model m1 does not exist"), chat('{"a": 1}'))
    sleeps: list[float] = []

    response = call(make_client(make_config(server.base_url, fallback_models=("m2",)), sleeps))

    assert response.model == "m2"
    assert sleeps == []
    assert [body["model"] for body in server.bodies()] == ["m1", "m2"]


def test_400_response_format_rejection_retries_without_it_and_remembers(
    server: FakeServer,
) -> None:
    server.reply(
        error_reply(400, "Invalid parameter: 'response_format' of type 'json_object' "
                         "is not supported"),
        chat('{"a": 1}'),
        chat('{"a": 2}'),
    )
    client = make_client(make_config(server.base_url))

    assert call(client).data == {"a": 1}
    assert call(client).data == {"a": 2}

    first, second, third = server.bodies()
    assert "response_format" in first
    assert "response_format" not in second
    assert "response_format" not in third


def test_400_unsupported_max_tokens_switches_parameter(server: FakeServer) -> None:
    server.reply(
        error_reply(400, "Unsupported parameter: 'max_tokens' is not supported with this model. "
                         "Use 'max_completion_tokens' instead."),
        chat('{"a": 1}'),
    )

    call(make_client(make_config(server.base_url)))

    first, second = server.bodies()
    assert first["max_tokens"] == 256
    assert second["max_completion_tokens"] == 256 and "max_tokens" not in second


def test_400_unsupported_temperature_is_dropped(server: FakeServer) -> None:
    server.reply(
        error_reply(400, "Unsupported value: 'temperature' does not support 0.2 with this model."),
        chat('{"a": 1}'),
    )

    call(make_client(make_config(server.base_url)))

    assert "temperature" not in server.bodies()[1]


def test_groq_json_validate_failed_retries_without_response_format(server: FakeServer) -> None:
    server.reply(
        (400, {}, {"error": {"message": "Failed to generate JSON. Please adjust your prompt.",
                             "type": "invalid_request_error", "code": "json_validate_failed"}}),
        chat('Tentu: {"a": 1}'),
    )

    assert call(make_client(make_config(server.base_url))).data == {"a": 1}
    assert "response_format" not in server.bodies()[1]


def test_reasoning_effort_is_sent_and_dropped_when_rejected(server: FakeServer) -> None:
    server.reply(
        chat('{"a": 1}'),
        error_reply(400, "Unrecognized request argument supplied: reasoning_effort"),
        chat('{"a": 2}'),
    )
    config = make_config(server.base_url, reasoning_effort="low")

    call(make_client(config))
    call(make_client(dataclasses.replace(config, model="m9")))

    first, second, third = server.bodies()
    assert first["reasoning_effort"] == "low"
    assert second["reasoning_effort"] == "low"
    assert "reasoning_effort" not in third


def test_reasoning_effort_is_omitted_by_default(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'))

    call(make_client(make_config(server.base_url)))

    assert "reasoning_effort" not in server.bodies()[0]


def test_openrouter_data_policy_404_explains_privacy_setting(server: FakeServer) -> None:
    server.reply(error_reply(404, "No endpoints found matching your data policy "
                                  "(Free model publication)."))

    with pytest.raises(LLMError) as caught:
        call(make_client(make_config(server.base_url, provider="openrouter")))

    assert caught.value.code == "model_not_found"
    assert "openrouter.ai/settings/privacy" in caught.value.message


@pytest.mark.parametrize(
    ("status", "message"),
    [
        (402, "Insufficient credits. Add more using https://openrouter.ai/settings/credits"),
        (403, "This model requires a subscription. Upgrade your plan to use it."),
    ],
)
def test_payment_errors_move_to_next_model(server: FakeServer, status: int, message: str) -> None:
    server.reply(error_reply(status, message), chat('{"a": 1}'))
    sleeps: list[float] = []

    response = call(make_client(make_config(server.base_url, fallback_models=("m2",)), sleeps))

    assert response.model == "m2"
    assert sleeps == []


def test_weekly_or_session_quota_is_exhausted_not_retried(server: FakeServer) -> None:
    server.reply(error_reply(429, "You have reached your weekly usage limit."),
                 chat('{"a": 1}'))
    sleeps: list[float] = []

    response = call(make_client(make_config(server.base_url, fallback_models=("m2",)), sleeps))

    assert response.model == "m2" and sleeps == []


def test_plain_400_is_not_retried_and_moves_on(server: FakeServer) -> None:
    server.reply(error_reply(400, "messages must not be empty"), chat('{"a": 1}'))

    response = call(make_client(make_config(server.base_url, fallback_models=("m2",))))

    assert response.model == "m2"
    assert len(server.requests) == 2


def test_context_length_error_has_stable_code(server: FakeServer) -> None:
    server.reply(error_reply(400, "This model's maximum context length is 8192 tokens."))

    with pytest.raises(LLMError) as caught:
        call(make_client(make_config(server.base_url)))

    assert caught.value.code == "context_length"


@pytest.mark.parametrize("status", [401, 403])
def test_auth_errors_are_not_retried_or_failed_over(server: FakeServer, status: int) -> None:
    server.reply(error_reply(status, f"Incorrect API key provided: {SECRET}"))
    sleeps: list[float] = []
    client = make_client(make_config(server.base_url, fallback_models=("m2", "m3")), sleeps)

    with pytest.raises(LLMError) as caught:
        call(client)

    assert caught.value.code == "auth"
    assert caught.value.status == status
    assert len(server.requests) == 1
    assert sleeps == []
    for rendered in (str(caught.value), repr(caught.value), json.dumps(caught.value.to_dict())):
        assert SECRET not in rendered
        assert "SECRETSECRET" not in rendered


def test_invalid_json_is_nudged_once_then_succeeds(server: FakeServer) -> None:
    server.reply(chat("Maaf, ini momennya: S0001 sampai S0004"), chat('{"a": 1}'))

    response = call(make_client(make_config(server.base_url)), user="Pilih momen.")

    assert response.data == {"a": 1}
    first, second = server.bodies()
    assert first["messages"][-1]["content"] == "Pilih momen."
    assert second["messages"][-1]["content"].endswith(NUDGE)
    assert second["messages"][-1]["content"].startswith("Pilih momen.")
    assert NUDGE == "Return ONLY one valid JSON object."


def test_invalid_json_twice_is_bad_json_and_moves_on(server: FakeServer) -> None:
    server.reply(chat("nope"), chat("still nope"), chat('{"a": 1}'))
    client = make_client(make_config(server.base_url, fallback_models=("m2",)))

    response = call(client)

    assert response.model == "m2"
    assert len(server.requests) == 3


def test_invalid_json_without_fallback_raises_bad_json(server: FakeServer) -> None:
    server.reply(chat("nope"), chat(None))

    with pytest.raises(LLMError) as caught:
        call(make_client(make_config(server.base_url)))

    assert caught.value.code == "bad_json"


def test_finish_reason_length_is_truncated(server: FakeServer) -> None:
    server.reply(chat('{"moments": [{"id": "S0001"', finish="length"))

    with pytest.raises(LLMError) as caught:
        call(make_client(make_config(server.base_url)))

    assert caught.value.code == "truncated"


def test_error_object_inside_200_is_classified(server: FakeServer) -> None:
    server.reply((200, {}, {"error": {"message": "Provider returned error", "code": 502}}),
                 chat('{"a": 1}'))
    sleeps: list[float] = []

    response = call(make_client(make_config(server.base_url), sleeps))

    assert response.data == {"a": 1}
    assert len(sleeps) == 1


def test_non_json_200_body_is_bad_response(server: FakeServer) -> None:
    server.reply(*((200, {}, "<html>gateway</html>") for _ in range(3)))

    with pytest.raises(LLMError) as caught:
        call(make_client(make_config(server.base_url)))

    assert caught.value.code == "bad_response"
    assert len(server.requests) == 3


def test_redirects_are_not_followed(server: FakeServer) -> None:
    server.reply((302, {"Location": server.base_url + "/elsewhere"}, {}))

    with pytest.raises(LLMError) as caught:
        call(make_client(make_config(server.base_url)))

    assert caught.value.code == "http_302"
    assert len(server.requests) == 1


def test_timeout_is_retried_then_reported(server: FakeServer) -> None:
    server.reply("HANG", "HANG")
    sleeps: list[float] = []
    client = make_client(make_config(server.base_url, timeout=0.15, max_retries=1), sleeps)

    with pytest.raises(LLMError) as caught:
        call(client)

    assert caught.value.code == "timeout"
    assert len(sleeps) == 1


def test_network_error_has_stable_code() -> None:
    config = make_config("http://127.0.0.1:9/v1", max_retries=0)

    with pytest.raises(LLMError) as caught:
        call(make_client(config))

    assert caught.value.code == "network"
    assert SECRET not in str(caught.value)


def test_complete_json_validates_arguments(server: FakeServer) -> None:
    client = make_client(make_config(server.base_url))
    with pytest.raises(ValueError):
        client.complete_json(system="s", user="  ")
    with pytest.raises(ValueError):
        client.complete_json(system="s", user="u", max_output_tokens=0)
    with pytest.raises(ValueError):
        client.complete_json(system="s", user="u", temperature=3.0)
    assert server.requests == []


def test_llm_errors_survive_pickling() -> None:
    import pickle

    error = LLMUnavailable("missing_api_key", "API key belum diisi.", provider="groq",
                           attempts=(("m1", "auth"),))
    clone = pickle.loads(pickle.dumps(error))
    assert type(clone) is LLMUnavailable
    assert clone.to_dict() == error.to_dict()


def test_http_date_retry_after_is_understood(server: FakeServer) -> None:
    from datetime import UTC, datetime, timedelta
    from email.utils import format_datetime

    when = format_datetime(datetime.now(UTC) + timedelta(seconds=30), usegmt=True)
    server.reply(error_reply(429, "slow", {"Retry-After": when}), chat('{"a": 1}'))
    sleeps: list[float] = []

    call(make_client(make_config(server.base_url), sleeps))

    assert len(sleeps) == 1 and 20 <= sleeps[0] <= 31


def test_cache_key_includes_reasoning_effort(tmp_path: Path) -> None:
    inner = ScriptedLLMClient([{"n": 1}, {"n": 2}])
    base = make_config("https://x.example/v1")
    CachedLLMClient(inner, tmp_path, config=base).complete_json(system="s", user="u")
    response = CachedLLMClient(
        inner, tmp_path, config=dataclasses.replace(base, reasoning_effort="low")
    ).complete_json(system="s", user="u")
    assert response.cached is False and response.data == {"n": 2}


# --- secrets ----------------------------------------------------------------------------------


def test_key_never_appears_in_config_response_or_error_renderings(server: FakeServer) -> None:
    config = make_config(server.base_url)
    server.reply(chat('{"a": 1}'), error_reply(500, f"upstream saw Bearer {SECRET}"))
    client = make_client(dataclasses.replace(config, max_retries=0))
    response = call(client)
    with pytest.raises(LLMError) as caught:
        call(client)

    renderings = [
        str(config), repr(config), json.dumps(config.public_dict()), str(config.public_dict()),
        str(response), repr(response), str(caught.value), repr(caught.value),
        json.dumps(caught.value.to_dict()), repr(client),
    ]
    for rendered in renderings:
        assert SECRET not in rendered
    assert "api_key" not in config.public_dict()
    assert config.public_dict()["api_key_set"] is True


def test_public_signatures_never_embed_the_process_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import inspect

    monkeypatch.setenv("GEMINI_API_KEY", SECRET)
    for function in (llm.load_llm_config, llm.load_llm_configs, llm.configured_providers,
                     llm.llm_disabled, llm.create_llm_client_from_env):
        assert SECRET not in str(inspect.signature(function))
    monkeypatch.setenv("POTONGIN_LLM_PROVIDER", "gemini")
    config = load_llm_config()
    assert config is not None and config.api_key == SECRET


# --- rate limiting ----------------------------------------------------------------------------


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []
        self.lock = threading.Lock()

    def time(self) -> float:
        with self.lock:
            return self.now

    def sleep(self, seconds: float) -> None:
        with self.lock:
            self.sleeps.append(seconds)
            self.now += seconds


def test_rate_limiter_spaces_requests() -> None:
    clock = FakeClock()
    limiter = RateLimiter(60.0, clock=clock.time, sleep=clock.sleep)

    limiter.acquire()
    limiter.acquire()
    clock.now += 0.25
    limiter.acquire()

    assert clock.sleeps == [pytest.approx(1.0), pytest.approx(0.75)]


def test_rate_limiter_reserves_distinct_slots_across_threads() -> None:
    clock = FakeClock()
    clock.sleep = lambda seconds: clock.sleeps.append(seconds)  # type: ignore[method-assign]
    limiter = RateLimiter(120.0, clock=clock.time, sleep=clock.sleep)
    threads = [threading.Thread(target=limiter.acquire) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(clock.sleeps) == pytest.approx([0.5, 1.0, 1.5, 2.0])


def test_rate_limiter_disabled_without_rpm() -> None:
    clock = FakeClock()
    limiter = RateLimiter(None, clock=clock.time, sleep=clock.sleep)
    for _ in range(3):
        limiter.acquire()
    assert clock.sleeps == []


def test_client_applies_requests_per_minute(server: FakeServer) -> None:
    server.reply(chat('{"a": 1}'), chat('{"a": 2}'))
    clock = FakeClock()
    client = OpenAICompatibleClient(
        make_config(server.base_url, requests_per_minute=30.0),
        sleep=clock.sleep, clock=clock.time, rng=lambda: 0.0,
    )

    call(client)
    call(client)

    assert clock.sleeps == [pytest.approx(2.0)]


# --- configuration ----------------------------------------------------------------------------

KEY_VARS = {
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "ollama-cloud": "OLLAMA_API_KEY",
}


CUSTOM_SERVERS = ("custom", "custom2", "custom3")


def test_presets_cover_every_provider() -> None:
    assert set(PROVIDERS) == set(PRESETS)
    assert set(PROVIDERS) == set(KEY_VARS) | {"ollama", *CUSTOM_SERVERS}
    assert PROVIDERS[-3:] == CUSTOM_SERVERS
    for name, preset in PRESETS.items():
        if name in CUSTOM_SERVERS:
            assert preset.base_url is None and preset.default_model is None
            assert preset.key_env == () and not preset.requires_key and not preset.paid_only
            assert dataclasses.replace(preset, name="custom", label="") == dataclasses.replace(
                PRESETS["custom"], label=""
            )
            continue
        assert preset.base_url and preset.default_model
        if name != "ollama":
            assert preset.base_url.startswith("https://")


@pytest.mark.parametrize("provider", sorted(KEY_VARS))
def test_each_preset_loads_with_its_own_key_variable(provider: str) -> None:
    env = {"POTONGIN_LLM_PROVIDER": provider, KEY_VARS[provider]: SECRET}

    config = load_llm_config(env)

    assert config is not None
    preset = PRESETS[provider]
    assert config.provider == provider
    assert config.base_url == preset.base_url
    assert config.model == preset.default_model
    assert config.fallback_models == tuple(m for m in preset.fallback_models if m != config.model)
    assert config.api_key == SECRET
    assert config.json_mode is preset.json_mode
    assert config.context_tokens == preset.context_tokens
    assert SECRET not in repr(config)


def test_generic_key_takes_precedence_and_gemini_accepts_google_key() -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "gemini", "POTONGIN_LLM_API_KEY": "generic",
                              "GEMINI_API_KEY": "specific"})
    assert config is not None and config.api_key == "generic"
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "Gemini", "GOOGLE_API_KEY": "google"})
    assert config is not None and config.api_key == "google"


def test_missing_key_is_unavailable_and_names_the_variable() -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "groq", "GEMINI_API_KEY": SECRET})
    assert caught.value.code == "missing_api_key"
    assert "GROQ_API_KEY" in str(caught.value)
    assert SECRET not in str(caught.value)


def test_ollama_needs_no_key() -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "ollama"})
    assert config is not None
    assert config.api_key is None
    assert config.base_url == "http://localhost:11434/v1"
    assert config.public_dict()["api_key_set"] is False


def test_local_ollama_never_sends_the_cloud_key() -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "ollama", "OLLAMA_API_KEY": SECRET})
    assert config is not None and config.api_key is None


def test_ollama_cloud_preset_and_underscore_alias() -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "ollama_cloud", "OLLAMA_API_KEY": SECRET,
                              "POTONGIN_LLM_OLLAMA_CLOUD_MODEL": "gemma4:31b"})
    assert config is not None
    assert config.provider == "ollama-cloud"
    assert config.base_url == "https://ollama.com/v1"
    assert config.model == "gemma4:31b"
    assert config.api_key == SECRET


def test_cloud_presets_fit_a_whole_episode_in_one_request() -> None:
    # Checked 2026-09-24: ollama.com/api/show reports gpt-oss:120b at 131072 tokens and
    # qwen3.5:397b / gemma4:31b at 262144; openrouter.ai/api/v1/models reports
    # qwen/qwen3.8-27b:free and google/gemma-4-31b-it:free at 262144 and openrouter/free at
    # 200000. The budget is the smallest context in each default chain. A 65-minute episode with
    # the editorial standard is about 30k tokens, and gpt-oss spends output tokens on reasoning.
    assert PRESETS["ollama-cloud"].context_tokens == 131_072
    assert PRESETS["ollama-cloud"].max_output_tokens == 16_384
    assert PRESETS["openrouter"].context_tokens == 131_072
    assert PRESETS["openrouter"].max_output_tokens == 8192


def test_ollama_in_docker_can_use_host_gateway() -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "ollama",
                              "POTONGIN_LLM_BASE_URL": "http://host.docker.internal:11434/v1/"})
    assert config is not None and config.base_url == "http://host.docker.internal:11434/v1"


def test_custom_requires_base_url_and_model() -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "custom", "POTONGIN_LLM_MODEL": "x"})
    assert caught.value.code == "config_invalid"
    assert "POTONGIN_LLM_BASE_URL" in str(caught.value)
    with pytest.raises(LLMUnavailable):
        load_llm_config({"POTONGIN_LLM_PROVIDER": "custom",
                         "POTONGIN_LLM_BASE_URL": "https://llm.example.com/v1"})
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "custom",
                              "POTONGIN_LLM_BASE_URL": "https://llm.example.com/v1",
                              "POTONGIN_LLM_MODEL": "my-model"})
    assert config is not None and config.api_key is None and config.model == "my-model"


HERMES_KEY = "hermes-key-AAAA1111zz"
ROUTER_KEY = "9router-key-BBBB2222yy"
THIRD_KEY = "third-key-CCCC3333xx"
THREE_SERVERS = {
    "POTONGIN_LLM_PROVIDERS": "custom,custom2,CUSTOM3",
    "POTONGIN_LLM_CUSTOM_NAME": "Hermes",
    "POTONGIN_LLM_CUSTOM_BASE_URL": "https://hermes.example/v1",
    "POTONGIN_LLM_CUSTOM_MODEL": "LJNAI-FAST",
    "POTONGIN_LLM_CUSTOM_API_KEY": HERMES_KEY,
    "POTONGIN_LLM_CUSTOM_REASONING_EFFORT": "none",
    "POTONGIN_LLM_CUSTOM2_NAME": "9Router",
    "POTONGIN_LLM_CUSTOM2_BASE_URL": "http://host.docker.internal:20128/v1",
    "POTONGIN_LLM_CUSTOM2_MODEL": "kr/glm-5",
    "POTONGIN_LLM_CUSTOM2_FALLBACK_MODELS": "combo-free, kr/claude-sonnet-4.5",
    "POTONGIN_LLM_CUSTOM2_API_KEY": ROUTER_KEY,
    "POTONGIN_LLM_CUSTOM2_REASONING_EFFORT": "LOW",
    "POTONGIN_LLM_CUSTOM2_CONTEXT_TOKENS": "65536",
    "POTONGIN_LLM_CUSTOM2_TIMEOUT": "240",
    "POTONGIN_LLM_CUSTOM3_BASE_URL": "http://localhost:1234/v1",
    "POTONGIN_LLM_CUSTOM3_MODEL": "qwen3.5:9b",
    "POTONGIN_LLM_CUSTOM3_API_KEY": THIRD_KEY,
}


def test_three_custom_servers_load_from_their_own_variables() -> None:
    hermes, router, third = load_llm_configs(THREE_SERVERS)

    assert (hermes.provider, router.provider, third.provider) == CUSTOM_SERVERS
    assert (hermes.base_url, hermes.model, hermes.api_key, hermes.reasoning_effort) == (
        "https://hermes.example/v1", "LJNAI-FAST", HERMES_KEY, "none")
    assert (router.base_url, router.model, router.api_key) == (
        "http://host.docker.internal:20128/v1", "kr/glm-5", ROUTER_KEY)
    assert router.fallback_models == ("combo-free", "kr/claude-sonnet-4.5")
    assert (router.reasoning_effort, router.context_tokens, router.timeout) == ("low", 65536, 240.0)
    assert (third.base_url, third.model, third.api_key) == (
        "http://localhost:1234/v1", "qwen3.5:9b", THIRD_KEY)
    assert third.context_tokens == PRESETS["custom3"].context_tokens
    assert third.reasoning_effort is None, "tuning of one server never leaks into another"
    for config in (hermes, router, third):
        shown = repr(config) + json.dumps(config.public_dict())
        assert all(key not in shown for key in (HERMES_KEY, ROUTER_KEY, THIRD_KEY))


def test_extra_custom_servers_never_take_the_shared_identity_variables() -> None:
    env = {
        "POTONGIN_LLM_PROVIDERS": "custom,custom2",
        "POTONGIN_LLM_BASE_URL": "https://hermes.example/v1",
        "POTONGIN_LLM_MODEL": "LJNAI-FAST",
        "POTONGIN_LLM_API_KEY": HERMES_KEY,
        "POTONGIN_LLM_CUSTOM2_BASE_URL": "https://router.example/v1",
        "POTONGIN_LLM_CUSTOM2_MODEL": "m2",
        "POTONGIN_LLM_TIMEOUT": "90",
    }

    hermes, router = load_llm_configs(env)

    assert (hermes.base_url, hermes.api_key) == ("https://hermes.example/v1", HERMES_KEY)
    assert (router.base_url, router.model, router.api_key) == ("https://router.example/v1", "m2",
                                                               None)
    assert hermes.timeout == router.timeout == 90.0, "shared tuning still applies to every server"


def test_a_listed_extra_server_without_its_url_or_model_names_its_own_variable() -> None:
    for missing, variable in (("BASE_URL", "POTONGIN_LLM_CUSTOM2_BASE_URL"),
                              ("MODEL", "POTONGIN_LLM_CUSTOM2_MODEL")):
        env = {name: value for name, value in THREE_SERVERS.items()
               if name != f"POTONGIN_LLM_CUSTOM2_{missing}"}
        with pytest.raises(LLMUnavailable) as caught:
            load_llm_configs(env)
        assert caught.value.code == "config_invalid"
        assert caught.value.provider == "custom2"
        assert variable in caught.value.message
        assert ROUTER_KEY not in caught.value.message
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "custom3", "POTONGIN_LLM_CUSTOM3_MODEL": "m"})
    assert caught.value.code == "config_invalid"
    assert "POTONGIN_LLM_CUSTOM3_BASE_URL" in caught.value.message


def test_free_only_treats_every_custom_server_as_the_owners_own() -> None:
    configs = load_llm_configs({**THREE_SERVERS, "POTONGIN_LLM_FREE_ONLY": "1",
                                "POTONGIN_LLM_CUSTOM2_MODEL": "cx/gpt-5.5"})
    assert [config.provider for config in configs] == list(CUSTOM_SERVERS)
    assert configs[1].model_chain == ("cx/gpt-5.5", "combo-free", "kr/claude-sonnet-4.5")
    assert all(llm.is_free_model(name, "any/model") for name in CUSTOM_SERVERS)


def test_failover_runs_through_custom_servers_with_each_servers_own_key(
    server: FakeServer,
) -> None:
    server.reply(error_reply(401, "bad key"), chat('{"ok": true}'))
    env = {
        "POTONGIN_LLM_PROVIDERS": "custom,custom2",
        "POTONGIN_LLM_CUSTOM_BASE_URL": f"{server.base_url}/hermes",
        "POTONGIN_LLM_CUSTOM_MODEL": "LJNAI-FAST",
        "POTONGIN_LLM_CUSTOM_API_KEY": HERMES_KEY,
        "POTONGIN_LLM_CUSTOM2_BASE_URL": f"{server.base_url}/router",
        "POTONGIN_LLM_CUSTOM2_MODEL": "kr/glm-5",
        "POTONGIN_LLM_CUSTOM2_API_KEY": ROUTER_KEY,
        "POTONGIN_LLM_MAX_RETRIES": "0",
    }
    client = create_llm_client_from_env(env)
    assert isinstance(client, FailoverLLMClient)

    response = call(client)

    assert (response.provider, response.data) == ("custom2", {"ok": True})
    seen = [(request["path"], request["headers"]["authorization"]) for request in server.requests]
    assert seen == [("/v1/hermes/chat/completions", f"Bearer {HERMES_KEY}"),
                    ("/v1/router/chat/completions", f"Bearer {ROUTER_KEY}")]


@pytest.mark.parametrize("value", ["off", "OFF", "0", "false", "disabled"])
def test_off_switch_disables_even_when_configured(value: str) -> None:
    env = {"POTONGIN_LLM": value, "POTONGIN_LLM_PROVIDER": "gemini", "GEMINI_API_KEY": SECRET}
    assert load_llm_config(env) is None


def test_unconfigured_returns_none() -> None:
    assert load_llm_config({}) is None
    assert load_llm_config({"GEMINI_API_KEY": SECRET}) is None


def test_unknown_provider_is_invalid() -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "skynet"})
    assert caught.value.code == "config_invalid"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/v1",
        "http://10.0.0.5:11434/v1",
        "ftp://example.com/v1",
        "https://user:pass@example.com/v1",
        "https://example.com/v1?key=abc",
        "not a url",
        "https:///v1",
    ],
)
def test_unsafe_base_urls_are_rejected(url: str) -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "custom", "POTONGIN_LLM_BASE_URL": url,
                         "POTONGIN_LLM_MODEL": "m"})
    assert caught.value.code == "config_invalid"
    assert "pass" not in str(caught.value)


@pytest.mark.parametrize(
    "url",
    ["http://localhost:8000/v1", "http://127.0.0.1:1234/v1", "http://[::1]:11434/v1",
     "http://host.docker.internal:11434/v1", "https://llm.example.com/v1"],
)
def test_local_http_and_https_base_urls_are_allowed(url: str) -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "custom", "POTONGIN_LLM_BASE_URL": url,
                              "POTONGIN_LLM_MODEL": "m"})
    assert config is not None and config.base_url == url


def test_tuning_variables_are_parsed() -> None:
    config = load_llm_config({
        "POTONGIN_LLM_PROVIDER": "openrouter",
        "OPENROUTER_API_KEY": SECRET,
        "POTONGIN_LLM_MODEL": "a/b:free",
        "POTONGIN_LLM_FALLBACK_MODELS": " c/d:free, ,a/b:free, e/f , c/d:free",
        "POTONGIN_LLM_TIMEOUT": "45.5",
        "POTONGIN_LLM_RPM": "12",
        "POTONGIN_LLM_JSON_MODE": "false",
        "POTONGIN_LLM_CONTEXT_TOKENS": "16000",
        "POTONGIN_LLM_MAX_OUTPUT_TOKENS": "2048",
        "POTONGIN_LLM_MAX_RETRIES": "1",
        "POTONGIN_LLM_TEMPERATURE": "0",
        "POTONGIN_LLM_HTTP_REFERER": "https://potongin.test",
        "POTONGIN_LLM_APP_TITLE": "Potongin Dev",
    })
    assert config is not None
    assert config.model == "a/b:free"
    assert config.fallback_models == ("c/d:free", "e/f")
    assert config.model_chain == ("a/b:free", "c/d:free", "e/f")
    assert config.timeout == 45.5
    assert config.requests_per_minute == 12.0
    assert config.json_mode is False
    assert config.context_tokens == 16000
    assert config.max_output_tokens == 2048
    assert config.max_retries == 1
    assert config.temperature == 0.0
    assert config.http_referer == "https://potongin.test"
    assert config.app_title == "Potongin Dev"


def test_reasoning_effort_variable() -> None:
    base = {"POTONGIN_LLM_PROVIDER": "groq", "GROQ_API_KEY": SECRET}
    config = load_llm_config(base)
    assert config is not None and config.reasoning_effort is None
    config = load_llm_config({**base, "POTONGIN_LLM_REASONING_EFFORT": "LOW"})
    assert config is not None and config.reasoning_effort == "low"
    assert config.public_dict()["reasoning_effort"] == "low"
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({**base, "POTONGIN_LLM_REASONING_EFFORT": "turbo"})
    assert "POTONGIN_LLM_REASONING_EFFORT" in str(caught.value)


@pytest.mark.parametrize("value", ["0", "off", "none"])
def test_rpm_can_be_disabled(value: str) -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "cerebras", "CEREBRAS_API_KEY": SECRET,
                              "POTONGIN_LLM_RPM": value})
    assert config is not None and config.requests_per_minute is None


def test_empty_variables_mean_preset_defaults() -> None:
    empty = {name: "" for name in (
        "POTONGIN_LLM", "POTONGIN_LLM_API_KEY", "POTONGIN_LLM_BASE_URL", "POTONGIN_LLM_MODEL",
        "POTONGIN_LLM_FALLBACK_MODELS", "POTONGIN_LLM_TIMEOUT", "POTONGIN_LLM_RPM",
        "POTONGIN_LLM_JSON_MODE", "POTONGIN_LLM_CONTEXT_TOKENS", "POTONGIN_LLM_MAX_OUTPUT_TOKENS",
    )}
    config = load_llm_config({**empty, "POTONGIN_LLM_PROVIDER": "cerebras",
                              "CEREBRAS_API_KEY": SECRET})
    preset = PRESETS["cerebras"]
    assert config is not None
    assert config.api_key == SECRET
    assert (config.base_url, config.model) == (preset.base_url, preset.default_model)
    assert config.requests_per_minute == preset.requests_per_minute
    assert config.fallback_models == preset.fallback_models
    assert config.timeout == preset.timeout
    assert load_llm_config({**empty, "POTONGIN_LLM_PROVIDER": ""}) is None


def test_fallbacks_can_be_disabled() -> None:
    config = load_llm_config({"POTONGIN_LLM_PROVIDER": "gemini", "GEMINI_API_KEY": SECRET,
                              "POTONGIN_LLM_FALLBACK_MODELS": "none"})
    assert config is not None and config.fallback_models == ()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("POTONGIN_LLM_TIMEOUT", "abc"),
        ("POTONGIN_LLM_TIMEOUT", "0"),
        ("POTONGIN_LLM_TIMEOUT", "nan"),
        ("POTONGIN_LLM_RPM", "-3"),
        ("POTONGIN_LLM_JSON_MODE", "maybe"),
        ("POTONGIN_LLM_CONTEXT_TOKENS", "12.5"),
        ("POTONGIN_LLM_CONTEXT_TOKENS", "10"),
        ("POTONGIN_LLM_MAX_OUTPUT_TOKENS", "-1"),
        ("POTONGIN_LLM_MAX_RETRIES", "99"),
        ("POTONGIN_LLM_TEMPERATURE", "5"),
    ],
)
def test_invalid_numbers_are_rejected(name: str, value: str) -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "ollama", name: value})
    assert caught.value.code == "config_invalid"
    assert name in str(caught.value)


def test_config_validates_direct_construction() -> None:
    with pytest.raises(ValueError):
        make_config("https://x.example/v1", temperature=2.5)
    with pytest.raises(ValueError):
        make_config("https://x.example/v1", provider="nope")
    with pytest.raises(ValueError):
        make_config("https://x.example/v1", api_key="has space")
    with pytest.raises(ValueError):
        make_config("http://example.com/v1")
    with pytest.raises(TypeError):
        make_config("https://x.example/v1", fallback_models=["m2"])
    with pytest.raises(dataclasses.FrozenInstanceError):
        make_config("https://x.example/v1").model = "other"  # type: ignore[misc]


# --- multi-provider failover ------------------------------------------------------------------


def test_provider_list_skips_providers_without_keys() -> None:
    env = {"POTONGIN_LLM_PROVIDERS": "gemini, groq ,openrouter", "GROQ_API_KEY": "g-key",
           "OPENROUTER_API_KEY": SECRET}

    configs = load_llm_configs(env)

    assert [config.provider for config in configs] == ["groq", "openrouter"]
    assert [config.api_key for config in configs] == ["g-key", SECRET]
    first = load_llm_config(env)
    assert first is not None and first.provider == "groq"


def test_singular_provider_variable_also_accepts_a_list_and_wins() -> None:
    env = {"POTONGIN_LLM_PROVIDER": "cerebras,groq", "POTONGIN_LLM_PROVIDERS": "gemini",
           "CEREBRAS_API_KEY": "c", "GROQ_API_KEY": "g", "GEMINI_API_KEY": "x"}
    assert [config.provider for config in load_llm_configs(env)] == ["cerebras", "groq"]


def test_provider_list_without_any_key_names_every_variable() -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_configs({"POTONGIN_LLM_PROVIDERS": "gemini,groq"})
    assert caught.value.code == "missing_api_key"
    assert "GEMINI_API_KEY" in caught.value.message and "GROQ_API_KEY" in caught.value.message


def test_provider_list_skips_unknown_names_but_not_when_nothing_is_left() -> None:
    configs = load_llm_configs({"POTONGIN_LLM_PROVIDERS": "gemini,skynet", "GEMINI_API_KEY": "k"})
    assert [config.provider for config in configs] == ["gemini"]
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_configs({"POTONGIN_LLM_PROVIDERS": "skynet,hal"})
    assert caught.value.code == "config_invalid"
    assert "skynet" in caught.value.message


def test_unscoped_overrides_apply_to_the_first_listed_provider_only() -> None:
    env = {
        "POTONGIN_LLM_PROVIDERS": "gemini,groq",
        "GEMINI_API_KEY": "gk",
        "GROQ_API_KEY": "rk",
        "POTONGIN_LLM_MODEL": "gemini-x",
        "POTONGIN_LLM_FALLBACK_MODELS": "none",
        "POTONGIN_LLM_API_KEY": "generic",
        "POTONGIN_LLM_GROQ_MODEL": "groq-y",
        "POTONGIN_LLM_GROQ_CONTEXT_TOKENS": "6000",
        "POTONGIN_LLM_TIMEOUT": "33",
    }

    gemini, groq = load_llm_configs(env)

    assert (gemini.model, gemini.fallback_models, gemini.api_key) == ("gemini-x", (), "generic")
    assert groq.model == "groq-y"
    assert groq.fallback_models == PRESETS["groq"].fallback_models
    assert groq.api_key == "rk"
    assert groq.context_tokens == 6000
    assert gemini.context_tokens == PRESETS["gemini"].context_tokens
    assert gemini.timeout == groq.timeout == 33.0


def test_scoped_variable_errors_name_the_scoped_variable() -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_configs({"POTONGIN_LLM_PROVIDERS": "ollama", "POTONGIN_LLM_OLLAMA_RPM": "x"})
    assert "POTONGIN_LLM_OLLAMA_RPM" in caught.value.message


def test_free_only_filters_openrouter_models_and_skips_paid_providers() -> None:
    env = {
        "POTONGIN_LLM_PROVIDERS": "deepseek,openrouter",
        "POTONGIN_LLM_FREE_ONLY": "1",
        "DEEPSEEK_API_KEY": "d",
        "OPENROUTER_API_KEY": SECRET,
        "POTONGIN_LLM_OPENROUTER_MODEL": "anthropic/claude-paid",
        "POTONGIN_LLM_OPENROUTER_FALLBACK_MODELS": "a/b:free,c/d,openrouter/free",
    }

    [config] = load_llm_configs(env)

    assert config.provider == "openrouter"
    assert config.model_chain == ("a/b:free", "openrouter/free")


def test_free_only_rejects_a_single_paid_provider() -> None:
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "openai", "OPENAI_API_KEY": "k",
                         "POTONGIN_LLM_FREE_ONLY": "true"})
    assert caught.value.code == "not_free"
    with pytest.raises(LLMUnavailable) as caught:
        load_llm_config({"POTONGIN_LLM_PROVIDER": "openrouter", "OPENROUTER_API_KEY": "k",
                         "POTONGIN_LLM_FREE_ONLY": "1", "POTONGIN_LLM_MODEL": "x/paid",
                         "POTONGIN_LLM_FALLBACK_MODELS": "none"})
    assert caught.value.code == "not_free"


def test_owner_env_shape_uses_keyed_free_providers_in_order() -> None:
    env = {
        "POTONGIN_LLM_PROVIDERS": "ollama-cloud,openrouter,gemini,groq",
        "GEMINI_API_KEY": "",
        "GROQ_API_KEY": "",
        "OPENROUTER_API_KEY": SECRET,
        "OLLAMA_API_KEY": "ollama-key-123",
        "POTONGIN_LLM_FREE_ONLY": "1",
    }

    cloud, openrouter = load_llm_configs(env)

    assert (cloud.provider, cloud.api_key) == ("ollama-cloud", "ollama-key-123")
    assert openrouter.provider == "openrouter"
    assert all(model.endswith(":free") or model == "openrouter/free"
               for model in openrouter.model_chain)


def test_failover_client_moves_to_next_provider() -> None:
    first = ScriptedLLMClient([LLMError("auth", "kunci salah", provider="groq", model="g1",
                                        attempts=(("g1", "auth"),))], provider="groq", model="g1")
    second = ScriptedLLMClient([{"a": 1}], provider="openrouter", model="o1")
    client = FailoverLLMClient([first, second])

    response = client.complete_json(system="s", user="u", temperature=0.3)

    assert response.provider == "openrouter" and response.data == {"a": 1}
    assert second.calls[0]["temperature"] == 0.3
    assert client.provider == "groq+openrouter"
    assert client.model_chain == ("groq/g1", "openrouter/o1")


def test_failover_client_reports_every_attempt_when_all_fail() -> None:
    first = ScriptedLLMClient([LLMError("quota_exhausted", "habis", provider="gemini",
                                        model="m1", attempts=(("m1", "quota_exhausted"),
                                                              ("m2", "rate_limited")))],
                              provider="gemini", model="m1")
    second = ScriptedLLMClient([LLMError("timeout", "lambat", provider="groq", model="g1")],
                               provider="groq", model="g1")

    with pytest.raises(LLMError) as caught:
        FailoverLLMClient([first, second]).complete_json(system="s", user="u")

    assert caught.value.code == "timeout"
    assert caught.value.attempts == (
        ("gemini/m1", "quota_exhausted"), ("gemini/m2", "rate_limited"), ("groq/g1", "timeout"),
    )
    assert "gemini" in caught.value.message and "groq" in caught.value.message


def test_create_client_from_env(tmp_path: Path) -> None:
    assert create_llm_client_from_env({}) is None
    single = create_llm_client_from_env({"POTONGIN_LLM_PROVIDER": "ollama"})
    assert isinstance(single, OpenAICompatibleClient)
    multi = create_llm_client_from_env(
        {"POTONGIN_LLM_PROVIDERS": "ollama,groq", "GROQ_API_KEY": "k"}, cache_dir=tmp_path
    )
    assert isinstance(multi, CachedLLMClient)
    assert isinstance(multi.inner, FailoverLLMClient)
    assert [client.provider for client in multi.inner.clients] == ["ollama", "groq"]
    cached = create_llm_client(make_config("https://x.example/v1"), cache_dir=tmp_path)
    assert isinstance(cached, CachedLLMClient)


def test_cache_over_failover_keys_on_every_provider(tmp_path: Path) -> None:
    def build(model: str) -> FailoverLLMClient:
        return FailoverLLMClient([
            OpenAICompatibleClient(make_config("https://a.example/v1", provider="groq")),
            OpenAICompatibleClient(make_config("https://b.example/v1", provider="gemini",
                                               model=model)),
        ])

    one = CachedLLMClient(build("m1"), tmp_path).cache_key(system="s", user="u")
    same = CachedLLMClient(build("m1"), tmp_path).cache_key(system="s", user="u")
    other = CachedLLMClient(build("m2"), tmp_path).cache_key(system="s", user="u")
    assert one == same != other


def test_cli_check_multi_provider_reports_each(server: FakeServer) -> None:
    server.reply(error_reply(401, "bad key"), chat('{"ok": true}'))
    env = {
        "POTONGIN_LLM_PROVIDERS": "gemini,groq,openrouter",
        "POTONGIN_LLM_GROQ_BASE_URL": server.base_url,
        "POTONGIN_LLM_OPENROUTER_BASE_URL": server.base_url,
        "GROQ_API_KEY": "bad",
        "OPENROUTER_API_KEY": SECRET,
    }

    code, output = run_cli(["--check", "--json"], env)

    assert code == 0
    payload = json.loads(output)
    assert payload["ok"] is True
    statuses = {item["provider"]: item for item in payload["providers"]}
    assert statuses["gemini"]["status"] == "skipped"
    assert statuses["gemini"]["error"]["code"] == "missing_api_key"
    assert statuses["groq"]["status"] == "failed"
    assert statuses["groq"]["error"]["code"] == "auth"
    assert statuses["openrouter"]["status"] == "ok"
    assert SECRET not in output


# --- cache ------------------------------------------------------------------------------------


def test_cache_hit_and_miss(tmp_path: Path) -> None:
    inner = ScriptedLLMClient([{"n": 1}, {"n": 2}, {"n": 3}, {"n": 4}])
    config = make_config("https://x.example/v1", provider="gemini")
    cache = CachedLLMClient(inner, tmp_path / "cache", config=config)

    first = cache.complete_json(system="s", user="u")
    second = cache.complete_json(system="s", user="u")
    third = cache.complete_json(system="s", user="u2")
    fourth = cache.complete_json(system="s", user="u", temperature=0.9)
    fifth = cache.complete_json(system="s", user="u", max_output_tokens=10)

    assert (first.cached, second.cached, third.cached) == (False, True, False)
    assert second.data == first.data == {"n": 1}
    assert third.data == {"n": 2}
    assert fourth.data == {"n": 3} and fourth.cached is False
    assert fifth.data == {"n": 4} and fifth.cached is False
    assert len(inner.calls) == 4
    files = sorted((tmp_path / "cache").iterdir())
    assert len(files) == 4
    assert all(path.suffix == ".json" for path in files)
    for path in files:
        content = path.read_text()
        json.loads(content)
        assert SECRET not in content


def test_cache_key_depends_on_provider_and_model_chain(tmp_path: Path) -> None:
    inner = ScriptedLLMClient([{"n": 1}, {"n": 2}, {"n": 3}])
    base = make_config("https://x.example/v1", provider="gemini")
    CachedLLMClient(inner, tmp_path, config=base).complete_json(system="s", user="u")
    CachedLLMClient(inner, tmp_path, config=dataclasses.replace(base, provider="groq")) \
        .complete_json(system="s", user="u")
    response = CachedLLMClient(
        inner, tmp_path, config=dataclasses.replace(base, fallback_models=("m2",))
    ).complete_json(system="s", user="u")
    assert response.cached is False
    assert len(inner.calls) == 3


def test_cache_ignores_corrupt_entries_and_does_not_cache_failures(tmp_path: Path) -> None:
    inner = ScriptedLLMClient([LLMError("rate_limited", "kuota"), {"n": 1}])
    cache = CachedLLMClient(inner, tmp_path)
    with pytest.raises(LLMError):
        cache.complete_json(system="s", user="u")
    assert list(tmp_path.iterdir()) == []

    assert cache.complete_json(system="s", user="u").cached is False
    [entry] = list(tmp_path.iterdir())
    entry.write_text("{broken")
    inner.responses.append({"n": 2})
    response = cache.complete_json(system="s", user="u")
    assert response.cached is False and response.data == {"n": 2}
    assert cache.complete_json(system="s", user="u").cached is True
    assert [path.name for path in tmp_path.iterdir()] == [entry.name]


def test_cache_wraps_real_client(server: FakeServer, tmp_path: Path) -> None:
    server.reply(chat('{"a": 1}', usage={"prompt_tokens": 5, "completion_tokens": 2}))
    cache = CachedLLMClient(make_client(make_config(server.base_url)), tmp_path)

    first = call(cache)
    second = call(cache)

    assert first.cached is False and second.cached is True
    assert second.data == {"a": 1}
    assert (second.input_tokens, second.output_tokens) == (5, 2)
    assert second.model == first.model
    assert len(server.requests) == 1


# --- scripted client --------------------------------------------------------------------------


def test_scripted_client_replays_and_records() -> None:
    def dynamic(system: str, user: str) -> dict[str, object]:
        return {"echo": user}

    client = ScriptedLLMClient([{"a": 1}, dynamic, '```json\n{"b": 2}\n```',
                                LLMError("timeout", "lambat")])

    assert client.complete_json(system="s", user="u1").data == {"a": 1}
    assert client.complete_json(system="s", user="u2", temperature=0.1).data == {"echo": "u2"}
    assert client.complete_json(system="s", user="u3").data == {"b": 2}
    with pytest.raises(LLMError) as caught:
        client.complete_json(system="s", user="u4")
    assert caught.value.code == "timeout"
    with pytest.raises(LLMError) as exhausted:
        client.complete_json(system="s", user="u5")
    assert exhausted.value.code == "script_exhausted"
    assert [entry["user"] for entry in client.calls] == ["u1", "u2", "u3", "u4", "u5"]
    assert client.calls[1]["temperature"] == 0.1
    response = ScriptedLLMClient([{"a": 1}], model="fake").complete_json(system="s", user="u")
    assert (response.provider, response.model, response.cached) == ("scripted", "fake", False)


def test_scripted_client_returns_given_response_objects() -> None:
    given = LLMResponse(data={"x": 1}, text='{"x": 1}', model="m", provider="p", input_tokens=1,
                        output_tokens=1, latency_s=0.0, cached=False)
    assert ScriptedLLMClient([lambda system, user: given]).complete_json(system="s", user="u") \
        is given


# --- command line -----------------------------------------------------------------------------


def run_cli(argv: list[str], env: dict[str, str]) -> tuple[int, str]:
    out = io.StringIO()
    code = llm.main(argv, env=env, stdout=out)
    return code, out.getvalue()


def test_cli_show_presets_lists_every_provider() -> None:
    code, output = run_cli(["--show-presets"], {})
    assert code == 0
    for provider in PROVIDERS:
        assert provider in output
    assert "GEMINI_API_KEY" in output


def test_cli_show_presets_names_each_custom_servers_own_variables() -> None:
    code, output = run_cli(["--show-presets"], {})
    assert code == 0
    for name in ("CUSTOM", "CUSTOM2", "CUSTOM3"):
        assert f"POTONGIN_LLM_{name}_BASE_URL" in output
        assert f"POTONGIN_LLM_{name}_MODEL" in output


def test_cli_show_presets_json() -> None:
    code, output = run_cli(["--show-presets", "--json"], {})
    assert code == 0
    payload = json.loads(output)
    assert set(payload) == set(PROVIDERS)


def test_cli_check_success_prints_public_config_without_key(server: FakeServer) -> None:
    server.reply(chat('{"ok": true}'))
    env = {"POTONGIN_LLM_PROVIDER": "custom", "POTONGIN_LLM_BASE_URL": server.base_url,
           "POTONGIN_LLM_MODEL": "m1", "POTONGIN_LLM_API_KEY": SECRET}

    code, output = run_cli(["--check"], env)

    assert code == 0
    assert "OK" in output
    assert server.base_url in output
    assert SECRET not in output
    assert '{"ok": true}' in server.bodies()[0]["messages"][-1]["content"]


def test_cli_check_failure_is_exit_1_with_indonesian_message(server: FakeServer) -> None:
    server.reply(error_reply(401, f"bad key {SECRET}"))
    env = {"POTONGIN_LLM_PROVIDER": "custom", "POTONGIN_LLM_BASE_URL": server.base_url,
           "POTONGIN_LLM_MODEL": "m1", "POTONGIN_LLM_API_KEY": SECRET}

    code, output = run_cli(["--check"], env)

    assert code == 1
    assert "GAGAL" in output and "auth" in output
    assert SECRET not in output


def test_cli_check_rejects_wrong_ping_answer(server: FakeServer) -> None:
    server.reply(chat('{"ok": false}'))
    env = {"POTONGIN_LLM_PROVIDER": "custom", "POTONGIN_LLM_BASE_URL": server.base_url,
           "POTONGIN_LLM_MODEL": "m1"}

    code, output = run_cli(["--check", "--json"], env)

    assert code == 1
    payload = json.loads(output)
    assert payload["ok"] is False
    assert payload["config"]["model"] == "m1"


def test_cli_check_reports_unconfigured_and_disabled() -> None:
    code, output = run_cli(["--check"], {})
    assert code == 1 and "belum dikonfigurasi" in output
    code, output = run_cli(["--check"], {"POTONGIN_LLM": "off", "POTONGIN_LLM_PROVIDER": "ollama"})
    assert code == 1 and "dimatikan" in output
    code, output = run_cli(["--check", "--json"], {"POTONGIN_LLM_PROVIDER": "groq"})
    assert code == 1
    assert json.loads(output)["error"]["code"] == "missing_api_key"
