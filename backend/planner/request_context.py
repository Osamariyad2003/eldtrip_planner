"""Per-request context: the request ID and provider-call accounting.

Kept in a ContextVar so the logging formatter and the error body can reach it
without threading it through every function (NFR-OBS-01, NFR-OBS-02).
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field

_current: ContextVar[RequestContext | None] = ContextVar("request_context", default=None)


@dataclass
class ProviderCall:
    provider: str
    endpoint: str
    status: int | str
    duration_ms: float


@dataclass
class RequestContext:
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    provider_calls: list[ProviderCall] = field(default_factory=list)

    def record(self, provider: str, endpoint: str, status: int | str, duration_ms: float) -> None:
        self.provider_calls.append(ProviderCall(provider, endpoint, status, duration_ms))


def begin(request_id: str | None = None) -> RequestContext:
    ctx = RequestContext(request_id=request_id) if request_id else RequestContext()
    _current.set(ctx)
    return ctx


def current() -> RequestContext | None:
    return _current.get()


def get_request_id() -> str:
    ctx = _current.get()
    return ctx.request_id if ctx else "-"


def record_provider_call(
    provider: str, endpoint: str, status: int | str, duration_ms: float
) -> None:
    ctx = _current.get()
    if ctx is not None:
        ctx.record(provider, endpoint, status, duration_ms)
