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
    selected_indices: list[int] = []
    selected_angles: list[float] = []
    for index, row in ranked.iterrows():
        angle = float(row["ANGLE_DEG"])
        if all(
            angular_difference(angle, existing) >= angle_threshold
            for existing in selected_angles
        ):
            selected_indices.append(index)
            selected_angles.append(angle)
        if len(selected_indices) >= target:
            break
    return selected_indices


def select_connectors(
    candidates: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> gpd.GeoDataFrame:
    """Select high-density candidates while preserving angular separation."""
    selected_parts: list[gpd.GeoDataFrame] = []
    for taz_id, group in candidates.groupby("TAZ_N", sort=False):
        ranked = group.sort_values(["DENSITY", "CC_PT"], ascending=[False, True])
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
                f"{config.minimum_angle:g}° to {threshold:g}°.",
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

