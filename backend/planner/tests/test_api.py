"""API tests (section 8.1, section 10, AC-08).

All provider HTTP is mocked, so these run in CI with no keys (section 14).
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

from planner.providers import geocoding, routing

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def provider_key(settings):
    settings.ORS_API_KEY = "test-key"
    settings.RATE_LIMIT_PER_MINUTE = 1000
    return settings


@pytest.fixture
def client():
    return Client()


def pelias(label, lat, lng, city, state):
    return {
        "geometry": {"coordinates": [lng, lat]},
        "properties": {
            "label": label, "locality": city, "region_a": state, "country_a": "USA",
        },
    }


def ors_route(coords, distance_mi, duration_s):
    return {
        "features": [
            {
                "geometry": {"coordinates": coords},
                "properties": {
                    "summary": {"distance": distance_mi, "duration": duration_s},
                    "segments": [
                        {"steps": [
                            {"instruction": "Head north on I-35", "distance": distance_mi,
                             "duration": duration_s},
                        ]}
                    ],
                },
            }
        ]
    }


def mock_full_trip():
    """Geocode three places and route two legs, all from local fixtures."""
    responses.add(
        responses.GET, geocoding.ORS_SEARCH,
        json={"features": [pelias("Dallas, TX", 32.7767, -96.7970, "Dallas", "TX")]},
    )
    responses.add(
        responses.POST, routing.ORS_DIRECTIONS,
        json=ors_route([[-96.797, 32.777], [-97.516, 35.467]], 206.0, 206 / 55 * 3600),
    )
    responses.add(
        responses.POST, routing.ORS_DIRECTIONS,
        json=ors_route([[-97.516, 35.467], [-87.630, 41.878]], 795.0, 795 / 55 * 3600),
    )
    responses.add(
        responses.GET, geocoding.ORS_REVERSE,
        json={"features": [pelias("Joplin, MO", 37.084, -94.513, "Joplin", "MO")]},
    )


# --- API-03 health ----------------------------------------------------------


def test_health_reports_key_presence_only(client, settings):
    settings.APP_VERSION = "1.2.3"
    response = client.get(reverse("health"))
    assert response.status_code == 200
    body = response.json()
    assert body == {"status": "ok", "version": "1.2.3", "providers": {"ors": True}}
    # FR-SYS-02: the key itself is never in the response.
    assert "test-key" not in response.content.decode()
    # NFR-OBS-02
    assert response["X-Request-ID"]


# --- API-02 geocode ---------------------------------------------------------


@responses.activate
def test_geocode_returns_at_most_five_us_suggestions(client):
    responses.add(
        responses.GET, geocoding.ORS_AUTOCOMPLETE,
        json={"features": [
            pelias(f"Place {i}, TX", 32.0 + i, -96.0, f"Place {i}", "TX") for i in range(8)
        ]},
    )
    response = client.get(reverse("geocode"), {"q": "dal"})
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 5
    assert set(body[0]) == {"label", "lat", "lng", "city", "state"}


@responses.activate
def test_geocode_excludes_non_us_results(client):
    feature = pelias("Toronto, ON", 43.65, -79.38, "Toronto", "ON")
    feature["properties"]["country_a"] = "CAN"
    responses.add(responses.GET, geocoding.ORS_AUTOCOMPLETE, json={"features": [feature]})
    responses.add(responses.GET, geocoding.NOMINATIM_SEARCH, json=[])
    response = client.get(reverse("geocode"), {"q": "toronto"})
    assert response.status_code == 200
    assert response.json() == []


def test_geocode_rejects_short_query(client):
    response = client.get(reverse("geocode"), {"q": "da"})
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert "q" in error["fields"]
    assert error["request_id"]


@responses.activate
def test_geocode_falls_back_to_nominatim(client):
    responses.add(responses.GET, geocoding.ORS_AUTOCOMPLETE, status=500)
    responses.add(responses.GET, geocoding.ORS_AUTOCOMPLETE, status=500)
    responses.add(
        responses.GET, geocoding.NOMINATIM_SEARCH,
        json=[{"display_name": "Dallas, Texas", "lat": "32.7767", "lon": "-96.797",
               "address": {"city": "Dallas", "state": "Texas"}}],
    )
    response = client.get(reverse("geocode"), {"q": "dallas"})
    assert response.status_code == 200
    assert response.json()[0]["state"] == "TX"


@responses.activate
def test_geocode_results_are_cached(client):
    responses.add(
        responses.GET, geocoding.ORS_AUTOCOMPLETE,
        json={"features": [pelias("Dallas, TX", 32.7767, -96.797, "Dallas", "TX")]},
    )
    client.get(reverse("geocode"), {"q": "dallas"})
    client.get(reverse("geocode"), {"q": " Dallas "})  # FR-GEO-04: normalized key
    assert len(responses.calls) == 1


@responses.activate
def test_both_geocode_providers_down_returns_503(client):
    for _ in range(2):
        responses.add(responses.GET, geocoding.ORS_AUTOCOMPLETE, status=500)
    for _ in range(2):
        responses.add(responses.GET, geocoding.NOMINATIM_SEARCH, status=500)
    response = client.get(reverse("geocode"), {"q": "dallas"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_unavailable"


# --- API-01 plan ------------------------------------------------------------


def plan_payload(**overrides):
    # A fixed wall-clock time inside the window FR-INP-03 allows, so the
    # fixtures do not drift out of range as the calendar moves on.
    start = (datetime.now(UTC) + timedelta(days=1)).astimezone(
        ZoneInfo("America/Chicago")
    ).replace(hour=8, minute=0, second=0, microsecond=0)
    body = {
        "current": {"label": "Dallas, TX", "lat": 32.7767, "lng": -96.7970},
        "pickup": {"label": "Oklahoma City, OK", "lat": 35.4676, "lng": -97.5164},
        "dropoff": {"label": "Chicago, IL", "lat": 41.8781, "lng": -87.6298},
        "cycle_used_hr": 22.5,
        "start_time": start.isoformat(),
    }
    body.update(overrides)
    return body


@responses.activate
def test_plan_returns_the_documented_shape(client):
    mock_full_trip()
    response = client.post(
        reverse("plan"), data=json.dumps(plan_payload()), content_type="application/json"
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert set(body) >= {
        "summary", "route", "stops", "events", "daily_logs", "notices", "assumptions"
    }

    summary = body["summary"]
    assert set(summary) == {
        "total_miles", "driving_hours", "on_duty_hours", "trip_start", "trip_end",
        "total_elapsed_hours", "num_days", "num_fuel_stops", "num_rests",
        "num_restarts", "timezone", "routing_provider",
    }
    assert summary["total_miles"] == pytest.approx(1001.0, abs=0.5)
    assert summary["routing_provider"] == routing.PROVIDER_HGV
    assert summary["timezone"] == "America/Chicago"

    # Exactly two legs with instructions (FR-RTE-01, FR-RTE-03).
    assert len(body["route"]["legs"]) == 2
    assert body["route"]["legs"][0]["instructions"][0]["text"]
    assert len(body["route"]["geometry"]) <= routing.MAX_GEOMETRY_POINTS

    # Every day totals 24 hours and covers the grid exactly.
    for log in body["daily_logs"]:
        assert sum(log["totals"].values()) == pytest.approx(24.0, abs=0.01)
        assert log["segments"][0]["start_min"] == 0
        assert log["segments"][-1]["end_min"] == 1440
        assert log["recap"]["available_tomorrow"] == pytest.approx(
            70 - log["recap"]["total_last_8_days"]
        )

    # Stops are the non-drive events, each with a location and a duration.
    assert body["stops"]
    for stop in body["stops"]:
        assert stop["kind"] != "drive"
        assert stop["location"]
        assert stop["duration_hr"] > 0
    # FR-UI-07
    assert len(body["assumptions"]) >= 4


@responses.activate
def test_plan_geocodes_labels_without_coordinates(client):
    mock_full_trip()
    payload = plan_payload(
        current={"label": "Dallas, TX"},
        pickup={"label": "Oklahoma City, OK"},
        dropoff={"label": "Chicago, IL"},
    )
    response = client.post(
        reverse("plan"), data=json.dumps(payload), content_type="application/json"
    )
    assert response.status_code == 200, response.content


def osrm_route(coords, miles):
    metres = miles * routing.METRES_PER_MILE
    return {
        "code": "Ok",
        "routes": [
            {
                "distance": metres,
                "duration": miles / 55 * 3600,
                "geometry": {"coordinates": coords},
                "legs": [
                    {"steps": [{
                        "name": "I-35", "distance": metres, "duration": 100,
                        "maneuver": {"type": "turn", "modifier": "left"},
                    }]}
                ],
            }
        ],
    }


@responses.activate
def test_plan_falls_back_to_car_routing(client):
    """FR-RTE-02: the response names the provider and the UI gets a notice."""
    # The HGV profile fails on both the call and its one retry, per INT-05.
    for _ in range(2):
        responses.add(responses.POST, routing.ORS_DIRECTIONS, status=503)
    responses.add(
        responses.GET, geocoding.ORS_REVERSE,
        json={"features": [pelias("Joplin, MO", 37.084, -94.513, "Joplin", "MO")]},
    )
    responses.add(
        responses.GET,
        f"{routing.OSRM_ROUTE}/-96.797,32.7767;-97.5164,35.4676",
        json=osrm_route([[-96.797, 32.777], [-97.516, 35.467]], 206.0),
    )
    responses.add(
        responses.GET,
        f"{routing.OSRM_ROUTE}/-97.5164,35.4676;-87.6298,41.8781",
        json=osrm_route([[-97.516, 35.467], [-87.630, 41.878]], 795.0),
    )

    response = client.post(
        reverse("plan"), data=json.dumps(plan_payload()), content_type="application/json"
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["summary"]["routing_provider"] == routing.PROVIDER_CAR
    assert any("Car routing" in notice for notice in body["notices"])
    assert body["route"]["legs"][0]["instructions"][0]["text"] == "Turn left i-35"


@responses.activate
def test_plan_reports_unroutable_leg(client):
    responses.add(responses.POST, routing.ORS_DIRECTIONS, status=404)
    response = client.post(
        reverse("plan"), data=json.dumps(plan_payload()), content_type="application/json"
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "route_not_found"
    assert "Dallas, TX" in error["message"]


@responses.activate
def test_plan_rejects_a_trip_over_five_thousand_miles(client):
    responses.add(
        responses.POST, routing.ORS_DIRECTIONS,
        json=ors_route([[-96.797, 32.777], [-97.516, 35.467]], 3000.0, 3000 / 55 * 3600),
    )
    responses.add(
        responses.POST, routing.ORS_DIRECTIONS,
        json=ors_route([[-97.516, 35.467], [-87.630, 41.878]], 2500.0, 2500 / 55 * 3600),
    )
    response = client.post(
        reverse("plan"), data=json.dumps(plan_payload()), content_type="application/json"
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "trip_too_long"


@responses.activate
def test_plan_handles_same_place_trip(client):
    """FR-INP-06: all three locations within half a mile still plans."""
    responses.add(
        responses.GET, geocoding.ORS_REVERSE,
        json={"features": [pelias("Dallas, TX", 32.7767, -96.797, "Dallas", "TX")]},
    )
    here = {"label": "Dallas, TX", "lat": 32.7767, "lng": -96.7970}
    response = client.post(
        reverse("plan"),
        data=json.dumps(plan_payload(current=here, pickup=dict(here), dropoff=dict(here))),
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["summary"]["total_miles"] == 0.0
    assert body["summary"]["driving_hours"] == 0.0
    assert "All locations are the same place." in body["notices"]
    kinds = {e["kind"] for e in body["events"]}
    assert {"pre_trip", "pickup", "dropoff"} <= kinds


# --- AC-08 validation -------------------------------------------------------


@pytest.mark.parametrize(
    "overrides,field",
    [
        ({"cycle_used_hr": 71}, "cycle_used_hr"),
        ({"cycle_used_hr": -1}, "cycle_used_hr"),
        ({"cycle_used_hr": "abc"}, "cycle_used_hr"),
        ({"current": {"label": ""}}, "current.label"),
        ({"current": {"label": "D"}}, "current.label"),
        ({"driver": "x" * 81}, "driver"),
        ({"start_time": "1999-01-01T08:00:00-06:00"}, "start_time"),  # > 7 days past
        ({"current": {"label": "Dallas", "lat": 32.7}}, "current"),
    ],
)
def test_plan_validation_errors(client, overrides, field):
    payload = plan_payload(**overrides)
    response = client.post(
        reverse("plan"), data=json.dumps(payload), content_type="application/json"
    )
    assert response.status_code == 400, response.content
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert field in error["fields"], error["fields"]


def test_plan_requires_all_three_locations(client):
    response = client.post(
        reverse("plan"), data=json.dumps({"cycle_used_hr": 0}),
        content_type="application/json",
    )
    assert response.status_code == 400
    fields = response.json()["error"]["fields"]
    assert {"current", "pickup", "dropoff"} <= set(fields)


@responses.activate
def test_plan_reports_unknown_location(client):
    responses.add(responses.GET, geocoding.ORS_SEARCH, json={"features": []})
    responses.add(responses.GET, geocoding.NOMINATIM_SEARCH, json=[])
    payload = plan_payload(current={"label": "Nowhere at all, ZZ"})
    response = client.post(
        reverse("plan"), data=json.dumps(payload), content_type="application/json"
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "not_found"


def test_cycle_used_rounds_to_quarter_hours(client):
    """BR-PLN-05."""
    from planner.serializers import TripRequestSerializer

    serializer = TripRequestSerializer(data=plan_payload(cycle_used_hr=22.6))
    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["cycle_used_hr"] == 22.5


# --- API-05, API-06, ERR-02 -------------------------------------------------


def test_rate_limit_returns_429(client, settings):
    settings.RATE_LIMIT_PER_MINUTE = 3
    for _ in range(3):
        assert client.get(reverse("geocode"), {"q": "da"}).status_code == 400
    response = client.get(reverse("geocode"), {"q": "da"})
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"


def test_unknown_api_path_returns_json_404(client):
    response = client.get("/api/does-not-exist/")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_cors_allows_only_configured_origins(client, settings):
    settings.CORS_ALLOWED_ORIGINS = ["https://eld.example.com"]
    allowed = client.get(reverse("health"), HTTP_ORIGIN="https://eld.example.com")
    assert allowed["Access-Control-Allow-Origin"] == "https://eld.example.com"
    blocked = client.get(reverse("health"), HTTP_ORIGIN="https://evil.example.com")
    assert "Access-Control-Allow-Origin" not in blocked


def test_request_id_header_is_echoed(client):
    response = client.get(reverse("health"), HTTP_X_REQUEST_ID="abc123")
    assert response["X-Request-ID"] == "abc123"


@pytest.mark.parametrize("value", [71, -1, "abc"])
def test_cycle_message_matches_the_requirement(client, value):
    """FR-INP-02 specifies the wording of the out-of-range message."""
    response = client.post(
        reverse("plan"),
        data=json.dumps(plan_payload(cycle_used_hr=value)),
        content_type="application/json",
    )
    assert response.status_code == 400
    assert response.json()["error"]["fields"]["cycle_used_hr"] == "Enter 0-70 hours."
