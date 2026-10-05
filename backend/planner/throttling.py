"""API-05: 30 requests per minute per client IP."""

from __future__ import annotations

import time

from django.conf import settings
from django.core.cache import cache

from .errors import RateLimited

WINDOW_SECONDS = 60


def enforce_rate_limit(request) -> None:
    """Fixed-window counter per IP; raises RateLimited when the window is full."""
    limit = settings.RATE_LIMIT_PER_MINUTE
    if not limit:
        return
    ip = _client_ip(request)
    window = int(time.time() // WINDOW_SECONDS)
    key = f"rl:{ip}:{window}"
    # add() only succeeds on the first call, which seeds the window's TTL.
    if cache.add(key, 1, WINDOW_SECONDS):
        return
    try:
        count = cache.incr(key)
    except ValueError:  # the entry expired between add() and incr()
        cache.set(key, 1, WINDOW_SECONDS)
        return
    if count > limit:
        raise RateLimited()


def _client_ip(request) -> str:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "unknown")
