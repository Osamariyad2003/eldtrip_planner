"""The single API error format (section 10).

Every failure the client can see is one of these codes, rendered as
``{"error": {"code", "message", "fields", "request_id"}}``. The UI shows
``message`` and never a stack trace.
"""

from __future__ import annotations

import logging

from django.http import JsonResponse
from rest_framework import status as http
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from .request_context import get_request_id

logger = logging.getLogger(__name__)


class ApiError(Exception):
    """A failure that maps directly onto a section 10 row."""

    code = "internal_error"
    status_code = http.HTTP_500_INTERNAL_SERVER_ERROR
    message = "Something went wrong."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        status_code: int | None = None,
        fields: dict | None = None,
    ) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        self.fields = fields or {}


class ValidationFailed(ApiError):
    code = "validation_error"
    status_code = http.HTTP_400_BAD_REQUEST
    message = "Please correct the highlighted fields."


class NotFound(ApiError):
    code = "not_found"
    status_code = http.HTTP_400_BAD_REQUEST
    message = "That location could not be found."


class RouteNotFound(ApiError):
    code = "route_not_found"
    status_code = http.HTTP_422_UNPROCESSABLE_ENTITY
    message = "No road route could be found for that leg."


class TripTooLong(ApiError):
    code = "trip_too_long"
    status_code = http.HTTP_422_UNPROCESSABLE_ENTITY
    message = "This trip is longer than the 5,000 mile limit."


class RateLimited(ApiError):
    code = "rate_limited"
    status_code = http.HTTP_429_TOO_MANY_REQUESTS
    message = "Too many requests, try again in a minute."


class ProviderUnavailable(ApiError):
    code = "provider_unavailable"
    status_code = http.HTTP_503_SERVICE_UNAVAILABLE
    message = "A map provider is unavailable. Please retry."


class ScheduleFailed(ApiError):
    code = "schedule_failed"
    message = "Something went wrong building the schedule."


class LogInvalidError(ApiError):
    code = "log_invalid"
    message = "Something went wrong building the log sheets."


def error_body(
    code: str, message: str, fields: dict | None = None, request_id: str | None = None
) -> dict:
    return {
        "error": {
            "code": code,
            "message": message,
            "fields": fields or {},
            "request_id": request_id or get_request_id(),
        }
    }


def exception_handler(exc, context):
    """DRF hook: render ApiError in our format, and never leak a traceback."""
    if isinstance(exc, ApiError):
        if exc.status_code >= 500:
            logger.error(
                "api_error", extra={"code": exc.code, "detail": str(exc)}, exc_info=exc
            )
        return Response(
            error_body(exc.code, exc.message, exc.fields), status=exc.status_code
        )

    response = drf_exception_handler(exc, context)
    if response is not None:
        detail = response.data
        message = ValidationFailed.message
        fields = {}
        if isinstance(detail, dict):
            fields = {k: _first(v) for k, v in detail.items() if k != "detail"}
            if "detail" in detail:
                message = str(detail["detail"])
        elif isinstance(detail, list):
            message = _first(detail)
        code = "validation_error" if response.status_code == 400 else "request_failed"
        response.data = error_body(code, message, fields)
        return response

    # LOGR-03: unexpected failures are logged with a stack trace and returned
    # as a generic 500 so the UI never shows internals.
    logger.exception("unhandled_exception")
    return Response(
        error_body("internal_error", ApiError.message),
        status=http.HTTP_500_INTERNAL_SERVER_ERROR,
    )


def _first(value) -> str:
    if isinstance(value, (list, tuple)) and value:
        return str(value[0])
    return str(value)


def api_not_found(request, exception=None):
    """ERR-02: 404 JSON for unknown routes."""
    return JsonResponse(
        error_body("not_found", "That endpoint does not exist."), status=404
    )
