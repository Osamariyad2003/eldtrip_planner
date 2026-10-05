"""BR-CFG - every bolded constant in the SRS business rules lives here.

Changing these requires a redeploy by the Operator (section 6.4); no visitor
can reach them. Tests override values by constructing their own HosConfig.
"""

from __future__ import annotations

from dataclasses import dataclass

MINUTES_PER_HOUR = 60
MINUTES_PER_DAY = 24 * 60


@dataclass(frozen=True)
class HosConfig:
    """Limits and durations used by the scheduling engine, all in minutes."""

    # 6.1 HOS rules
    drive_limit_min: int = 11 * 60          # BR-HOS-01
    window_limit_min: int = 14 * 60         # BR-HOS-02
    drive_before_break_min: int = 8 * 60    # BR-HOS-03
    break_min: int = 30                     # BR-HOS-03
    cycle_limit_min: int = 70 * 60          # BR-HOS-04
    rest_min: int = 10 * 60                 # BR-HOS-05
    restart_min: int = 34 * 60              # BR-HOS-06

    # 6.2 Planning rules
    fuel_interval_mi: float = 1000.0        # BR-PLN-01
    fuel_min: int = 30                      # BR-PLN-01
    pickup_min: int = 60                    # BR-PLN-02
    dropoff_min: int = 60                   # BR-PLN-02
    pre_trip_min: int = 30                  # BR-PLN-02
    post_trip_min: int = 0                  # BR-PLN-02
    step_min: int = 15                      # BR-PLN-05

    # FR-HOS-08 guard
    max_simulated_days: int = 30

    def __post_init__(self) -> None:
        for name in (
            "drive_limit_min",
            "window_limit_min",
            "drive_before_break_min",
            "break_min",
            "cycle_limit_min",
            "rest_min",
            "restart_min",
            "fuel_min",
            "step_min",
            "max_simulated_days",
        ):
            if getattr(self, name) <= 0:
                raise ValueError(f"HosConfig.{name} must be positive")
        if self.fuel_interval_mi <= 0:
            raise ValueError("HosConfig.fuel_interval_mi must be positive")
        for name in ("pickup_min", "dropoff_min", "pre_trip_min", "post_trip_min"):
            if getattr(self, name) < 0:
                raise ValueError(f"HosConfig.{name} must not be negative")


DEFAULT_CONFIG = HosConfig()
