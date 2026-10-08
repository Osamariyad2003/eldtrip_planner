"""The HOS scheduling engine (section 4.4).

A pure function: (legs, cycle used, start time, config) -> ordered duty
events. It makes no network or database calls, so the same inputs always
produce byte-identical output (NFR-REL-01).

The core loop drives a leg in chunks. Each chunk is the shortest of the
remaining allowances - drive time, 14-hour window, time to the next 30-minute
break, cycle hours, miles to the next fuel stop, and miles left in the leg -
so a chunk always ends at the first limit reached or at the end of the leg
(FR-HOS-02). Whichever limit bound the chunk then decides the stop to insert,
by the precedence in BR-PLN-04.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from .config import DEFAULT_CONFIG, HosConfig
from .geometry import LegGeometry
from .types import (
    BREAK,
    DRIVE,
    DRIVING,
    DROPOFF,
    FUEL,
    OFF,
    OFF_DUTY,
    ON_DUTY,
    PICKUP,
    POST_TRIP,
    PRE_TRIP,
    REST_10,
    RESTART_34,
    SLEEPER_BERTH,
    DutyEvent,
    EngineLeg,
    ScheduleError,
)

MINUTES_PER_DAY = 1440
_EPS_MI = 1e-6

# BR-LOG-02 activity labels, keyed by event kind.
NOTES = {
    PRE_TRIP: "Pre-trip inspection / TIV",
    POST_TRIP: "Post-trip inspection",
    PICKUP: "Pickup - loading",
    DROPOFF: "Dropoff - unloading",
    FUEL: "Fuel",
    BREAK: "30-min break",
    REST_10: "10-hr rest",
    RESTART_34: "34-hr restart",
    OFF: "Off duty",
    DRIVE: "Depart",
}


def _floor_step(minutes: float, step: int) -> int:
    return int(minutes // step) * step


def _ceil_step(minutes: float, step: int) -> int:
    whole = int(minutes // step) * step
    return whole if abs(minutes - whole) < 1e-9 else whole + step


class _Engine:
    def __init__(
        self,
        legs: list[EngineLeg],
        cycle_used_hr: float,
        start: datetime,
        config: HosConfig,
    ) -> None:
        self.cfg = config
        self.legs = legs
        self.start = start
        self.events: list[DutyEvent] = []

        # BR-PLN-05: the cycle-used input rounds to the nearest quarter hour,
        # which keeps every allowance a whole number of 15-minute steps.
        self.cycle_used = round(cycle_used_hr * 4) * 15

        self.now = 0                 # minutes from trip start
        self.miles = 0.0             # cumulative trip miles
        self.window_start: int | None = None   # duty-period start, None = off duty
        self.drive_in_period = 0
        self.drive_since_break = 0
        self.miles_since_fuel = 0.0

        self._geom: LegGeometry | None = None
        self._leg_miles = 0.0        # miles completed within the current leg
        self._budget = config.max_simulated_days * MINUTES_PER_DAY

    # -- event emission -------------------------------------------------

    def _at(self, minutes: int) -> datetime:
        """The local time ``minutes`` of real elapsed time into the trip.

        BR-HOS-05/06 are durations a clock measures, not positions on a wall
        calendar: a 10-hour rest is ten hours wherever it falls. Adding a
        timedelta straight to a zone-aware datetime does wall-clock arithmetic
        instead, so a rest spanning a daylight-saving change came out as nine
        or eleven real hours and the driver was shown as rested when they were
        not. Doing the addition in UTC and converting back keeps the duration
        honest and lets the local time shift, which is what actually happens.
        """
        absolute = self.start.astimezone(UTC) + timedelta(minutes=minutes)
        return absolute.astimezone(self.start.tzinfo)

    def _emit(self, status: str, kind: str, minutes: int, miles: float = 0.0) -> None:
        if minutes <= 0:
            return
        if self.now + minutes > self._budget:
            raise ScheduleError(
                f"schedule exceeded {self.cfg.max_simulated_days} simulated days"
            )
        start_min, end_min = self.now, self.now + minutes
        miles_start = self.miles
        # FR-HOS-05: the event's point is where the duty status changed, which
        # is the start of the event - so it is interpolated before the event's
        # own miles are added. For a stationary event start and end coincide.
        point = self._geom.at(self._leg_miles) if self._geom else None
        self.miles += miles
        self._leg_miles += miles
        end_point = self._geom.at(self._leg_miles) if self._geom else None
        self.events.append(
            DutyEvent(
                status=status,
                kind=kind,
                start=self._at(start_min),
                end=self._at(end_min),
                start_min=start_min,
                end_min=end_min,
                miles_start=miles_start,
                miles_end=self.miles,
                lat=point[0] if point else None,
                lng=point[1] if point else None,
                end_lat=end_point[0] if end_point else None,
                end_lng=end_point[1] if end_point else None,
                note=NOTES.get(kind, ""),
            )
        )
        self.now = end_min

    # -- duty period boundaries -----------------------------------------

    def _begin_period(self) -> None:
        """Come on duty after a qualifying rest: start the 14-hour window.

        BR-PLN-02 puts a pre-trip inspection at trip start and after every
        10-hour rest and 34-hour restart, so it is emitted here.
        """
        self.window_start = self.now
        self.drive_in_period = 0
        self.drive_since_break = 0
        if not self.cfg.pre_trip_min:
            return
        # FR-HOS-04 applies to the pre-trip too. The restart resets cycle used
        # to 0 and begins its own period, so this recurses at most once.
        if self.cycle_used + self.cfg.pre_trip_min > self.cfg.cycle_limit_min:
            self._take_restart()
            return
        self._emit(ON_DUTY, PRE_TRIP, self.cfg.pre_trip_min)
        self.cycle_used += self.cfg.pre_trip_min

    def _take_restart(self) -> None:
        """BR-HOS-06. Logged OFF per BR-PLN-06; resets cycle used to 0."""
        self._emit(OFF_DUTY, RESTART_34, self.cfg.restart_min)
        self.cycle_used = 0
        self.window_start = None
        self._begin_period()

    def _take_rest(self) -> None:
        """BR-HOS-05. Logged sleeper berth per BR-PLN-06."""
        self._emit(SLEEPER_BERTH, REST_10, self.cfg.rest_min)
        self.window_start = None
        self._begin_period()

    def _take_break(self) -> None:
        """BR-HOS-03. Logged OFF per BR-PLN-06."""
        self._emit(OFF_DUTY, BREAK, self.cfg.break_min)
        self.drive_since_break = 0

    def _take_fuel(self) -> None:
        """BR-PLN-01: 30 minutes on duty. Also satisfies BR-HOS-03."""
        self._on_duty(FUEL, self.cfg.fuel_min)
        self.miles_since_fuel = 0.0
        self.drive_since_break = 0

    # -- on-duty work ----------------------------------------------------

    def _on_duty(self, kind: str, minutes: int) -> None:
        """Emit on-duty-not-driving work, taking a restart first if needed.

        FR-HOS-04: a 34-hour restart goes before any on-duty or driving event
        that would push cycle used above 70 hours. Note that only *driving* is
        barred after the 14-hour window (BR-HOS-02), so this never checks it.
        """
        if minutes <= 0:
            return
        if self.cycle_used + minutes > self.cfg.cycle_limit_min:
            self._take_restart()
        if self.window_start is None:
            self._begin_period()
        self._emit(ON_DUTY, kind, minutes)
        self.cycle_used += minutes

    # -- driving ---------------------------------------------------------

    def _drive_leg(self, leg: EngineLeg) -> None:
        self._geom = leg.leg_geometry()
        self._leg_miles = 0.0
        remaining = leg.distance_mi
        if remaining <= _EPS_MI:
            return
        mi_per_min = leg.speed_mph / 60.0
        if mi_per_min <= 0:
            raise ScheduleError(
                f"leg {leg.from_label} -> {leg.to_label} has no usable speed"
            )

        step = self.cfg.step_min
        while remaining > _EPS_MI:
            if self.window_start is None:
                self._begin_period()

            cap_drive = self.cfg.drive_limit_min - self.drive_in_period
            cap_window = (self.window_start + self.cfg.window_limit_min) - self.now
            cap_break = self.cfg.drive_before_break_min - self.drive_since_break
            cap_cycle = self.cfg.cycle_limit_min - self.cycle_used
            # BR-PLN-05: fuel-limited chunks round down, so the stop lands on
            # the last 15-minute boundary at or before 1,000 miles.
            cap_fuel = _floor_step(
                (self.cfg.fuel_interval_mi - self.miles_since_fuel) / mi_per_min, step
            )
            # BR-PLN-05: the final driving chunk of a leg rounds up.
            cap_leg = _ceil_step(remaining / mi_per_min, step)

            chunk = min(cap_drive, cap_window, cap_break, cap_cycle, cap_fuel, cap_leg)

            if chunk > 0:
                finishing = chunk >= cap_leg
                miles = remaining if finishing else chunk * mi_per_min
                self._emit(DRIVING, DRIVE, chunk, miles)
                self.drive_in_period += chunk
                self.drive_since_break += chunk
                self.cycle_used += chunk
                self.miles_since_fuel += miles
                remaining = 0.0 if finishing else remaining - miles
                if remaining <= _EPS_MI:
                    return

            self._insert_required_stop(mi_per_min)

    def _insert_required_stop(self, mi_per_min: float) -> None:
        """Insert the stop for the limit that stopped the chunk (BR-PLN-04).

        Precedence is restart, then 10-hour rest, then the 30-minute break,
        then fuel - except that fuel is checked before the break, because a
        fuel stop due in the same 15 minutes as a break replaces it (it is a
        30-minute on-duty interruption, so it satisfies BR-HOS-03).
        """
        cfg = self.cfg
        need_restart = self.cycle_used >= cfg.cycle_limit_min
        out_of_drive = self.drive_in_period >= cfg.drive_limit_min
        out_of_window = self.now >= (self.window_start or 0) + cfg.window_limit_min
        need_fuel = (
            _floor_step(
                (cfg.fuel_interval_mi - self.miles_since_fuel) / mi_per_min, cfg.step_min
            )
            <= 0
        )
        need_break = self.drive_since_break >= cfg.drive_before_break_min

        # A 10-hour rest is pointless when the cycle cannot fit the pre-trip
        # plus one more step of driving: the restart is needed either way, so
        # take it directly rather than resting first.
        if (
            (out_of_drive or out_of_window)
            and not need_restart
            and self.cycle_used + cfg.pre_trip_min + cfg.step_min > cfg.cycle_limit_min
        ):
            need_restart = True

        if need_restart:
            self._take_restart()
        elif out_of_drive or out_of_window:
            self._take_rest()
        elif need_fuel:
            self._take_fuel()
        elif need_break:
            self._take_break()
        else:  # pragma: no cover - defensive; one of the caps must have bound
            raise ScheduleError("engine stalled with no limit reached")

    # -- top level -------------------------------------------------------

    def run(self) -> list[DutyEvent]:
        cfg = self.cfg
        # FR-HOS-04 covers the case cycle used == 70 at the start: with a
        # zero-length pre-trip the guard in _on_duty fires on the pickup
        # instead, so the restart is still the first event either way.
        if self.cycle_used + cfg.pre_trip_min > cfg.cycle_limit_min:
            self._take_restart()
        else:
            self._begin_period()

        self._drive_leg(self.legs[0])
        self._on_duty(PICKUP, cfg.pickup_min)
        self._drive_leg(self.legs[1])
        self._on_duty(DROPOFF, cfg.dropoff_min)
        if cfg.post_trip_min:
            self._on_duty(POST_TRIP, cfg.post_trip_min)

        self._close_out()
        return self.events

    def _close_out(self) -> None:
        """FR-HOS-01: off duty to the end of the final day."""
        last = self.events[-1] if self.events else None
        self._geom = None
        start_of_day = self.start.replace(hour=0, minute=0, second=0, microsecond=0)
        elapsed = int((self.start - start_of_day).total_seconds() // 60) + self.now
        remainder = (-elapsed) % MINUTES_PER_DAY
        if not remainder:
            return  # the trip ended exactly at midnight; the day is already full
        self._emit(OFF_DUTY, OFF, remainder)
        if last is not None:
            # The driver is off duty wherever the trip finished.
            tail = self.events[-1]
            tail.lat = last.end_lat if last.end_lat is not None else last.lat
            tail.lng = last.end_lng if last.end_lng is not None else last.lng
            tail.end_lat, tail.end_lng = tail.lat, tail.lng


def schedule(
    legs: list[EngineLeg],
    cycle_used_hr: float,
    start: datetime,
    config: HosConfig | None = None,
) -> list[DutyEvent]:
    """Build the duty-event sequence for a trip (FR-HOS-01).

    ``legs`` must be exactly two: current -> pickup and pickup -> dropoff.
    Returns contiguous events with no gaps or overlaps, every boundary on a
    15-minute step (FR-HOS-06).
    """
    cfg = config or DEFAULT_CONFIG
    if len(legs) != 2:
        raise ValueError("schedule() expects exactly two legs")
    for leg in legs:
        if leg.distance_mi < 0 or leg.duration_hr < 0:
            raise ValueError("leg distance and duration must not be negative")
    if not 0 <= cycle_used_hr <= cfg.cycle_limit_min / 60:
        raise ValueError("cycle_used_hr out of range")
    if start.tzinfo is None:
        raise ValueError("start must be timezone-aware")
    if start.minute % cfg.step_min or start.second or start.microsecond:
        raise ValueError("start must fall on a 15-minute step")
    return _Engine(legs, cycle_used_hr, start, cfg).run()
