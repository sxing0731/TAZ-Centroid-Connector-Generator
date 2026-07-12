"""Road-density calculations."""

from __future__ import annotations

from typing import Callable

import geopandas as gpd
import numpy as np

LogFn = Callable[[str, int], None]


def calculate_road_density(
    buffers: gpd.GeoDataFrame,
    links: gpd.GeoDataFrame,
    log: LogFn,
) -> gpd.GeoDataFrame:
    """Calculate clipped road length / clipped buffer area using a spatial index."""
    spatial_index = links.sindex
    road_lengths: list[float] = []
    densities: list[float] = []

    for row in buffers.itertuples():
        area = float(row.BUFFER_AREA)
        if row.geometry.is_empty or area <= 0:
            road_lengths.append(0.0)
            densities.append(0.0)
            continue

        possible = list(spatial_index.query(row.geometry, predicate="intersects"))
        if possible:
            clipped = links.geometry.iloc[possible].intersection(row.geometry)
            road_length = float(clipped.length.sum())
        else:
            road_length = 0.0
        road_lengths.append(road_length)
        densities.append(road_length / area if area else 0.0)

    result = buffers.copy()
    result["ROAD_LENGTH"] = road_lengths
    result["DENSITY"] = np.nan_to_num(densities, nan=0.0, posinf=0.0, neginf=0.0)
    result["DENS_RANK"] = (
        result.groupby("N")["DENSITY"]
        .rank(method="first", ascending=False)
        .astype(int)
    )
    if (result["DENSITY"] == 0).any():
        count = int((result["DENSITY"] == 0).sum())
        log(f"{count} candidate buffers have zero road density.", 30)
    return result
