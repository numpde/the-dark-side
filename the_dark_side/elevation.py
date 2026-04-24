"""Elevation helpers for enriching precomputed route catalogs."""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from hashlib import sha1
from pathlib import Path


EARTH_RADIUS_M = 6371000.0
OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
OPEN_TOPO_DATA_URL = "https://api.opentopodata.org/v1/mapzen"


def haversine_meters(
    lon_a: float,
    lat_a: float,
    lon_b: float,
    lat_b: float,
) -> float:
    dlat = math.radians(lat_b - lat_a)
    dlon = math.radians(lon_b - lon_a)
    lat1 = math.radians(lat_a)
    lat2 = math.radians(lat_b)
    value = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(value))


def cumulative_distances(coordinates: list[list[float]]) -> list[float]:
    if not coordinates:
        return []
    distances = [0.0]
    for index in range(1, len(coordinates)):
        first = coordinates[index - 1]
        second = coordinates[index]
        distances.append(
            distances[-1]
            + haversine_meters(first[0], first[1], second[0], second[1])
        )
    return distances


def interpolate_coordinate(
    first: list[float],
    second: list[float],
    fraction: float,
) -> list[float]:
    return [
        first[0] + (second[0] - first[0]) * fraction,
        first[1] + (second[1] - first[1]) * fraction,
    ]


def resample_coordinates(
    coordinates: list[list[float]],
    spacing_m: float,
) -> tuple[list[list[float]], list[float]]:
    if not coordinates:
        return [], []
    if len(coordinates) == 1 or spacing_m <= 0:
        return [list(coord) for coord in coordinates], cumulative_distances(coordinates)

    source_distances = cumulative_distances(coordinates)
    total_distance = source_distances[-1]
    if total_distance == 0:
        return [list(coordinates[0])], [0.0]

    sample_distances: list[float] = [0.0]
    distance = spacing_m
    while distance < total_distance:
        sample_distances.append(distance)
        distance += spacing_m
    if sample_distances[-1] != total_distance:
        sample_distances.append(total_distance)

    sampled_coordinates: list[list[float]] = []
    source_index = 0
    for target_distance in sample_distances:
        while (
            source_index < len(source_distances) - 2
            and source_distances[source_index + 1] < target_distance
        ):
            source_index += 1
        left_distance = source_distances[source_index]
        right_distance = source_distances[source_index + 1]
        left_coord = coordinates[source_index]
        right_coord = coordinates[source_index + 1]
        if right_distance == left_distance:
            sampled_coordinates.append(list(left_coord))
            continue
        fraction = (target_distance - left_distance) / (right_distance - left_distance)
        sampled_coordinates.append(interpolate_coordinate(left_coord, right_coord, fraction))

    return sampled_coordinates, sample_distances


def thin_path_coordinates(
    coordinates: list[list[float]],
    *,
    min_point_spacing_m: float = 25.0,
    max_points: int = 180,
) -> list[list[float]]:
    if len(coordinates) <= 2:
        return [list(coord) for coord in coordinates]

    thinned = [list(coordinates[0])]
    last_kept = coordinates[0]
    for coordinate in coordinates[1:-1]:
        if (
            haversine_meters(
                last_kept[0],
                last_kept[1],
                coordinate[0],
                coordinate[1],
            )
            >= min_point_spacing_m
        ):
            thinned.append(list(coordinate))
            last_kept = coordinate
    thinned.append(list(coordinates[-1]))

    if len(thinned) <= max_points:
        return thinned

    stride = max(1, math.ceil((len(thinned) - 1) / (max_points - 1)))
    reduced = [thinned[0]]
    index = stride
    while index < len(thinned) - 1:
        reduced.append(thinned[index])
        index += stride
    reduced.append(thinned[-1])
    return reduced


def interpolate_values(
    source_distances: list[float],
    source_values: list[float],
    target_distances: list[float],
) -> list[float]:
    if not source_distances or not source_values:
        return []
    if len(source_distances) == 1:
        return [float(source_values[0]) for _ in target_distances]

    output: list[float] = []
    source_index = 0
    for target_distance in target_distances:
        while (
            source_index < len(source_distances) - 2
            and source_distances[source_index + 1] < target_distance
        ):
            source_index += 1
        left_distance = source_distances[source_index]
        right_distance = source_distances[source_index + 1]
        left_value = source_values[source_index]
        right_value = source_values[source_index + 1]
        if right_distance == left_distance:
            output.append(float(left_value))
            continue
        fraction = (target_distance - left_distance) / (right_distance - left_distance)
        output.append(left_value + (right_value - left_value) * fraction)
    return output


