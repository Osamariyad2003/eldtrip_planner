"""The three public endpoints (section 8.1)."""

from __future__ import annotations

from django.conf import settings
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .errors import ValidationFailed
from .planning import plan_trip
from .providers import geocoding
from .serializers import GeocodeQuerySerializer, TripRequestSerializer
from .throttling import enforce_rate_limit


@api_view(["POST"])
def plan(request):
    """API-01: POST /api/trips/plan/"""
    enforce_rate_limit(request)
    serializer = TripRequestSerializer(data=request.data)
    if not serializer.is_valid():
        raise ValidationFailed(fields=_flatten(serializer.errors))
    return Response(plan_trip(serializer.validated_data))


@api_view(["GET"])
def geocode(request):
    """API-02: GET /api/geocode/?q="""
    enforce_rate_limit(request)
    serializer = GeocodeQuerySerializer(data=request.query_params)
    if not serializer.is_valid():
        raise ValidationFailed(fields=_flatten(serializer.errors))
    places = geocoding.suggest(serializer.validated_data["q"])
    return Response([p.as_dict() for p in places])


@api_view(["GET"])
def health(request):
    """API-03: GET /api/health/ - key presence only, never the key."""
    return Response(
        {
            "status": "ok",
            "version": settings.APP_VERSION,
            "providers": {"ors": bool(settings.ORS_API_KEY)},
        }
    )


def _flatten(errors) -> dict:
    """Turn DRF's nested errors into the flat {field: message} of section 10."""
    flat: dict[str, str] = {}

    def walk(prefix: str, value) -> None:
        if isinstance(value, dict):
            for key, inner in value.items():
                # A nested object's non-field error belongs to the object
                # itself, so the UI can show it under that input.
                if key == "non_field_errors" and prefix:
                    walk(prefix, inner)
                else:
                    walk(f"{prefix}.{key}" if prefix else str(key), inner)
        elif isinstance(value, (list, tuple)):
            if value and isinstance(value[0], (dict, list)):
                for item in value:
                    walk(prefix, item)
            elif value:
                flat.setdefault(prefix, str(value[0]))
        else:
            flat.setdefault(prefix, str(value))

    walk("", errors)
    return flat
