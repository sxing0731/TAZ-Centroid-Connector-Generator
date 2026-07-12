"""Geometry creation and nearest-node operations."""

from __future__ import annotations

import math
from typing import Callable

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, Point, Polygon
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
        {"N": taz[config.fields.taz_id].to_numpy()},
        geometry=taz.geometry.representative_point(),
        crs=taz.crs,
    )


def _point_at_bearing(origin: Point, angle_degrees: float, distance: float) -> Point:
    angle = math.radians(angle_degrees)
    return Point(
        origin.x + distance * math.sin(angle),
        origin.y + distance * math.cos(angle),
    )


def _collect_points(geometry) -> list[Point]:
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Point":
        return [geometry]
    if geometry.geom_type == "MultiPoint":
        return list(geometry.geoms)
    if geometry.geom_type in {"LineString", "LinearRing"}:
        return [Point(coordinate) for coordinate in geometry.coords]
    if hasattr(geometry, "geoms"):
        points: list[Point] = []
        for part in geometry.geoms:
            points.extend(_collect_points(part))
        return points
    return []


def _ray_boundary_point(origin: Point, polygon, angle_degrees: float, radius: float) -> Point:
    endpoint = _point_at_bearing(origin, angle_degrees, radius)
    ray = LineString([origin, endpoint])
    points = _collect_points(ray.intersection(polygon.boundary))
    if not points:
        return endpoint
    return max(points, key=lambda point: origin.distance(point))


def _sector_polygon(origin: Point, start_angle: float, end_angle: float, radius: float) -> Polygon:
    span = end_angle - start_angle
    steps = max(4, int(math.ceil(span / 5.0)))
    arc = [
        _point_at_bearing(origin, start_angle + span * index / steps, radius)
        for index in range(steps + 1)
    ]
    return Polygon([origin, *arc, origin])


def _covering_radius(origin: Point, geometry) -> float:
    minx, miny, maxx, maxy = geometry.bounds
    corners = [
        Point(minx, miny),
        Point(minx, maxy),
        Point(maxx, miny),
        Point(maxx, maxy),
    ]
    return max(origin.distance(corner) for corner in corners) * 1.05


