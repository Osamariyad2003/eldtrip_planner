"""Geocoding, autocomplete and reverse geocoding (section 4.2).

Primary provider is OpenRouteService / Pelias; Nominatim is the fallback
(INT-01). Results are cached for at least 24 hours keyed by the normalized
query, or by lat/lng rounded to 3 decimals (FR-GEO-04).
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass

from django.conf import settings
from django.core.cache import cache

from ..errors import NotFound, ProviderUnavailable, RateLimited
from .http import ProviderError, ProviderRateLimited, get_json

logger = logging.getLogger("planner.geocoding")

ORS_SEARCH = "https://api.openrouteservice.org/geocode/search"
ORS_AUTOCOMPLETE = "https://api.openrouteservice.org/geocode/autocomplete"
ORS_REVERSE = "https://api.openrouteservice.org/geocode/reverse"
NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"

MAX_SUGGESTIONS = 5

# Nominatim's usage policy caps us at 1 request per second (INT-01).
_nominatim_lock = threading.Lock()
_nominatim_last_call = 0.0


@dataclass(frozen=True)
class Place:
    label: str
    lat: float
    lng: float
    city: str = ""
    state: str = ""

    def as_dict(self) -> dict:
        return {
            "label": self.label,
            "lat": round(self.lat, 6),
            "lng": round(self.lng, 6),
            "city": self.city,
            "state": self.state,
        }

    @property
    def city_state(self) -> str:
        if self.city and self.state:
            return f"{self.city}, {self.state}"
        return self.city or self.label


def normalize_query(query: str) -> str:
    return re.sub(r"\s+", " ", query.strip()).lower()


def suggest(query: str) -> list[Place]:
    """FR-GEO-01: up to 5 US suggestions for a query of 3+ characters."""
    key = f"geo:suggest:{normalize_query(query)}"
    cached = cache.get(key)
    if cached is not None:
        return [Place(**item) for item in cached]

    places = _suggest_uncached(query)
    cache.set(key, [p.__dict__ for p in places], settings.GEOCODE_CACHE_SECONDS)
    return places


def _suggest_uncached(query: str) -> list[Place]:
    try:
        if settings.ORS_API_KEY:
            return _ors_search(ORS_AUTOCOMPLETE, query)
    except ProviderRateLimited:
        raise RateLimited() from None
    except ProviderError:
        logger.warning("geocode_fallback", extra={"provider": "ors", "stage": "autocomplete"})
    try:
        return _nominatim_search(query)
    except ProviderRateLimited:
        raise RateLimited() from None
    except ProviderError as exc:
        raise ProviderUnavailable("Search unavailable, try again.") from exc


def geocode(label: str) -> Place:
    """FR-GEO-02: resolve a submitted label to one US point."""
    key = f"geo:one:{normalize_query(label)}"
    cached = cache.get(key)
    if cached is not None:
        return Place(**cached)

    try:
        places = _ors_search(ORS_SEARCH, label) if settings.ORS_API_KEY else []
    except ProviderRateLimited:
        raise RateLimited() from None
    except ProviderError:
        logger.warning("geocode_fallback", extra={"provider": "ors", "stage": "search"})
        places = []

    if not places:
        try:
            places = _nominatim_search(label)
        except ProviderRateLimited:
            raise RateLimited() from None
        except ProviderError as exc:
            raise ProviderUnavailable("Location search is unavailable.") from exc

    if not places:
        raise NotFound(f'No US match for "{label}".')

    cache.set(key, places[0].__dict__, settings.GEOCODE_CACHE_SECONDS)
    return places[0]


def reverse(lat: float, lng: float, fallback: str = "") -> str:
    """FR-GEO-03: "City, ST" for a point; never blocks the plan.

    On provider failure it returns ``fallback`` if given, otherwise a
    coordinate string rounded to 2 decimals.
    """
    key = f"geo:rev:{round(lat, 3)},{round(lng, 3)}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    label = ""
    try:
        if settings.ORS_API_KEY:
            label = _ors_reverse(lat, lng)
    except (ProviderError, ProviderRateLimited):
        logger.warning("reverse_fallback", extra={"provider": "ors"})
    if not label:
        try:
            label = _nominatim_reverse(lat, lng)
        except (ProviderError, ProviderRateLimited):
            logger.warning("reverse_failed", extra={"provider": "nominatim"})

    if not label:
        label = fallback or f"near {lat:.2f}, {lng:.2f}"
    else:
        cache.set(key, label, settings.GEOCODE_CACHE_SECONDS)
    return label


# -- OpenRouteService / Pelias ---------------------------------------------


def _ors_search(url: str, query: str) -> list[Place]:
    data = get_json(
        "ors",
        url,
        params={
            "api_key": settings.ORS_API_KEY,
            "text": query,
            "boundary.country": "US",
            "size": MAX_SUGGESTIONS,
        },
        endpoint="geocode/search" if url == ORS_SEARCH else "geocode/autocomplete",
    )
    places = [p for p in (_place_from_pelias(f) for f in data.get("features", [])) if p]
    return places[:MAX_SUGGESTIONS]


def _ors_reverse(lat: float, lng: float) -> str:
    data = get_json(
        "ors",
        ORS_REVERSE,
        params={
            "api_key": settings.ORS_API_KEY,
            "point.lat": lat,
            "point.lon": lng,
            "size": 1,
            "boundary.country": "US",
        },
        endpoint="geocode/reverse",
    )
    features = data.get("features") or []
    if not features:
        return ""
    place = _place_from_pelias(features[0])
    return place.city_state if place else ""


def _place_from_pelias(feature: dict) -> Place | None:
    props = feature.get("properties") or {}
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coords) < 2:
        return None
    if props.get("country_a") not in (None, "USA", "US"):
        return None
    city = props.get("locality") or props.get("county") or props.get("region") or ""
    state = props.get("region_a") or ""
    return Place(
        label=props.get("label") or f"{city}, {state}".strip(", "),
        lat=float(coords[1]),
        lng=float(coords[0]),
        city=city,
        state=state,
    )


# -- Nominatim fallback ----------------------------------------------------


def _throttle_nominatim() -> None:
    global _nominatim_last_call
    with _nominatim_lock:
        wait = 1.0 - (time.monotonic() - _nominatim_last_call)
        if wait > 0:
            time.sleep(wait)
        _nominatim_last_call = time.monotonic()


def _nominatim_headers() -> dict:
    return {"User-Agent": settings.NOMINATIM_USER_AGENT}


def _nominatim_search(query: str) -> list[Place]:
    _throttle_nominatim()
    data = get_json(
        "nominatim",
        NOMINATIM_SEARCH,
        params={
            "q": query,
            "format": "jsonv2",
            "addressdetails": 1,
            "countrycodes": "us",
            "limit": MAX_SUGGESTIONS,
        },
        headers=_nominatim_headers(),
        endpoint="search",
    )
    places = []
    for item in data or []:
        address = item.get("address") or {}
        city = (
            address.get("city")
            or address.get("town")
            or address.get("village")
            or address.get("county")
            or ""
        )
        places.append(
            Place(
                label=item.get("display_name", query),
                lat=float(item["lat"]),
                lng=float(item["lon"]),
                city=city,
                state=_state_code(address.get("state", "")),
            )
        )
    return places[:MAX_SUGGESTIONS]


def _nominatim_reverse(lat: float, lng: float) -> str:
    _throttle_nominatim()
    data = get_json(
        "nominatim",
        NOMINATIM_REVERSE,
        params={"lat": lat, "lon": lng, "format": "jsonv2", "addressdetails": 1, "zoom": 10},
        headers=_nominatim_headers(),
        endpoint="reverse",
    )
    address = (data or {}).get("address") or {}
    city = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("county")
        or ""
    )
    state = _state_code(address.get("state", ""))
    if city and state:
        return f"{city}, {state}"
    return city or state or ""


STATE_CODES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}


def _state_code(name: str) -> str:
    if len(name) == 2:
        return name.upper()
    return STATE_CODES.get(name.strip().lower(), name)
