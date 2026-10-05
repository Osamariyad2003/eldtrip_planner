"""Structured JSON logging (NFR-OBS-01, LOGR-04).

Never emits API keys, full request bodies or client IPs - only the fields
listed in section 11.
"""

from __future__ import annotations

import json
import logging

from .request_context import get_request_id

_RESERVED = {
    "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
    "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
    "pathname", "process", "processName", "relativeCreated", "stack_info",
    "taskName", "thread", "threadName",
}

_REDACT = ("key", "token", "secret", "password", "authorization")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
            "request_id": getattr(record, "request_id", None) or get_request_id(),
        }
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_") or key == "request_id":
                continue
            if any(marker in key.lower() for marker in _REDACT):
                value = "[redacted]"
            payload[key] = value
        if record.exc_info:
            payload["traceback"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)
