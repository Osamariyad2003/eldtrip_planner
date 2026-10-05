"""AC-03: the invariant suite over randomly generated trips.

500 random trips (50-3,000 mi, cycle 0-70): no event breaks BR-HOS-01..04 or
BR-PLN-01; every day totals 24.00; segments are contiguous; day miles sum to
route miles within half a mile.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from hypothesis import HealthCheck, given
from hypothesis import settings as hyp_settings
from hypothesis import strategies as st

from planner.hos import DEFAULT_CONFIG, EngineLeg, build_daily_logs, schedule
from planner.hos.types import DRIVING, ON_DUTY

from .test_engine import assert_no_violations

CT = ZoneInfo("America/Chicago")

trip_miles = st.floats(min_value=50, max_value=3000, allow_nan=False, allow_infinity=False)
leg_split = st.floats(min_value=0.0, max_value=1.0)
cycle_hours = st.sampled_from([i / 4 for i in range(0, 281)])  # 0 to 70 in 0.25 steps
speeds = st.floats(min_value=35, max_value=70)
start_offsets = st.integers(min_value=0, max_value=95)  # 15-minute steps over a day


def _legs(total_mi: float, split: float, mph: float) -> list[EngineLeg]:
    leg1 = total_mi * split
    leg2 = total_mi - leg1
    return [
        EngineLeg("current", "pickup", leg1, leg1 / mph),
        EngineLeg("pickup", "dropoff", leg2, leg2 / mph),
    ]


def check_trip(total_mi: float, split: float, cycle: float, mph: float, offset: int) -> None:
    start = datetime(2026, 3, 2, tzinfo=CT) + timedelta(minutes=15 * offset)
    legs = _legs(total_mi, split, mph)
    events = schedule(legs, cycle, start)

    # Contiguous, quarter-hour, monotonic in miles (FR-HOS-01, FR-HOS-06).
    assert events[0].start_min == 0
    for prev, cur in zip(events, events[1:], strict=False):
        assert prev.end_min == cur.start_min
        assert prev.miles_end == pytest.approx(cur.miles_start)
    for event in events:
        assert event.start_min % 15 == 0 and event.end_min % 15 == 0
        assert event.duration_min > 0

    # BR-HOS-01..04 and BR-PLN-01.
    assert_no_violations(events, DEFAULT_CONFIG, cycle)

    # Totals, contiguity and mileage per day (FR-LOG-03..05).
    logs = build_daily_logs(events, header={}, cycle_used_hr=cycle)
    assert logs
    for log in logs:
        assert sum(log.totals.values()) == pytest.approx(24.0, abs=1e-9)
        assert log.segments[0].start_min == 0
        assert log.segments[-1].end_min == 1440
        for prev, cur in zip(log.segments, log.segments[1:], strict=False):
            assert prev.end_min == cur.start_min
        for bracket in log.brackets:
            assert 0 <= bracket.start_min < bracket.end_min <= 1440
        assert 0 <= log.recap.total_last_8_days <= 70
        assert log.recap.available_tomorrow == pytest.approx(
            70 - log.recap.total_last_8_days
        )

    assert sum(log.miles_today for log in logs) == pytest.approx(total_mi, abs=0.5)
    assert events[-1].miles_end == pytest.approx(total_mi, abs=1e-6)


@hyp_settings(
    max_examples=500,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(trip_miles, leg_split, cycle_hours, speeds, start_offsets)
def test_ac03_no_violations_across_random_trips(total_mi, split, cycle, mph, offset):
    check_trip(total_mi, split, cycle, mph, offset)


@pytest.mark.parametrize(
    "total_mi,split,cycle,mph,offset",
    [
        (50, 0.0, 0.0, 50, 0),        # shortest trip, midnight start
        (3000, 1.0, 0.0, 35, 0),      # all miles on leg 1, slowest speed
        (3000, 0.5, 70.0, 70, 95),    # full cycle, 23:45 start
        (1000, 0.0, 69.75, 50, 32),   # restart needed before the pre-trip
        (2000, 0.0, 35.0, 60, 48),    # fuel stops mid-trip
    ],
)
def test_ac03_edge_cases(total_mi, split, cycle, mph, offset):
    check_trip(total_mi, split, cycle, mph, offset)


def test_engine_performance_budget():
    """NFR-PERF-02: engine + log builder under 200 ms for a 3,000 mi trip."""
    import time

    start = datetime(2026, 3, 2, 6, tzinfo=CT)
    legs = _legs(3000, 0.1, 55)
    best = float("inf")
    for _ in range(5):
        began = time.perf_counter()
        events = schedule(legs, 10.0, start)
        build_daily_logs(events, header={}, cycle_used_hr=10.0)
        best = min(best, (time.perf_counter() - began) * 1000)
    assert best < 200, f"engine + log builder took {best:.1f} ms"


def test_driving_and_on_duty_hours_are_consistent():
    start = datetime(2026, 3, 2, 6, tzinfo=CT)
    events = schedule(_legs(1500, 0.2, 55), 0.0, start)
    driving = sum(e.duration_hr for e in events if e.status == DRIVING)
    on_duty = sum(e.duration_hr for e in events if e.status == ON_DUTY)
    logs = build_daily_logs(events, header={}, cycle_used_hr=0.0)
    assert sum(log.totals[DRIVING] for log in logs) == pytest.approx(driving, abs=0.01)
    assert sum(log.totals[ON_DUTY] for log in logs) == pytest.approx(on_duty, abs=0.01)
