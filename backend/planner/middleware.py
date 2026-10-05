"""Request logging and the X-Request-ID header (NFR-OBS-01, NFR-OBS-02)."""

from __future__ import annotations

import logging
import time

from . import request_context

logger = logging.getLogger("planner.request")


class RequestLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        ctx = request_context.begin(request.headers.get("X-Request-ID"))
        started = time.perf_counter()
        response = self.get_response(request)
        duration_ms = (time.perf_counter() - started) * 1000

        response["X-Request-ID"] = ctx.request_id
        if request.path.startswith("/api/"):
            # LOGR-01: one INFO line per API request.
            logger.info(
                "request",
                extra={
                    "endpoint": request.path,
                    "method": request.method,
                    "status": response.status_code,
                    "duration_ms": round(duration_ms, 1),
                    "provider_calls": len(ctx.provider_calls),
                    "provider_timing_ms": [
                        {"provider": c.provider, "endpoint": c.endpoint,
                         "status": c.status, "ms": round(c.duration_ms, 1)}
                        for c in ctx.provider_calls
                    ],
                },
            )
        return response
