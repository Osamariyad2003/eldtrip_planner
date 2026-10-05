"""Shared outbound HTTP client for third-party providers.

INT-05: every call has a 10 s timeout and at most one retry on timeout or 5xx.
INT-06: keys come from environment variables only, and never from the client.
LOGR-02: provider errors and fallback use are logged at WARNING.
"""

from __future__ import annotations

import logging
import time

import requests
from django.conf import settings

from ..request_context import record_provider_call

logger = logging.getLogger("planner.providers")

RETRY_STATUSES = frozenset({500, 502, 503, 504})


class ProviderError(Exception):
    """A provider call failed after its retry."""

    def __init__(self, provider: str, endpoint: str, status: int | str, detail: str = "") -> None:
        super().__init__(f"{provider} {endpoint} failed: {status} {detail}".strip())
        self.provider = provider
        self.endpoint = endpoint
        self.status = status


class ProviderRateLimited(ProviderError):
    """The provider returned 429."""


def get_json(
    provider: str,
    url: str,
    *,
    params: dict | None = None,
    headers: dict | None = None,
    endpoint: str | None = None,
    timeout: float | None = None,
) -> dict | list:
    """GET JSON with one retry, recording timing for the request log."""
    return _request("GET", provider, url, params=params, headers=headers,
                    endpoint=endpoint, timeout=timeout)


def post_json(
    provider: str,
    url: str,
    *,
    json: dict,
    headers: dict | None = None,
    endpoint: str | None = None,
    timeout: float | None = None,
) -> dict | list:
    """POST JSON with one retry, recording timing for the request log."""
    return _request("POST", provider, url, json=json, headers=headers,
                    endpoint=endpoint, timeout=timeout)


def _request(
    method: str,
    provider: str,
    url: str,
    *,
    params: dict | None = None,
    json: dict | None = None,
    headers: dict | None = None,
    endpoint: str | None = None,
    timeout: float | None = None,
) -> dict | list:
    label = endpoint or url
    limit = timeout or settings.PROVIDER_TIMEOUT_SECONDS
    last: Exception | None = None

    for attempt in range(2):
        started = time.perf_counter()
        try:
            response = requests.request(
                method, url, params=params, json=json,
                headers={"Accept": "application/json", **(headers or {})},
                timeout=limit,
            )
            elapsed = (time.perf_counter() - started) * 1000
            record_provider_call(provider, label, response.status_code, elapsed)

            if response.status_code == 429:
                logger.warning(
                    "provider_rate_limited",
                    extra={"provider": provider, "endpoint": label,
                           "status": 429, "latency_ms": round(elapsed, 1)},
                )
                raise ProviderRateLimited(provider, label, 429)
            if response.status_code in RETRY_STATUSES and attempt == 0:
                logger.warning(
                    "provider_error_retrying",
                    extra={"provider": provider, "endpoint": label,
                           "status": response.status_code, "latency_ms": round(elapsed, 1)},
                )
                last = ProviderError(provider, label, response.status_code)
                continue
            if not response.ok:
                logger.warning(
                    "provider_error",
                    extra={"provider": provider, "endpoint": label,
                           "status": response.status_code, "latency_ms": round(elapsed, 1)},
                )
                raise ProviderError(
                    provider, label, response.status_code, response.text[:200]
                )
            return response.json()

        except requests.Timeout as exc:
            elapsed = (time.perf_counter() - started) * 1000
            record_provider_call(provider, label, "timeout", elapsed)
            logger.warning(
                "provider_timeout",
                extra={"provider": provider, "endpoint": label,
                       "status": "timeout", "latency_ms": round(elapsed, 1)},
            )
            last = ProviderError(provider, label, "timeout", str(exc))
            if attempt == 1:
                break
        except requests.RequestException as exc:
            elapsed = (time.perf_counter() - started) * 1000
            record_provider_call(provider, label, "error", elapsed)
            logger.warning(
                "provider_unreachable",
                extra={"provider": provider, "endpoint": label,
                       "status": "error", "latency_ms": round(elapsed, 1)},
            )
            last = ProviderError(provider, label, "error", str(exc))
            if attempt == 1:
                break
        except ValueError as exc:  # malformed JSON body
            last = ProviderError(provider, label, "bad_json", str(exc))
            break

    raise last or ProviderError(provider, label, "unknown")
