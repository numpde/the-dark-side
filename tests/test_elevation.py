from __future__ import annotations

import unittest

from the_dark_side.elevation import (
    annotate_route_geometry,
    cumulative_distances,
    fill_missing_values,
    resample_coordinates,
)


class StubElevationProvider:
    def get_elevations(self, points: list[list[float]]):
        return [(lon - 36.0) * 10000.0 for lon, lat in points]


class ElevationPipelineTest(unittest.TestCase):
    def test_cumulative_distances_grow_along_route(self) -> None:
        coordinates = [
            [36.0, -1.0],
            [36.001, -1.0],
            [36.002, -1.0],
        ]
        distances = cumulative_distances(coordinates)
        self.assertEqual(len(distances), 3)
        self.assertEqual(distances[0], 0.0)
        self.assertGreater(distances[1], 100.0)
        self.assertGreater(distances[2], distances[1])

    def test_resample_coordinates_keeps_endpoints(self) -> None:
        coordinates = [
            [36.0, -1.0],
            [36.002, -1.0],
        ]
        sampled_coordinates, sampled_distances = resample_coordinates(coordinates, spacing_m=50.0)
        self.assertEqual(sampled_coordinates[0], coordinates[0])
        self.assertEqual(sampled_coordinates[-1], coordinates[-1])
        self.assertEqual(sampled_distances[0], 0.0)
        self.assertGreater(len(sampled_coordinates), 2)

    def test_fill_missing_values_interpolates(self) -> None:
        values = fill_missing_values([100.0, None, None, 112.0])
        self.assertEqual(values[0], 100.0)
        self.assertAlmostEqual(values[1], 104.0)
        self.assertAlmostEqual(values[2], 108.0)
        self.assertEqual(values[3], 112.0)

    def test_annotate_route_geometry_produces_gain_loss(self) -> None:
        coordinates = [
            [36.0, -1.0],
            [36.001, -1.0],
            [36.002, -1.0],
        ]
        enriched = annotate_route_geometry(
            coordinates,
            provider=StubElevationProvider(),
            sample_spacing_m=40.0,
            profile_spacing_m=60.0,
            smoothing_window=1,
            min_step_m=0.1,
        )
        self.assertEqual(len(enriched["elevations_m"]), len(coordinates))
        self.assertGreater(enriched["elevation_gain_m"], 0.0)
        self.assertEqual(enriched["elevation_loss_m"], 0.0)
        self.assertGreaterEqual(enriched["elevation_max_m"], enriched["elevation_min_m"])
        self.assertGreater(len(enriched["elevation_profile"]), 1)


if __name__ == "__main__":
    unittest.main()
