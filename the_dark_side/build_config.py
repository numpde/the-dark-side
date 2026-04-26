"""Shared route-catalog and planner build configuration."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


DEBUG_CATALOG_KEYS = (
    "algorithms",
    "seed_start",
    "seed_end",
    "candidate_limit_per_run",
    "routes_per_scenario",
    "selection_window",
    "elevation_profile_spacing_m",
)

DEBUG_CATALOG_ARG_SPECS: tuple[tuple[str, str, type], ...] = (
    ("seed_start", "--seed-start", int),
    ("seed_end", "--seed-end", int),
    ("candidate_limit_per_run", "--candidate-limit-per-run", int),
    ("routes_per_scenario", "--routes-per-scenario", int),
    ("selection_window", "--selection-window", int),
    ("elevation_profile_spacing_m", "--elevation-profile-spacing-m", float),
)

PLANNER_KEYS = (
    "short_connector_max_length_m",
    "max_overlap_m",
    "max_steps",
    "random_top_k",
    "end_stop_probability",
    "end_stop_unused_slack_m",
    "end_finish_unused_slack_m",
    "future_length_weight",
    "connector_length_weight",
    "overlap_penalty_per_m",
    "articulation_penalty",
    "articulation_future_threshold_m",
    "dead_end_penalty",
    "early_finish_penalty",
    "rollout_trials",
    "keep_best",
    "beam_width",
    "beam_branch_factor",
    "beam_rounds",
    "beam_selection_pool",
    "beam_selection_window",
    "mcts_iterations",
    "mcts_exploration_weight",
    "mcts_rollout_top_k",
    "mcts_rollout_samples",
    "mcts_prior_weight",
    "mcts_loop_completion_bonus",
    "mcts_loop_unused_penalty_per_m",
    "mcts_loop_late_return_bonus",
    "mcts_loop_overlap_penalty_per_m",
    "elevation_smoothing_window",
    "elevation_min_step_m",
)

PLANNER_CONFIG_KEYS = (
    "short_connector_max_length_m",
    "max_overlap_m",
    "max_steps",
    "random_top_k",
    "end_stop_probability",
    "end_stop_unused_slack_m",
    "end_finish_unused_slack_m",
    "future_length_weight",
    "connector_length_weight",
    "overlap_penalty_per_m",
    "articulation_penalty",
    "articulation_future_threshold_m",
    "dead_end_penalty",
    "early_finish_penalty",
    "rollout_trials",
    "keep_best",
    "beam_width",
    "beam_branch_factor",
    "beam_rounds",
    "beam_selection_pool",
    "beam_selection_window",
    "mcts_iterations",
    "mcts_exploration_weight",
    "mcts_rollout_top_k",
    "mcts_rollout_samples",
    "mcts_prior_weight",
    "mcts_loop_completion_bonus",
    "mcts_loop_unused_penalty_per_m",
    "mcts_loop_late_return_bonus",
    "mcts_loop_overlap_penalty_per_m",
)

PLANNER_ARG_SPECS: tuple[tuple[str, str, type], ...] = (
    ("short_connector_max_length_m", "--short-connector-max-length-m", float),
    ("max_overlap_m", "--max-overlap-m", float),
    ("max_steps", "--max-steps", int),
    ("random_top_k", "--random-top-k", int),
    ("end_stop_probability", "--end-stop-probability", float),
    ("end_stop_unused_slack_m", "--end-stop-unused-slack-m", float),
    ("end_finish_unused_slack_m", "--end-finish-unused-slack-m", float),
    ("future_length_weight", "--future-length-weight", float),
    ("connector_length_weight", "--connector-length-weight", float),
    ("overlap_penalty_per_m", "--overlap-penalty-per-m", float),
    ("articulation_penalty", "--articulation-penalty", float),
    ("articulation_future_threshold_m", "--articulation-future-threshold-m", float),
    ("dead_end_penalty", "--dead-end-penalty", float),
    ("early_finish_penalty", "--early-finish-penalty", float),
    ("rollout_trials", "--rollout-trials", int),
    ("keep_best", "--keep-best", int),
    ("beam_width", "--beam-width", int),
    ("beam_branch_factor", "--beam-branch-factor", int),
    ("beam_rounds", "--beam-rounds", int),
    ("beam_selection_pool", "--beam-selection-pool", int),
    ("beam_selection_window", "--beam-selection-window", int),
    ("mcts_iterations", "--mcts-iterations", int),
    ("mcts_exploration_weight", "--mcts-exploration-weight", float),
    ("mcts_rollout_top_k", "--mcts-rollout-top-k", int),
    ("mcts_rollout_samples", "--mcts-rollout-samples", int),
    ("mcts_prior_weight", "--mcts-prior-weight", float),
    ("mcts_loop_completion_bonus", "--mcts-loop-completion-bonus", float),
    ("mcts_loop_unused_penalty_per_m", "--mcts-loop-unused-penalty-per-m", float),
    ("mcts_loop_late_return_bonus", "--mcts-loop-late-return-bonus", float),
    ("mcts_loop_overlap_penalty_per_m", "--mcts-loop-overlap-penalty-per-m", float),
)

BROWSER_RUNTIME_KEYS = (
    "browser_selection_pool",
    "browser_selection_window",
    "browser_mcts_iterations",
    "browser_mcts_rollout_top_k",
    "browser_mcts_rollout_samples",
    "browser_mcts_time_budget_ms",
    "browser_mcts_progress_interval_iterations",
)


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
    "browser_selection_pool": 5,
    "browser_selection_window": 12,
    "browser_mcts_iterations": 320,
    "browser_mcts_rollout_top_k": 3,
    "browser_mcts_rollout_samples": 2,
    "browser_mcts_time_budget_ms": 350.0,
    "browser_mcts_progress_interval_iterations": 24,
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

DEFAULT_CATALOG_BUILD_SOURCE: dict[str, Any] = {
    "debug_catalog": {
        key: DEFAULT_CATALOG_BUILD_CONFIG[key]
        for key in DEBUG_CATALOG_KEYS
    },
    "planner": {
        key: DEFAULT_CATALOG_BUILD_CONFIG[key]
        for key in PLANNER_KEYS
    },
    "browser_runtime": {
        key: DEFAULT_CATALOG_BUILD_CONFIG[key]
        for key in BROWSER_RUNTIME_KEYS
    },
}


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"catalog build config {label} must be an object")
    return value


def _flatten_catalog_build_source(raw: dict[str, Any]) -> dict[str, Any]:
    uses_sections = any(key in raw for key in ("debug_catalog", "planner", "browser_runtime"))
    if not uses_sections:
        return dict(raw)
    flat: dict[str, Any] = {}
    section_specs = (
        ("debug_catalog", DEBUG_CATALOG_KEYS),
        ("planner", PLANNER_KEYS),
        ("browser_runtime", BROWSER_RUNTIME_KEYS),
    )
    for section_name, keys in section_specs:
        section = _require_object(raw.get(section_name, {}), section_name)
        for key in keys:
            if key in section:
                flat[key] = section[key]
    unexpected_top_level = [
        key for key in raw
        if key not in {"debug_catalog", "planner", "browser_runtime"}
    ]
    if unexpected_top_level:
        raise ValueError(
            "catalog build config must not mix sectioned keys with flat keys; "
            f"unexpected top-level keys: {', '.join(sorted(unexpected_top_level))}"
        )
    return flat


def normalize_catalog_build_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    if raw is not None and (not isinstance(raw, dict) or isinstance(raw, list)):
        raise ValueError("catalog build config must be a JSON object")
    config = dict(DEFAULT_CATALOG_BUILD_CONFIG)
    if raw:
        config.update(_flatten_catalog_build_source(raw))
    algorithms = config["algorithms"]
    if not isinstance(algorithms, list) or not algorithms:
        raise ValueError("catalog build config algorithms must be a non-empty array")
    config["algorithms"] = [str(value) for value in algorithms]

    integer_fields = (
        "browser_selection_pool",
        "browser_selection_window",
        "browser_mcts_iterations",
        "browser_mcts_rollout_top_k",
        "browser_mcts_rollout_samples",
        "browser_mcts_progress_interval_iterations",
    )
    for field_name in integer_fields:
        value = config[field_name]
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"catalog build config {field_name} must be a positive integer")

    time_budget = config["browser_mcts_time_budget_ms"]
    if (
        isinstance(time_budget, bool)
        or not isinstance(time_budget, (int, float))
        or not math.isfinite(float(time_budget))
        or float(time_budget) <= 0
    ):
        raise ValueError("catalog build config browser_mcts_time_budget_ms must be a positive finite number")
    return config


def load_catalog_build_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"missing catalog build config: {path}")
    return normalize_catalog_build_config(json.loads(path.read_text()))


def resolve_build_config_defaults(
    argv: list[str] | None,
    *,
    default_path: Path,
) -> tuple[Path, dict[str, Any], list[str]]:
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--build-config-json", type=Path, default=default_path)
    pre_args, remaining = pre_parser.parse_known_args(argv)
    return pre_args.build_config_json, load_catalog_build_config(pre_args.build_config_json), remaining


def catalog_build_config_digest(config: dict[str, Any]) -> str:
    normalized = json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(normalized).hexdigest()[:12]


def add_planner_config_args(parser: argparse.ArgumentParser, defaults: dict[str, Any]) -> None:
    for field_name, flag, value_type in PLANNER_ARG_SPECS:
        parser.add_argument(flag, type=value_type, default=defaults[field_name])


def add_debug_catalog_args(parser: argparse.ArgumentParser, defaults: dict[str, Any]) -> None:
    for field_name, flag, value_type in DEBUG_CATALOG_ARG_SPECS:
        parser.add_argument(flag, type=value_type, default=defaults[field_name])


def planner_config_kwargs_from_namespace(args: argparse.Namespace) -> dict[str, Any]:
    return {field_name: getattr(args, field_name) for field_name in PLANNER_CONFIG_KEYS}


def catalog_build_kwargs_from_namespace(
    args: argparse.Namespace,
    *,
    include_browser_runtime: bool = False,
    keys: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    selected_keys = list(keys) if keys is not None else list(DEBUG_CATALOG_KEYS) + list(PLANNER_KEYS)
    if include_browser_runtime:
        selected_keys.extend(BROWSER_RUNTIME_KEYS)
    return {field_name: getattr(args, field_name) for field_name in selected_keys}
