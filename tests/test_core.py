from __future__ import annotations

import logging

import geopandas as gpd
from shapely.geometry import LineString, Point, Polygon

from config import FieldMapping, ProcessingConfig
from density import calculate_road_density
from geometry import (
    attach_node_major_levels,
    create_sector_buffers,
    create_interior_centroids,
    generate_sector_candidates,
    match_candidates_to_nodes,
)
from selection import angular_difference, select_connectors


def silent_log(message: str, level: int = logging.INFO) -> None:
    pass


def test_representative_point_and_candidate_minimum() -> None:
    config = ProcessingConfig(sector_count=10, target_connector_count=4, minimum_connector_count=3)
    polygon = Polygon([(0, 0), (10000, 0), (10000, 10000), (0, 10000)])
    taz = gpd.GeoDataFrame({"N": [1]}, geometry=[polygon], crs="EPSG:2240")
    centroids = create_interior_centroids(taz, config)
    candidates = generate_sector_candidates(taz, centroids, config, silent_log)
    assert polygon.covers(centroids.geometry.iloc[0])
    assert len(candidates) == config.sector_count
    assert candidates["SECTOR_AREA"].gt(0).all()


def test_density_and_selection() -> None:
    config = ProcessingConfig(
        sector_count=10,
        target_connector_count=4,
        minimum_connector_count=3,
        minimum_angle=60,
    )
    polygon = Polygon([(0, 0), (10000, 0), (10000, 10000), (0, 10000)])
    taz = gpd.GeoDataFrame({"N": [1]}, geometry=[polygon], crs="EPSG:2240")
    links = gpd.GeoDataFrame(
        {"ID": [1, 2]},
        geometry=[
            LineString([(0, 1000), (10000, 1000)]),
            LineString([(5000, 0), (5000, 10000)]),
        ],
        crs=taz.crs,
    )
    centroids = create_interior_centroids(taz, config)
    candidates = generate_sector_candidates(taz, centroids, config, silent_log)
    buffers = create_sector_buffers(candidates, silent_log)
    scored_buffers = calculate_road_density(buffers, links, silent_log)
    scored = candidates.merge(
        scored_buffers[["CC_PT", "DENSITY", "DENS_RANK"]], on="CC_PT"
    )
    scored = gpd.GeoDataFrame(scored, geometry="geometry", crs=taz.crs)
    selected = select_connectors(scored, config, silent_log)
    assert len(selected) >= config.minimum_connector_count
    assert scored_buffers["DENS_RANK"].min() == 1
    assert scored_buffers["DENSITY"].max() > 0


def test_selection_uses_density_without_safety_rejection() -> None:
    candidates = gpd.GeoDataFrame(
        {
            "N": [1, 1, 1, 1],
            "CC_PT": ["low_1", "corner", "major", "low_2"],
            "ANGLE_DEG": [0.0, 90.0, 180.0, 200.0],
            "DENSITY": [1.0, 100.0, 90.0, 0.5],
        },
        geometry=[Point(0, 0), Point(1, 0), Point(2, 0), Point(3, 0)],
        crs="EPSG:2240",
    )
    config = ProcessingConfig(
        target_connector_count=5,
        minimum_connector_count=2,
        minimum_angle=60,
    )
    selected = select_connectors(candidates, config, silent_log)
    assert set(selected["CC_PT"]) == {"corner", "major", "low_1"}


def test_selection_finds_larger_angularly_separated_set() -> None:
    candidates = gpd.GeoDataFrame(
        {
            "N": [1] * 5,
            "CC_PT": ["a", "b", "c", "d", "e"],
            "ANGLE_DEG": [58.0, 103.0, 259.0, 275.0, 3.0],
            "DENSITY": [1.0] * 5,
        },
        geometry=[Point(i, 0) for i in range(5)],
        crs="EPSG:2240",
    )
    config = ProcessingConfig(
        target_connector_count=5,
        minimum_connector_count=2,
        minimum_angle=60,
    )
    selected = select_connectors(candidates, config, silent_log)
    assert len(selected) == 3
    assert set(selected["CC_PT"]) == {"b", "c", "e"}


