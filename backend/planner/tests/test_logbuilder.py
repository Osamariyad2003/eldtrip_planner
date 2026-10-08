"""Log builder tests: AC-05, and FR-LOG-01..08."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from planner.hos import EngineLeg, HosConfig, build_daily_logs, schedule
from planner.hos.logbuilder import LogInvalid, _brackets, _segments_for_day
from planner.hos.types import (
    DRIVING,
    OFF_DUTY,
    ON_DUTY,
    SLEEPER_BERTH,
    DutyEvent,
)

CT = ZoneInfo("America/Chicago")
NO_PRETRIP = HosConfig(pre_trip_min=0)


def legs(leg1_mi, leg2_mi, mph=50.0):
    return [
        EngineLeg("current", "pickup", leg1_mi, leg1_mi / mph if mph else 0),
        EngineLeg("pickup", "dropoff", leg2_mi, leg2_mi / mph if mph else 0),
    ]


def event(status, kind, start_min, end_min, location="Dallas, TX", note="", miles=0.0):
    base = datetime(2026, 3, 2, tzinfo=CT)
    from datetime import timedelta

    return DutyEvent(
        status=status,
        kind=kind,
        start=base + timedelta(minutes=start_min),
        end=base + timedelta(minutes=end_min),
        start_min=start_min,
        end_min=end_min,
        miles_start=0.0,
        miles_end=miles,
        location=location,
        note=note,
    )


# --- AC-05 ------------------------------------------------------------------


def schneider_day() -> list[DutyEvent]:
    """The AC-05 reference day: OFF 8.5, SB 5, D 9.5, ON 1, four stop brackets.

    Three driving runs separated by a break and a fuel stop, which is what
    gives the day its four stationary brackets.
    """
    return [
        event(OFF_DUTY, "off", 0, 360, note="Off duty"),                       # 6.0
        event(ON_DUTY, "pre_trip", 360, 390, note="Pre-trip inspection / TIV"),  # 0.5
        event(DRIVING, "drive", 390, 690, note="Depart", miles=250),           # 5.0
        event(OFF_DUTY, "break", 690, 720, note="30-min break"),               # 0.5
        event(DRIVING, "drive", 720, 900, note="Depart", miles=400),           # 3.0
        event(ON_DUTY, "fuel", 900, 930, note="Fuel"),                         # 0.5
        event(DRIVING, "drive", 930, 1020, note="Depart", miles=475),          # 1.5
        event(SLEEPER_BERTH, "rest_10", 1020, 1320, note="10-hr rest"),        # 5.0
        event(OFF_DUTY, "off", 1320, 1440, note="Off duty"),                   # 2.0
    ]


def test_ac05_schneider_reference_day():
    """OFF 8.5, SB 5, D 9.5, ON 1 with four brackets and circled 10.5."""
    logs = build_daily_logs(schneider_day(), header={}, cycle_used_hr=0)
    assert len(logs) == 1
    log = logs[0]
    assert log.totals == {OFF_DUTY: 8.5, SLEEPER_BERTH: 5.0, DRIVING: 9.5, ON_DUTY: 1.0}
    assert sum(log.totals.values()) == 24.0
    # FR-UI-04: the circled value is driving + on duty.
    assert log.recap.on_duty_today == 10.5
    # FR-LOG-07: one bracket per maximal stationary run.
    assert len(log.brackets) == 4


def test_ac05_brackets_are_maximal_non_driving_runs():
    segments = _segments_for_day(
        [(e, e.start_min, e.end_min, e.duration_min) for e in schneider_day()]
    )
    assert [(b.start_min, b.end_min) for b in _brackets(segments)] == [
        (0, 390),       # off duty and the pre-trip, one stationary run
        (690, 720),     # the 30-minute break
        (900, 930),     # the fuel stop
        (1020, 1440),   # sleeper berth, then off duty to midnight
    ]


def test_ac05_remark_per_duty_status_change():
    """FR-LOG-06: one remark per change of duty status, with location and label.

    AC-05 quotes "4 remarks" for this day, which matches the number of stops
    rather than the number of status changes. FR-LOG-06 is the normative rule,
    so the builder follows it and the day yields nine remarks.
    """
    log = build_daily_logs(schneider_day(), header={}, cycle_used_hr=0)[0]
    assert [r.minute for r in log.remarks] == [
        0, 360, 390, 690, 720, 900, 930, 1020, 1320
    ]
    assert log.remarks[1].note == "Pre-trip inspection / TIV"
    assert log.remarks[2].note == "Depart"          # BR-LOG-02
    assert all(r.location == "Dallas, TX" for r in log.remarks)
    # One remark per stop is also available, as a subset of the above.
    assert len([r for r in log.remarks if r.note != "Depart"]) == 6


def test_remarks_at_the_same_minute_merge():
    """FR-LOG-06: a zero-gap pair of changes produces one remark."""
    events = [
        event(ON_DUTY, "pre_trip", 0, 30, note="Pre-trip inspection / TIV"),
        event(DRIVING, "drive", 30, 60, note="Depart"),
        event(OFF_DUTY, "off", 60, 1440, note="Off duty"),
    ]
    log = build_daily_logs(events, header={}, cycle_used_hr=0)[0]
    assert [r.minute for r in log.remarks] == [0, 30, 60]


# --- FR-LOG-01..05 ----------------------------------------------------------


def test_segments_cover_the_day_exactly():
    """FR-LOG-03: padding to 0 and 1,440 minutes."""
    segments = _segments_for_day([(event(DRIVING, "drive", 480, 600), 480, 600, 120)])
    assert segments[0].start_min == 0 and segments[-1].end_min == 1440
    assert all(a.end_min == b.start_min for a, b in zip(segments, segments[1:], strict=False))
    assert sum(s.end_min - s.start_min for s in segments) == 1440


def test_midnight_crossing_is_split_keeping_kind():
    """FR-LOG-02."""
    events = schedule(
        legs(0, 1100), cycle_used_hr=0, start=datetime(2026, 3, 2, 20, tzinfo=CT),
        config=NO_PRETRIP,
    )
    logs = build_daily_logs(events, header={}, cycle_used_hr=0, config=NO_PRETRIP)
    assert len(logs) >= 2
    for log in logs:
        assert sum(log.totals.values()) == 24.0
        assert log.segments[0].start_min == 0
        assert log.segments[-1].end_min == 1440


def test_one_sheet_per_calendar_day():
    """FR-LOG-01: a trip ending before midnight on day N gives N sheets."""
    events = schedule(
        legs(0, 1100), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    logs = build_daily_logs(events, header={}, cycle_used_hr=0, config=NO_PRETRIP)
    assert [log.day_index for log in logs] == [0, 1]
    assert logs[0].date.isoformat() == "2026-03-02"
    assert logs[1].date.isoformat() == "2026-03-03"


def test_day_miles_sum_to_route_miles():
    """FR-LOG-05."""
    events = schedule(
        legs(240, 1860), cycle_used_hr=5, start=datetime(2026, 3, 2, 6, tzinfo=CT)
    )
    logs = build_daily_logs(events, header={}, cycle_used_hr=5)
    assert sum(log.miles_today for log in logs) == pytest.approx(2100.0, abs=0.5)


def test_totals_failure_raises_log_invalid():
    """FR-LOG-04: the 24-hour assertion is enforced, not assumed."""
    import planner.hos.logbuilder as lb

    original = lb._totals
    lb._totals = lambda segments: {OFF_DUTY: 1.0, SLEEPER_BERTH: 0.0,
                                   DRIVING: 0.0, ON_DUTY: 0.0}
    try:
        with pytest.raises(LogInvalid):
            build_daily_logs([event(DRIVING, "drive", 0, 60)], {}, 0)
    finally:
        lb._totals = original


# --- BR-LOG-03 recap --------------------------------------------------------


def test_recap_tracks_cycle_used():
    events = schedule(
        legs(0, 1100), cycle_used_hr=20, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    logs = build_daily_logs(events, header={}, cycle_used_hr=20, config=NO_PRETRIP)
    # Day 1: 20 h at start + 12 h worked (11 D + 1 ON).
    assert logs[0].recap.on_duty_today == 12.0
    assert logs[0].recap.total_last_8_days == 32.0
    assert logs[0].recap.available_tomorrow == 38.0
    # Day 2 adds 12.5 h (11 D + 1.5 ON).
    assert logs[1].recap.on_duty_today == 12.5
    assert logs[1].recap.total_last_8_days == 44.5
    assert logs[1].recap.available_tomorrow == 25.5
    assert not logs[0].recap.restart_taken


def test_recap_resets_after_restart():
    events = schedule(
        legs(0, 600), cycle_used_hr=70, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    logs = build_daily_logs(events, header={}, cycle_used_hr=70, config=NO_PRETRIP)
    restart_days = [log for log in logs if log.recap.restart_taken]
    assert len(restart_days) == 1
    # BR-LOG-03: after a restart, A counts only the hours since it ended.
    assert restart_days[0].recap.total_last_8_days == restart_days[0].recap.on_duty_today
    assert restart_days[0].recap.available_tomorrow == (
        70.0 - restart_days[0].recap.total_last_8_days
    )


def test_header_defaults_are_carried_per_day():
    """FR-LOG-09."""
    header = {"driver": "A. Driver", "carrier": "Acme", "co_driver": "N/A"}
    events = schedule(
        legs(0, 1100), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    logs = build_daily_logs(events, header=header, cycle_used_hr=0, config=NO_PRETRIP)
    for log in logs:
        assert log.header["driver"] == "A. Driver"
        assert log.header["co_driver"] == "N/A"
        assert log.header["date"] == log.date.isoformat()
        assert log.header["miles_today"] == log.miles_today
