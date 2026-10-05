"""Truck routing (section 4.3).

Primary is OpenRouteService ``driving-hgv``; on failure we retry once with the
public OSRM car profile (FR-RTE-02, INT-02). The response reports which
provider was used so the UI can warn that truck times may differ.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from django.conf import settings

from ..errors import ProviderUnavailable, RateLimited, RouteNotFound
from ..hos.geometry import Point, simplify
from .http import ProviderError, ProviderRateLimited, get_json, post_json

logger = logging.getLogger("planner.routing")

ORS_DIRECTIONS = "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson"
OSRM_ROUTE = "https://router.project-osrm.org/route/v1/driving"

METRES_PER_MILE = 1609.344
MAX_GEOMETRY_POINTS = 2000  # FR-RTE-04
MAX_TRIP_MILES = 5000.0     # FR-RTE-05

PROVIDER_HGV = "openrouteservice-hgv"
PROVIDER_CAR = "osrm-car"


@dataclass
class Instruction:
    text: str
    distance_mi: float
    duration_min: float

    def as_dict(self) -> dict:
        return {
            "text": self.text,
            "distance_mi": round(self.distance_mi, 1),
            "duration_min": round(self.duration_min, 1),
        }


@dataclass
class RoutedLeg:
    from_label: str
    to_label: str
    distance_mi: float
    duration_hr: float
    geometry: list[Point] = field(default_factory=list)
    instructions: list[Instruction] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "from_label": self.from_label,
            "to_label": self.to_label,
            "distance_mi": round(self.distance_mi, 1),
            "duration_hr": round(self.duration_hr, 2),
            "geometry": [[round(lat, 5), round(lng, 5)] for lat, lng in self.geometry],
            "instructions": [i.as_dict() for i in self.instructions],
        }


@dataclass
class RouteResult:
    legs: list[RoutedLeg]
    provider: str

    @property
    def total_miles(self) -> float:
        return sum(leg.distance_mi for leg in self.legs)

    def combined_geometry(self) -> list[Point]:
        """Full route polyline, simplified to the response budget (FR-RTE-04)."""
        combined: list[Point] = []
        for leg in self.legs:
            points = leg.geometry
            if combined and points and points[0] == combined[-1]:
                points = points[1:]
            combined.extend(points)
        return simplify(combined, MAX_GEOMETRY_POINTS)


def route_trip(waypoints: list[tuple[str, float, float]]) -> RouteResult:
    """Route the two legs current -> pickup -> dropoff (FR-RTE-01).

    ``waypoints`` is [(label, lat, lng)] with exactly three entries.
    """
    if len(waypoints) != 3:
        raise ValueError("route_trip expects three waypoints")

    pairs = [(waypoints[0], waypoints[1]), (waypoints[1], waypoints[2])]
    provider = PROVIDER_HGV
    legs: list[RoutedLeg] = []

    try:
        if not settings.ORS_API_KEY:
            raise ProviderError("ors", "directions", "no_key", "ORS_API_KEY not set")
        legs = [_ors_leg(a, b) for a, b in pairs]
    except ProviderRateLimited:
        raise RateLimited() from None
    except RouteNotFound:
        raise
    except ProviderError as exc:
        # FR-RTE-02: retry once with the fallback car-profile provider.
        logger.warning(
            "routing_fallback",
            extra={"provider": "ors", "endpoint": "directions", "status": exc.status},
        )
        provider = PROVIDER_CAR
        try:
            legs = [_osrm_leg(a, b) for a, b in pairs]
        except ProviderRateLimited:
            raise RateLimited() from None
        except RouteNotFound:
            raise
        except ProviderError as inner:
            raise ProviderUnavailable(
                "Routing is unavailable right now. Please retry."
            ) from inner

    result = RouteResult(legs=legs, provider=provider)
    if result.total_miles > MAX_TRIP_MILES:
        raise TripTooLongError(result.total_miles)
    return result


class TripTooLongError(Exception):
    """Raised with the measured distance so the view can build the message."""

    def __init__(self, miles: float) -> None:
        super().__init__(f"{miles:.0f} mi exceeds the {MAX_TRIP_MILES:.0f} mi limit")
        self.miles = miles


# -- OpenRouteService ------------------------------------------------------


def _ors_leg(start, end) -> RoutedLeg:
    (from_label, lat1, lng1), (to_label, lat2, lng2) = start, end
    if _same_point(lat1, lng1, lat2, lng2):
        return _zero_leg(from_label, to_label, lat1, lng1)

    try:
        data = post_json(
            "ors",
            ORS_DIRECTIONS,
            json={
                "coordinates": [[lng1, lat1], [lng2, lat2]],
                "instructions": True,
                "units": "mi",
                "geometry_simplify": True,
            },
            headers={
                "Authorization": settings.ORS_API_KEY,
                "Content-Type": "application/json",
                # The /geojson endpoint only serves geo+json; the default
                # Accept of application/json is refused with a 406.
                "Accept": "application/geo+json",
            },
            endpoint="v2/directions/driving-hgv",
        )
    except ProviderError as exc:
        if exc.status in (400, 404):
            # ORS reports an unroutable pair as a client error.
            raise RouteNotFound(
                f"No truck route found from {from_label} to {to_label}."
            ) from exc
        raise

    features = data.get("features") or []
    if not features:
        raise RouteNotFound(f"No truck route found from {from_label} to {to_label}.")

    feature = features[0]
    summary = (feature.get("properties") or {}).get("summary") or {}
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    geometry = [(float(c[1]), float(c[0])) for c in coords if len(c) >= 2]

    instructions: list[Instruction] = []
    for segment in (feature.get("properties") or {}).get("segments", []):
        for step in segment.get("steps", []):
            instructions.append(
                Instruction(
                    text=step.get("instruction", ""),
                    distance_mi=float(step.get("distance", 0.0)),
                    duration_min=float(step.get("duration", 0.0)) / 60.0,
                )
            )

    distance_mi = float(summary.get("distance", 0.0))
    duration_hr = float(summary.get("duration", 0.0)) / 3600.0
    if distance_mi > 0 and duration_hr <= 0:
        duration_hr = distance_mi / 55.0
    return RoutedLeg(from_label, to_label, distance_mi, duration_hr, geometry, instructions)


# -- OSRM fallback ---------------------------------------------------------


def _osrm_leg(start, end) -> RoutedLeg:
    (from_label, lat1, lng1), (to_label, lat2, lng2) = start, end
    if _same_point(lat1, lng1, lat2, lng2):
        return _zero_leg(from_label, to_label, lat1, lng1)

    data = get_json(
        "osrm",
        f"{OSRM_ROUTE}/{lng1},{lat1};{lng2},{lat2}",
        params={"overview": "full", "geometries": "geojson", "steps": "true"},
        endpoint="route/v1/driving",
    )
    if data.get("code") != "Ok" or not data.get("routes"):
        raise RouteNotFound(f"No road route found from {from_label} to {to_label}.")

    route = data["routes"][0]
    coords = (route.get("geometry") or {}).get("coordinates") or []
    geometry = [(float(c[1]), float(c[0])) for c in coords if len(c) >= 2]

    instructions: list[Instruction] = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            manoeuvre = step.get("maneuver") or {}
            name = step.get("name") or ""
            text = " ".join(
                part for part in (manoeuvre.get("type"), manoeuvre.get("modifier"), name) if part
            ).strip()
            instructions.append(
                Instruction(
                    text=(text or "Continue").capitalize(),
                    distance_mi=float(step.get("distance", 0.0)) / METRES_PER_MILE,
                    duration_min=float(step.get("duration", 0.0)) / 60.0,
                )
            )

    distance_mi = float(route.get("distance", 0.0)) / METRES_PER_MILE
    duration_hr = float(route.get("duration", 0.0)) / 3600.0
    if distance_mi > 0 and duration_hr <= 0:
        duration_hr = distance_mi / 55.0
    return RoutedLeg(from_label, to_label, distance_mi, duration_hr, geometry, instructions)


def _same_point(lat1: float, lng1: float, lat2: float, lng2: float) -> bool:
    """FR-INP-06: locations within about half a mile count as the same place."""
    from ..hos.geometry import haversine_mi

    return haversine_mi((lat1, lng1), (lat2, lng2)) < 0.5


def _zero_leg(from_label: str, to_label: str, lat: float, lng: float) -> RoutedLeg:
    return RoutedLeg(from_label, to_label, 0.0, 0.0, [(lat, lng)], [])