def test_candidate_direction_matches_nearest_node_to_radial_line() -> None:
    taz = gpd.GeoDataFrame(
        {"N": [1]},
        geometry=[Polygon([(0, -100), (1000, -100), (1000, 100), (0, 100)])],
        crs="EPSG:2240",
    )
    centroids = gpd.GeoDataFrame({"N": [1]}, geometry=[Point(0, 0)], crs="EPSG:2240")
    candidates = gpd.GeoDataFrame(
        {
            "N": [1],
            "CC_PT": ["1_1"],
            "ANGLE_DEG": [90.0],
            "ANGLE_START": [45.0],
            "ANGLE_END": [135.0],
            "DENSITY": [1.0],
            "DENS_RANK": [1],
        },
        geometry=[Point(1000, 0)],
        crs=centroids.crs,
    )
    nodes = gpd.GeoDataFrame(
        {"NODE_ID": [10, 20], "MAJOR_LEVEL": [4, 4], "MAJOR_INT": ["N", "N"]},
        geometry=[Point(500, 25), Point(1000, 200)],
        crs=centroids.crs,
    )
    annotated = match_candidates_to_nodes(candidates, centroids, taz, nodes, ProcessingConfig())
    assert annotated["MATCH_NODE_IDX"].iloc[0] == 0
    assert annotated["LINE_NODE_DIST"].iloc[0] == 25.0


def test_candidate_direction_skips_level_one_and_two_snap_nodes() -> None:
    config = ProcessingConfig(blocked_major_level=2, snap_blocked_major_level=2)
    taz = gpd.GeoDataFrame(
        {"N": [1]},
        geometry=[Polygon([(0, -100), (1000, -100), (1000, 100), (0, 100)])],
        crs="EPSG:2240",
    )
    centroids = gpd.GeoDataFrame({"N": [1]}, geometry=[Point(0, 0)], crs="EPSG:2240")
    candidates = gpd.GeoDataFrame(
        {
            "N": [1],
            "CC_PT": ["1_1"],
            "ANGLE_DEG": [90.0],
            "ANGLE_START": [45.0],
            "ANGLE_END": [135.0],
            "DENSITY": [1.0],
            "DENS_RANK": [1],
        },
        geometry=[Point(1000, 0)],
        crs=centroids.crs,
    )
    nodes = gpd.GeoDataFrame(
        {"NODE_ID": [10, 20], "MAJOR_LEVEL": [1, 2]},
        geometry=[Point(500, 0), Point(700, 50)],
        crs=centroids.crs,
    )
    annotated = match_candidates_to_nodes(candidates, centroids, taz, nodes, config)
    assert annotated["MATCH_NODE_IDX"].iloc[0] == -1
    assert not annotated["SNAP_ALLOWED"].iloc[0]


def test_candidate_direction_allows_level_three_four_and_five_snap_nodes() -> None:
    config = ProcessingConfig(blocked_major_level=2, snap_blocked_major_level=2)
    taz = gpd.GeoDataFrame(
        {"N": [1]},
        geometry=[Polygon([(0, -100), (1000, -100), (1000, 100), (0, 100)])],
        crs="EPSG:2240",
    )
    centroids = gpd.GeoDataFrame({"N": [1]}, geometry=[Point(0, 0)], crs="EPSG:2240")
    candidates = gpd.GeoDataFrame(
        {
            "N": [1],
            "CC_PT": ["1_1"],
            "ANGLE_DEG": [90.0],
            "ANGLE_START": [45.0],
            "ANGLE_END": [135.0],
            "DENSITY": [1.0],
            "DENS_RANK": [1],
        },
        geometry=[Point(1000, 0)],
        crs=centroids.crs,
    )
    nodes = gpd.GeoDataFrame(
        {"NODE_ID": [10, 20, 30], "MAJOR_LEVEL": [3, 4, 5]},
        geometry=[Point(500, 0), Point(700, 50), Point(900, 60)],
        crs=centroids.crs,
    )
    annotated = match_candidates_to_nodes(candidates, centroids, taz, nodes, config)
    assert annotated["MATCH_NODE_IDX"].iloc[0] == 0
    assert annotated["MAJOR_LEVEL"].iloc[0] == 3
    assert annotated["MAJOR_INT"].iloc[0] == "N"
    assert annotated["SNAP_ALLOWED"].iloc[0]


