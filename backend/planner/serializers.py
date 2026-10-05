"""Request validation (section 4.1, NFR-SEC-03).

Every rule here is enforced server-side regardless of what the client does.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from rest_framework import serializers

CYCLE_MAX_HOURS = 70
TEXT_MAX = 80


class LocationField(serializers.Serializer):
    """A location is ``{label}`` or ``{label, lat, lng}`` (API-01)."""

    label = serializers.CharField(min_length=2, max_length=200, trim_whitespace=True)
    lat = serializers.FloatField(required=False, allow_null=True,
                                 min_value=-90, max_value=90)
    lng = serializers.FloatField(required=False, allow_null=True,
                                 min_value=-180, max_value=180)

    def validate(self, attrs):
        has_lat, has_lng = attrs.get("lat") is not None, attrs.get("lng") is not None
        if has_lat != has_lng:
            raise serializers.ValidationError(
                "Supply both lat and lng, or neither."
            )
        return attrs


class TripRequestSerializer(serializers.Serializer):
    current = LocationField()
    pickup = LocationField()
    dropoff = LocationField()

    # FR-INP-02 - the wording below is the message the requirement specifies.
    cycle_used_hr = serializers.FloatField(
        min_value=0,
        max_value=CYCLE_MAX_HOURS,
        error_messages={
            "min_value": "Enter 0-70 hours.",
            "max_value": "Enter 0-70 hours.",
            "invalid": "Enter 0-70 hours.",
            "required": "Enter your cycle hours used.",
        },
    )

    # FR-INP-03 - the optional, collapsed "Log details" group.
    start_time = serializers.DateTimeField(required=False, allow_null=True)
    driver = serializers.CharField(required=False, allow_blank=True, max_length=TEXT_MAX)
    carrier = serializers.CharField(required=False, allow_blank=True, max_length=TEXT_MAX)
    main_office = serializers.CharField(required=False, allow_blank=True, max_length=TEXT_MAX)
    home_terminal = serializers.CharField(required=False, allow_blank=True, max_length=TEXT_MAX)
    vehicle = serializers.CharField(required=False, allow_blank=True, max_length=TEXT_MAX)
    shipper = serializers.CharField(required=False, allow_blank=True, max_length=TEXT_MAX)
    commodity = serializers.CharField(required=False, allow_blank=True, max_length=TEXT_MAX)
    shipping_document = serializers.CharField(
        required=False, allow_blank=True, max_length=TEXT_MAX
    )

    def validate_cycle_used_hr(self, value: float) -> float:
        # BR-PLN-05: the cycle-used input rounds to the nearest quarter hour.
        rounded = round(value * 4) / 4
        if not 0 <= rounded <= CYCLE_MAX_HOURS:
            raise serializers.ValidationError("Enter 0-70 hours.")
        return rounded

    def validate_start_time(self, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        now = datetime.now(UTC)
        if value < now - timedelta(days=7):
            raise serializers.ValidationError(
                "Start time cannot be more than 7 days in the past."
            )
        if value > now + timedelta(days=365):
            raise serializers.ValidationError(
                "Start time cannot be more than 365 days in the future."
            )
        return value


class GeocodeQuerySerializer(serializers.Serializer):
    q = serializers.CharField(min_length=3, max_length=200, trim_whitespace=True)
