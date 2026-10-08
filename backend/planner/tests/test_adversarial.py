"""Adversarial / negative test suite (QA pass, 2026-10-07).

These tests attack the implementation rather than confirm it. Tests for
defects that are confirmed present are marked ``xfail(strict=True)`` and
tagged with their defect ID, so:

  * the suite stays green on a known-broken build, and
  * the moment a defect is fixed the test reports XPASS and fails the run,
    which forces the marker to be removed.

Every test carries its QA test ID and the SRS requirement it traces to.
Run just this file:  pytest planner/tests/test_adversarial.py
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
import responses
from django.core.cache import cache
from django.test import Client
from django.urls import reverse

from planner.hos import DEFAULT_CONFIG, EngineLeg, build_daily_logs, schedule
from planner.hos.config import HosConfig
from planner.hos.types import DRIVING, ON_DUTY, ScheduleError
from planner.providers import geocoding, routing

from .test_api import ors_route, pelias

pytestmark = pytest.mark.django_db

CHICAGO = ZoneInfo("America/Chicago")

# US daylight-saving transitions used below (2 a.m. local).
SPRING_FORWARD = datetime(2026, 3, 8, 2, 0, tzinfo=CHICAGO)
FALL_BACK = datetime(2026, 11, 1, 2, 0, tzinfo=CHICAGO)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolate_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _provider_key(settings):
    settings.ORS_API_KEY = "test-key"
    settings.RATE_LIMIT_PER_MINUTE = 1000
    return settings


@pytest.fixture
def client():
    return Client()


def legs(leg1_mi: float, leg2_mi: float, mph: float = 50.0) -> list[EngineLeg]:
    return [
        EngineLeg("Start", "Pickup", leg1_mi, leg1_mi / mph),
        EngineLeg("Pickup", "Dropoff", leg2_mi, leg2_mi / mph),
    ]


def real_minutes(event) -> float:
    """Elapsed wall-clock minutes measured in UTC, i.e. what a clock sees."""
    return (event.end.astimezone(UTC) - event.start.astimezone(UTC)).total_seconds() / 60


def plan_body(**overrides) -> dict:
    body = {
        "current": {"label": "Dallas, TX", "lat": 32.7767, "lng": -96.797},
        "pickup": {"label": "Oklahoma City, OK", "lat": 35.4676, "lng": -97.5164},
        "dropoff": {"label": "Chicago, IL", "lat": 41.8781, "lng": -87.6298},
        "cycle_used_hr": 22.5,
    }
    body.update(overrides)
    return body


def post_plan(client, body, **extra):
    raw = body if isinstance(body, str) else json.dumps(body)
    return client.post(
        reverse("plan"), data=raw, content_type="application/json", **extra
    )


def mock_two_legs(leg1_mi: float, leg2_mi: float, mph: float = 50.0) -> None:
    """Route both legs and answer any reverse-geocode lookup."""
    responses.add(
        responses.POST,
        routing.ORS_DIRECTIONS,
        json=ors_route([[-96.797, 32.777], [-97.516, 35.467]], leg1_mi, leg1_mi / mph * 3600),
    )
    responses.add(
        responses.POST,
        routing.ORS_DIRECTIONS,
        json=ors_route([[-97.516, 35.467], [-87.630, 41.878]], leg2_mi, leg2_mi / mph * 3600),
    )
    responses.add(
        responses.GET,
        geocoding.ORS_REVERSE,
        json={"features": [pelias("Joplin, MO", 37.084, -94.513, "Joplin", "MO")]},
    )


# ===========================================================================
# 1. Engine - daylight saving time (DEF-01)
# ===========================================================================


@pytest.mark.parametrize(
    "tag,start",
    [
        ("spring-forward", datetime(2026, 3, 7, 8, 0, tzinfo=CHICAGO)),
        ("fall-back", datetime(2026, 10, 31, 8, 0, tzinfo=CHICAGO)),
    ],
)
def test_tc_eng_dst_01_rest_is_ten_real_hours(tag, start):
    """TC-ENG-DST-01 | BR-HOS-05, FR-HOS-01 | P1

    A 10-hour rest must be 10 hours of real elapsed time wherever it falls.
    A driver who rests from 20:00 to 06:00 across spring-forward has rested
    nine hours and is not legal to drive.
    """
    events = schedule(legs(1100, 100), 0.0, start)
    rests = [e for e in events if e.kind == "rest_10"]
    assert rests, "the fixture must produce at least one 10-hour rest"
    for rest in rests:
        assert real_minutes(rest) == pytest.approx(
            DEFAULT_CONFIG.rest_min
        ), f"{tag}: rest {rest.start} -> {rest.end} is {real_minutes(rest)} real minutes"


def test_tc_eng_dst_02_restart_is_thirty_four_real_hours():
    """TC-ENG-DST-02 | BR-HOS-06, FR-HOS-04 | P1"""
    # Cycle 68 forces a restart; starting the day before the transition puts
    # the restart across it.
    events = schedule(legs(1100, 400), 68.0, datetime(2026, 3, 7, 18, 0, tzinfo=CHICAGO))
    restarts = [e for e in events if e.kind == "restart_34"]
    assert restarts, "the fixture must produce a 34-hour restart"
    for restart in restarts:
        assert real_minutes(restart) == pytest.approx(DEFAULT_CONFIG.restart_min)


def test_tc_eng_dst_03_elapsed_hours_match_the_clock():
    """TC-ENG-DST-03 | FR-MAP-06, API-04 | P2"""
    events = schedule(legs(1100, 100), 0.0, datetime(2026, 3, 7, 8, 0, tzinfo=CHICAGO))
    nominal = events[-1].end_min - events[0].start_min
    real = (
        events[-1].end.astimezone(UTC) - events[0].start.astimezone(UTC)
    ).total_seconds() / 60
    assert real == pytest.approx(nominal)


def test_tc_eng_dst_04_dst_day_still_totals_24_on_the_grid():
    """TC-ENG-DST-04 | FR-LOG-04, BR-LOG-01 | P2

    The sheet is a wall-clock document: 24 columns, midnight to midnight,
    whatever the clock did in between, so FR-LOG-04 still sums to 24.00 on a
    23-hour day. Durations that decide legality - rests, the cycle recap - are
    measured in real time instead (see TC-ENG-DST-01/02 and TC-ENG-DST-05).
    """
    events = schedule(legs(1100, 100), 0.0, datetime(2026, 3, 7, 8, 0, tzinfo=CHICAGO))
    logs = build_daily_logs(events, {}, 0.0)
    for log in logs:
        assert sum(log.totals.values()) == pytest.approx(24.0)


def test_tc_eng_dst_05_recap_counts_real_hours_not_grid_hours():
    """TC-ENG-DST-05 | BR-LOG-02, BR-LOG-03, FR-HOS-04 | P1

    The 70-hour cycle counts hours a clock measured. On the 23-hour day the
    grid still shows 24, so a recap fed from the grid can report more cycle
    used than the cycle allows - which is how a driver gets told they are out
    of hours a quarter-hour early, or worse, late.
    """
    start = datetime(2026, 3, 6, 6, 0, tzinfo=CHICAGO)
    events = schedule(legs(1600, 600), 40.0, start)
    for log in build_daily_logs(events, {}, 40.0):
        assert log.recap.total_last_8_days <= 70.0
        assert log.recap.available_tomorrow == pytest.approx(
            70.0 - log.recap.total_last_8_days
        )


# ===========================================================================
# 2. Summary / log-sheet consistency (DEF-02)
# ===========================================================================


@pytest.mark.parametrize("cycle,hour", [(65.0, 12), (68.0, 18), (70.0, 22)])
def test_tc_sum_01_sheets_cover_every_calendar_day(cycle, hour):
    """TC-SUM-01 | FR-MAP-06, FR-UI-06, FR-LOG-01 | P2 (DEF-02 fixed)

    FR-UI-06 requires the day count shown to match FR-LOG-01's sheets.
    ``summary.num_days`` is now ``len(daily_logs)``, so the two agree by
    construction; what still needs asserting is that the sheets themselves
    are a gapless run of calendar days covering every event. Counting
    distinct event start dates - the old implementation - does not, because a
    day swallowed whole by a 34-hour restart contains no event start.
    """
    start = datetime(2026, 6, 1, hour, 0, tzinfo=CHICAGO)
    events = schedule(legs(1100, 400), cycle, start)
    logs = build_daily_logs(events, {}, cycle)

    dates = [log.date for log in logs]
    assert dates == sorted(dates), "sheets are out of order"
    for earlier, later in zip(dates, dates[1:], strict=False):
        assert (later - earlier).days == 1, f"gap between {earlier} and {later}"
    assert {e.start.date() for e in events} <= set(dates)
    assert len({e.start.date() for e in events}) <= len(logs)


@responses.activate
def test_tc_sum_02_num_days_matches_the_sheets_over_the_api(client):
    """TC-SUM-02 | FR-MAP-06 | P2

    The summary's day count and the number of rendered log sheets are the
    same number on the wire, including the restart case that produced the
    off-by-one under DEF-02.
    """
    mock_two_legs(1100, 400)
    future = datetime.now(CHICAGO).replace(
        hour=18, minute=0, second=0, microsecond=0
    ) + timedelta(days=30)
    response = post_plan(
        client, plan_body(cycle_used_hr=68, start_time=future.isoformat())
    )
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["num_days"] == len(body["daily_logs"])


# ===========================================================================
# 3. Request-ID handling (DEF-03)
# ===========================================================================


@pytest.mark.xfail(
    strict=True,
    reason="DEF-03: the client-supplied X-Request-ID is echoed into a response "
    "header unvalidated; a CRLF in it raises BadHeaderError inside middleware, "
    "outside the DRF exception handler, so the request dies as a bare 500.",
)
@pytest.mark.parametrize(
    "value",
    [
        "abc\r\nX-Injected: 1",
        "abc\nSet-Cookie: a=b",
    ],
)
def test_tc_api_rid_01_hostile_request_id_does_not_crash(client, value):
    """TC-API-RID-01 | NFR-OBS-02, NFR-REL-02, ERR | P1

    Any request must come back in the section-10 error envelope or succeed;
    it must never escape as an unhandled 500.
    """
    response = client.get(reverse("health"), HTTP_X_REQUEST_ID=value)
    assert response.status_code < 500


@pytest.mark.xfail(
    strict=True,
    reason="DEF-03b: X-Request-ID length is unbounded, so an attacker controls "
    "the size of every structured log line and response header.",
)
def test_tc_api_rid_02_request_id_length_is_bounded(client):
    """TC-API-RID-02 | NFR-OBS-01, NFR-OBS-02 | P3"""
    response = client.get(reverse("health"), HTTP_X_REQUEST_ID="A" * 5000)
    assert len(response.headers.get("X-Request-ID", "")) <= 64


def test_tc_api_rid_03_generated_request_id_is_echoed(client):
    """TC-API-RID-03 | NFR-OBS-02 | P2 (passes)"""
    response = client.get(reverse("health"))
    assert len(response.headers["X-Request-ID"]) == 16


def test_tc_api_rid_04_non_latin1_request_id_is_mime_encoded(client):
    """TC-API-RID-04 | NFR-OBS-02 | P3 (passes)

    Only CRLF is fatal; Django MIME-encodes other non-latin-1 bytes, so this
    bounds the blast radius of DEF-03 to the newline case.
    """
    response = client.get(reverse("health"), HTTP_X_REQUEST_ID="ééé")
    assert response.status_code == 200


# ===========================================================================
# 4. Rate limiting (DEF-04)
# ===========================================================================


@pytest.mark.xfail(
    strict=True,
    reason="DEF-04: _client_ip trusts the first X-Forwarded-For entry with no "
    "trusted-proxy allowlist, so rotating the header resets the per-IP window.",
)
def test_tc_api_rl_01_forwarded_for_cannot_bypass_the_limit(client, settings):
    """TC-API-RL-01 | API-05, NFR-SEC-05 | P1

    30/min/IP is the only abuse control on an endpoint that spends a metered
    third-party key, so it must not be client-controlled.
    """
    settings.RATE_LIMIT_PER_MINUTE = 3
    codes = [
        client.get(
            reverse("geocode") + "?q=zzz", HTTP_X_FORWARDED_FOR=f"203.0.113.{i}"
        ).status_code
        for i in range(8)
    ]
    assert 429 in codes, f"all {len(codes)} requests were allowed: {codes}"


def test_tc_api_rl_02_limit_holds_for_a_single_ip(client, settings):
    """TC-API-RL-02 | API-05 | P1 (passes - the baseline control works)"""
    settings.RATE_LIMIT_PER_MINUTE = 3
    codes = [client.get(reverse("geocode") + "?q=zzz").status_code for _ in range(6)]
    assert codes[:3] == [400, 400, 400] or codes[3:] == [429, 429, 429]
    assert codes.count(429) == 3


def test_tc_api_rl_03_health_is_not_rate_limited(client, settings):
    """TC-API-RL-03 | API-05, NFR-AVL-01 | P3 (passes - documents the gap)

    /api/health/ never calls enforce_rate_limit. That is deliberate (it is the
    uptime probe) but it means the endpoint is a free unauthenticated
    amplifier for log volume. Recorded, not asserted as a defect.
    """
    settings.RATE_LIMIT_PER_MINUTE = 1
    codes = [client.get(reverse("health")).status_code for _ in range(10)]
    assert codes == [200] * 10


# ===========================================================================
# 5. Input validation / scope (DEF-05)
# ===========================================================================


@pytest.mark.xfail(
    strict=True,
    reason="DEF-05: LocationField accepts any lat/lng on Earth. Supplying "
    "coordinates bypasses the US-only geocoder entirely (FR-GEO-01..03).",
)
@responses.activate
def test_tc_api_val_01_non_us_coordinates_are_rejected(client):
    """TC-API-VAL-01 | FR-GEO-01, FR-GEO-02, FR-GEO-03 | P2

    The product is US HOS only: log time zones, state codes and the 70/8
    cycle all assume it. Paris -> Berlin -> Rome currently plans happily and
    returns timezone "Europe/Paris".
    """
    mock_two_legs(500, 500)
    body = plan_body(
        current={"label": "Paris, France", "lat": 48.8566, "lng": 2.3522},
        pickup={"label": "Berlin, Germany", "lat": 52.5200, "lng": 13.4050},
        dropoff={"label": "Rome, Italy", "lat": 41.9028, "lng": 12.4964},
    )
    response = post_plan(client, body)
    assert response.status_code == 400
    assert response.json()["error"]["code"] in {"validation_error", "not_found"}


@responses.activate
def test_tc_api_val_02_non_us_plan_currently_succeeds(client):
    """TC-API-VAL-02 | FR-GEO-02 | P2 (passes - pins the observed behaviour)"""
    mock_two_legs(500, 500)
    body = plan_body(
        current={"label": "Paris, France", "lat": 48.8566, "lng": 2.3522},
        pickup={"label": "Berlin, Germany", "lat": 52.5200, "lng": 13.4050},
        dropoff={"label": "Rome, Italy", "lat": 41.9028, "lng": 12.4964},
    )
    response = post_plan(client, body)
    assert response.status_code == 200
    assert response.json()["summary"]["timezone"] == "Europe/Paris"  # DEF-05


@pytest.mark.parametrize(
    "tag,raw",
    [
        ("NaN cycle", '{"cycle_used_hr": NaN}'),
        ("Infinity cycle", '{"cycle_used_hr": Infinity}'),
        ("array body", "[1, 2, 3]"),
        ("null body", "null"),
        ("string body", '"hello"'),
        ("truncated json", '{"current": '),
        ("empty body", ""),
        ("deep nesting", '{"current": ' + "[" * 200 + "]" * 200 + "}"),
    ],
)
def test_tc_api_val_03_malformed_bodies_use_the_error_envelope(client, tag, raw):
    """TC-API-VAL-03 | NFR-SEC-03, NFR-REL-02, section 10 | P1 (passes)

    Out-of-range JSON floats are the interesting case: NaN defeats every
    min/max comparison in DRF, so if the parser accepted it the engine would
    receive NaN. DRF's strict parser rejects it first.
    """
    response = post_plan(client, raw)
    assert 400 <= response.status_code < 500, tag
    assert set(response.json()["error"]) == {"code", "message", "fields", "request_id"}


@pytest.mark.parametrize(
    "tag,body",
    [
        ("lat without lng", {"current": {"label": "Dallas, TX", "lat": 32.7}}),
        ("lat out of range", {"current": {"label": "Dallas, TX", "lat": 91.0, "lng": 0.0}}),
        ("lng out of range", {"current": {"label": "Dallas, TX", "lat": 0.0, "lng": 181.0}}),
        ("label too short", {"current": {"label": "D"}}),
        ("label 201 chars", {"current": {"label": "D" * 201}}),
        ("cycle 70.01", {"cycle_used_hr": 70.01}),
        ("cycle -0.01", {"cycle_used_hr": -0.01}),
        ("cycle as list", {"cycle_used_hr": [1]}),
        ("cycle as string", {"cycle_used_hr": "abc"}),
        ("text field 81 chars", {"driver": "x" * 81}),
    ],
)
def test_tc_api_val_04_boundary_inputs_are_rejected(client, tag, body):
    """TC-API-VAL-04 | FR-INP-01, FR-INP-02, FR-INP-03, AC-08 | P1 (passes)"""
    response = post_plan(client, plan_body(**body))
    assert response.status_code == 400, f"{tag} was accepted"
    assert response.json()["error"]["code"] == "validation_error"


@responses.activate
def test_tc_api_val_4b_boolean_cycle_is_silently_coerced(client):
    """TC-API-VAL-04b | FR-INP-02, NFR-SEC-03 | P3 (passes - documents DEF-10)

    DRF's FloatField accepts JSON ``true`` and yields 1.0, so a malformed
    client sends a boolean and gets a plan built on "1 hour used" with no
    error. Strictly a type-coercion gap, not exploitable.
    """
    mock_two_legs(200, 200)
    response = post_plan(client, plan_body(cycle_used_hr=True))
    assert response.status_code == 200  # DEF-10: should be 400
    assert response.json()["daily_logs"][0]["recap"]["total_last_8_days"] >= 1.0


@pytest.mark.parametrize("value,expected", [(70.0, 70.0), (69.99, 70.0), (0.12, 0.25)])
@responses.activate
def test_tc_api_val_05_cycle_rounds_to_quarters_at_the_boundary(client, value, expected):
    """TC-API-VAL-05 | FR-INP-02, BR-PLN-05 | P2 (passes)

    69.99 rounds UP to exactly 70.0, the hard cycle limit - the engine must
    still cope rather than reject it.
    """
    mock_two_legs(200, 200)
    response = post_plan(client, plan_body(cycle_used_hr=value))
    assert response.status_code == 200


def test_tc_api_val_06_start_time_boundaries(client):
    """TC-API-VAL-06 | FR-INP-03 | P2 (passes)"""
    now = datetime.now(UTC)
    for delta, ok in (
        (timedelta(days=-8), False),
        (timedelta(days=-6), True),
        (timedelta(days=366), False),
    ):
        body = plan_body(start_time=(now + delta).isoformat())
        response = post_plan(client, body)
        if ok:
            assert response.status_code != 400 or "start_time" not in response.json()[
                "error"
            ]["fields"]
        else:
            assert response.status_code == 400
            assert "start_time" in response.json()["error"]["fields"]


# ===========================================================================
# 6. Provider-call amplification (DEF-06)
# ===========================================================================


@responses.activate
def test_tc_perf_01_reverse_geocode_calls_are_bounded(client):
    """TC-PERF-01 | NFR-PERF-01, NFR-SCL-01, FR-GEO-03 | P1 (DEF-06 fixed)

    A 4,800 mi trip used to issue one blocking reverse lookup per interpolated
    stop - 21 of them, serially. The ceiling is now a fixed budget that does
    not grow with trip length.

    The original bound here was 5. That is below the number of distinct towns
    a legal multi-day trip actually stops in, so meeting it would have meant
    leaving real duty-status changes unnamed on the log sheet. The defect was
    unboundedness, not the specific number, so the assertion tracks the
    budget.
    """
    mock_two_legs(2400, 2400, mph=55.0)
    response = post_plan(client, plan_body(cycle_used_hr=0))
    assert response.status_code == 200
    # +3: the three trip endpoints are resolved outside the batch budget.
    reverse_calls = [c for c in responses.calls if "reverse" in c.request.url]
    assert len(reverse_calls) <= geocoding.REVERSE_CALL_BUDGET + 3, (
        f"{len(reverse_calls)} serial reverse-geocode calls for one plan request"
    )


@responses.activate
def test_tc_perf_01b_unnamed_stops_degrade_to_coordinates_with_a_notice(client):
    """TC-PERF-01b | FR-GEO-03, NFR-PERF-01 | P2

    Past the budget a stop is labelled with its coordinates rather than left
    blank or silently given a neighbouring town's name, and the plan says so.
    """
    mock_two_legs(2400, 2400, mph=55.0)
    body = post_plan(client, plan_body(cycle_used_hr=0)).json()
    degraded = [s for s in body["stops"] if s["location"].startswith("near ")]
    assert degraded, "the long-trip fixture should exhaust the budget"
    assert any("coordinates" in notice for notice in body["notices"])


@responses.activate
def test_tc_perf_01c_a_failing_provider_costs_one_call_not_one_per_stop(client):
    """TC-PERF-01c | NFR-PERF-01, NFR-SCL-01, NFR-REL-02 | P1

    The pathological case: the primary is down and the Nominatim fallback is
    rate-limited to 1 req/s process-wide. Retrying it per stop is what turned
    one plan into a half-minute of blocked worker. One failed point is enough
    evidence to stop paying.
    """
    mock_two_legs(2400, 2400, mph=55.0)
    responses.replace(responses.GET, geocoding.ORS_REVERSE, status=503, json={})
    responses.add(responses.GET, geocoding.NOMINATIM_REVERSE, status=503, json={})
    response = post_plan(client, plan_body(cycle_used_hr=0))
    assert response.status_code == 200

    # Count distinct points asked for, not raw requests: each point costs two
    # providers x INT-05's one retry, and that multiplier is not what this
    # test is about. Three endpoints plus a single probe from the batch.
    asked = {
        (c.request.params.get("point.lat") or c.request.params.get("lat"),
         c.request.params.get("point.lon") or c.request.params.get("lon"))
        for c in responses.calls
        if "reverse" in c.request.url
    }
    assert len(asked) <= 4, f"{len(asked)} distinct points asked of a dead provider"


@responses.activate
def test_tc_perf_02_repeat_stops_reuse_the_cache(client):
    """TC-PERF-02 | FR-GEO-04 | P2 (passes)

    The reverse cache is keyed on lat/lng to 3 dp, so a second identical plan
    makes no new reverse calls. Both plans need their own routing fixtures,
    or ``responses`` replays a different leg order and the stops move.
    """
    mock_two_legs(1100, 400)
    mock_two_legs(1100, 400)
    assert post_plan(client, plan_body()).status_code == 200
    first = len([c for c in responses.calls if "reverse" in c.request.url])
    assert post_plan(client, plan_body()).status_code == 200
    second = len([c for c in responses.calls if "reverse" in c.request.url])
    assert second == first, "the second identical plan re-queried the provider"


# ===========================================================================
# 7. Log-sheet content limits (DEF-07)
# ===========================================================================


def test_tc_log_01_a_day_can_exceed_the_ui_remark_budget():
    """TC-LOG-01 | FR-LOG-06, FR-UI-05 | P2 (passes - evidence for DEF-07)

    LogSheet.tsx renders a 3x3 remarks grid (9 cells) and hides the rest
    behind "+N more". The engine produces up to 10 remarks on a single day
    from an ordinary 1,500 mi trip, so a printed inspection sheet silently
    omits a duty-status change.
    """
    events = schedule(legs(750, 750), 0.0, datetime(2026, 6, 1, 0, 0, tzinfo=CHICAGO))
    counts = [len(log.remarks) for log in build_daily_logs(events, {}, 0.0)]
    assert max(counts) > 9, f"remark counts per day: {counts}"


def test_tc_log_02_every_status_change_has_exactly_one_remark():
    """TC-LOG-02 | FR-LOG-06 | P2 (passes)"""
    events = schedule(legs(900, 600), 10.0, datetime(2026, 6, 1, 7, 0, tzinfo=CHICAGO))
    logs = build_daily_logs(events, {}, 10.0)
    for log in logs:
        minutes = [r.minute for r in log.remarks]
        assert minutes == sorted(set(minutes)), "remarks duplicated or unsorted"
        for remark in log.remarks:
            assert remark.note, f"remark at {remark.minute} has no activity label"


def test_tc_log_03_brackets_stay_inside_the_day():
    """TC-LOG-03 | FR-LOG-07 | P2 (passes)"""
    events = schedule(legs(1500, 900), 0.0, datetime(2026, 6, 1, 6, 0, tzinfo=CHICAGO))
    for log in build_daily_logs(events, {}, 0.0):
        for bracket in log.brackets:
            assert 0 <= bracket.start_min < bracket.end_min <= 1440


def test_tc_log_04_segments_are_contiguous_and_cover_the_day():
    """TC-LOG-04 | FR-LOG-03 | P1 (passes)"""
    events = schedule(legs(1500, 900), 40.0, datetime(2026, 6, 1, 21, 0, tzinfo=CHICAGO))
    for log in build_daily_logs(events, {}, 40.0):
        assert log.segments[0].start_min == 0
        assert log.segments[-1].end_min == 1440
        for prev, nxt in zip(log.segments, log.segments[1:], strict=False):
            assert prev.end_min == nxt.start_min
            assert prev.status != nxt.status, "adjacent same-status run not merged"


# ===========================================================================
# 8. Engine edge and boundary conditions
# ===========================================================================


def test_tc_eng_01_zero_mile_trip_still_produces_a_legal_day():
    """TC-ENG-01 | FR-INP-06 | P2 (passes)"""
    events = schedule(legs(0.0, 0.0), 0.0, datetime(2026, 6, 1, 8, 0, tzinfo=CHICAGO))
    kinds = [e.kind for e in events]
    assert kinds == ["pre_trip", "pickup", "dropoff", "off"]
    assert not any(e.status == DRIVING for e in events)
    logs = build_daily_logs(events, {}, 0.0)
    assert len(logs) == 1
    assert sum(logs[0].totals.values()) == pytest.approx(24.0)


def test_tc_eng_02_trip_ending_exactly_at_midnight_adds_no_padding():
    """TC-ENG-02 | FR-HOS-01, FR-LOG-01 | P3 (passes)"""
    # 08:00 + 30 pre-trip + 4 h drive + 60 pickup + ... engineered to land
    # anywhere; the invariant is that the last event ends on a day boundary.
    events = schedule(legs(100, 100), 0.0, datetime(2026, 6, 1, 0, 0, tzinfo=CHICAGO))
    assert events[-1].end_min % 1440 == 0


def test_tc_eng_03_cycle_exactly_at_the_limit_restarts_first():
    """TC-ENG-03 | FR-HOS-04, AC-02 | P1 (passes)"""
    events = schedule(legs(500, 100), 70.0, datetime(2026, 6, 1, 8, 0, tzinfo=CHICAGO))
    assert events[0].kind == "restart_34"
    assert events[0].start_min == 0


def test_tc_eng_04_one_minute_over_the_cycle_is_rejected():
    """TC-ENG-04 | FR-HOS-07 | P2 (passes)"""
    with pytest.raises(ValueError):
        schedule(legs(100, 100), 70.25, datetime(2026, 6, 1, 8, 0, tzinfo=CHICAGO))


def test_tc_eng_05_naive_start_is_rejected():
    """TC-ENG-05 | FR-HOS-06 | P2 (passes)"""
    with pytest.raises(ValueError):
        schedule(legs(100, 100), 0.0, datetime(2026, 6, 1, 8, 0))


def test_tc_eng_06_off_step_start_is_rejected():
    """TC-ENG-06 | FR-HOS-06, BR-PLN-05 | P2 (passes)"""
    with pytest.raises(ValueError):
        schedule(legs(100, 100), 0.0, datetime(2026, 6, 1, 8, 7, tzinfo=CHICAGO))


def test_tc_eng_07_zero_duration_leg_with_distance_is_typed():
    """TC-ENG-07 | FR-HOS-01, BR-PLN-08 | P2 (passes)

    A provider that reports miles but no duration gives speed 0. The engine
    must raise its typed error, not divide by zero or loop.
    """
    bad = [EngineLeg("A", "B", 100.0, 0.0), EngineLeg("B", "C", 10.0, 0.2)]
    with pytest.raises(ScheduleError):
        schedule(bad, 0.0, datetime(2026, 6, 1, 8, 0, tzinfo=CHICAGO))


def test_tc_eng_08_absurdly_slow_leg_hits_the_day_budget():
    """TC-ENG-08 | FR-HOS-08 | P2 (passes)

    5,000 mi at 8 mph is 625 driving hours: more than 30 simulated days once
    restarts are inserted. It must raise ScheduleError rather than spin.
    """
    with pytest.raises(ScheduleError):
        schedule(
            legs(2500, 2500, mph=8.0), 0.0, datetime(2026, 6, 1, 8, 0, tzinfo=CHICAGO)
        )


def test_tc_eng_09_fuel_never_exceeds_the_interval():
    """TC-ENG-09 | BR-PLN-01, BR-PLN-05 | P1 (passes)"""
    events = schedule(legs(2400, 2400, mph=55.0), 0.0, datetime(2026, 6, 1, 8, 0, tzinfo=CHICAGO))
    since_fuel = 0.0
    for event in events:
        if event.is_drive:
            since_fuel += event.miles
            assert since_fuel <= DEFAULT_CONFIG.fuel_interval_mi + 1e-6
        elif event.kind == "fuel":
            since_fuel = 0.0


def test_tc_eng_10_driving_never_runs_past_the_fourteen_hour_window():
    """TC-ENG-10 | BR-HOS-02 | P1 (passes)"""
    events = schedule(legs(1800, 900), 5.0, datetime(2026, 6, 1, 4, 0, tzinfo=CHICAGO))
    window_start = None
    for event in events:
        if event.kind in ("rest_10", "restart_34"):
            window_start = None
        elif window_start is None and event.status in (DRIVING, ON_DUTY):
            window_start = event.start_min
        if event.is_drive:
            assert event.end_min - window_start <= DEFAULT_CONFIG.window_limit_min


def test_tc_eng_11_determinism_is_byte_identical():
    """TC-ENG-11 | NFR-REL-01 | P2 (passes)"""
    args = (legs(1234.5, 678.9, mph=47.3), 33.75, datetime(2026, 6, 1, 9, 15, tzinfo=CHICAGO))
    first = [
        (e.status, e.kind, e.start_min, e.end_min, round(e.miles_end, 9))
        for e in schedule(*args)
    ]
    second = [
        (e.status, e.kind, e.start_min, e.end_min, round(e.miles_end, 9))
        for e in schedule(*args)
    ]
    assert first == second


def test_tc_eng_12_day_miles_sum_to_route_miles():
    """TC-ENG-12 | FR-LOG-05, AC-03 | P1 (passes)"""
    total = 1500 + 900
    events = schedule(legs(1500, 900), 12.0, datetime(2026, 6, 1, 13, 0, tzinfo=CHICAGO))
    logs = build_daily_logs(events, {}, 12.0)
    assert sum(log.miles_today for log in logs) == pytest.approx(total, abs=0.5)


def test_tc_eng_13_config_with_non_step_durations_breaks_the_grid():
    """TC-ENG-13 | FR-HOS-06, FR-HOS-07, BR-CFG | P3 (passes - documents a
    latent config trap)

    HosConfig validates signs only, not step alignment. A 10-minute pickup is
    accepted and puts event boundaries off the 15-minute grid, silently
    breaking FR-HOS-06. Guard rails belong in __post_init__.
    """
    cfg = HosConfig(pickup_min=10)
    events = schedule(legs(100, 100), 0.0, datetime(2026, 6, 1, 8, 0, tzinfo=CHICAGO), cfg)
    assert any(e.start_min % 15 for e in events), "expected an off-grid boundary"


# ===========================================================================
# 9. Integration failure modes
# ===========================================================================


@responses.activate
def test_tc_int_01_ors_connection_error_falls_back_to_osrm(client):
    """TC-INT-01 | FR-RTE-02, INT-02, INT-05, NFR-REL-02 | P1 (passes)

    ORS unreachable: two attempts (INT-05 allows one retry), then the whole
    trip is re-routed on OSRM and the response says so.
    """
    import requests

    for _ in range(2):
        responses.add(
            responses.POST,
            routing.ORS_DIRECTIONS,
            body=requests.exceptions.ConnectionError("down"),
        )
    responses.add(
        responses.GET,
        routing.OSRM_ROUTE + "/-96.797,32.7767;-97.5164,35.4676",
        json={
            "code": "Ok",
            "routes": [
                {
                    "distance": 206 * 1609.344,
                    "duration": 3600 * 4,
                    "geometry": {"coordinates": [[-96.797, 32.777], [-97.516, 35.467]]},
                    "legs": [{"steps": []}],
                }
            ],
        },
    )
    responses.add(
        responses.GET,
        routing.OSRM_ROUTE + "/-97.5164,35.4676;-87.6298,41.8781",
        json={
            "code": "Ok",
            "routes": [
                {
                    "distance": 795 * 1609.344,
                    "duration": 3600 * 14,
                    "geometry": {"coordinates": [[-97.516, 35.467], [-87.630, 41.878]]},
                    "legs": [{"steps": []}],
                }
            ],
        },
    )
    responses.add(
        responses.GET,
        geocoding.ORS_REVERSE,
        json={"features": [pelias("Joplin, MO", 37.0, -94.5, "Joplin", "MO")]},
    )
    response = post_plan(client, plan_body())
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["routing_provider"] == routing.PROVIDER_CAR
    assert any("Car routing" in n for n in body["notices"])
    assert sum(1 for c in responses.calls if "directions" in c.request.url) == 2


@responses.activate
def test_tc_int_01b_non_requests_exception_escapes_as_a_bare_500(client):
    """TC-INT-01b | NFR-REL-02 | P3 (passes - documents DEF-11)

    http._request only catches requests.Timeout and requests.RequestException.
    Anything else from the transport - a bare OSError/ConnectionError, an ssl
    or urllib3 error that does not get wrapped - skips the OSRM fallback
    entirely and returns internal_error instead of provider_unavailable.
    The common failures ARE wrapped, so this is a narrow gap, not the usual
    path (contrast TC-INT-01).
    """
    responses.add(responses.POST, routing.ORS_DIRECTIONS, body=OSError("raw socket error"))
    responses.add(
        responses.GET,
        geocoding.ORS_REVERSE,
        json={"features": [pelias("Joplin, MO", 37.0, -94.5, "Joplin", "MO")]},
    )
    response = post_plan(client, plan_body())
    assert response.status_code == 500  # DEF-11: should be 503 provider_unavailable
    assert response.json()["error"]["code"] == "internal_error"
    assert not any("osrm" in c.request.url for c in responses.calls)


@responses.activate
def test_tc_int_02_both_routing_providers_down_is_503_not_500(client):
    """TC-INT-02 | NFR-REL-02, section 10 | P1 (passes)"""
    for _ in range(4):
        responses.add(responses.POST, routing.ORS_DIRECTIONS, status=503, json={})
    responses.add(responses.GET, routing.OSRM_ROUTE, status=503, json={})
    responses.add(responses.GET, routing.OSRM_ROUTE, status=503, json={})
    responses.add(responses.GET, routing.OSRM_ROUTE, status=503, json={})
    responses.add(responses.GET, routing.OSRM_ROUTE, status=503, json={})
    response = post_plan(client, plan_body())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


@responses.activate
def test_tc_int_03_provider_429_maps_to_rate_limited(client):
    """TC-INT-03 | section 10, INT-05 | P2 (passes)"""
    responses.add(responses.POST, routing.ORS_DIRECTIONS, status=429, json={})
    response = post_plan(client, plan_body())
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"


@responses.activate
def test_tc_int_04_garbage_provider_payload_does_not_500(client):
    """TC-INT-04 | NFR-REL-02 | P1 (passes)

    A provider that answers 200 with a nonsense body must not produce an
    unhandled 500.
    """
    responses.add(responses.POST, routing.ORS_DIRECTIONS, json={"features": "not a list"})
    responses.add(responses.POST, routing.ORS_DIRECTIONS, json={"features": "not a list"})
    responses.add(responses.GET, routing.OSRM_ROUTE, json={"code": "Ok", "routes": "nope"})
    responses.add(responses.GET, routing.OSRM_ROUTE, json={"code": "Ok", "routes": "nope"})
    response = post_plan(client, plan_body())
    assert response.status_code in (422, 500, 503)
    body = response.json()
    assert "error" in body
    assert "Traceback" not in json.dumps(body)


@responses.activate
def test_tc_int_05_provider_text_is_never_reflected_to_the_client(client):
    """TC-INT-05 | NFR-SEC-03, LOGR-03 | P2 (passes)

    An error body from a provider must not reach the browser, where it could
    carry a key, an internal hostname or markup.
    """
    marker = "<img src=x onerror=alert(1)> key=abcdef0123456789"
    for _ in range(4):
        responses.add(responses.POST, routing.ORS_DIRECTIONS, status=500, body=marker)
    for _ in range(4):
        responses.add(responses.GET, routing.OSRM_ROUTE, status=500, body=marker)
    response = post_plan(client, plan_body())
    assert response.status_code == 503
    assert marker not in response.content.decode()
    assert "test-key" not in response.content.decode()


@responses.activate
def test_tc_int_06_unroutable_leg_is_422_without_osrm_fallback(client):
    """TC-INT-06 | FR-RTE-02 vs section 10 | P3 (passes - documents a design
    tension)

    An ORS 400 is treated as "unroutable" and short-circuits the OSRM
    fallback. ORS also returns 400 for coordinates it simply cannot snap, so
    a routable trip can be refused without the fallback ever being tried.
    """
    responses.add(responses.POST, routing.ORS_DIRECTIONS, status=400, json={})
    response = post_plan(client, plan_body())
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "route_not_found"
    assert not any("osrm" in c.request.url for c in responses.calls)


@responses.activate
def test_tc_int_07_trip_over_five_thousand_miles_is_422(client):
    """TC-INT-07 | FR-RTE-05 | P1 (passes)"""
    mock_two_legs(2600, 2600)
    response = post_plan(client, plan_body())
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "trip_too_long"


# ===========================================================================
# 10. API surface / HTTP semantics
# ===========================================================================


@pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
def test_tc_api_http_01_wrong_method_is_405_in_the_envelope(client, method):
    """TC-API-HTTP-01 | section 10, ERR-02 | P2 (passes)"""
    response = getattr(client, method)(reverse("plan"))
    assert response.status_code == 405
    assert "error" in response.json()


def test_tc_api_http_02_unknown_api_path_is_json_404(client):
    """TC-API-HTTP-02 | ERR-02 | P2 (passes)"""
    response = client.get("/api/does/not/exist/")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_tc_api_http_03_foreign_origin_gets_no_cors_grant(client):
    """TC-API-HTTP-03 | API-06, NFR-SEC-05 | P1 (passes)"""
    response = client.get(reverse("health"), HTTP_ORIGIN="http://evil.example")
    assert "Access-Control-Allow-Origin" not in response.headers
    preflight = client.options(
        reverse("plan"),
        HTTP_ORIGIN="http://evil.example",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert "Access-Control-Allow-Origin" not in preflight.headers


def test_tc_api_http_04_health_never_leaks_the_key(client, settings):
    """TC-API-HTTP-04 | FR-SYS-01, FR-SYS-02, AC-10 | P1 (passes)"""
    settings.ORS_API_KEY = "super-secret-value-0123456789"
    response = client.get(reverse("health"))
    assert response.status_code == 200
    assert response.json()["providers"] == {"ors": True}
    assert "super-secret" not in response.content.decode()


@responses.activate
def test_tc_api_http_05_response_stays_within_the_geometry_budget(client):
    """TC-API-HTTP-05 | FR-RTE-04 | P2 (passes)"""
    dense = [[-96.0 + i * 0.0005, 32.0 + i * 0.0005] for i in range(6000)]
    responses.add(
        responses.POST, routing.ORS_DIRECTIONS, json=ors_route(dense, 300.0, 300 / 55 * 3600)
    )
    responses.add(
        responses.POST, routing.ORS_DIRECTIONS, json=ors_route(dense, 300.0, 300 / 55 * 3600)
    )
    responses.add(
        responses.GET,
        geocoding.ORS_REVERSE,
        json={"features": [pelias("Joplin, MO", 37.0, -94.5, "Joplin", "MO")]},
    )
    response = post_plan(client, plan_body())
    assert response.status_code == 200
    assert len(response.json()["route"]["geometry"]) <= 2000


# ===========================================================================
# 11. Cache / concurrency behaviour of the rate limiter
# ===========================================================================


def test_tc_cnc_01_rate_window_survives_a_mid_window_eviction(client, settings):
    """TC-CNC-01 | API-05 | P2 (passes - but see DEF-08)

    Production backs the rate limiter with the same DatabaseCache table as the
    geocode cache (MAX_ENTRIES 10,000, CULL_FREQUENCY 4). A cull that evicts
    the counter resets the window. The code's ValueError path handles the
    expiry race; eviction simply restarts the count.
    """
    settings.RATE_LIMIT_PER_MINUTE = 2
    probe = reverse("geocode") + "?q=ab"  # invalid query: 400, but still counted
    assert [client.get(probe).status_code for _ in range(3)] == [400, 400, 429]
    cache.clear()  # stands in for a cull of the shared provider_cache table
    assert client.get(probe).status_code == 400, "window did not restart after eviction"