def generate_sector_candidates(
    taz: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> gpd.GeoDataFrame:
    """Create equally spaced angular sector candidates around each centroid."""
    records: list[dict[str, object]] = []
    taz_id_field = config.fields.taz_id
    centroid_lookup = centroids.set_index("N").geometry

    for _, row in taz.iterrows():
        taz_id = row[taz_id_field]
        center = centroid_lookup.loc[taz_id]
        radius = _covering_radius(center, row.geometry)
        sector_width = 360.0 / config.sector_count
        for sequence in range(1, config.sector_count + 1):
            start_angle = (sequence - 1) * sector_width
            end_angle = sequence * sector_width
            angle = (start_angle + end_angle) / 2.0
            point = _ray_boundary_point(center, row.geometry, angle, radius)
            sector = _sector_polygon(center, start_angle, end_angle, radius).intersection(
                row.geometry
            )
            if sector.is_empty or sector.area <= 0:
                log(f"TAZ {taz_id} sector {sequence}: clipped sector is empty.", 30)
            records.append(
                {
                    "N": taz_id,
                    "CC_PT": f"{taz_id}_S{sequence}",
                    "SECTOR_ID": sequence,
                    "ANGLE_DEG": angle % 360.0,
                    "ANGLE_START": start_angle % 360.0,
                    "ANGLE_END": end_angle % 360.0,
                    "SECTOR_AREA": float(sector.area),
                    "SECTOR_GEOM": sector,
                    "geometry": point,
                }
            )

    return gpd.GeoDataFrame(records, geometry="geometry", crs=taz.crs)


def create_sector_buffers(
    candidates: gpd.GeoDataFrame,
    log: LogFn,
) -> gpd.GeoDataFrame:
    """Use clipped sector polygons as density zones."""
    records: list[dict[str, object]] = []
    for _, row in candidates.iterrows():
        sector = row["SECTOR_GEOM"]
        if sector.is_empty or sector.area <= 0:
            log(f"Candidate {row['CC_PT']}: clipped sector is empty.", 30)
        records.append(
            {
                "N": row["N"],
                "CC_PT": row["CC_PT"],
                "SECTOR_ID": row["SECTOR_ID"],
                "ANGLE_DEG": row["ANGLE_DEG"],
                "BUFFER_AREA": float(sector.area),
                "geometry": sector,
            }
        )
    return gpd.GeoDataFrame(records, geometry="geometry", crs=candidates.crs)


def bearing_degrees(origin: Point, destination: Point) -> float:
    """Return a clockwise bearing in degrees, measured from north."""
    dx = destination.x - origin.x
    dy = destination.y - origin.y
    return float((math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0)


def _angle_in_sector(angle: float, start: float, end: float) -> bool:
    angle = angle % 360.0
    start = start % 360.0
    end = end % 360.0
    if math.isclose(start, end):
        return True
    if start < end:
        return start <= angle < end
    return angle >= start or angle < end


def _snap_level_allowed(level: object, config: ProcessingConfig) -> bool:
    """Only minor/intersection levels above the blocked threshold can be snapped."""
    return pd.notna(level) and int(level) > config.blocked_major_level


def attach_node_major_levels(
    nodes: gpd.GeoDataFrame,
    gstdm_links: gpd.GeoDataFrame,
    config: ProcessingConfig,
) -> gpd.GeoDataFrame:
    """Attach each node's highest GSTDM link class as MAJOR_LEVEL.

    GSTDM/HERE functional classes use smaller numeric values for more major
    facilities, so links with classes 1, 3, and 5 produce MAJOR_LEVEL = 1.
    """
    fields = config.fields
    level_lookup: dict[object, int] = {}
    func_classes = pd.to_numeric(
        gstdm_links[fields.link_func_class],
        errors="coerce",
    )

    for row, func_class in zip(gstdm_links.itertuples(index=False), func_classes):
        if pd.isna(func_class):
            continue
        level = int(func_class)
        for field in (fields.link_from_node, fields.link_to_node):
            node_id = getattr(row, field)
            if pd.isna(node_id):
                continue
            existing = level_lookup.get(node_id)
            level_lookup[node_id] = level if existing is None else min(existing, level)

    result = nodes.copy()
    result["MAJOR_LEVEL"] = result[fields.node_id].map(level_lookup)
    result["MAJOR_INT"] = result["MAJOR_LEVEL"].map(
        lambda level: "Y" if pd.notna(level) and int(level) <= 3 else "N"
    )
    return result


def match_candidates_to_nodes(
    candidates: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
    taz: gpd.GeoDataFrame,
    nodes: gpd.GeoDataFrame,
    config: ProcessingConfig,
) -> gpd.GeoDataFrame:
    """Match each candidate direction to the nearest allowed GSTDM node.

    A node is eligible only when it is above the blocked major level, within
    the candidate sector, and within the configured distance from the parent
    TAZ boundary.
    """
    centroid_lookup = centroids.set_index("N").geometry
    polygon_lookup = taz.set_index(config.fields.taz_id).geometry
    node_geometries = list(nodes.geometry)
    major_levels = nodes["MAJOR_LEVEL"].tolist() if "MAJOR_LEVEL" in nodes.columns else [None] * len(nodes)
    major_ints = (
        nodes["MAJOR_INT"].tolist()
        if "MAJOR_INT" in nodes.columns
        else ["Y" if pd.notna(level) and int(level) <= 3 else "N" for level in major_levels]
    )
    node_tree = STRtree(node_geometries) if node_geometries else None
    matched_node_indices: list[int] = []
    matched_candidate_distances: list[float] = []
    matched_line_distances: list[float] = []
    matched_boundary_distances: list[float] = []
    matched_major_levels: list[int | None] = []
    matched_major_ints: list[str] = []
    snap_allowed: list[bool] = []
    fail_reasons: list[str] = []

    def level_is_allowed(index: int) -> bool:
        return _snap_level_allowed(major_levels[index], config)

    def append_no_match(reason: str) -> None:
        matched_node_indices.append(-1)
        matched_candidate_distances.append(float("inf"))
        matched_line_distances.append(float("inf"))
        matched_boundary_distances.append(float("inf"))
        matched_major_levels.append(None)
        matched_major_ints.append("N")
        snap_allowed.append(False)
        fail_reasons.append(reason)

    for taz_id, group in candidates.groupby("N", sort=False):
        if node_tree is None:
            for _ in group.itertuples():
                append_no_match("NO_GSTDM_NODE")
            continue

        polygon = polygon_lookup.loc[taz_id]
        boundary = polygon.boundary
        query_zone = boundary.buffer(config.boundary_endpoint_tolerance)
        nearby_indices = [
            int(index)
            for index in node_tree.query(query_zone, predicate="intersects")
        ]
        nearby_allowed: list[tuple[int, float]] = []
        for index in nearby_indices:
            if not level_is_allowed(index):
                continue
            boundary_distance = float(node_geometries[index].distance(boundary))
            if boundary_distance <= config.boundary_endpoint_tolerance:
                nearby_allowed.append((index, boundary_distance))

        if not nearby_allowed:
            for _ in group.itertuples():
                append_no_match("NO_ALLOWED_NODE_WITHIN_BOUNDARY_TOLERANCE")
            continue

        for row in group.itertuples():
            center = centroid_lookup.loc[row.N]
            radial_line = LineString([center, row.geometry])
            start = getattr(row, "ANGLE_START", None)
            end = getattr(row, "ANGLE_END", None)
            best: tuple[float, float, float, int] | None = None
            for index, boundary_distance in nearby_allowed:
                node_geometry = node_geometries[index]
                node_angle = bearing_degrees(center, node_geometry)
                if start is not None and end is not None and not _angle_in_sector(
                    node_angle, float(start), float(end)
                ):
                    continue
                line_distance = float(radial_line.distance(node_geometry))
                candidate_distance = float(row.geometry.distance(node_geometry))
                if (
                    config.maximum_snap_distance is not None
                    and candidate_distance > config.maximum_snap_distance
                ):
                    continue
                key = (line_distance, candidate_distance, boundary_distance, index)
                if best is None or key < best:
                    best = key
            if best is None:
                append_no_match("NO_ALLOWED_NODE_IN_SECTOR_WITHIN_BOUNDARY_TOLERANCE")
                continue
            line_distance, candidate_distance, boundary_distance, node_index = best
            matched_node_indices.append(node_index)
            matched_candidate_distances.append(candidate_distance)
            matched_line_distances.append(line_distance)
            matched_boundary_distances.append(boundary_distance)
            matched_major_levels.append(major_levels[node_index])
            matched_major_ints.append(major_ints[node_index])
            snap_allowed.append(True)
            fail_reasons.append("")

    result = candidates.copy()
    result["MATCH_NODE_IDX"] = matched_node_indices
    result["NEAR_DIST"] = matched_candidate_distances
    result["LINE_NODE_DIST"] = matched_line_distances
    result["MATCH_BND_DIST"] = matched_boundary_distances
    result["MAJOR_LEVEL"] = matched_major_levels
    result["MAJOR_INT"] = matched_major_ints
    result["SNAP_ALLOWED"] = snap_allowed
    result["SNAP_FAIL_REASON"] = fail_reasons
    return result


def create_candidate_lines(
    candidates: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    centroid_lookup = centroids.set_index("N").geometry
    result = candidates.drop(columns="geometry").copy()
    result["geometry"] = [
        LineString([centroid_lookup.loc[row.N], row.geometry])
        for row in candidates.itertuples()
    ]
    return gpd.GeoDataFrame(result, geometry="geometry", crs=candidates.crs)


def snap_candidates_to_nodes(
    selected: gpd.GeoDataFrame,
    nodes: gpd.GeoDataFrame,
    taz: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """Snap selected boundary points to nearest nodes using an STRtree."""
    node_geometries = list(nodes.geometry)
    tree = STRtree(node_geometries)
    node_ids = nodes[config.fields.node_id].tolist()
    major_levels = nodes["MAJOR_LEVEL"].tolist() if "MAJOR_LEVEL" in nodes.columns else [None] * len(nodes)
    major_ints = (
        nodes["MAJOR_INT"].tolist()
        if "MAJOR_INT" in nodes.columns
        else ["Y" if pd.notna(level) and int(level) <= 3 else "N" for level in major_levels]
    )
    polygon_lookup = taz.set_index(config.fields.taz_id).geometry
    point_records: list[dict[str, object]] = []
    line_records: list[dict[str, object]] = []

    for row in selected.itertuples():
        nearest_index = (
            int(row.MATCH_NODE_IDX)
            if hasattr(row, "MATCH_NODE_IDX")
            else int(tree.nearest(row.geometry))
        )
        if nearest_index < 0:
            log(
                f"Candidate {row.CC_PT}: no GSTDM node has MAJOR_LEVEL > "
                f"{config.blocked_major_level}.",
                30,
            )
            continue
        major_level = major_levels[nearest_index] if nearest_index >= 0 else None
        major_int = major_ints[nearest_index] if nearest_index >= 0 else "N"
        level_allowed = _snap_level_allowed(major_level, config)
        node_geometry = node_geometries[nearest_index]
        node = (
            node_geometry
            if node_geometry.geom_type == "Point"
            else nearest_points(row.geometry, node_geometry)[1]
        )
        distance = float(row.geometry.distance(node))
        match_allowed = bool(getattr(row, "SNAP_ALLOWED", level_allowed))
        snap_ok = (
            config.maximum_snap_distance is None
            or distance <= config.maximum_snap_distance
        ) and level_allowed and match_allowed
        polygon = polygon_lookup.loc[row.N]
        line = LineString([row.CENTROID_GEOM, node])
        outside_length = float(line.difference(polygon).length)
        boundary_distance = float(node.distance(polygon.boundary))
        common = {
            "N": row.N,
            "CC_PT": row.CC_PT,
            "SECTOR_ID": getattr(row, "SECTOR_ID", None),
            "CC_NODE": node_ids[nearest_index] if snap_ok else None,
            "DENSITY": row.DENSITY,
            "DENS_RANK": row.DENS_RANK,
            "ANGLE_DEG": row.ANGLE_DEG,
            "NEAR_DIST": distance,
            "SNAP_OK": bool(snap_ok),
            "LINE_NODE_DIST": row.LINE_NODE_DIST,
            "MATCH_BND_DIST": getattr(row, "MATCH_BND_DIST", boundary_distance),
            "MAJOR_LEVEL": major_level,
            "MAJOR_INT": major_int,
            "SNAP_ALLOWED": bool(level_allowed and match_allowed),
            "SNAP_FAIL_REASON": getattr(row, "SNAP_FAIL_REASON", ""),
            "END_BND_DIST": boundary_distance,
            "END_ON_BND": boundary_distance <= config.boundary_endpoint_tolerance,
            "CROSSES_TAZ": outside_length > 1e-6,
            "OUTSIDE_LEN": outside_length,
        }
        point_records.append({**common, "geometry": node})
        if snap_ok:
            line_records.append(
                {
                    **common,
                    "geometry": line,
                }
            )
        else:
            log(
                f"Candidate {row.CC_PT}: nearest node is {distance:.2f} ft away, "
                "beyond the maximum snap distance.",
                30,
            )

    columns = [
        "N", "CC_PT", "SECTOR_ID", "CC_NODE", "DENSITY", "DENS_RANK",
        "ANGLE_DEG", "NEAR_DIST", "SNAP_OK", "LINE_NODE_DIST",
        "MATCH_BND_DIST", "MAJOR_LEVEL", "MAJOR_INT", "SNAP_ALLOWED",
        "SNAP_FAIL_REASON", "END_BND_DIST", "END_ON_BND", "CROSSES_TAZ",
        "OUTSIDE_LEN", "geometry",
    ]
    snapped = gpd.GeoDataFrame(point_records, columns=columns, geometry="geometry", crs=nodes.crs)
    lines = gpd.GeoDataFrame(line_records, columns=columns, geometry="geometry", crs=nodes.crs)
    return snapped, lines


def attach_centroid_geometry(
    selected: gpd.GeoDataFrame,
    centroids: gpd.GeoDataFrame,
) -> gpd.GeoDataFrame:
    """Attach centroid geometry as a temporary non-active column."""
    lookup = centroids.set_index("N").geometry
    result = selected.copy()
    result["CENTROID_GEOM"] = result["N"].map(lookup)
    return result
