"""Density and angular-separation candidate selection."""

from __future__ import annotations

from typing import Callable

import geopandas as gpd
import pandas as pd

from config import ProcessingConfig

LogFn = Callable[[str, int], None]


def angular_difference(first: float, second: float) -> float:
    difference = abs(first - second) % 360.0
    return min(difference, 360.0 - difference)


def _select_with_angle(
    ranked: gpd.GeoDataFrame,
    target: int,
    angle_threshold: float,
) -> list[int]:
    if ranked.empty:
        return []

    rank_position = {
        index: position for position, index in enumerate(ranked.index)
    }
    solutions: list[list[int]] = []
    for seed_index in ranked.index:
        selected_indices = [seed_index]
        selected_angles = [float(ranked.at[seed_index, "ANGLE_DEG"])]
        for index, row in ranked.iterrows():
            if index == seed_index:
                continue
            angle = float(row["ANGLE_DEG"])
            if all(
                angular_difference(angle, existing) >= angle_threshold
                for existing in selected_angles
            ):
                selected_indices.append(index)
                selected_angles.append(angle)
            if len(selected_indices) >= target:
                break
        solutions.append(selected_indices)

    return min(
        solutions,
        key=lambda indices: (
            -len(indices),
            sum(rank_position[index] for index in indices),
            tuple(rank_position[index] for index in indices),
        ),
    )


def select_connectors(
    candidates: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> gpd.GeoDataFrame:
    """Select high-density candidates while preserving angular separation."""
    selected_parts: list[gpd.GeoDataFrame] = []
    for taz_id, group in candidates.groupby("N", sort=False):
        group = group.copy()
        if "SNAP_ALLOWED" not in group:
            group["SNAP_ALLOWED"] = True
        eligible = group[group["SNAP_ALLOWED"].fillna(False).astype(bool)].copy()
        rejected_count = len(group) - len(eligible)
        if rejected_count:
            log(
                f"TAZ {taz_id}: excluded {rejected_count} candidates without a "
                "valid non-major node within the outside-TAZ and GSTDM-crossing limits.",
                20,
            )
        ranked = eligible.sort_values(
            ["DENSITY", "CC_PT"],
            ascending=[False, True],
        )
        threshold = config.minimum_angle
        indices = _select_with_angle(
            ranked, config.target_connector_count, threshold
        )
        while (
            len(indices) < config.minimum_connector_count
            and threshold > 0
        ):
            threshold = max(0.0, threshold - 5.0)
            indices = _select_with_angle(
                ranked, config.target_connector_count, threshold
            )
        if threshold < config.minimum_angle:
            log(
                f"TAZ {taz_id}: angle threshold relaxed from "
                f"{config.minimum_angle:g} deg to {threshold:g} deg.",
                30,
            )
        if len(indices) < config.minimum_connector_count:
            log(
                f"TAZ {taz_id}: only {len(indices)} connectors could be selected.",
                30,
            )
        chosen = ranked.loc[indices].copy()
        chosen["ANGLE_THRESHOLD"] = threshold
        selected_parts.append(chosen)

    if not selected_parts:
        return candidates.iloc[0:0].copy()
    return gpd.GeoDataFrame(
        pd.concat(selected_parts, ignore_index=True),
        geometry="geometry",
        crs=candidates.crs,
    )
