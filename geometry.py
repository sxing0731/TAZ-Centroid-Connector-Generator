"""Geometry creation and nearest-node operations."""

from __future__ import annotations

import math
from typing import Callable

import geopandas as gpd
import numpy as np
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points
from shapely.strtree import STRtree

from config import ProcessingConfig

LogFn = Callable[[str, int], None]


def create_interior_centroids(
    taz: gpd.GeoDataFrame,
    config: ProcessingConfig,
) -> gpd.GeoDataFrame:
    """Create one guaranteed-inside representative point per TAZ."""
    return gpd.GeoDataFrame(
        {"TAZ_N": taz[config.fields.taz_id].to_numpy()},
        geometry=taz.geometry.representative_point(),
        crs=taz.crs,
    )


def _boundary_sample_distances(
    boundary_length: float,
    config: ProcessingConfig,
) -> np.ndarray:
    required = max(config.target_connector_count * 4, 12)
    natural_count = max(1, int(math.ceil(boundary_length / config.boundary_spacing)))
    count = max(natural_count, required)
    if boundary_length <= 0:
        return np.array([], dtype=float)
    return np.linspace(0.0, boundary_length, num=count, endpoint=False)


def generate_boundary_candidates(
    taz: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> gpd.GeoDataFrame:
    """Sample each polygon boundary and assign stable candidate IDs."""
    records: list[dict[str, object]] = []
    taz_id_field = config.fields.taz_id
    centroid_lookup = centroids.set_index("TAZ_N").geometry

    for _, row in taz.iterrows():
        taz_id = row[taz_id_field]
        boundary = row.geometry.boundary
        distances = _boundary_sample_distances(boundary.length, config)
        if len(distances) < config.minimum_connector_count:
            log(f"TAZ {taz_id}: polygon boundary is too small for enough candidates.", 30)
        center = centroid_lookup.loc[taz_id]
        for sequence, distance in enumerate(distances, start=1):
            point = boundary.interpolate(float(distance))
            records.append(
                {
                    "TAZ_N": taz_id,
                    "CC_PT": f"{taz_id}_{sequence}",
                    "ANGLE_DEG": bearing_degrees(center, point),
                    "geometry": point,
                }
            )

    return gpd.GeoDataFrame(records, geometry="geometry", crs=taz.crs)


def create_candidate_buffers(
    candidates: gpd.GeoDataFrame,
    taz: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> gpd.GeoDataFrame:
    """Buffer each candidate and clip the buffer to its parent TAZ."""
    polygon_lookup = taz.set_index(config.fields.taz_id).geometry
    records: list[dict[str, object]] = []
    for _, row in candidates.iterrows():
        clipped = row.geometry.buffer(config.buffer_radius).intersection(
            polygon_lookup.loc[row["TAZ_N"]]
        )
        if clipped.is_empty or clipped.area <= 0:
            log(f"Candidate {row['CC_PT']}: clipped buffer is empty.", 30)
        records.append(
            {
                "TAZ_N": row["TAZ_N"],
                "CC_PT": row["CC_PT"],
                "BUFFER_AREA": float(clipped.area),
                "geometry": clipped,
            }
        )
    return gpd.GeoDataFrame(records, geometry="geometry", crs=taz.crs)


def bearing_degrees(origin: Point, destination: Point) -> float:
    """Return a clockwise bearing in degrees, measured from north."""
    dx = destination.x - origin.x
    dy = destination.y - origin.y
    return float((math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0)


def create_candidate_lines(
    candidates: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    centroid_lookup = centroids.set_index("TAZ_N").geometry
    result = candidates.drop(columns="geometry").copy()
    result["geometry"] = [
        LineString([centroid_lookup.loc[row.TAZ_N], row.geometry])
        for row in candidates.itertuples()
    ]
    return gpd.GeoDataFrame(result, geometry="geometry", crs=candidates.crs)


def snap_candidates_to_nodes(
    selected: gpd.GeoDataFrame,
    nodes: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """Snap selected boundary points to nearest nodes using an STRtree."""
    node_geometries = list(nodes.geometry)
    tree = STRtree(node_geometries)
    node_ids = nodes[config.fields.node_id].tolist()
    point_records: list[dict[str, object]] = []
    line_records: list[dict[str, object]] = []

    for row in selected.itertuples():
        nearest_index = int(tree.nearest(row.geometry))
        node_geometry = node_geometries[nearest_index]
        node = (
            node_geometry
            if node_geometry.geom_type == "Point"
            else nearest_points(row.geometry, node_geometry)[1]
        )
        distance = float(row.geometry.distance(node))
        snap_ok = (
            config.maximum_snap_distance is None
            or distance <= config.maximum_snap_distance
        )
        common = {
            "TAZ_N": row.TAZ_N,
            "CC_PT": row.CC_PT,
            "CC_NODE": node_ids[nearest_index] if snap_ok else None,
            "DENSITY": row.DENSITY,
            "DENS_RANK": row.DENS_RANK,
            "ANGLE_DEG": row.ANGLE_DEG,
            "NEAR_DIST": distance,
            "SNAP_OK": bool(snap_ok),
        }
        point_records.append({**common, "geometry": node})
        if snap_ok:
            line_records.append(
                {
                    **common,
                    "geometry": LineString([row.CENTROID_GEOM, node]),
                }
            )
        else:
            log(
                f"Candidate {row.CC_PT}: nearest node is {distance:.2f} ft away, "
                "beyond the maximum snap distance.",
                30,
            )

    columns = [
        "TAZ_N", "CC_PT", "CC_NODE", "DENSITY", "DENS_RANK",
        "ANGLE_DEG", "NEAR_DIST", "SNAP_OK", "geometry",
    ]
    snapped = gpd.GeoDataFrame(point_records, columns=columns, geometry="geometry", crs=nodes.crs)
    lines = gpd.GeoDataFrame(line_records, columns=columns, geometry="geometry", crs=nodes.crs)
    return snapped, lines


def attach_centroid_geometry(
    selected: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    """Attach centroid geometry as a temporary non-active column."""
    lookup = centroids.set_index("TAZ_N").geometry
    result = selected.copy()
    result["CENTROID_GEOM"] = result["TAZ_N"].map(lookup)
    return result
