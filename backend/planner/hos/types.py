"""Engine input and output types (section 7.1)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from .geometry import LegGeometry, Point

# DutyEvent.status - the four RODS rows
OFF_DUTY = "off_duty"
SLEEPER_BERTH = "sleeper_berth"
DRIVING = "driving"
ON_DUTY = "on_duty"

STATUSES = (OFF_DUTY, SLEEPER_BERTH, DRIVING, ON_DUTY)

# DutyEvent.kind
PRE_TRIP = "pre_trip"
DRIVE = "drive"
PICKUP = "pickup"
DROPOFF = "dropoff"
FUEL = "fuel"
BREAK = "break"
REST_10 = "rest_10"
RESTART_34 = "restart_34"
OFF = "off"
POST_TRIP = "post_trip"

STOP_KINDS = (PRE_TRIP, PICKUP, DROPOFF, FUEL, BREAK, REST_10, RESTART_34, POST_TRIP)


@dataclass
class EngineLeg:
    """One routed segment handed to the engine."""

    from_label: str
    to_label: str
    distance_mi: float
    duration_hr: float
    geometry: list[Point] = field(default_factory=list)

    @property
    def speed_mph(self) -> float:
        """BR-PLN-08: average speed = distance / provider duration."""
        if self.duration_hr <= 0 or self.distance_mi <= 0:
            return 0.0
        return self.distance_mi / self.duration_hr

    def leg_geometry(self) -> LegGeometry:
        return LegGeometry(self.geometry, self.distance_mi)


@dataclass
class DutyEvent:
    """One contiguous period in a single duty status."""

    status: str
    kind: str
    start: datetime
    end: datetime
    start_min: int          # minutes from trip start, for deterministic tests
    end_min: int
    miles_start: float
    miles_end: float
    # Where the duty status changed, i.e. the start of the event.
    lat: float | None = None
    lng: float | None = None
    # Where the event finished; differs from the above only while driving.
    end_lat: float | None = None
    end_lng: float | None = None
    location: str = ""
    note: str = ""

    @property
    def duration_min(self) -> int:
        return self.end_min - self.start_min

    @property
    def duration_hr(self) -> float:
        return self.duration_min / 60.0

    @property
    def miles(self) -> float:
        return self.miles_end - self.miles_start

    @property
    def is_drive(self) -> bool:
        return self.kind == DRIVE


class ScheduleError(Exception):
    """FR-HOS-08: the engine could not finish within the simulated budget."""

    code = "schedule_failed"
