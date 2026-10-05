"""Engine acceptance tests: AC-01, AC-02, AC-04 and the rule invariants."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from planner.hos import DEFAULT_CONFIG, EngineLeg, HosConfig, ScheduleError, schedule
from planner.hos.types import (
    BREAK,
    DRIVE,
    DRIVING,
    DROPOFF,
    FUEL,
    OFF_DUTY,
    ON_DUTY,
    PICKUP,
    REST_10,
    RESTART_34,
    SLEEPER_BERTH,
)

CT = ZoneInfo("America/Chicago")
NO_PRETRIP = HosConfig(pre_trip_min=0)


def legs(leg1_mi: float, leg2_mi: float, mph: float = 50.0) -> list[EngineLeg]:
    return [
        EngineLeg("current", "pickup", leg1_mi, leg1_mi / mph if mph else 0.0),
        EngineLeg("pickup", "dropoff", leg2_mi, leg2_mi / mph if mph else 0.0),
    ]


def clock(event) -> tuple[str, str]:
    return event.start.strftime("%H:%M"), event.end.strftime("%H:%M")


def summarise(events) -> list[tuple[str, str, str]]:
    return [(e.kind, *clock(e)) for e in events]


# --- AC-01 ------------------------------------------------------------------


def test_ac01_reference_schedule():
    """1,100 mi leg at 50 mph, cycle 0, start 08:00, pre-trip 0."""
    events = schedule(
        legs(0, 1100), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    # Drop the trailing off-duty padding, which is not part of the fixture.
    body = [e for e in events if e.kind != "off"]
    assert summarise(body) == [
        (PICKUP, "08:00", "09:00"),
        (DRIVE, "09:00", "17:00"),
        (BREAK, "17:00", "17:30"),
        (DRIVE, "17:30", "20:30"),
        (REST_10, "20:30", "06:30"),
        (DRIVE, "06:30", "14:30"),
        (BREAK, "14:30", "15:00"),
        (DRIVE, "15:00", "16:00"),
        (FUEL, "16:00", "16:30"),
        (DRIVE, "16:30", "18:30"),
        (DROPOFF, "18:30", "19:30"),
    ]
    assert events[-1].kind == "off"
    assert clock(events[-1]) == ("19:30", "00:00")
    # The 10-hour rest is logged sleeper berth, breaks and padding off duty.
    assert body[4].status == SLEEPER_BERTH
    assert body[2].status == OFF_DUTY
    assert body[0].status == ON_DUTY
    assert body[1].status == DRIVING
    # Miles are exact end to end.
    assert events[-1].miles_end == pytest.approx(1100.0)


def test_ac01_daily_totals():
    from planner.hos import build_daily_logs

    events = schedule(
        legs(0, 1100), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    logs = build_daily_logs(events, header={}, cycle_used_hr=0, config=NO_PRETRIP)
    assert len(logs) == 2
    assert logs[0].totals == {OFF_DUTY: 8.5, SLEEPER_BERTH: 3.5, DRIVING: 11.0, ON_DUTY: 1.0}
    assert logs[1].totals == {OFF_DUTY: 5.0, SLEEPER_BERTH: 6.5, DRIVING: 11.0, ON_DUTY: 1.5}
    assert sum(logs[0].totals.values()) == 24.0
    assert sum(logs[1].totals.values()) == 24.0
    assert logs[0].miles_today + logs[1].miles_today == pytest.approx(1100.0, abs=0.5)


# --- AC-02 ------------------------------------------------------------------


def test_ac02_restart_mid_trip_at_cycle_65():
    events = schedule(
        legs(0, 1100), cycle_used_hr=65, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    restarts = [e for e in events if e.kind == RESTART_34]
    assert len(restarts) == 1
    assert restarts[0].start.strftime("%a %H:%M") == "Mon 13:00"
    assert restarts[0].end.strftime("%a %H:%M") == "Tue 23:00"
    assert restarts[0].status == OFF_DUTY


def test_ac02_restart_is_first_event_at_cycle_70():
    events = schedule(
        legs(0, 1100), cycle_used_hr=70, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=NO_PRETRIP,
    )
    assert events[0].kind == RESTART_34
    assert clock(events[0]) == ("08:00", "18:00")


def test_restart_is_first_event_at_cycle_70_with_pretrip():
    events = schedule(
        legs(0, 300), cycle_used_hr=70, start=datetime(2026, 3, 2, 8, tzinfo=CT)
    )
    assert events[0].kind == RESTART_34
    assert events[1].kind == "pre_trip"


def test_pretrip_never_pushes_cycle_over_limit():
    """A near-full cycle must restart before the 30-minute pre-trip."""
    events = schedule(
        legs(0, 100), cycle_used_hr=69.75, start=datetime(2026, 3, 2, 8, tzinfo=CT)
    )
    assert events[0].kind == RESTART_34


# --- AC-04 ------------------------------------------------------------------


def test_ac04_short_trip_single_sheet():
    from planner.hos import build_daily_logs

    events = schedule(
        legs(50, 100), cycle_used_hr=0, start=datetime(2026, 3, 2, 6, tzinfo=CT)
    )
    kinds = {e.kind for e in events}
    assert not kinds & {BREAK, REST_10, FUEL, RESTART_34}
    logs = build_daily_logs(events, header={}, cycle_used_hr=0)
    assert len(logs) == 1
    assert sum(logs[0].totals.values()) == 24.0
    assert logs[0].miles_today == pytest.approx(150.0, abs=0.5)


# --- rule invariants --------------------------------------------------------


def assert_no_violations(events, cfg=DEFAULT_CONFIG, cycle_used_hr=0.0):
    """Check BR-HOS-01..04 and BR-PLN-01 over a whole schedule."""
    drive_in_period = window_start = drive_since_break = 0
    cycle = int(round(cycle_used_hr * 4)) * 15
    miles_since_fuel = 0.0
    on_duty = False

    for event in events:
        dur = event.duration_min
        if event.kind in (REST_10, RESTART_34):
            on_duty = False
            if event.kind == RESTART_34:
                cycle = 0
            continue
        if not on_duty and event.status in (DRIVING, ON_DUTY):
            on_duty = True
            window_start = event.start_min
            drive_in_period = drive_since_break = 0
        if event.status == DRIVING:
            drive_in_period += dur
            drive_since_break += dur
            cycle += dur
            miles_since_fuel += event.miles
            assert drive_in_period <= cfg.drive_limit_min, "BR-HOS-01"
            assert event.end_min <= window_start + cfg.window_limit_min, "BR-HOS-02"
            assert drive_since_break <= cfg.drive_before_break_min, "BR-HOS-03"
            assert cycle <= cfg.cycle_limit_min, "BR-HOS-04"
            assert miles_since_fuel <= cfg.fuel_interval_mi + 1e-6, "BR-PLN-01"
        else:
            if event.status == ON_DUTY:
                cycle += dur
                assert cycle <= cfg.cycle_limit_min, "BR-HOS-04"
            if dur >= cfg.break_min:
                drive_since_break = 0
            if event.kind == FUEL:
                miles_since_fuel = 0.0


def test_events_are_contiguous_and_on_quarter_hours():
    events = schedule(
        legs(120, 2400), cycle_used_hr=12.5, start=datetime(2026, 3, 2, 7, 15, tzinfo=CT)
    )
    assert events[0].start_min == 0
    for prev, cur in zip(events, events[1:], strict=False):
        assert prev.end_min == cur.start_min, "no gaps or overlaps (FR-HOS-01)"
        assert prev.miles_end == pytest.approx(cur.miles_start)
    for event in events:
        assert event.start_min % 15 == 0 and event.end_min % 15 == 0, "FR-HOS-06"
    assert_no_violations(events, cycle_used_hr=12.5)


def test_fuel_stop_every_thousand_miles():
    events = schedule(
        legs(0, 2600), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT)
    )
    assert len([e for e in events if e.kind == FUEL]) == 2
    assert_no_violations(events)


def test_same_place_trip_has_no_driving():
    events = schedule(legs(0, 0), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT))
    assert not [e for e in events if e.kind == DRIVE]
    assert {e.kind for e in events} == {"pre_trip", PICKUP, DROPOFF, "off"}
    assert events[-1].miles_end == 0.0


def test_determinism():
    """NFR-REL-01: identical inputs give identical output."""
    args = dict(cycle_used_hr=31.25, start=datetime(2026, 7, 4, 5, 30, tzinfo=CT))
    first = summarise(schedule(legs(310, 1480), **args))
    second = summarise(schedule(legs(310, 1480), **args))
    assert first == second


def test_config_is_honoured():
    """FR-HOS-07: tests can override limits such as pre-trip."""
    events = schedule(
        legs(0, 600), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT),
        config=HosConfig(pre_trip_min=45, pickup_min=90),
    )
    assert events[0].kind == "pre_trip" and events[0].duration_min == 45
    assert [e for e in events if e.kind == PICKUP][0].duration_min == 90


def test_schedule_failure_is_typed():
    """FR-HOS-08: the simulated-day budget raises a typed error."""
    with pytest.raises(ScheduleError):
        schedule(
            legs(0, 4800), cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT),
            config=HosConfig(max_simulated_days=2),
        )


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(cycle_used_hr=71),
        dict(cycle_used_hr=-1),
        dict(start=datetime(2026, 3, 2, 8, 7, tzinfo=CT)),
        dict(start=datetime(2026, 3, 2, 8)),
    ],
)
def test_invalid_inputs_rejected(kwargs):
    base = dict(cycle_used_hr=0, start=datetime(2026, 3, 2, 8, tzinfo=CT))
    with pytest.raises(ValueError):
        schedule(legs(0, 100), **{**base, **kwargs})
