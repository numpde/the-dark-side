"""Shared route-catalog build configuration."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


DEFAULT_CATALOG_BUILD_CONFIG: dict[str, Any] = {
    "algorithms": ["mcts", "beam", "naive"],
    "seed_start": 1,
    "seed_end": 6,
    "candidate_limit_per_run": 2,
    "routes_per_scenario": 12,
    "selection_window": 36,
    "short_connector_max_length_m": 35.0,
    "max_overlap_m": 70.0,
    "max_steps": 256,
    "random_top_k": 4,
    "end_stop_probability": 0.7,
    "end_stop_unused_slack_m": 400.0,
    "end_finish_unused_slack_m": 250.0,
    "future_length_weight": 0.08,
    "connector_length_weight": 0.02,
    "overlap_penalty_per_m": 12.0,
    "articulation_penalty": 45.0,
    "articulation_future_threshold_m": 400.0,
    "dead_end_penalty": 180.0,
    "early_finish_penalty": 320.0,
    "rollout_trials": 250,
    "keep_best": 5,
    "beam_width": 80,
    "beam_branch_factor": 5,
    "beam_rounds": 200,
    "beam_selection_pool": 5,
    "beam_selection_window": 12,
    "mcts_iterations": 640,
    "mcts_exploration_weight": 1.0,
    "mcts_rollout_top_k": 3,
    "mcts_rollout_samples": 3,
    "mcts_prior_weight": 0.5,
    "mcts_loop_completion_bonus": 220.0,
    "mcts_loop_unused_penalty_per_m": 0.045,
    "mcts_loop_late_return_bonus": 180.0,
    "mcts_loop_overlap_penalty_per_m": 4.0,
    "elevation_profile_spacing_m": 60.0,
    "elevation_smoothing_window": 3,
    "elevation_min_step_m": 0.5,
}


def normalize_catalog_build_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    config = dict(DEFAULT_CATALOG_BUILD_CONFIG)
    if raw:
        config.update(raw)
    config["algorithms"] = [str(value) for value in config["algorithms"]]
    return config


def load_catalog_build_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"missing catalog build config: {path}")
    return normalize_catalog_build_config(json.loads(path.read_text()))


def catalog_build_config_digest(config: dict[str, Any]) -> str:
    normalized = json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(normalized).hexdigest()[:12]
