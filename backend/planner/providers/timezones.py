"""Log time zone resolution (BR-PLN-06, INT-04).

The log time zone is the time zone of the current location. If the lookup
library cannot place the point, we fall back to America/Chicago and the plan
carries a notice.
"""

from __future__ import annotations

import logging
from zoneinfo import ZoneInfo

logger = logging.getLogger("planner.timezones")

DEFAULT_TZ = "America/Chicago"
_finder = None


def _get_finder():
    global _finder
    if _finder is None:
        from timezonefinder import TimezoneFinder

        _finder = TimezoneFinder()
    return _finder


def zone_for(lat: float, lng: float) -> tuple[ZoneInfo, str, bool]:
    """Return (zone, name, used_fallback) for a point."""
    name = None
    try:
        name = _get_finder().timezone_at(lat=lat, lng=lng)
    except Exception:
        logger.warning("timezone_lookup_failed", extra={"lat": round(lat, 2)})
    if not name:
        return ZoneInfo(DEFAULT_TZ), DEFAULT_TZ, True
    try:
        return ZoneInfo(name), name, False
    except Exception:
        return ZoneInfo(DEFAULT_TZ), DEFAULT_TZ, True