def moving_average(values: list[float], window: int) -> list[float]:
    if window <= 1 or len(values) <= 2:
        return [float(value) for value in values]
    radius = max(0, window // 2)
    smoothed: list[float] = []
    for index in range(len(values)):
        left = max(0, index - radius)
        right = min(len(values), index + radius + 1)
        sample = values[left:right]
        smoothed.append(sum(sample) / len(sample))
    return smoothed


def fill_missing_values(values: list[float | None]) -> list[float]:
    known = [index for index, value in enumerate(values) if value is not None]
    if not known:
        raise ValueError("No elevation values available")
    filled = [0.0 if value is None else float(value) for value in values]
    first_known = known[0]
    for index in range(0, first_known):
        filled[index] = filled[first_known]
    last_known = known[-1]
    for index in range(last_known + 1, len(filled)):
        filled[index] = filled[last_known]
    for left, right in zip(known, known[1:]):
        if right == left + 1:
            continue
        left_value = filled[left]
        right_value = filled[right]
        span = right - left
        for offset in range(1, span):
            fraction = offset / span
            filled[left + offset] = left_value + (right_value - left_value) * fraction
    return filled


def compute_gain_loss(values: list[float], min_step_m: float) -> tuple[float, float]:
    gain = 0.0
    loss = 0.0
    for previous, current in zip(values, values[1:]):
        delta = current - previous
        if abs(delta) < min_step_m:
            continue
        if delta > 0:
            gain += delta
        else:
            loss += -delta
    return gain, loss


class OpenMeteoElevationClient:
    """Small cached client for Open-Meteo's elevation endpoint."""

    def __init__(
        self,
        *,
        api_url: str = OPEN_METEO_ELEVATION_URL,
        cache_path: Path | None = None,
        batch_size: int = 100,
        user_agent: str = "the-dark-side-elevation/1.0",
    ) -> None:
        self.api_url = api_url
        self.cache_path = cache_path
        self.batch_size = batch_size
        self.user_agent = user_agent
        self.cache: dict[str, float] = {}
        if cache_path and cache_path.exists():
            self.cache = {
                str(key): float(value)
                for key, value in json.loads(cache_path.read_text()).items()
            }

    @staticmethod
    def cache_key(lon: float, lat: float) -> str:
        return f"{lat:.6f},{lon:.6f}"

    def persist_cache(self) -> None:
        if not self.cache_path:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(json.dumps(self.cache, indent=2, sort_keys=True) + "\n")

    def fetch_batch(self, points: list[list[float]]) -> list[float | None]:
        latitudes = ",".join(f"{lat:.6f}" for lon, lat in points)
        longitudes = ",".join(f"{lon:.6f}" for lon, lat in points)
        url = f"{self.api_url}?{urllib.parse.urlencode({'latitude': latitudes, 'longitude': longitudes})}"
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
        elevations = payload.get("elevation")
        if not isinstance(elevations, list) or len(elevations) != len(points):
            raise RuntimeError(f"Unexpected elevation response payload: {payload}")
        return [None if value is None else float(value) for value in elevations]

    def get_elevations(self, points: list[list[float]]) -> list[float | None]:
        output: list[float | None] = []
        missing: list[list[float]] = []
        missing_keys: list[str] = []
        for lon, lat in points:
            key = self.cache_key(lon, lat)
            if key in self.cache:
                output.append(self.cache[key])
            else:
                output.append(None)
                missing.append([lon, lat])
                missing_keys.append(key)

        if not missing:
            return output

        resolved: dict[str, float | None] = {}
        for start in range(0, len(missing), self.batch_size):
            batch_points = missing[start : start + self.batch_size]
            batch_keys = missing_keys[start : start + self.batch_size]
            batch_elevations = self.fetch_batch(batch_points)
            for key, elevation in zip(batch_keys, batch_elevations):
                if elevation is not None:
                    self.cache[key] = elevation
                resolved[key] = elevation
        self.persist_cache()

        final: list[float | None] = []
        for lon, lat in points:
            key = self.cache_key(lon, lat)
            if key in self.cache:
                final.append(self.cache[key])
            else:
                final.append(resolved.get(key))
        return final


def encode_polyline(coordinates: list[list[float]]) -> str:
    result: list[str] = []
    last_lat = 0
    last_lon = 0
    for lon, lat in coordinates:
        lat_value = int(round(lat * 1e5))
        lon_value = int(round(lon * 1e5))
        for value in (lat_value - last_lat, lon_value - last_lon):
            shifted = value << 1
            if value < 0:
                shifted = ~shifted
            while shifted >= 0x20:
                result.append(chr((0x20 | (shifted & 0x1F)) + 63))
                shifted >>= 5
            result.append(chr(shifted + 63))
        last_lat = lat_value
        last_lon = lon_value
    return "".join(result)


class OpenTopoDataElevationClient:
    """Route-profile client for Open Topo Data's public elevation API."""

    def __init__(
        self,
        *,
        api_url: str = OPEN_TOPO_DATA_URL,
        cache_path: Path | None = None,
        min_interval_seconds: float = 1.1,
        min_point_spacing_m: float = 25.0,
        max_path_points: int = 100,
        max_samples: int = 100,
        user_agent: str = "the-dark-side-elevation/1.0",
    ) -> None:
        self.api_url = api_url
        self.cache_path = cache_path
        self.min_interval_seconds = min_interval_seconds
        self.min_point_spacing_m = min_point_spacing_m
        self.max_path_points = max_path_points
        self.max_samples = max_samples
        self.user_agent = user_agent
        self.last_request_time = 0.0
        self.cache: dict[str, list[float]] = {}
        if cache_path and cache_path.exists():
            self.cache = {
                str(key): [float(value) for value in values]
                for key, values in json.loads(cache_path.read_text()).items()
            }

    def persist_cache(self) -> None:
        if not self.cache_path:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(json.dumps(self.cache, indent=2, sort_keys=True) + "\n")

    @staticmethod
    def cache_key(encoded_polyline: str, sample_count: int) -> str:
        return sha1(f"{sample_count}:{encoded_polyline}".encode("utf-8")).hexdigest()

    def throttle(self) -> None:
        elapsed = time.monotonic() - self.last_request_time
        if elapsed < self.min_interval_seconds:
            time.sleep(self.min_interval_seconds - elapsed)

    def sample_path_profile(
        self,
        coordinates: list[list[float]],
        sample_count: int,
    ) -> list[float]:
        sample_count = max(2, min(self.max_samples, sample_count))
        thinned_coordinates = thin_path_coordinates(
            coordinates,
            min_point_spacing_m=self.min_point_spacing_m,
            max_points=self.max_path_points,
        )
        locations = "|".join(f"{lat:.6f},{lon:.6f}" for lon, lat in thinned_coordinates)
        key = self.cache_key(locations, sample_count)
        if key in self.cache:
            return list(self.cache[key])

        payload = {
            "locations": locations,
            "samples": str(sample_count),
            "interpolation": "bilinear",
        }
        body = json.dumps(payload).encode("utf-8")

        attempt = 0
        while True:
            attempt += 1
            self.throttle()
            request = urllib.request.Request(
                self.api_url,
                data=body,
                headers={
                    "User-Agent": self.user_agent,
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                self.last_request_time = time.monotonic()
                break
            except urllib.error.HTTPError as error:
                self.last_request_time = time.monotonic()
                if error.code != 429 or attempt >= 5:
                    raise
                retry_after = float(error.headers.get("Retry-After", self.min_interval_seconds * attempt))
                time.sleep(max(self.min_interval_seconds, retry_after))

        if payload.get("status") != "OK":
            raise RuntimeError(f"Unexpected Open Topo Data response: {payload}")

        elevations = [
            None if item.get("elevation") is None else float(item["elevation"])
            for item in payload.get("results", [])
        ]
        if len(elevations) != sample_count:
            raise RuntimeError(
                f"Expected {sample_count} elevation samples, got {len(elevations)}"
            )
        filled = fill_missing_values(elevations)
        self.cache[key] = filled
        self.persist_cache()
        return list(filled)

    def get_elevations(self, points: list[list[float]]) -> list[float | None]:
        output: list[float | None] = []
        missing_points: list[list[float]] = []
        missing_indexes: list[int] = []
        for index, (lon, lat) in enumerate(points):
            key = self.cache_key(f"{lat:.6f},{lon:.6f}", 1)
            if key in self.cache:
                output.append(float(self.cache[key][0]))
            else:
                output.append(None)
                missing_points.append([lon, lat])
                missing_indexes.append(index)

        for start in range(0, len(missing_points), self.max_path_points):
            batch_points = missing_points[start : start + self.max_path_points]
            locations = "|".join(f"{lat:.6f},{lon:.6f}" for lon, lat in batch_points)
            body = json.dumps({"locations": locations}).encode("utf-8")

            attempt = 0
            while True:
                attempt += 1
                self.throttle()
                request = urllib.request.Request(
                    self.api_url,
                    data=body,
                    headers={
                        "User-Agent": self.user_agent,
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(request, timeout=60) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                    self.last_request_time = time.monotonic()
                    break
                except urllib.error.HTTPError as error:
                    self.last_request_time = time.monotonic()
                    if error.code != 429 or attempt >= 5:
                        raise
                    retry_after = float(error.headers.get("Retry-After", self.min_interval_seconds * attempt))
                    time.sleep(max(self.min_interval_seconds, retry_after))

            if payload.get("status") != "OK":
                raise RuntimeError(f"Unexpected Open Topo Data response: {payload}")

            results = payload.get("results", [])
            if len(results) != len(batch_points):
                raise RuntimeError(
                    f"Expected {len(batch_points)} elevation results, got {len(results)}"
                )

            for offset, item in enumerate(results):
                elevation = item.get("elevation")
                result_index = missing_indexes[start + offset]
                lon, lat = batch_points[offset]
                key = self.cache_key(f"{lat:.6f},{lon:.6f}", 1)
                if elevation is not None:
                    self.cache[key] = [float(elevation)]
                    output[result_index] = float(elevation)
                else:
                    output[result_index] = None

        self.persist_cache()
        return output


def summarize_elevation_series(
    coordinates: list[list[float]],
    elevations_m: list[float],
    *,
    smoothing_window: int = 3,
    min_step_m: float = 0.5,
    profile_spacing_m: float = 60.0,
) -> dict:
    route_distances = cumulative_distances(coordinates)
    smoothed = moving_average(elevations_m, smoothing_window)
    gain_m, loss_m = compute_gain_loss(smoothed, min_step_m=min_step_m)

    profile_coordinates, profile_distances = resample_coordinates(
        coordinates,
        spacing_m=profile_spacing_m,
    )
    profile_elevations = interpolate_values(route_distances, smoothed, profile_distances)

    return {
        "elevations_m": [round(value, 1) for value in smoothed],
        "elevation_gain_m": round(gain_m, 1),
        "elevation_loss_m": round(loss_m, 1),
        "elevation_min_m": round(min(smoothed), 1),
        "elevation_max_m": round(max(smoothed), 1),
        "elevation_profile": [
            [round(distance_m, 1), round(elevation_m, 1)]
            for distance_m, elevation_m in zip(profile_distances, profile_elevations)
        ],
    }


def annotate_route_geometry(
    coordinates: list[list[float]],
    *,
    provider,
    sample_spacing_m: float = 40.0,
    smoothing_window: int = 5,
    min_step_m: float = 1.5,
    profile_spacing_m: float | None = None,
) -> dict:
    route_distances = cumulative_distances(coordinates)
    total_distance = route_distances[-1] if route_distances else 0.0
    sampled_coordinates, sampled_distances = resample_coordinates(
        coordinates,
        spacing_m=sample_spacing_m,
    )
    sample_count = max(2, len(sampled_distances)) if total_distance > 0 else 1
    if hasattr(provider, "sample_path_profile"):
        sampled_elevations = provider.sample_path_profile(coordinates, sample_count)
        if total_distance == 0:
            sampled_distances = [0.0] * len(sampled_elevations)
        else:
            sampled_distances = [
                total_distance * index / max(1, len(sampled_elevations) - 1)
                for index in range(len(sampled_elevations))
            ]
    else:
        sampled_elevations = fill_missing_values(provider.get_elevations(sampled_coordinates))
    smoothed_sampled = moving_average(sampled_elevations, smoothing_window)
    route_elevations = interpolate_values(sampled_distances, smoothed_sampled, route_distances)
    gain_m, loss_m = compute_gain_loss(route_elevations, min_step_m=min_step_m)

    profile_coordinates, profile_distances = sampled_coordinates, sampled_distances
    profile_elevations = smoothed_sampled
    if profile_spacing_m and profile_spacing_m > 0 and profile_spacing_m != sample_spacing_m:
        profile_coordinates, profile_distances = resample_coordinates(
            coordinates,
            spacing_m=profile_spacing_m,
        )
        profile_elevations = interpolate_values(
            sampled_distances,
            smoothed_sampled,
            profile_distances,
        )

    return {
        "elevations_m": [round(value, 1) for value in route_elevations],
        "elevation_gain_m": round(gain_m, 1),
        "elevation_loss_m": round(loss_m, 1),
        "elevation_min_m": round(min(route_elevations), 1),
        "elevation_max_m": round(max(route_elevations), 1),
        "elevation_profile": [
            [round(distance_m, 1), round(elevation_m, 1)]
            for distance_m, elevation_m in zip(profile_distances, profile_elevations)
        ],
    }