def test_candidate_direction_expands_outward_before_nearest_fallback() -> None:
    config = ProcessingConfig(boundary_endpoint_tolerance=200.0)
    taz = gpd.GeoDataFrame(
        {"N": [1]},
        geometry=[Polygon([(0, -100), (1000, -100), (1000, 100), (0, 100)])],
        crs="EPSG:2240",
    )
    centroids = gpd.GeoDataFrame({"N": [1]}, geometry=[Point(0, 0)], crs=taz.crs)
    candidates = gpd.GeoDataFrame(
        {
            "N": [1],
            "CC_PT": ["1_1"],
            "ANGLE_DEG": [90.0],
            "ANGLE_START": [45.0],
            "ANGLE_END": [135.0],
            "DENSITY": [1.0],
            "DENS_RANK": [1],
        },
        geometry=[Point(1000, 0)],
        crs=taz.crs,
    )
    nodes = gpd.GeoDataFrame(
        {"NODE_ID": [10, 20], "MAJOR_LEVEL": [4, 4]},
        geometry=[Point(-100, 0), Point(500, 500)],
        crs=taz.crs,
    )
    annotated = match_candidates_to_nodes(candidates, centroids, taz, nodes, config)
    assert annotated["MATCH_NODE_IDX"].iloc[0] == 1
    assert annotated["SNAP_ALLOWED"].iloc[0]
    assert annotated["SNAP_FALLBACK"].iloc[0]
    assert annotated["SNAP_FAIL_REASON"].iloc[0] == "EXPANDED_SECTOR_ALLOWED_NODE"


def test_node_major_level_uses_lowest_numeric_func_class() -> None:
    config = ProcessingConfig(fields=FieldMapping(node_id="NODE_ID"))
    nodes = gpd.GeoDataFrame(
        {"NODE_ID": [10, 20, 30, 40]},
        geometry=[Point(0, 0), Point(1, 0), Point(2, 0), Point(3, 0)],
        crs="EPSG:2240",
    )
    links = gpd.GeoDataFrame(
        {
            "A": [10, 10, 10, 20, 40],
            "B": [20, 30, 20, 30, 30],
            "FUNC_CLASS": [1, 3, 5, 4, 5],
        },
        geometry=[
            LineString([(0, 0), (1, 0)]),
            LineString([(0, 0), (2, 0)]),
            LineString([(0, 0), (1, 0)]),
            LineString([(1, 0), (2, 0)]),
            LineString([(3, 0), (2, 0)]),
        ],
        crs=nodes.crs,
    )
    annotated_nodes = attach_node_major_levels(nodes, links, config)
    levels = annotated_nodes.set_index("NODE_ID")["MAJOR_LEVEL"].to_dict()
    major_ints = annotated_nodes.set_index("NODE_ID")["MAJOR_INT"].to_dict()
    assert levels[10] == 1
    assert levels[20] == 1
    assert levels[30] == 3
    assert levels[40] == 5
    assert major_ints[10] == "Y"
    assert major_ints[20] == "Y"
    assert major_ints[30] == "N"
    assert major_ints[40] == "N"


def test_circular_angle_difference() -> None:
    assert angular_difference(350, 10) == 20
    assert angular_difference(20, 200) == 180
