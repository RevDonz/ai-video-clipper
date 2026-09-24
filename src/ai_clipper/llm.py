"""Provider-agnostic JSON client for OpenAI-compatible Chat Completions APIs.

Every provider (Gemini AI Studio, Groq, OpenRouter, Cerebras, Mistral, DeepSeek, OpenAI,
local Ollama, Ollama Cloud, or any custom server) is reached through
``POST {base_url}/chat/completions`` with the standard library only. Configuration comes from
``POTONGIN_LLM_*`` environment variables so the owner can switch between free and cheap
providers without code changes. Several providers may be listed; they are tried in order.

The API key never appears in reprs, exceptions, logs, cache files, or command output.
"""

from __future__ import annotations

import argparse
import copy
import email.utils
import hashlib
import http.client
import json
import logging
import math
import os
import random
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from numbers import Real
from pathlib import Path
from types import MappingProxyType
from typing import Any, Protocol, TextIO, runtime_checkable

LOGGER = logging.getLogger(__name__)

NUDGE = "Return ONLY one valid JSON object."
JSON_HINT = "Respond with one valid JSON object only."
CACHE_FORMAT = "potongin-llm-cache-v1"
MAX_RETRY_WAIT = 60.0
QUOTA_COOLDOWN = 900.0
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
LOCAL_HTTP_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "host.docker.internal"})
PROVIDERS = (
    "gemini",
    "groq",
    "openrouter",
    "cerebras",
    "mistral",
    "deepseek",
    "openai",
    "ollama",
    "ollama-cloud",
    "custom",
    "custom2",
    "custom3",
)
# Up to three OpenAI-compatible servers of the owner's own (e.g. a self-hosted Hermes and a
# 9Router gateway), each configured with its own POTONGIN_LLM_CUSTOM<n>_* variables.
CUSTOM_PROVIDERS = ("custom", "custom2", "custom3")

REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high")
_OFF_VALUES = frozenset({"off", "0", "false", "no", "disabled", "disable", "none"})
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES = frozenset({"0", "false", "no", "off"})
_NONE_VALUES = frozenset({"none", "off", "-"})
_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
_MODEL_RE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,200}$")
_KEY_RE = re.compile(r"^[\x21-\x7e]{1,4096}$")
_TITLE_RE = re.compile(r"^[\x20-\x7e]{1,100}$")
_THINK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?(.*?)```", re.DOTALL)
_RETRY_DELAY_RE = re.compile(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"')
_DAILY_RE = re.compile(
    r"per[\s_-]?(?:day|week|month)|daily|weekly|monthly|session limit|\brpd\b", re.IGNORECASE
)
_PLAN_RE = re.compile(
    r"subscription|upgrade|your plan|premium|credits|billing|payment|paid model",
    re.IGNORECASE,
)
_CONTEXT_RE = re.compile(
    r"context[\s_-]?length|maximum context|context window|too many tokens|prompt is too long"
    r"|reduce the length",
    re.IGNORECASE,
)
_MODEL_MISSING_RE = re.compile(
    r"model.{0,80}(?:not found|does not exist|not exist|decommissioned|not available|"
    r"no longer|invalid model|not a valid model|unknown model)"
    r"|(?:no such|unknown|invalid) model|no endpoints found",
    re.IGNORECASE | re.DOTALL,
)
_UNSUPPORTED_WORDS = (
    "unsupported",
    "not supported",
    "does not support",
    "only the default",
    "unrecognized",
    "unknown parameter",
    "extra inputs",
    "not permitted",
)
_REDACTED = "[disembunyikan]"
_SECRET_PATTERNS = (
    re.compile(r"(?i)\bbearer\s+[^\s\"',]+"),
    re.compile(r"\b(?:sk|gsk|csk|xai|pk|rk)[-_][A-Za-z0-9_\-*.]{6,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{16,}"),
    re.compile(r"\b[A-Za-z0-9]{32,}\b"),
)


# --- errors -----------------------------------------------------------------------------------


class LLMError(Exception):
    """A sanitized LLM failure; its message is safe to show to users and store in artifacts."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        provider: str | None = None,
        model: str | None = None,
        status: int | None = None,
        retryable: bool = False,
        retry_after: float | None = None,
        attempts: tuple[tuple[str, str], ...] = (),
    ) -> None:
        if not isinstance(code, str) or not _CODE_RE.match(code):
            raise ValueError("LLM error code must be a short lowercase identifier")
        if not isinstance(message, str) or not message.strip():
            raise ValueError("LLM error message cannot be empty")
        super().__init__(message)
        self.code = code
        self.message = message
        self.provider = provider
        self.model = model
        self.status = status
        self.retryable = retryable
        self.retry_after = retry_after
        self.attempts = tuple(attempts)

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(code={self.code!r}, message={self.message!r}, "
            f"provider={self.provider!r}, model={self.model!r}, status={self.status!r})"
        )

    def __reduce__(self):
        return (_rebuild_error, (type(self), self.to_dict(), self.retryable, self.retry_after))

    def to_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "message": self.message,
            "provider": self.provider,
            "model": self.model,
            "status": self.status,
            "attempts": [{"model": model, "code": code} for model, code in self.attempts],
        }

    def with_attempts(self, attempts: tuple[tuple[str, str], ...], message: str | None = None):
        """Return a copy of this error that records every model tried."""
        return type(self)(
            self.code,
            message or self.message,
            provider=self.provider,
            model=self.model,
            status=self.status,
            retryable=self.retryable,
            retry_after=self.retry_after,
            attempts=attempts,
        )


class LLMUnavailable(LLMError):
    """The LLM is not usable because of configuration (missing key, invalid values)."""


def _rebuild_error(
    cls: type[LLMError], payload: dict[str, Any], retryable: bool, retry_after: float | None
) -> LLMError:
    return cls(
        payload["code"],
        payload["message"],
        provider=payload["provider"],
        model=payload["model"],
        status=payload["status"],
        retryable=retryable,
        retry_after=retry_after,
        attempts=tuple((item["model"], item["code"]) for item in payload["attempts"]),
    )


class _BadJSON(Exception):
    """Internal signal: the model answered but no JSON object could be extracted."""


def _redact(text: str, secrets: Iterable[str | None] = ()) -> str:
    for secret in secrets:
        if secret and len(secret) >= 4:
            text = text.replace(secret, _REDACTED)
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(_REDACTED, text)
    return text


# --- presets ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ProviderPreset:
    """Defaults for one provider. Model IDs change often; every value can be overridden."""

    name: str
    label: str
    base_url: str | None
    default_model: str | None
    fallback_models: tuple[str, ...]
    key_env: tuple[str, ...]
    requires_key: bool
    json_mode: bool
    requests_per_minute: float | None
    context_tokens: int
    max_output_tokens: int
    timeout: float
    max_tokens_param: str
    free_tier: str
    docs_url: str
    paid_only: bool = False


def _custom_preset(name: str, label: str) -> ProviderPreset:
    """A server of the owner's own: base URL and model are required, the key is optional."""
    return ProviderPreset(
        name=name,
        label=label,
        base_url=None,
        default_model=None,
        fallback_models=(),
        key_env=(),
        requires_key=False,
        json_mode=True,
        requests_per_minute=None,
        context_tokens=32_768,
        max_output_tokens=4096,
        timeout=300.0,
        max_tokens_param="max_tokens",
        free_tier="tergantung server (Hermes, 9Router, LM Studio, vLLM, llama.cpp, dll.)",
        docs_url="docs/operations/LLM_PROVIDERS.md",
    )


PRESETS: Mapping[str, ProviderPreset] = MappingProxyType(
    {
        "gemini": ProviderPreset(
            name="gemini",
            label="Google AI Studio (Gemini)",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai",
            default_model="gemini-3.5-flash-lite",
            fallback_models=("gemini-3.1-flash-lite", "gemini-3.8-flash"),
            key_env=("GEMINI_API_KEY", "GOOGLE_API_KEY"),
            requires_key=True,
            json_mode=True,
            requests_per_minute=10.0,
            context_tokens=131_072,
            max_output_tokens=8192,
            timeout=180.0,
            max_tokens_param="max_tokens",
            free_tier="gratis; Flash-Lite ~500 permintaan/hari, Flash ~20/hari; data free tier "
            "boleh dipakai Google",
            docs_url="https://ai.google.dev/gemini-api/docs/openai",
        ),
        "groq": ProviderPreset(
            name="groq",
            label="Groq",
            base_url="https://api.groq.com/openai/v1",
            default_model="openai/gpt-oss-120b",
            fallback_models=("qwen/qwen3.8-27b", "openai/gpt-oss-20b"),
            key_env=("GROQ_API_KEY",),
            requires_key=True,
            json_mode=True,
            requests_per_minute=25.0,
            context_tokens=8000,
            max_output_tokens=3000,
            timeout=120.0,
            max_tokens_param="max_tokens",
            free_tier="gratis; 30 RPM, 1.000 RPD, 8K token/menit, 200K token/hari",
            docs_url="https://console.groq.com/docs/rate-limits",
        ),
        "openrouter": ProviderPreset(
            name="openrouter",
            label="OpenRouter",
            base_url="https://openrouter.ai/api/v1",
            default_model="qwen/qwen3.8-27b:free",
            fallback_models=("google/gemma-4-31b-it:free", "openrouter/free"),
            key_env=("OPENROUTER_API_KEY",),
            requires_key=True,
            json_mode=True,
            requests_per_minute=16.0,
            context_tokens=131_072,
            max_output_tokens=8192,
            timeout=180.0,
            max_tokens_param="max_tokens",
            free_tier="model ':free' gratis; 20 RPM, 50 RPD (1.000 RPD setelah beli 10 kredit)",
            docs_url="https://openrouter.ai/docs/api/reference/limits",
        ),
        "cerebras": ProviderPreset(
            name="cerebras",
            label="Cerebras",
            base_url="https://api.cerebras.ai/v1",
            default_model="gpt-oss-120b",
            fallback_models=("qwen-3.8-27b",),
            key_env=("CEREBRAS_API_KEY",),
            requires_key=True,
            json_mode=True,
            requests_per_minute=5.0,
            context_tokens=30_000,
            max_output_tokens=8192,
            timeout=120.0,
            max_tokens_param="max_tokens",
            free_tier="gratis; 5 RPM, 30K token/menit, 1 juta token/hari, konteks 64-65K",
            docs_url="https://inference-docs.cerebras.ai/support/rate-limits",
        ),
        "mistral": ProviderPreset(
            name="mistral",
            label="Mistral La Plateforme",
            base_url="https://api.mistral.ai/v1",
            default_model="mistral-small-latest",
            fallback_models=("mistral-medium-latest",),
            key_env=("MISTRAL_API_KEY",),
            requires_key=True,
            json_mode=True,
            requests_per_minute=50.0,
            context_tokens=32_000,
            max_output_tokens=8192,
            timeout=180.0,
            max_tokens_param="max_tokens",
            free_tier="paket Experiment gratis; ~1 permintaan/detik; data dipakai training "
            "kecuali opt-out",
            docs_url="https://docs.mistral.ai/api",
        ),
        "deepseek": ProviderPreset(
            name="deepseek",
            label="DeepSeek",
            base_url="https://api.deepseek.com",
            default_model="deepseek-flash",
            fallback_models=("deepseek-v4-pro",),
            key_env=("DEEPSEEK_API_KEY",),
            requires_key=True,
            json_mode=True,
            requests_per_minute=None,
            context_tokens=131_072,
            max_output_tokens=8192,
            timeout=300.0,
            max_tokens_param="max_tokens",
            free_tier="berbayar tapi sangat murah (~$0,15/1 juta token input); server di RRT",
            docs_url="https://api-docs.deepseek.com/",
            paid_only=True,
        ),
        "openai": ProviderPreset(
            name="openai",
            label="OpenAI",
            base_url="https://api.openai.com/v1",
            default_model="gpt-6-luna",
            fallback_models=(),
            key_env=("OPENAI_API_KEY",),
            requires_key=True,
            json_mode=True,
            requests_per_minute=None,
            context_tokens=131_072,
            max_output_tokens=16_384,
            timeout=180.0,
            max_tokens_param="max_completion_tokens",
            free_tier="berbayar ($0,10/$0,50 per 1 juta token untuk gpt-6-luna)",
            docs_url="https://developers.openai.com/api/docs/models",
            paid_only=True,
        ),
        "ollama": ProviderPreset(
            name="ollama",
            label="Ollama (lokal)",
            base_url="http://localhost:11434/v1",
            default_model="qwen3.5:9b",
            fallback_models=(),
            key_env=(),
            requires_key=False,
            json_mode=True,
            requests_per_minute=None,
            context_tokens=8192,
            max_output_tokens=4096,
            timeout=900.0,
            max_tokens_param="max_tokens",
            free_tier="gratis dan privat (jalan di mesin sendiri); lambat di CPU",
            docs_url="https://docs.ollama.com/api/openai-compatibility",
        ),
        "ollama-cloud": ProviderPreset(
            name="ollama-cloud",
            label="Ollama Cloud",
            base_url="https://ollama.com/v1",
            # Benchmarked 2026-09-24 on the two tuning episodes (gold hits@10, same pipeline):
            # gemma4:31b 9, gpt-oss:120b 4. On the Free plan, qwen3.5, deepseek-v4, kimi, glm,
            # minimax and mistral-large answer payment_required; gpt-oss:20b and nemotron-3
            # super/nano were truncated by reasoning, nemotron-3-ultra timed out.
            default_model="gemma4:31b",
            fallback_models=("gpt-oss:120b",),
            key_env=("OLLAMA_API_KEY",),
            requires_key=True,
            json_mode=True,
            requests_per_minute=10.0,
            context_tokens=131_072,
            max_output_tokens=16_384,
            timeout=300.0,
            max_tokens_param="max_tokens",
            free_tier="paket Free: kredit awal untuk model starter, 1 permintaan bersamaan; "
            "prompt tidak dicatat/dilatih",
            docs_url="https://docs.ollama.com/cloud",
        ),
        **{
            name: _custom_preset(name, label)
            for name, label in zip(
                CUSTOM_PROVIDERS,
                (
                    "Server OpenAI-compatible lain",
                    "Server OpenAI-compatible lain (2)",
                    "Server OpenAI-compatible lain (3)",
                ),
                strict=True,
            )
        },
    }
)


# --- validation helpers -----------------------------------------------------------------------


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _base_url_problem(url: object) -> str | None:
    """Return why ``url`` is unsafe or malformed, without echoing the URL itself."""
    if not isinstance(url, str) or not url.strip() or any(ch.isspace() for ch in url):
        return "harus berupa URL http(s) tanpa spasi"
    try:
        parts = urllib.parse.urlsplit(url)
        hostname = parts.hostname
        parts.port  # noqa: B018 - raises ValueError for an invalid port
    except ValueError:
        return "bukan URL yang valid"
    if parts.scheme not in {"http", "https"}:
        return "harus diawali https:// (atau http:// untuk server lokal)"
    if not hostname:
        return "tidak memiliki nama host"
    if parts.username is not None or parts.password is not None:
        return "tidak boleh berisi kredensial (user:...@)"
    if parts.query or parts.fragment:
        return "tidak boleh berisi query string atau fragment"
    if parts.scheme == "http" and hostname.lower() not in LOCAL_HTTP_HOSTS:
        return (
            "http:// hanya diizinkan untuk localhost, 127.0.0.1, ::1, atau "
            "host.docker.internal; pakai https://"
        )
    return None


def _model_problem(model: object) -> str | None:
    if not isinstance(model, str):
        return "harus berupa teks"
    if not _MODEL_RE.match(model):
        return "harus berupa ID model tanpa spasi (maks. 200 karakter)"
    return None


def _check_model(value: object, name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if _model_problem(value):
        raise ValueError(f"{name} must be a model ID without whitespace")
    return value


def _check_float(value: object, name: str, *, low: float, high: float, low_open: bool) -> float:
    if not _is_number(value):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    too_low = result <= low if low_open else result < low
    if not math.isfinite(result) or too_low or result > high:
        bound = "greater than" if low_open else "at least"
        raise ValueError(f"{name} must be finite, {bound} {low:g}, and at most {high:g}")
    return result


def _check_int(value: object, name: str, *, low: int, high: int) -> int:
    if not _is_int(value):
        raise TypeError(f"{name} must be an integer")
    if not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


# --- configuration ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class LLMConfig:
    """Resolved LLM settings. ``api_key`` is hidden from repr; use ``public_dict`` to show."""

    provider: str
    base_url: str
    model: str
    api_key: str | None = field(default=None, repr=False)
    fallback_models: tuple[str, ...] = ()
    timeout: float = 120.0
    max_retries: int = 3
    temperature: float = 0.2
    max_output_tokens: int = 4096
    json_mode: bool = True
    requests_per_minute: float | None = None
    context_tokens: int = 32_768
    http_referer: str | None = None
    app_title: str | None = None
    reasoning_effort: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.provider, str):
            raise TypeError("provider must be a string")
        if self.provider not in PRESETS:
            raise ValueError(f"provider must be one of: {', '.join(PROVIDERS)}")
        problem = _base_url_problem(self.base_url)
        if problem:
            raise ValueError(f"base_url {problem}")
        object.__setattr__(self, "base_url", self.base_url.rstrip("/"))
        _check_model(self.model, "model")
        if self.api_key is not None:
            if not isinstance(self.api_key, str):
                raise TypeError("api_key must be a string or None")
            if not _KEY_RE.match(self.api_key):
                raise ValueError("api_key must be non-empty printable ASCII without whitespace")
        if not isinstance(self.fallback_models, tuple):
            raise TypeError("fallback_models must be a tuple")
        for model in self.fallback_models:
            _check_model(model, "fallback model")
        timeout = _check_float(self.timeout, "timeout", low=0.0, high=3600.0, low_open=True)
        object.__setattr__(self, "timeout", timeout)
        _check_int(self.max_retries, "max_retries", low=0, high=10)
        temperature = _check_float(self.temperature, "temperature", low=0.0, high=2.0,
                                   low_open=False)
        object.__setattr__(self, "temperature", temperature)
        _check_int(self.max_output_tokens, "max_output_tokens", low=1, high=1_000_000)
        if not isinstance(self.json_mode, bool):
            raise TypeError("json_mode must be a boolean")
        if self.requests_per_minute is not None:
            rpm = _check_float(self.requests_per_minute, "requests_per_minute", low=0.0,
                               high=100_000.0, low_open=True)
            object.__setattr__(self, "requests_per_minute", rpm)
        _check_int(self.context_tokens, "context_tokens", low=512, high=10_000_000)
        if self.http_referer is not None:
            if not isinstance(self.http_referer, str):
                raise TypeError("http_referer must be a string or None")
            if not _TITLE_RE.match(self.http_referer) or not self.http_referer.startswith(
                ("http://", "https://")
            ) or " " in self.http_referer:
                raise ValueError("http_referer must be an http(s) URL")
        if self.app_title is not None:
            if not isinstance(self.app_title, str):
                raise TypeError("app_title must be a string or None")
            if not _TITLE_RE.match(self.app_title):
                raise ValueError("app_title must be printable ASCII (max 100 characters)")
        if self.reasoning_effort is not None and self.reasoning_effort not in REASONING_EFFORTS:
            raise ValueError(f"reasoning_effort must be one of: {', '.join(REASONING_EFFORTS)}")

    @property
    def model_chain(self) -> tuple[str, ...]:
        """The primary model followed by distinct fallbacks, in the order they are tried."""
        chain = [self.model]
        chain.extend(model for model in self.fallback_models if model not in chain)
        return tuple(dict.fromkeys(chain))

    @property
    def has_api_key(self) -> bool:
        return self.api_key is not None

    def public_dict(self) -> dict[str, object]:
        """Settings that are safe to print, log, or store; never includes the API key."""
        return {
            "provider": self.provider,
            "base_url": self.base_url,
            "model": self.model,
            "fallback_models": list(self.fallback_models),
            "timeout": self.timeout,
            "max_retries": self.max_retries,
            "temperature": self.temperature,
            "max_output_tokens": self.max_output_tokens,
            "json_mode": self.json_mode,
            "requests_per_minute": self.requests_per_minute,
            "context_tokens": self.context_tokens,
            "http_referer": self.http_referer,
            "app_title": self.app_title,
            "reasoning_effort": self.reasoning_effort,
            "api_key_set": self.api_key is not None,
        }


def _env_text(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _config_error(message: str, *, provider: str | None = None) -> LLMUnavailable:
    return LLMUnavailable("config_invalid", message, provider=provider)


def _parse_float(
    name: str,
    raw: str | None,
    default: float | None,
    *,
    low: float,
    high: float,
    low_open: bool,
    allow_off: bool = False,
) -> float | None:
    if raw is None:
        return default
    if allow_off and raw.lower() in _OFF_VALUES:
        return None
    try:
        value = float(raw)
    except ValueError:
        raise _config_error(f"{name} harus berupa angka.") from None
    if allow_off and value == 0:
        return None
    too_low = value <= low if low_open else value < low
    if not math.isfinite(value) or too_low or value > high:
        relation = "lebih dari" if low_open else "minimal"
        raise _config_error(f"{name} harus {relation} {low:g} dan maksimal {high:g}.")
    return value


def _parse_int(name: str, raw: str | None, default: int, *, low: int, high: int) -> int:
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise _config_error(f"{name} harus berupa bilangan bulat.") from None
    if not low <= value <= high:
        raise _config_error(f"{name} harus antara {low} dan {high}.")
    return value


def _parse_bool(name: str, raw: str | None, default: bool) -> bool:
    if raw is None:
        return default
    lowered = raw.lower()
    if lowered in _TRUE_VALUES:
        return True
    if lowered in _FALSE_VALUES:
        return False
    raise _config_error(f"{name} harus true/false (atau 1/0).")


def _parse_models(name: str, raw: str | None) -> tuple[str, ...] | None:
    if raw is None:
        return None
    if raw.lower() in _NONE_VALUES:
        return ()
    models = tuple(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    for model in models:
        if _model_problem(model):
            raise _config_error(f"{name} berisi ID model yang tidak valid (ada spasi?).")
    return models


def is_free_model(provider: str, model: str) -> bool:
    """Whether ``model`` is a zero-price model ID; only OpenRouter marks this in the ID.

    Custom servers (``custom``, ``custom2``, ``custom3``) are the owner's own, so
    ``POTONGIN_LLM_FREE_ONLY`` never filters them, even when they are a gateway to paid models.
    """
    if PRESETS[provider].paid_only:
        return False
    if provider == "openrouter":
        return model.endswith(":free") or model == "openrouter/free"
    return True


def llm_disabled(env: Mapping[str, str] | None = None) -> bool:
    """True when ``POTONGIN_LLM`` explicitly switches the LLM off."""
    switch = _env_text(os.environ if env is None else env, "POTONGIN_LLM")
    return switch is not None and switch.lower() in _OFF_VALUES


def configured_providers(env: Mapping[str, str] | None = None) -> tuple[str, ...]:
    """Provider names in failover order from ``POTONGIN_LLM_PROVIDER(S)``; () when unset."""
    env = os.environ if env is None else env
    raw = _env_text(env, "POTONGIN_LLM_PROVIDER")
    name = "POTONGIN_LLM_PROVIDER"
    if raw is None:
        raw = _env_text(env, "POTONGIN_LLM_PROVIDERS")
        name = "POTONGIN_LLM_PROVIDERS"
    if raw is None:
        return ()
    providers = tuple(dict.fromkeys(
        part.strip().lower().replace("_", "-") for part in raw.split(",") if part.strip()
    ))
    if not providers or any(not re.fullmatch(r"[a-z0-9-]{1,40}", item) for item in providers):
        raise _config_error(f"{name} harus berisi nama penyedia dipisah koma.")
    return providers


def _unknown_provider(provider: str, *, single: bool) -> LLMUnavailable:
    return LLMUnavailable(
        "config_invalid" if single else "unknown_provider",
        f"Penyedia '{provider}' tidak dikenal; pilih dari: {', '.join(PROVIDERS)}.",
        provider=provider,
    )


class _Settings:
    """Reads ``POTONGIN_LLM_<PROVIDER>_<NAME>`` first, then the shared ``POTONGIN_LLM_<NAME>``.

    Identity settings (key, base URL, model, fallbacks) are shared only with the primary
    (first listed) provider; tuning settings are shared with every provider.
    """

    _PRIMARY_ONLY = frozenset({"API_KEY", "BASE_URL", "MODEL", "FALLBACK_MODELS"})

    def __init__(self, env: Mapping[str, str], provider: str, *, primary: bool) -> None:
        self._env = env
        self._scope = f"POTONGIN_LLM_{provider.upper().replace('-', '_')}_"
        self._primary = primary

    def get(self, suffix: str) -> tuple[str, str | None]:
        scoped = f"{self._scope}{suffix}"
        value = _env_text(self._env, scoped)
        if value is not None:
            return scoped, value
        shared = f"POTONGIN_LLM_{suffix}"
        if suffix in self._PRIMARY_ONLY and not self._primary:
            return scoped, None
        return shared, _env_text(self._env, shared)

    def required(self, suffix: str) -> str:
        """The variable(s) to name when a required setting is missing."""
        scoped = f"{self._scope}{suffix}"
        if suffix in self._PRIMARY_ONLY and not self._primary:
            return scoped
        return f"{scoped} (atau POTONGIN_LLM_{suffix})"


def _provider_config(
    env: Mapping[str, str], provider: str, *, primary: bool, free_only: bool
) -> LLMConfig:
    preset = PRESETS[provider]
    settings = _Settings(env, provider, primary=primary)
    if free_only and preset.paid_only:
        raise LLMUnavailable(
            "not_free",
            f"POTONGIN_LLM_FREE_ONLY aktif, tetapi {provider} tidak punya model gratis.",
            provider=provider,
        )

    base_name, base_raw = settings.get("BASE_URL")
    base_url = base_raw or preset.base_url
    if base_url is None:
        raise _config_error(
            f"Penyedia {provider} wajib mengisi {settings.required('BASE_URL')}.", provider=provider
        )
    problem = _base_url_problem(base_url)
    if problem:
        raise _config_error(f"{base_name} {problem}.", provider=provider)

    model_name, model_raw = settings.get("MODEL")
    model = model_raw or preset.default_model
    if model is None:
        raise _config_error(
            f"Penyedia {provider} wajib mengisi {settings.required('MODEL')}.", provider=provider
        )
    if _model_problem(model):
        raise _config_error(f"{model_name} tidak valid (ID model tanpa spasi).", provider=provider)

    key_name, api_key = settings.get("API_KEY")
    for name in preset.key_env:
        if api_key is not None:
            break
        api_key = _env_text(env, name)
    if api_key is None and preset.requires_key:
        variables = " atau ".join((*preset.key_env[:1], key_name))
        raise LLMUnavailable(
            "missing_api_key",
            f"API key untuk {provider} belum diisi: set {variables} di .env.",
            provider=provider,
        )
    if api_key is not None and not _KEY_RE.match(api_key):
        raise _config_error("API key berisi spasi atau karakter yang tidak valid.",
                            provider=provider)

    fallbacks = _parse_models(*settings.get("FALLBACK_MODELS"))
    if fallbacks is None:
        fallbacks = preset.fallback_models
    chain = tuple(dict.fromkeys((model, *fallbacks)))
    if free_only:
        chain = tuple(item for item in chain if is_free_model(provider, item))
        if not chain:
            raise LLMUnavailable(
                "not_free",
                f"POTONGIN_LLM_FREE_ONLY aktif, tetapi tidak ada model gratis (':free') untuk "
                f"{provider}.",
                provider=provider,
            )

    def optional_number(suffix: str, default: float | None, **bounds: Any) -> float | None:
        name, raw = settings.get(suffix)
        return _parse_float(name, raw, default, **bounds)

    def number(suffix: str, default: float, **bounds: Any) -> float:
        value = optional_number(suffix, default, **bounds)
        return default if value is None else value

    def integer(suffix: str, default: int, *, low: int, high: int) -> int:
        name, raw = settings.get(suffix)
        return _parse_int(name, raw, default, low=low, high=high)

    effort_name, effort = settings.get("REASONING_EFFORT")
    if effort is not None:
        effort = effort.lower()
        if effort not in REASONING_EFFORTS:
            raise _config_error(
                f"{effort_name} harus salah satu: {', '.join(REASONING_EFFORTS)}.",
                provider=provider,
            )
    try:
        return LLMConfig(
            provider=provider,
            base_url=base_url,
            model=chain[0],
            api_key=api_key,
            fallback_models=chain[1:],
            timeout=number("TIMEOUT", preset.timeout, low=0.0, high=3600.0, low_open=True),
            max_retries=integer("MAX_RETRIES", 3, low=0, high=10),
            temperature=number("TEMPERATURE", 0.2, low=0.0, high=2.0, low_open=False),
            max_output_tokens=integer("MAX_OUTPUT_TOKENS", preset.max_output_tokens, low=1,
                                      high=1_000_000),
            json_mode=_parse_bool(*settings.get("JSON_MODE"), preset.json_mode),
            requests_per_minute=optional_number("RPM", preset.requests_per_minute, low=0.0,
                                                high=100_000.0, low_open=True, allow_off=True),
            context_tokens=integer("CONTEXT_TOKENS", preset.context_tokens, low=512,
                                   high=10_000_000),
            http_referer=settings.get("HTTP_REFERER")[1],
            app_title=settings.get("APP_TITLE")[1] or "Potongin",
            reasoning_effort=effort,
        )
    except (TypeError, ValueError) as error:
        raise _config_error(f"Konfigurasi LLM {provider} tidak valid: {error}.",
                            provider=provider) from None


_SKIPPABLE = frozenset({"missing_api_key", "not_free", "unknown_provider"})


def _resolve_configs(
    env: Mapping[str, str],
) -> tuple[tuple[LLMConfig, ...], tuple[LLMUnavailable, ...]]:
    """Return usable configs plus the providers skipped for a missing key or FREE_ONLY."""
    if llm_disabled(env):
        return (), ()
    providers = configured_providers(env)
    if not providers:
        return (), ()
    free_only = _parse_bool("POTONGIN_LLM_FREE_ONLY", _env_text(env, "POTONGIN_LLM_FREE_ONLY"),
                            False)
    configs: list[LLMConfig] = []
    skipped: list[LLMUnavailable] = []
    for index, provider in enumerate(providers):
        try:
            if provider not in PRESETS:
                raise _unknown_provider(provider, single=len(providers) == 1)
            configs.append(
                _provider_config(env, provider, primary=index == 0, free_only=free_only)
            )
        except LLMUnavailable as error:
            if len(providers) == 1 or error.code not in _SKIPPABLE:
                raise
            skipped.append(error)
    if not configs:
        codes = {error.code for error in skipped}
        code = next(
            (item for item in ("missing_api_key", "not_free") if item in codes), "config_invalid"
        )
        details = " ".join(error.message for error in skipped)
        raise LLMUnavailable(code, f"Tidak ada penyedia LLM yang siap dipakai. {details}")
    return tuple(configs), tuple(skipped)


def load_llm_configs(env: Mapping[str, str] | None = None) -> tuple[LLMConfig, ...]:
    """Every usable provider config, in failover order; () when the LLM is off or unset.

    ``POTONGIN_LLM_PROVIDER`` (or ``POTONGIN_LLM_PROVIDERS``) may list several providers
    separated by commas. With several providers, one without a key (or a paid one when
    ``POTONGIN_LLM_FREE_ONLY=1``) is skipped; a single provider raises instead.
    """
    return _resolve_configs(os.environ if env is None else env)[0]


def load_llm_config(env: Mapping[str, str] | None = None) -> LLMConfig | None:
    """Resolve the (first) LLM provider configuration from ``POTONGIN_LLM_*`` variables.

    Returns ``None`` when no provider is configured or ``POTONGIN_LLM=off``. Raises
    ``LLMUnavailable`` (code ``missing_api_key``, ``not_free`` or ``config_invalid``) when a
    provider is chosen but unusable. Empty variables count as unset.
    """
    configs = load_llm_configs(os.environ if env is None else env)
    return configs[0] if configs else None


# --- responses and protocol -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class LLMResponse:
    data: dict[str, Any]
    text: str
    model: str
    provider: str
    input_tokens: int | None
    output_tokens: int | None
    latency_s: float
    cached: bool

    def __post_init__(self) -> None:
        if type(self.data) is not dict:
            raise TypeError("response data must be a JSON object")
        if not isinstance(self.text, str):
            raise TypeError("response text must be a string")
        for name in ("model", "provider"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"response {name} must be a non-empty string")
        for name in ("input_tokens", "output_tokens"):
            value = getattr(self, name)
            if value is not None and (not _is_int(value) or value < 0):
                raise ValueError(f"{name} must be a non-negative integer or None")
        latency = _check_float(self.latency_s, "latency_s", low=0.0, high=1e9, low_open=False)
        object.__setattr__(self, "latency_s", latency)
        if not isinstance(self.cached, bool):
            raise TypeError("cached must be a boolean")


@runtime_checkable
class LLMClient(Protocol):
    def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse: ...


def _check_request(
    system: object, user: object, max_output_tokens: object, temperature: object
) -> None:
    if not isinstance(system, str) or not isinstance(user, str):
        raise TypeError("system and user prompts must be strings")
    if not user.strip():
        raise ValueError("user prompt cannot be empty")
    if max_output_tokens is not None:
        _check_int(max_output_tokens, "max_output_tokens", low=1, high=1_000_000)
    if temperature is not None:
        _check_float(temperature, "temperature", low=0.0, high=2.0, low_open=False)


# --- JSON extraction --------------------------------------------------------------------------


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant {value}")


def _strict_loads(text: str) -> object:
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except RecursionError:
        raise ValueError("JSON nesting is too deep") from None


def _balanced_end(text: str, start: int) -> int:
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def _first_object(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    if stripped.startswith("["):
        with suppress(ValueError):
            if isinstance(_strict_loads(stripped), list):
                return None
    position = 0
    for _ in range(64):
        start = text.find("{", position)
        if start < 0:
            return None
        end = _balanced_end(text, start)
        if end < 0:
            return None
        try:
            value = _strict_loads(text[start : end + 1])
        except ValueError:
            value = None
        if type(value) is dict:
            return value
        position = end + 1
    return None


def extract_json_object(text: str) -> dict[str, Any]:
    """Return the first top-level JSON object in a model answer.

    Strips ``<think>`` blocks and Markdown code fences, then parses strictly (no NaN or
    Infinity). A bare top-level array is rejected. Raises ``ValueError`` when nothing parses.
    """
    if not isinstance(text, str):
        raise TypeError("model output must be a string")
    cleaned = _THINK_RE.sub("", text).strip()
    if not cleaned:
        raise ValueError("model output is empty")
    candidates = [match.group(1) for match in _FENCE_RE.finditer(cleaned)]
    candidates.append(cleaned)
    for candidate in candidates:
        value = _first_object(candidate)
        if value is not None:
            return value
    raise ValueError("model output does not contain a JSON object")


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts)
    return ""


def _reasoning_texts(message: Mapping[str, object]) -> list[str]:
    texts: list[str] = []
    for key in ("reasoning_content", "reasoning", "thinking"):
        value = _content_text(message.get(key))
        if value.strip():
            texts.append(value)
    details = message.get("reasoning_details")
    if isinstance(details, list):
        joined = _content_text(details)
        if joined.strip():
            texts.append(joined)
    return texts


def _with_json_hint(system: str, user: str) -> str:
    if "json" in f"{system}\n{user}".lower():
        return system
    return f"{system}\n\n{JSON_HINT}" if system.strip() else JSON_HINT


# --- rate limiting ----------------------------------------------------------------------------


class RateLimiter:
    """Thread-safe request spacing: at most ``requests_per_minute`` evenly spaced requests."""

    def __init__(
        self,
        requests_per_minute: float | None,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if requests_per_minute is not None:
            requests_per_minute = _check_float(requests_per_minute, "requests_per_minute",
                                               low=0.0, high=100_000.0, low_open=True)
        self._interval = 60.0 / requests_per_minute if requests_per_minute else 0.0
        self._clock = clock
        self._sleep = sleep
        self._next: float | None = None
        self._lock = threading.Lock()

    @property
    def interval(self) -> float:
        return self._interval

    def acquire(self) -> float:
        """Reserve the next slot and sleep until it; returns the seconds waited."""
        if self._interval <= 0:
            return 0.0
        with self._lock:
            now = self._clock()
            slot = now if self._next is None else max(now, self._next)
            self._next = slot + self._interval
        wait = slot - now
        if wait > 0:
            self._sleep(wait)
            return wait
        return 0.0


# --- HTTP client ------------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: they would drop the POST body or leak the key to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_limited(stream: Any) -> bytes:
    data = stream.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise ValueError("response too large")
    return data


def _retry_after_seconds(headers: Any, text: str) -> float | None:
    def header(name: str) -> str | None:
        if headers is None:
            return None
        value = headers.get(name)
        return value.strip() if isinstance(value, str) and value.strip() else None

    milliseconds = header("retry-after-ms")
    if milliseconds is not None:
        with suppress(ValueError):
            value = float(milliseconds) / 1000.0
            if math.isfinite(value) and value >= 0:
                return value
    retry_after = header("retry-after")
    if retry_after is not None:
        try:
            value = float(retry_after)
            if math.isfinite(value) and value >= 0:
                return value
        except ValueError:
            with suppress(TypeError, ValueError, IndexError, OverflowError):
                moment = email.utils.parsedate_to_datetime(retry_after)
                if moment.tzinfo is None:
                    moment = moment.replace(tzinfo=UTC)
                return max(0.0, (moment - datetime.now(UTC)).total_seconds())
    match = _RETRY_DELAY_RE.search(text)
    if match:
        return float(match.group(1))
    return None


def _error_detail(text: str) -> str:
    detail: object = None
    try:
        payload: object = json.loads(text)
    except ValueError:
        payload = None
    if isinstance(payload, list) and payload:
        payload = payload[0]
    if isinstance(payload, dict):
        error = payload.get("error", payload)
        if isinstance(error, dict):
            detail = error.get("message") or error.get("detail") or error.get("error")
            metadata = error.get("metadata")
            if isinstance(metadata, dict) and isinstance(metadata.get("raw"), str):
                detail = f"{detail} ({metadata['raw']})" if detail else metadata["raw"]
        elif isinstance(error, str):
            detail = error
        if detail is None:
            detail = payload.get("message") or payload.get("detail")
    if not isinstance(detail, str) or not detail.strip():
        detail = text if not text.lstrip().startswith("<") else "respons bukan JSON"
    collapsed = " ".join(str(detail).split())
    return collapsed[:240] + ("…" if len(collapsed) > 240 else "")


class OpenAICompatibleClient:
    """JSON completions over ``POST {base_url}/chat/completions`` with retries and fallbacks.

    Transient failures (429, 5xx, timeouts, unreadable bodies) are retried with exponential
    backoff and jitter, honoring ``Retry-After`` up to 60 s. A daily quota or a longer
    ``Retry-After`` puts the model on cooldown and moves on. 401/403 stop immediately. 404,
    other client errors, exhausted retries, invalid JSON after one nudge, and truncation move
    to the next fallback model. Unsupported ``response_format``/``temperature``/``max_tokens``
    parameters are detected from 400 responses, dropped or renamed, and remembered per model.
    """

    def __init__(
        self,
        config: LLMConfig,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        rng: Callable[[], float] = random.random,
        backoff_base: float = 1.0,
        max_retry_wait: float = MAX_RETRY_WAIT,
    ) -> None:
        if not isinstance(config, LLMConfig):
            raise TypeError("config must be an LLMConfig")
        self._config = config
        self._sleep = sleep
        self._clock = clock
        self._rng = rng
        self._backoff_base = _check_float(backoff_base, "backoff_base", low=0.0, high=60.0,
                                          low_open=False)
        self._max_retry_wait = _check_float(max_retry_wait, "max_retry_wait", low=0.0,
                                            high=3600.0, low_open=False)
        self._limiter = RateLimiter(config.requests_per_minute, clock=clock, sleep=sleep)
        self._opener = urllib.request.build_opener(_NoRedirect)
        self._endpoint = f"{config.base_url}/chat/completions"
        self._lock = threading.Lock()
        self._dropped: dict[str, set[str]] = {}
        self._token_params: dict[str, str] = {}
        self._cooldown_until: dict[str, float] = {}

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(provider={self._config.provider!r}, "
            f"model_chain={self._config.model_chain!r})"
        )

    @property
    def config(self) -> LLMConfig:
        return self._config

    @property
    def provider(self) -> str:
        return self._config.provider

    @property
    def model_chain(self) -> tuple[str, ...]:
        return self._config.model_chain

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse:
        _check_request(system, user, max_output_tokens, temperature)
        max_tokens = self._config.max_output_tokens if max_output_tokens is None else (
            max_output_tokens
        )
        effective_temperature = self._config.temperature if temperature is None else float(
            temperature
        )
        system = _with_json_hint(system, user)
        started = self._clock()
        failures: list[tuple[str, str]] = []
        last_error: LLMError | None = None
        chain = self._config.model_chain
        for model in chain:
            if self._cooling_down(model):
                failures.append((model, "quota_exhausted"))
                last_error = self._error("quota_exhausted", model)
                continue
            try:
                return self._complete_with_model(
                    model, system, user, max_tokens, effective_temperature, started
                )
            except LLMError as error:
                failures.append((model, error.code))
                last_error = error
                if error.code == "auth":
                    raise error.with_attempts(tuple(failures)) from None
                if model != chain[-1]:
                    LOGGER.warning(
                        "LLM %s/%s gagal (%s); mencoba model cadangan berikutnya.",
                        self._config.provider, model, error.code,
                    )
        if last_error is None:  # pragma: no cover - the model chain is never empty
            raise RuntimeError("LLM model chain is empty")
        if len(failures) == 1:
            raise last_error.with_attempts(tuple(failures)) from None
        summary = ", ".join(f"{model} ({code})" for model, code in failures)
        raise last_error.with_attempts(
            tuple(failures), f"Semua model gagal: {summary}. Terakhir: {last_error.message}"
        ) from None

    # -- per-model state

    def _cooling_down(self, model: str) -> bool:
        with self._lock:
            until = self._cooldown_until.get(model)
        return until is not None and self._clock() < until

    def _start_cooldown(self, model: str, seconds: float) -> None:
        with self._lock:
            self._cooldown_until[model] = self._clock() + seconds

    def _model_state(self, model: str) -> tuple[set[str], str]:
        preset_param = PRESETS[self._config.provider].max_tokens_param
        with self._lock:
            return set(self._dropped.get(model, ())), self._token_params.get(model, preset_param)

    def _remember(self, model: str, dropped: set[str], token_param: str) -> None:
        with self._lock:
            self._dropped[model] = set(dropped)
            self._token_params[model] = token_param

    # -- request cycle

    def _complete_with_model(
        self,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
        temperature: float,
        started: float,
    ) -> LLMResponse:
        dropped, token_param = self._model_state(model)
        adapted: set[str] = set()
        attempt = 0
        nudged = False
        user_text = user
        while True:
            payload = self._payload(model, system, user_text, max_tokens, temperature, dropped,
                                    token_param)
            self._limiter.acquire()
            try:
                status, headers, raw = self._post(payload, model)
                if not 200 <= status < 300:
                    text = raw.decode("utf-8", errors="replace")
                    adaptation = _parameter_adaptation(status, text, payload)
                    if adaptation is not None and adaptation not in adapted:
                        adapted.add(adaptation)
                        if adaptation == "max_tokens":
                            token_param = "max_completion_tokens"
                        elif adaptation == "max_completion_tokens":
                            token_param = "max_tokens"
                        else:
                            dropped.add(adaptation)
                        self._remember(model, dropped, token_param)
                        LOGGER.info(
                            "LLM %s/%s menolak parameter %s; mengulang tanpa parameter itu.",
                            self._config.provider, model, adaptation,
                        )
                        continue
                    raise self._http_error(status, headers, text, model)
                return self._parse_success(raw, model, started)
            except _BadJSON:
                if not nudged:
                    nudged = True
                    user_text = f"{user}\n\n{NUDGE}"
                    continue
                raise self._error("bad_json", model) from None
            except LLMError as error:
                if error.code == "quota_exhausted":
                    retry_after = error.retry_after
                    cooldown = (
                        retry_after
                        if retry_after is not None and retry_after > self._max_retry_wait
                        else QUOTA_COOLDOWN
                    )
                    self._start_cooldown(model, cooldown)
                    raise
                if not error.retryable or attempt >= self._config.max_retries:
                    raise
                delay = self._backoff(attempt, error.retry_after)
                attempt += 1
                LOGGER.info(
                    "LLM %s/%s: %s; percobaan ulang %d/%d dalam %.1f s.",
                    self._config.provider, model, error.code, attempt,
                    self._config.max_retries, delay,
                )
                self._sleep(delay)

    def _payload(
        self,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
        temperature: float,
        dropped: set[str],
        token_param: str,
    ) -> dict[str, object]:
        messages: list[dict[str, str]] = []
        if system.strip():
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})
        payload: dict[str, object] = {"model": model, "messages": messages, "stream": False}
        if "temperature" not in dropped:
            payload["temperature"] = temperature
        payload[token_param] = max_tokens
        if self._config.json_mode and "response_format" not in dropped:
            payload["response_format"] = {"type": "json_object"}
        if self._config.reasoning_effort is not None and "reasoning_effort" not in dropped:
            payload["reasoning_effort"] = self._config.reasoning_effort
        return payload

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Potongin-AI-Clipper/1.0",
        }
        if self._config.api_key:
            headers["Authorization"] = f"Bearer {self._config.api_key}"
        if self._config.provider == "openrouter":
            if self._config.http_referer:
                headers["HTTP-Referer"] = self._config.http_referer
            if self._config.app_title:
                headers["X-Title"] = self._config.app_title
        return headers

    def _post(self, payload: Mapping[str, object], model: str) -> tuple[int, Any, bytes]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint, data=body, headers=self._headers(), method="POST"
        )
        try:
            with self._opener.open(request, timeout=self._config.timeout) as response:
                return response.status, response.headers, _read_limited(response)
        except urllib.error.HTTPError as error:
            try:
                raw = _read_limited(error)
            except (OSError, ValueError, http.client.HTTPException):
                raw = b""
            finally:
                error.close()
            return error.code, error.headers, raw
        except ValueError:
            raise self._error("bad_response", model, retryable=True) from None
        except (TimeoutError, urllib.error.URLError, OSError, http.client.HTTPException) as error:
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
                raise self._error("timeout", model, retryable=True) from None
            detail = _redact(" ".join(str(reason).split())[:160], (self._config.api_key,))
            raise self._error("network", model, retryable=True, detail=detail) from None

    def _parse_success(self, raw: bytes, model: str, started: float) -> LLMResponse:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise self._error("bad_response", model, retryable=True) from None
        if not isinstance(payload, dict):
            raise self._error("bad_response", model, retryable=True)
        choices = payload.get("choices")
        if payload.get("error") is not None and not choices:
            raise self._embedded_error(payload["error"], model)
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise self._error("bad_response", model, retryable=True)
        choice = choices[0]
        if choice.get("error") is not None:
            raise self._embedded_error(choice["error"], model)
        message = choice.get("message")
        message = message if isinstance(message, dict) else {}
        finish_reason = choice.get("finish_reason")
        if finish_reason == "length":
            raise self._error("truncated", model)
        content = _content_text(message.get("content"))
        texts = [content] if content.strip() else _reasoning_texts(message)
        if not texts and finish_reason == "content_filter":
            raise self._error("content_filter", model)
        for text in texts:
            try:
                data = extract_json_object(text)
            except ValueError:
                continue
            usage = payload.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            reported_model = payload.get("model")
            return LLMResponse(
                data=data,
                text=text,
                model=reported_model if isinstance(reported_model, str)
                and reported_model.strip() else model,
                provider=self._config.provider,
                input_tokens=_token_count(usage.get("prompt_tokens")),
                output_tokens=_token_count(usage.get("completion_tokens")),
                latency_s=max(0.0, self._clock() - started),
                cached=False,
            )
        raise _BadJSON

    def _embedded_error(self, error: object, model: str) -> LLMError:
        code = error.get("code") if isinstance(error, dict) else None
        status = code if _is_int(code) and 400 <= code <= 599 else 502
        return self._http_error(status, None, json.dumps({"error": error}, default=str), model)

    def _backoff(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(max(retry_after, 0.0), self._max_retry_wait)
        delay = min(self._max_retry_wait, self._backoff_base * (2**attempt))
        jitter = min(max(self._rng(), 0.0), 1.0)
        return min(self._max_retry_wait, delay * (0.5 + 0.5 * jitter))

    # -- error construction

    def _http_error(self, status: int, headers: Any, text: str, model: str) -> LLMError:
        detail = _redact(_error_detail(text), (self._config.api_key,))
        if status == 402 or (status == 403 and _PLAN_RE.search(detail)):
            return self._error("payment_required", model, status=status, detail=detail)
        if status in (401, 403):
            return self._error("auth", model, status=status)
        if status == 429:
            retry_after = _retry_after_seconds(headers, text)
            if _DAILY_RE.search(text) or (
                retry_after is not None and retry_after > self._max_retry_wait
            ):
                return self._error("quota_exhausted", model, status=status,
                                   retry_after=retry_after, detail=detail)
            return self._error("rate_limited", model, status=status, retryable=True,
                               retry_after=retry_after, detail=detail)
        if status == 404 or (status in (400, 422) and _MODEL_MISSING_RE.search(detail)):
            return self._error("model_not_found", model, status=status, detail=detail)
        if status in (400, 422) and _CONTEXT_RE.search(detail):
            return self._error("context_length", model, status=status, detail=detail)
        if status == 413:
            return self._error("too_large", model, status=status, detail=detail)
        if status == 408:
            return self._error("timeout", model, status=status, retryable=True)
        retryable = status >= 500 or status == 425
        return self._error(f"http_{status}", model, status=status, retryable=retryable,
                           detail=detail)

    def _error(
        self,
        code: str,
        model: str,
        *,
        status: int | None = None,
        retryable: bool = False,
        retry_after: float | None = None,
        detail: str | None = None,
    ) -> LLMError:
        return LLMError(
            code,
            _message(code, self._config, model, status, detail),
            provider=self._config.provider,
            model=model,
            status=status,
            retryable=retryable,
            retry_after=retry_after,
        )


def _token_count(value: object) -> int | None:
    return value if _is_int(value) and value >= 0 else None


def _parameter_adaptation(status: int, text: str, payload: Mapping[str, object]) -> str | None:
    """Name the request parameter a 400/422 rejects, if the body says so."""
    if status not in (400, 422):
        return None
    lowered = text.lower()
    unsupported = any(word in lowered for word in _UNSUPPORTED_WORDS)
    if "reasoning_effort" in payload and "reasoning" in lowered:
        return "reasoning_effort"
    if "response_format" in payload and (
        "response_format" in lowered
        or "json_object" in lowered
        or "json mode" in lowered
        or "json_mode" in lowered
        or "json_validate_failed" in lowered
        or "failed to generate json" in lowered
    ):
        return "response_format"
    if "max_tokens" in payload and "max_completion_tokens" in lowered:
        return "max_tokens"
    if "max_completion_tokens" in payload and "max_completion_tokens" in lowered and unsupported:
        return "max_completion_tokens"
    if "temperature" in payload and "temperature" in lowered and unsupported:
        return "temperature"
    return None


def _message(
    code: str, config: LLMConfig, model: str, status: int | None, detail: str | None
) -> str:
    provider = config.provider
    suffix = f" Detail: {detail}" if detail else ""
    lowered = (detail or "").lower()
    if code == "model_not_found" and ("data policy" in lowered or "guardrail" in lowered):
        suffix += (
            " Untuk model gratis OpenRouter, izinkan endpoint gratis di "
            "https://openrouter.ai/settings/privacy."
        )
    messages = {
        "auth": f"API key ditolak oleh {provider} (HTTP {status}). Periksa API key di .env.",
        "rate_limited": f"Kena rate limit {provider} untuk model {model}.{suffix}",
        "quota_exhausted": (
            f"Kuota {provider} untuk model {model} habis atau harus menunggu lama; "
            f"model ini dilewati sementara.{suffix}"
        ),
        "timeout": f"Permintaan ke {provider} ({model}) melewati batas waktu {config.timeout:g} s.",
        "network": f"Tidak bisa terhubung ke {provider} ({model}).{suffix}",
        "model_not_found": (
            f"Model {model} tidak ditemukan atau tidak tersedia di {provider}; ID model mungkin "
            f"sudah berganti.{suffix}"
        ),
        "bad_json": f"Model {model} tidak mengembalikan satu objek JSON yang valid.",
        "bad_response": f"Respons {provider} ({model}) tidak bisa dibaca.",
        "truncated": (
            f"Jawaban model {model} terpotong karena batas token output; naikkan "
            f"POTONGIN_LLM_MAX_OUTPUT_TOKENS atau perkecil potongan transkrip."
        ),
        "context_length": (
            f"Prompt terlalu panjang untuk model {model}; perkecil POTONGIN_LLM_CONTEXT_TOKENS."
            f"{suffix}"
        ),
        "too_large": (
            f"Permintaan terlalu besar untuk batas {provider} (HTTP 413); perkecil "
            f"POTONGIN_LLM_CONTEXT_TOKENS.{suffix}"
        ),
        "content_filter": f"Jawaban model {model} diblokir filter konten {provider}.",
        "payment_required": (
            f"Model {model} di {provider} butuh kredit/langganan berbayar; model ini dilewati."
            f"{suffix}"
        ),
    }
    if code in messages:
        return messages[code]
    return f"{provider} ({model}) mengembalikan HTTP {status}.{suffix}"


# --- cache ------------------------------------------------------------------------------------


def _config_identity(config: LLMConfig, *, with_defaults: bool) -> dict[str, object]:
    identity: dict[str, object] = {
        "provider": config.provider,
        "base_url": config.base_url,
        "models": list(config.model_chain),
        "reasoning_effort": config.reasoning_effort,
    }
    if with_defaults:
        identity["temperature"] = config.temperature
        identity["max_output_tokens"] = config.max_output_tokens
    return identity


def _client_identity(client: object) -> object:
    """A JSON-able, key-free description of what a client would answer with."""
    method = getattr(client, "cache_identity", None)
    if callable(method):
        return method()
    config = getattr(client, "config", None)
    if isinstance(config, LLMConfig):
        return _config_identity(config, with_defaults=True)
    return {
        "provider": getattr(client, "provider", type(client).__name__),
        "models": list(getattr(client, "model_chain", ())),
    }


class CachedLLMClient:
    """On-disk response cache keyed by sha256 over the full request identity.

    The key covers provider(s), base URL(s), model chain(s), system and user prompts,
    temperature, and max output tokens. Entries are atomic JSON files that never contain
    prompts or keys. Failures are never cached.
    """

    def __init__(
        self, inner: LLMClient, cache_dir: str | os.PathLike[str], *, config: LLMConfig | None = None
    ) -> None:
        self._inner = inner
        self._dir = Path(cache_dir)
        inner_config = getattr(inner, "config", None)
        self._config = config if config is not None else (
            inner_config if isinstance(inner_config, LLMConfig) else None
        )

    @property
    def inner(self) -> LLMClient:
        return self._inner

    @property
    def cache_dir(self) -> Path:
        return self._dir

    @property
    def config(self) -> LLMConfig | None:
        return self._config

    @property
    def provider(self) -> str:
        return str(getattr(self._inner, "provider", type(self._inner).__name__))

    @property
    def model_chain(self) -> tuple[str, ...]:
        return tuple(getattr(self._inner, "model_chain", ()))

    def cache_identity(self) -> object:
        return _client_identity(self._inner)

    def cache_key(
        self,
        *,
        system: str,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        client: object
        if self._config is not None:
            client = _config_identity(self._config, with_defaults=False)
            if temperature is None:
                temperature = self._config.temperature
            if max_output_tokens is None:
                max_output_tokens = self._config.max_output_tokens
        else:
            client = _client_identity(self._inner)
        identity = {
            "format": CACHE_FORMAT,
            "client": client,
            "system": system,
            "user": user,
            "temperature": None if temperature is None else float(temperature),
            "max_output_tokens": max_output_tokens,
        }
        canonical = json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse:
        _check_request(system, user, max_output_tokens, temperature)
        key = self.cache_key(system=system, user=user, max_output_tokens=max_output_tokens,
                             temperature=temperature)
        path = self._dir / f"{key}.json"
        hit = self._load(path, key)
        if hit is not None:
            return hit
        response = self._inner.complete_json(
            system=system, user=user, max_output_tokens=max_output_tokens, temperature=temperature
        )
        try:
            self._store(path, key, response)
        except (OSError, TypeError, ValueError) as error:
            LOGGER.warning("Cache LLM tidak bisa ditulis (%s).", type(error).__name__)
        return response

    @staticmethod
    def _load(path: Path, key: str) -> LLMResponse | None:
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            return None
        try:
            if entry.get("format") != CACHE_FORMAT or entry.get("key") != key:
                return None
            stored = entry["response"]
            return LLMResponse(
                data=stored["data"],
                text=stored["text"],
                model=stored["model"],
                provider=stored["provider"],
                input_tokens=stored["input_tokens"],
                output_tokens=stored["output_tokens"],
                latency_s=stored["latency_s"],
                cached=True,
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            return None

    def _store(self, path: Path, key: str, response: LLMResponse) -> None:
        entry = {
            "format": CACHE_FORMAT,
            "key": key,
            "response": {
                "data": response.data,
                "text": response.text,
                "model": response.model,
                "provider": response.provider,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "latency_s": response.latency_s,
            },
        }
        encoded = json.dumps(entry, ensure_ascii=False, sort_keys=True, allow_nan=False)
        self._dir.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{key[:16]}.", suffix=".tmp",
                                                 dir=self._dir)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except BaseException:
            with suppress(FileNotFoundError):
                os.unlink(temporary)
            raise


# --- scripted client --------------------------------------------------------------------------

ScriptItem = (
    dict[str, Any] | str | LLMResponse | BaseException | Callable[..., Any]
)


class ScriptedLLMClient:
    """Deterministic client for tests: replays dicts, JSON strings, callables, or exceptions.

    Callables receive ``system=`` and ``user=`` keywords and may return any other item.
    Every call is recorded in ``calls``; running out of items raises ``script_exhausted``.
    """

    def __init__(
        self,
        responses: Iterable[ScriptItem],
        *,
        provider: str = "scripted",
        model: str = "scripted",
    ) -> None:
        if not isinstance(provider, str) or not provider.strip():
            raise ValueError("provider must be a non-empty string")
        _check_model(model, "model")
        self.responses: list[ScriptItem] = list(responses)
        self.calls: list[dict[str, object]] = []
        self.provider = provider
        self.model = model
        self._lock = threading.Lock()

    @property
    def model_chain(self) -> tuple[str, ...]:
        return (self.model,)

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse:
        with self._lock:
            self.calls.append({
                "system": system,
                "user": user,
                "max_output_tokens": max_output_tokens,
                "temperature": temperature,
            })
            if not self.responses:
                raise LLMError("script_exhausted", "Skrip ScriptedLLMClient sudah habis.",
                               provider=self.provider, model=self.model)
            item = self.responses.pop(0)
        if callable(item) and not isinstance(item, (BaseException, LLMResponse)):
            item = item(system=system, user=user)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, LLMResponse):
            return item
        if isinstance(item, str):
            try:
                data = extract_json_object(item)
            except ValueError:
                raise LLMError("bad_json", f"Model {self.model} tidak mengembalikan JSON.",
                               provider=self.provider, model=self.model) from None
            text = item
        elif isinstance(item, dict):
            data = copy.deepcopy(item)
            text = json.dumps(item, ensure_ascii=False)
        else:
            raise TypeError("script items must be dicts, strings, responses, or exceptions")
        return LLMResponse(
            data=data,
            text=text,
            model=self.model,
            provider=self.provider,
            input_tokens=None,
            output_tokens=None,
            latency_s=0.0,
            cached=False,
        )


class FailoverLLMClient:
    """Tries several provider clients in order until one answers.

    Each client keeps its own model fallback chain. Any ``LLMError`` (including auth, since
    another provider has its own key) moves on to the next client. When every client fails,
    the last error is raised with ``attempts`` naming each ``provider/model`` tried.
    """

    def __init__(self, clients: Iterable[LLMClient]) -> None:
        self._clients = tuple(clients)
        if not self._clients:
            raise ValueError("failover needs at least one client")

    def __repr__(self) -> str:
        return f"{type(self).__name__}(providers={self.provider!r})"

    @property
    def clients(self) -> tuple[LLMClient, ...]:
        return self._clients

    @property
    def provider(self) -> str:
        return "+".join(_client_provider(client) for client in self._clients)

    @property
    def model_chain(self) -> tuple[str, ...]:
        return tuple(
            f"{_client_provider(client)}/{model}"
            for client in self._clients
            for model in getattr(client, "model_chain", ())
        )

    def cache_identity(self) -> object:
        return {"failover": [_client_identity(client) for client in self._clients]}

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse:
        _check_request(system, user, max_output_tokens, temperature)
        failures: list[tuple[str, str]] = []
        last_error: LLMError | None = None
        for index, client in enumerate(self._clients):
            provider = _client_provider(client)
            try:
                return client.complete_json(
                    system=system,
                    user=user,
                    max_output_tokens=max_output_tokens,
                    temperature=temperature,
                )
            except LLMError as error:
                attempts = error.attempts or ((error.model or "?", error.code),)
                failures.extend((f"{provider}/{model}", code) for model, code in attempts)
                last_error = error
                if index + 1 < len(self._clients):
                    LOGGER.warning(
                        "Penyedia LLM %s gagal (%s); pindah ke penyedia berikutnya.",
                        provider, error.code,
                    )
        if last_error is None:  # pragma: no cover - there is always at least one client
            raise RuntimeError("failover has no clients")
        summary = ", ".join(f"{name} ({code})" for name, code in failures)
        raise last_error.with_attempts(
            tuple(failures), f"Semua penyedia LLM gagal: {summary}. Terakhir: {last_error.message}"
        ) from None


def _client_provider(client: object) -> str:
    return str(getattr(client, "provider", type(client).__name__))


def create_llm_client(
    config: LLMConfig, *, cache_dir: str | os.PathLike[str] | None = None
) -> LLMClient:
    """Build the default client for one ``config``, optionally wrapped in an on-disk cache."""
    client: LLMClient = OpenAICompatibleClient(config)
    if cache_dir is not None:
        client = CachedLLMClient(client, cache_dir, config=config)
    return client


def create_llm_client_from_env(
    env: Mapping[str, str] | None = None, *, cache_dir: str | os.PathLike[str] | None = None
) -> LLMClient | None:
    """Build the client the environment asks for; ``None`` when the LLM is off or unset.

    Several providers become a ``FailoverLLMClient``. Raises ``LLMUnavailable`` on invalid
    configuration, like ``load_llm_configs``.
    """
    configs = load_llm_configs(os.environ if env is None else env)
    if not configs:
        return None
    clients = [OpenAICompatibleClient(config) for config in configs]
    client: LLMClient = clients[0] if len(clients) == 1 else FailoverLLMClient(clients)
    if cache_dir is not None:
        client = CachedLLMClient(client, cache_dir)
    return client


# --- command line -----------------------------------------------------------------------------

_PING_SYSTEM = "You are a connectivity check. Reply with JSON only."
_PING_USER = 'Return exactly this JSON object and nothing else: {"ok": true}'
_HINTS = {
    "auth": "Periksa API key di .env (lihat docs/operations/LLM_PROVIDERS.md).",
    "missing_api_key": "Isi API key penyedia di .env (lihat docs/operations/LLM_PROVIDERS.md).",
    "config_invalid": "Perbaiki variabel POTONGIN_LLM_* di .env.",
    "model_not_found": "ID model mungkin sudah berganti; set POTONGIN_LLM_MODEL ke model yang "
    "tersedia.",
    "rate_limited": "Tunggu sebentar, turunkan POTONGIN_LLM_RPM, atau pakai penyedia lain.",
    "quota_exhausted": "Kuota gratis habis; tunggu reset harian atau ganti model/penyedia.",
    "network": "Periksa koneksi internet dan POTONGIN_LLM_BASE_URL.",
    "timeout": "Naikkan POTONGIN_LLM_TIMEOUT atau pakai model yang lebih cepat.",
    "truncated": "Naikkan POTONGIN_LLM_MAX_OUTPUT_TOKENS.",
    "not_free": "Matikan POTONGIN_LLM_FREE_ONLY atau pilih model ':free' / penyedia gratis.",
    "payment_required": "Model ini butuh kredit; pilih model gratis atau isi kredit.",
}


def _preset_rows() -> dict[str, dict[str, object]]:
    return {
        name: {
            "label": preset.label,
            "base_url": preset.base_url,
            "default_model": preset.default_model,
            "fallback_models": list(preset.fallback_models),
            "key_env": list(preset.key_env),
            "requires_key": preset.requires_key,
            "json_mode": preset.json_mode,
            "requests_per_minute": preset.requests_per_minute,
            "context_tokens": preset.context_tokens,
            "max_output_tokens": preset.max_output_tokens,
            "timeout": preset.timeout,
            "free_tier": preset.free_tier,
            "docs_url": preset.docs_url,
        }
        for name, preset in PRESETS.items()
    }


def _show_presets(out: TextIO, as_json: bool) -> int:
    rows = _preset_rows()
    if as_json:
        out.write(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
        return 0
    out.write("Preset penyedia LLM (semua lewat API OpenAI-compatible /chat/completions).\n")
    out.write("ID model sering berubah: override dengan POTONGIN_LLM_MODEL dan "
              "POTONGIN_LLM_FALLBACK_MODELS.\n")
    for name, preset in PRESETS.items():
        keys = " atau ".join(preset.key_env) or "-"
        if not preset.requires_key:
            keys += " (opsional)"
        fallbacks = ", ".join(preset.fallback_models) or "-"
        rpm = preset.requests_per_minute
        scope = f"POTONGIN_LLM_{name.upper().replace('-', '_')}"
        out.write(
            f"\n{name:<13}{preset.label}\n"
            f"  base_url : {preset.base_url or f'(wajib {scope}_BASE_URL)'}\n"
            f"  model    : {preset.default_model or f'(wajib {scope}_MODEL)'}\n"
            f"  cadangan : {fallbacks}\n"
            f"  API key  : {keys}\n"
            f"  json_mode: {'ya' if preset.json_mode else 'tidak'}   "
            f"rpm: {format(rpm, 'g') if rpm is not None else 'tanpa batas'}   "
            f"konteks: {preset.context_tokens} token\n"
            f"  gratis?  : {preset.free_tier}\n"
        )
    return 0


def _ping(config: LLMConfig) -> dict[str, object]:
    """Send the tiny JSON ping to one provider and describe the outcome (never the key)."""
    report: dict[str, object] = {"provider": config.provider, "status": "failed",
                                 "model": None, "latency_s": None, "usage": None, "error": None}
    client = OpenAICompatibleClient(replace(config, max_retries=min(config.max_retries, 1)))
    try:
        response = client.complete_json(
            system=_PING_SYSTEM,
            user=_PING_USER,
            max_output_tokens=min(config.max_output_tokens, 1024),
            temperature=0.0,
        )
    except LLMError as error:
        report["error"] = {"code": error.code, "message": error.message}
        return report
    report["model"] = response.model
    report["latency_s"] = round(response.latency_s, 3)
    report["usage"] = {"input_tokens": response.input_tokens,
                       "output_tokens": response.output_tokens}
    if response.data.get("ok") is not True:
        report["error"] = {"code": "unexpected_reply",
                           "message": 'Model menjawab JSON, tapi bukan {"ok": true}.'}
        return report
    report["status"] = "ok"
    return report


def _write_failure(out: TextIO, code: str, message: str) -> None:
    out.write(f"GAGAL [{code}]: {message}\n")
    if code in _HINTS:
        out.write(f"Saran: {_HINTS[code]}\n")


def _check(env: Mapping[str, str], out: TextIO, as_json: bool) -> int:
    result: dict[str, object] = {"ok": False, "config": None, "model": None, "latency_s": None,
                                 "usage": None, "error": None, "providers": []}

    def fail(code: str, message: str) -> int:
        result["error"] = {"code": code, "message": message}
        if as_json:
            out.write(json.dumps(result, ensure_ascii=False) + "\n")
        else:
            _write_failure(out, code, message)
        return 1

    try:
        configs, skipped = _resolve_configs(env)
    except LLMUnavailable as error:
        return fail(error.code, error.message)
    if not configs:
        if llm_disabled(env):
            return fail("disabled", "LLM dimatikan (POTONGIN_LLM=off).")
        return fail(
            "not_configured",
            "LLM belum dikonfigurasi: set POTONGIN_LLM_PROVIDER "
            f"({', '.join(PROVIDERS)}) dan API key-nya. Lihat docs/operations/LLM_PROVIDERS.md.",
        )
    result["config"] = configs[0].public_dict()
    reports: dict[str, dict[str, object]] = {
        str(error.provider): {"provider": error.provider, "status": "skipped",
                              "error": {"code": error.code, "message": error.message}}
        for error in skipped
    }
    for config in configs:
        if not as_json:
            out.write(f"Konfigurasi LLM {config.provider} (tanpa API key):\n")
            out.write(json.dumps(config.public_dict(), ensure_ascii=False, indent=2) + "\n")
            out.write(f"Mengirim ping JSON ke {config.provider} / {config.model} ...\n")
        report = _ping(config)
        reports[config.provider] = report
        if as_json:
            continue
        if report["status"] == "ok":
            usage = report["usage"]
            tokens = ""
            if isinstance(usage, dict) and any(value is not None for value in usage.values()):
                tokens = (f" (token masuk {usage['input_tokens']}, "
                          f"keluar {usage['output_tokens']})")
            out.write(
                f'OK: {config.provider} / {report["model"]} menjawab {{"ok": true}} dalam '
                f'{report["latency_s"]:.2f} s{tokens}.\n'
            )
        else:
            error = report["error"] if isinstance(report["error"], dict) else {}
            _write_failure(out, str(error.get("code")), str(error.get("message")))
    order = [provider for provider in configured_providers(env) if provider in reports]
    ordered = [reports[provider] for provider in order]
    result["providers"] = ordered
    working = [report for report in ordered if report["status"] == "ok"]
    if working:
        result.update(ok=True, model=working[0]["model"], latency_s=working[0]["latency_s"],
                      usage=working[0]["usage"])
    else:
        failures = [report for report in ordered if report["status"] == "failed"]
        result["error"] = failures[0]["error"] if failures else None
    if as_json:
        out.write(json.dumps(result, ensure_ascii=False) + "\n")
    elif len(order) > 1:
        for error in skipped:
            out.write(f"Dilewati [{error.provider}]: {error.message}\n")
        ready = [str(report["provider"]) for report in working]
        out.write(
            f"Ringkasan: {len(ready)} dari {len(order)} penyedia siap. Urutan failover: "
            f"{' -> '.join(ready) if ready else '-'}.\n"
        )
    return 0 if working else 1


def main(
    argv: list[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ai_clipper.llm",
        description="Cek koneksi LLM Potongin dan lihat preset penyedia.",
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true",
                        help="tampilkan konfigurasi (tanpa API key) dan kirim ping JSON kecil")
    action.add_argument("--show-presets", action="store_true",
                        help="tampilkan preset penyedia dan model bawaan")
    parser.add_argument("--json", action="store_true", help="keluaran dalam format JSON")
    args = parser.parse_args(argv)
    out = stdout if stdout is not None else sys.stdout
    if args.show_presets:
        return _show_presets(out, args.json)
    return _check(os.environ if env is None else env, out, args.json)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
