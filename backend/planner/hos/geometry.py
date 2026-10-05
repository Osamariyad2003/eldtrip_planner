"""Pure polyline maths used by the engine to place events on the route.

No network or database access, so the engine stays a pure function
(FR-HOS-05).
"""

from __future__ import annotations

from itertools import pairwise
from math import asin, cos, radians, sin, sqrt

EARTH_RADIUS_MI = 3958.7613

Point = tuple[float, float]  # (lat, lng)


def haversine_mi(a: Point, b: Point) -> float:
    """Great-circle distance between two (lat, lng) points, in miles."""
    lat1, lng1 = radians(a[0]), radians(a[1])
    lat2, lng2 = radians(b[0]), radians(b[1])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_MI * asin(min(1.0, sqrt(h)))


def cumulative_mi(points: list[Point]) -> list[float]:
    """Running distance along a polyline; same length as ``points``."""
    out = [0.0]
    for prev, cur in pairwise(points):
        out.append(out[-1] + haversine_mi(prev, cur))
    return out


class LegGeometry:
    """A routed leg's polyline, queryable by distance travelled along it.

    The provider's reported leg distance is authoritative for scheduling, so
    the polyline is scaled onto it: ``at(miles)`` treats ``miles`` as a
    fraction of the reported distance and returns the matching polyline point.
    """

    def __init__(self, points: list[Point], distance_mi: float) -> None:
        self.points = [p for p in points if p is not None]
        self.distance_mi = max(0.0, float(distance_mi))
        self._cum = cumulative_mi(self.points) if self.points else [0.0]
        self._geom_len = self._cum[-1]

    def __bool__(self) -> bool:
        return bool(self.points)

    def at(self, miles: float) -> Point | None:
        """Point on the polyline at ``miles`` along the leg, or None if empty."""
        if not self.points:
            return None
        if len(self.points) == 1 or self._geom_len <= 0:
            return self.points[0]
        fraction = 0.0 if self.distance_mi <= 0 else miles / self.distance_mi
        target = min(max(fraction, 0.0), 1.0) * self._geom_len
        # Last vertex at or before the target; the polyline is monotonic.
        lo, hi = 0, len(self._cum) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self._cum[mid] <= target:
                lo = mid
            else:
                hi = mid - 1
        if lo >= len(self.points) - 1:
            return self.points[-1]
        seg = self._cum[lo + 1] - self._cum[lo]
        t = 0.0 if seg <= 0 else (target - self._cum[lo]) / seg
        (lat1, lng1), (lat2, lng2) = self.points[lo], self.points[lo + 1]
        return (lat1 + (lat2 - lat1) * t, lng1 + (lng2 - lng1) * t)


def simplify(points: list[Point], max_points: int, tolerance_m: float = 50.0) -> list[Point]:
    """Reduce a polyline to at most ``max_points`` vertices (FR-RTE-04).

    Ramer-Douglas-Peucker at ``tolerance_m``; if that still leaves too many
    vertices the tolerance is doubled until the budget is met, so the result
    always fits the response size limit.
    """
    if len(points) <= max_points:
        return list(points)
    tol = tolerance_m
    out = _rdp(points, tol)
    while len(out) > max_points and tol < 20_000:
        tol *= 2
        out = _rdp(points, tol)
    if len(out) > max_points:  # pathological input: keep endpoints and sample
        step = len(out) / (max_points - 1)
        sampled = [out[int(i * step)] for i in range(max_points - 1)]
        sampled.append(out[-1])
        return sampled
    return out


def _rdp(points: list[Point], tolerance_m: float) -> list[Point]:
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        worst, worst_i = -1.0, start
        for i in range(start + 1, end):
            d = _perpendicular_m(points[i], points[start], points[end])
            if d > worst:
                worst, worst_i = d, i
        if worst > tolerance_m:
            keep[worst_i] = True
            stack.append((start, worst_i))
            stack.append((worst_i, end))
    return [p for p, k in zip(points, keep, strict=False) if k]


def _perpendicular_m(p: Point, a: Point, b: Point) -> float:
    """Distance from p to segment a-b in metres, on a local flat projection."""
    scale = cos(radians(p[0])) or 1e-9
    px, py = p[1] * scale, p[0]
    ax, ay = a[1] * scale, a[0]
    bx, by = b[1] * scale, b[0]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        dist_deg = sqrt((px - ax) ** 2 + (py - ay) ** 2)
    else:
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        cx, cy = ax + t * dx, ay + t * dy
        dist_deg = sqrt((px - cx) ** 2 + (py - cy) ** 2)
    return dist_deg * 111_320.0
