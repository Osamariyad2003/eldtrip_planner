"""The daily log builder (section 4.5).

Turns the engine's duty events into one drawn-log-sheet worth of data per
calendar day in the log time zone: grid segments, per-status totals, remarks,
stationary brackets, the 70-hour recap and the header fields.

Pure, like the engine - it takes already-resolved location strings and never
calls out.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from .config import DEFAULT_CONFIG, HosConfig
from .types import (
    DRIVING,
    OFF,
    OFF_DUTY,
    ON_DUTY,
    STATUSES,
    DutyEvent,
)

MINUTES_PER_DAY = 1440


class LogInvalid(Exception):
    """FR-LOG-04 / BR-LOG-01: a day's totals did not come to 24 hours."""

    code = "log_invalid"


@dataclass
class LogSegment:
    status: str
    start_min: int
    end_min: int
    kind: str = ""


@dataclass
class Remark:
    minute: int
    location: str
    note: str


@dataclass
class Bracket:
    start_min: int
    end_min: int


@dataclass
class Recap:
    """BR-LOG-03."""

    on_duty_today: float
    total_last_8_days: float      # A
    available_tomorrow: float     # B
    restart_taken: bool


@dataclass
class DailyLog:
    date: date
    day_index: int
    miles_today: float
    header: dict
    segments: list[LogSegment] = field(default_factory=list)
    totals: dict = field(default_factory=dict)
    remarks: list[Remark] = field(default_factory=list)
    brackets: list[Bracket] = field(default_factory=list)
    recap: Recap | None = None


def _quarter(hours: float) -> float:
    """Round to 0.25 h, the resolution the log sheet is read at."""
    return round(hours * 4) / 4


def build_daily_logs(
    events: list[DutyEvent],
    header: dict,
    cycle_used_hr: float,
    config: HosConfig | None = None,
) -> list[DailyLog]:
    """Build one DailyLog per calendar day covered by ``events``.

    ``header`` supplies the resolved, defaulted values for FR-LOG-09; the
    per-day ``date``, ``from``, ``to`` and ``miles_today`` fields are filled
    in here.
    """
    cfg = config or DEFAULT_CONFIG
    if not events:
        return []

    day_zero = events[0].start.replace(hour=0, minute=0, second=0, microsecond=0)
    # FR-LOG-02: split any event crossing midnight at 00:00, keeping its kind.
    per_day: dict[int, list[tuple[DutyEvent, int, int]]] = {}
    for event in events:
        start_abs = _minutes_since(day_zero, event.start)
        end_abs = _minutes_since(day_zero, event.end)
        cursor = start_abs
        while cursor < end_abs:
            day = cursor // MINUTES_PER_DAY
            day_end = (day + 1) * MINUTES_PER_DAY
            piece_end = min(end_abs, day_end)
            per_day.setdefault(day, []).append(
                (event, cursor - day * MINUTES_PER_DAY, piece_end - day * MINUTES_PER_DAY)
            )
            cursor = piece_end

    logs: list[DailyLog] = []
    cumulative_on_duty = 0.0           # ON + D since the trip start, in hours
    cycle_at_base = _quarter(cycle_used_hr)  # BR-LOG-03: cycle used at start
    total_miles_assigned = 0.0

    for day_index in range(max(per_day) + 1):
        pieces = per_day.get(day_index, [])
        day_date = (day_zero + timedelta(days=day_index)).date()
        segments = _segments_for_day(pieces)
        totals = _totals(segments)

        if abs(sum(totals.values()) - 24.0) > 1e-9:
            raise LogInvalid(
                f"{day_date}: status totals sum to {sum(totals.values()):.4f}, not 24.00"
            )

        # FR-LOG-05: miles driven today.
        miles_today = sum(
            _prorated_miles(event, start, end) for event, start, end in pieces
        )
        total_miles_assigned += miles_today

        day_on_duty = _quarter(totals[DRIVING] + totals[ON_DUTY])
        restart_taken = any(
            event.kind == "restart_34" and end > start and end <= MINUTES_PER_DAY
            and _ends_today(event, day_zero, day_index)
            for event, start, end in pieces
        )
        if restart_taken:
            # BR-LOG-03: after a restart, A counts only hours since it ended.
            cycle_at_base = 0.0
            cumulative_on_duty = _on_duty_after_restart(pieces, day_zero, day_index)
        else:
            cumulative_on_duty += day_on_duty

        total_a = _quarter(cycle_at_base + cumulative_on_duty)
        recap = Recap(
            on_duty_today=day_on_duty,
            total_last_8_days=total_a,
            available_tomorrow=_quarter(max(0.0, cfg.cycle_limit_min / 60 - total_a)),
            restart_taken=restart_taken,
        )

        day_header = dict(header)
        day_header["date"] = day_date.isoformat()
        day_header["miles_today"] = round(miles_today, 1)
        day_header["total_miles_today"] = round(miles_today, 1)

        logs.append(
            DailyLog(
                date=day_date,
                day_index=day_index,
                miles_today=round(miles_today, 1),
                header=day_header,
                segments=segments,
                totals={k: _quarter(v) for k, v in totals.items()},
                remarks=_remarks_for_day(pieces),
                brackets=_brackets(segments),
                recap=recap,
            )
        )

    return logs


