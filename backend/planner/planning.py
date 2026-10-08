"""The planning service: validated request in, TripPlan out.

Orchestrates geocoding, routing, the engine and the log builder, and is the
only place that knows about all four (WF-1 step 6).
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .errors import LogInvalidError, ScheduleFailed, TripTooLong
from .hos import (
    DEFAULT_CONFIG,
    EngineLeg,
    HosConfig,
    ScheduleError,
    build_daily_logs,
    schedule,
)
from .hos.logbuilder import DailyLog, LogInvalid
from .hos.types import DRIVE, DRIVING, OFF, ON_DUTY, STOP_KINDS, DutyEvent
from .providers import geocoding, routing, timezones

logger = logging.getLogger("planner.planning")

STEP_MINUTES = 15


def plan_trip(data: dict, config: HosConfig | None = None) -> dict:
    """Build the full plan payload for API-01."""
    cfg = config or DEFAULT_CONFIG

    # 1. Resolve the three locations.
    current = _resolve(data["current"])
    pickup = _resolve(data["pickup"])
    dropoff = _resolve(data["dropoff"])
    notices: list[str] = []

    # 2. Log time zone comes from the current location (BR-PLN-06).
    zone, zone_name, tz_fallback = timezones.zone_for(current.lat, current.lng)
    if tz_fallback:
        notices.append(
            f"Time zone could not be determined; logs use {zone_name}."
        )

    # 3. Route both legs.
    try:
        route = routing.route_trip(
            [
                (current.label, current.lat, current.lng),
                (pickup.label, pickup.lat, pickup.lng),
                (dropoff.label, dropoff.lat, dropoff.lng),
            ]
        )
    except routing.TripTooLongError as exc:
        raise TripTooLong(
            f"This trip is {exc.miles:,.0f} miles, over the 5,000 mile limit."
        ) from exc

    if route.provider == routing.PROVIDER_CAR:
        notices.append("Car routing used; truck times may differ.")
    if route.total_miles == 0:
        # FR-INP-06
        notices.append("All locations are the same place.")

    # 4. Start time (BR-PLN-07 default: next full hour in the log time zone).
    start = _start_time(data.get("start_time"), zone)

    # 5. Run the engine.
    legs = [
        EngineLeg(leg.from_label, leg.to_label, leg.distance_mi, leg.duration_hr, leg.geometry)
        for leg in route.legs
    ]
    try:
        events = schedule(legs, data["cycle_used_hr"], start, cfg)
    except ScheduleError as exc:
        logger.error("schedule_failed", extra={"detail": str(exc)}, exc_info=exc)
        raise ScheduleFailed() from exc

    # 6. Name every event's location (FR-GEO-03), then build the log sheets.
    if _label_events(events, current, pickup, dropoff):
        notices.append(
            "Some stop locations are shown as coordinates; place names were "
            "unavailable."
        )
    header = _header(data, current, pickup, dropoff)
    try:
        daily_logs = build_daily_logs(events, header, data["cycle_used_hr"], cfg)
    except LogInvalid as exc:
        logger.error("log_invalid", extra={"detail": str(exc)}, exc_info=exc)
        raise LogInvalidError() from exc

    _fill_day_endpoints(daily_logs, events)

    return {
        "summary": _summary(events, route, zone_name, start, len(daily_logs)),
        "route": {
            "geometry": [
                [round(lat, 5), round(lng, 5)] for lat, lng in route.combined_geometry()
            ],
            "legs": [leg.as_dict() for leg in route.legs],
        },
        "stops": [_stop_dict(e) for e in events if e.kind in STOP_KINDS],
        "events": [_event_dict(e) for e in events],
        "daily_logs": [_log_dict(log) for log in daily_logs],
        "notices": notices,
        "assumptions": _assumptions(cfg),
    }


# -- geocoding -------------------------------------------------------------


def _resolve(location: dict) -> geocoding.Place:
    """Use supplied coordinates when present, else geocode the label."""
    if location.get("lat") is not None and location.get("lng") is not None:
        label = location["label"]
        city_state = geocoding.reverse(location["lat"], location["lng"], fallback=label)
        city, _, state = city_state.partition(", ")
        return geocoding.Place(
            label=label, lat=location["lat"], lng=location["lng"],
            city=city, state=state,
        )
    return geocoding.geocode(location["label"])


def _label_events(
    events: list[DutyEvent],
    current: geocoding.Place,
    pickup: geocoding.Place,
    dropoff: geocoding.Place,
) -> bool:
    """FR-GEO-03: give each duty-status change a "City, ST" location.

    The three trip endpoints are already known, so only the interpolated stop
    points need a reverse lookup. Those are resolved in one batch: distinct
    points are asked for once, the batch spends a bounded number of provider
    calls, and the cache (keyed to 3 decimals) means a repeated trip asks for
    nothing at all.

    Returns True when at least one point had to fall back to coordinates, so
    the caller can say so in the plan's notices.
    """
    needs_lookup: dict[tuple[float, float], list[DutyEvent]] = {}

    for event in events:
        if event.kind == "pickup":
            event.location = pickup.city_state
            event.lat, event.lng = pickup.lat, pickup.lng
        elif event.kind == "dropoff":
            event.location = dropoff.city_state
            event.lat, event.lng = dropoff.lat, dropoff.lng
        elif event.start_min == 0 or (event.kind == "pre_trip" and event.miles_start == 0):
            event.location = current.city_state
            event.lat = event.lat if event.lat is not None else current.lat
            event.lng = event.lng if event.lng is not None else current.lng
        elif event.lat is not None and event.lng is not None:
            needs_lookup.setdefault((event.lat, event.lng), []).append(event)
        else:
            event.location = current.city_state
            event.lat, event.lng = current.lat, current.lng

    if not needs_lookup:
        return False

    batch = geocoding.reverse_many(list(needs_lookup))
    for point, point_events in needs_lookup.items():
        for event in point_events:
            event.location = batch.labels[point]
    return batch.degraded


# -- defaults and header ---------------------------------------------------


def _start_time(supplied: datetime | None, zone: ZoneInfo) -> datetime:
    """BR-PLN-07: default is the next full hour in the log time zone."""
    if supplied is not None:
        local = supplied.astimezone(zone)
        # FR-HOS-06 needs a 15-minute boundary; round down to one.
        return local.replace(
            minute=local.minute - local.minute % STEP_MINUTES, second=0, microsecond=0
        )
    now = datetime.now(zone)
    return (now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))


def _header(
    data: dict,
    current: geocoding.Place,
    pickup: geocoding.Place,
    dropoff: geocoding.Place,
) -> dict:
    """FR-LOG-09 header fields, with BR-PLN-07 defaults for blanks."""
    city = current.city_state
    return {
        "driver": data.get("driver") or "Driver",
        "co_driver": "N/A",
        "carrier": data.get("carrier") or "Carrier",
        "main_office": data.get("main_office") or city,
        "home_terminal": data.get("home_terminal") or data.get("main_office") or city,
        "vehicle": data.get("vehicle") or "TRK-001 / TRL-001",
        "shipper": data.get("shipper") or "Shipper at pickup",
        "commodity": data.get("commodity") or "General freight",
        "shipping_document": data.get("shipping_document") or _bol(data),
        "from_label": current.city_state,
        "to_label": dropoff.city_state,
        "pickup_label": pickup.city_state,
    }


def _bol(data: dict) -> str:
    """BR-PLN-07: "BOL-" plus a 6-character hash of the inputs."""
    seed = "|".join(
        str(data.get(key, "")) for key in ("current", "pickup", "dropoff", "cycle_used_hr")
    )
    return "BOL-" + hashlib.sha256(seed.encode()).hexdigest()[:6].upper()


def _assumptions(cfg: HosConfig) -> list[str]:
    """FR-UI-07: the panel lists BR-PLN-02, BR-PLN-03, BR-PLN-06 and pre-trip."""
    return [
        f"Pickup and dropoff are {cfg.pickup_min} minutes on duty each (BR-PLN-02).",
        f"Pre-trip inspection is {cfg.pre_trip_min} minutes at trip start and after "
        "every 10-hour rest or 34-hour restart (BR-PLN-02).",
        "The driver starts fresh, with at least 10 hours off before the start. "
        "Cycle used stays fixed during the trip except for a 34-hour restart; "
        "no hours roll off (BR-PLN-03).",
        "Logs use the time zone of the current location. 10-hour rests are logged "
        "sleeper berth; 30-minute breaks, 34-hour restarts and time outside the "
        "trip are logged off duty (BR-PLN-06).",
        f"Fuel stop at least every {cfg.fuel_interval_mi:,.0f} miles, "
        f"{cfg.fuel_min} minutes on duty (BR-PLN-01).",
    ]


# -- response shaping ------------------------------------------------------


def _summary(
    events: list[DutyEvent],
    route,
    zone_name: str,
    start: datetime,
    num_days: int,
) -> dict:
    driving = sum(e.duration_hr for e in events if e.status == DRIVING)
    on_duty = sum(e.duration_hr for e in events if e.status == ON_DUTY)
    # The trailing off-duty padding is not part of the working trip.
    working = [e for e in events if e.kind != OFF] or events
    trip_end = working[-1].end
    return {
        "total_miles": round(route.total_miles, 1),
        "driving_hours": round(driving, 2),
        "on_duty_hours": round(on_duty, 2),
        "trip_start": start.isoformat(),
        "trip_end": trip_end.isoformat(),
        "total_elapsed_hours": round((trip_end - start).total_seconds() / 3600, 2),
        # FR-UI-06: the count shown must be the number of sheets FR-LOG-01
        # produced. Counting distinct event start dates undercounts a calendar
        # day swallowed whole by a 34-hour restart, which still gets a sheet.
        "num_days": num_days,
        "num_fuel_stops": sum(1 for e in events if e.kind == "fuel"),
        "num_rests": sum(1 for e in events if e.kind == "rest_10"),
        "num_restarts": sum(1 for e in events if e.kind == "restart_34"),
        "timezone": zone_name,
        "routing_provider": route.provider,
    }


def _event_dict(event: DutyEvent) -> dict:
    return {
        "status": event.status,
        "kind": event.kind,
        "start": event.start.isoformat(),
        "end": event.end.isoformat(),
        "duration_hr": round(event.duration_hr, 2),
        "miles_start": round(event.miles_start, 1),
        "miles_end": round(event.miles_end, 1),
        "lat": round(event.lat, 6) if event.lat is not None else None,
        "lng": round(event.lng, 6) if event.lng is not None else None,
        "location": event.location,
        "note": event.note,
    }


def _stop_dict(event: DutyEvent) -> dict:
    """Stop is the derived map/timeline view of a non-drive event (section 7.1)."""
    return {
        **_event_dict(event),
        "duration_hr": round(event.duration_hr, 2),
        "miles_from_start": round(event.miles_start, 1),
    }


def _log_dict(log: DailyLog) -> dict:
    return {
        "date": log.date.isoformat(),
        "day_index": log.day_index,
        "miles_today": log.miles_today,
        "header": log.header,
        "segments": [
            {"status": s.status, "start_min": s.start_min, "end_min": s.end_min, "kind": s.kind}
            for s in log.segments
        ],
        "totals": {k: round(v, 2) for k, v in log.totals.items()},
        "remarks": [
            {"minute": r.minute, "location": r.location, "note": r.note} for r in log.remarks
        ],
        "brackets": [{"start_min": b.start_min, "end_min": b.end_min} for b in log.brackets],
        "recap": {
            "on_duty_today": log.recap.on_duty_today,
            "total_last_8_days": log.recap.total_last_8_days,
            "available_tomorrow": log.recap.available_tomorrow,
            "restart_taken": log.recap.restart_taken,
        }
        if log.recap
        else None,
    }


def _fill_day_endpoints(logs: list[DailyLog], events: list[DutyEvent]) -> None:
    """Set each sheet's From / To to where the day's driving began and ended."""
    by_date: dict[str, list[DutyEvent]] = {}
    for event in events:
        if event.kind in (DRIVE, "pickup", "dropoff", "fuel"):
            by_date.setdefault(event.start.date().isoformat(), []).append(event)
    for log in logs:
        day_events = by_date.get(log.date.isoformat()) or []
        if day_events:
            log.header["from_label"] = day_events[0].location or log.header.get("from_label", "")
            log.header["to_label"] = day_events[-1].location or log.header.get("to_label", "")