def _minutes_since(origin: datetime, moment: datetime) -> int:
    return int((moment - origin).total_seconds() // 60)


def _ends_today(event: DutyEvent, day_zero: datetime, day_index: int) -> bool:
    end_abs = _minutes_since(day_zero, event.end)
    return day_index * MINUTES_PER_DAY < end_abs <= (day_index + 1) * MINUTES_PER_DAY


def _prorated_miles(event: DutyEvent, start: int, end: int) -> float:
    """The share of an event's miles falling in one day's slice of it."""
    if not event.is_drive or event.duration_min <= 0:
        return 0.0
    return event.miles * (end - start) / event.duration_min


def _segments_for_day(pieces: list[tuple[DutyEvent, int, int]]) -> list[LogSegment]:
    """Grid segments covering 0-1,440 minutes exactly (FR-LOG-03).

    Pads with OFF before the first event and after the last, and merges
    adjacent same-status runs so the drawn line has one step per real change.
    """
    raw = [LogSegment(event.status, start, end, event.kind) for event, start, end in pieces]
    raw.sort(key=lambda s: s.start_min)

    filled: list[LogSegment] = []
    cursor = 0
    for seg in raw:
        if seg.start_min > cursor:
            filled.append(LogSegment(OFF_DUTY, cursor, seg.start_min, OFF))
        filled.append(seg)
        cursor = seg.end_min
    if cursor < MINUTES_PER_DAY:
        filled.append(LogSegment(OFF_DUTY, cursor, MINUTES_PER_DAY, OFF))

    merged: list[LogSegment] = []
    for seg in filled:
        if merged and merged[-1].status == seg.status and merged[-1].end_min == seg.start_min:
            merged[-1].end_min = seg.end_min
        else:
            merged.append(LogSegment(seg.status, seg.start_min, seg.end_min, seg.kind))
    return merged


def _totals(segments: list[LogSegment]) -> dict[str, float]:
    """FR-LOG-04: hours per duty status, summing to 24."""
    totals = dict.fromkeys(STATUSES, 0.0)
    for seg in segments:
        totals[seg.status] += (seg.end_min - seg.start_min) / 60.0
    return totals


def _remarks_for_day(pieces: list[tuple[DutyEvent, int, int]]) -> list[Remark]:
    """FR-LOG-06: one remark per change of duty status, merged by minute."""
    by_minute: dict[int, Remark] = {}
    previous_status: str | None = None
    for event, start, _end in sorted(pieces, key=lambda p: p[1]):
        if event.status != previous_status:
            existing = by_minute.get(start)
            if existing is None:
                by_minute[start] = Remark(
                    minute=start,
                    location=event.location or "",
                    note=event.note or "",
                )
            elif event.note and event.note not in existing.note:
                existing.note = f"{existing.note} / {event.note}".strip(" /")
        previous_status = event.status
    return [by_minute[m] for m in sorted(by_minute)]


def _brackets(segments: list[LogSegment]) -> list[Bracket]:
    """FR-LOG-07: one bracket per maximal run of non-driving time."""
    brackets: list[Bracket] = []
    run_start: int | None = None
    for seg in segments:
        if seg.status == DRIVING:
            if run_start is not None:
                brackets.append(Bracket(run_start, seg.start_min))
                run_start = None
        elif run_start is None:
            run_start = seg.start_min
    if run_start is not None and run_start < MINUTES_PER_DAY:
        brackets.append(Bracket(run_start, MINUTES_PER_DAY))
    return [b for b in brackets if b.end_min > b.start_min]


def _on_duty_after_restart(
    pieces: list[tuple[DutyEvent, int, int]], day_zero: datetime, day_index: int
) -> float:
    """ON + D hours on this day that fall after the restart ended."""
    restart_end = 0
    for event, _start, end in pieces:
        if event.kind == "restart_34" and _ends_today(event, day_zero, day_index):
            restart_end = max(restart_end, end)
    hours = 0.0
    for event, start, end in pieces:
        if event.status in (DRIVING, ON_DUTY) and end > restart_end:
            hours += (end - max(start, restart_end)) / 60.0
    return _quarter(hours)
