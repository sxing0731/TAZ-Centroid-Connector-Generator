from __future__ import annotations

import logging

import geopandas as gpd
from shapely.geometry import LineString, Point, Polygon

from config import ProcessingConfig
from density import calculate_road_density
from geometry import (
    create_candidate_buffers,
    create_interior_centroids,
    generate_boundary_candidates,
)
from selection import angular_difference, select_connectors


def silent_log(message: str, level: int = logging.INFO) -> None:
    pass


def test_representative_point_and_candidate_minimum() -> None:
    config = ProcessingConfig(target_connector_count=4, minimum_connector_count=3)
    polygon = Polygon([(0, 0), (10000, 0), (10000, 10000), (0, 10000)])
    taz = gpd.GeoDataFrame({"TAZ_N": [1]}, geometry=[polygon], crs="EPSG:2240")
    centroids = create_interior_centroids(taz, config)
    candidates = generate_boundary_candidates(taz, centroids, config, silent_log)
    assert polygon.covers(centroids.geometry.iloc[0])
    assert len(candidates) >= 16


def test_density_and_selection() -> None:
    config = ProcessingConfig(
        boundary_spacing=2000,
        buffer_radius=2000,
        target_connector_count=4,
        minimum_connector_count=3,
        minimum_angle=60,
    )
    polygon = Polygon([(0, 0), (10000, 0), (10000, 10000), (0, 10000)])
    taz = gpd.GeoDataFrame({"TAZ_N": [1]}, geometry=[polygon], crs="EPSG:2240")
    links = gpd.GeoDataFrame(
        {"ID": [1, 2]},
        geometry=[
            LineString([(0, 1000), (10000, 1000)]),
            LineString([(5000, 0), (5000, 10000)]),
        ],
        crs=taz.crs,
    )
    centroids = create_interior_centroids(taz, config)
    candidates = generate_boundary_candidates(taz, centroids, config, silent_log)
    buffers = create_candidate_buffers(candidates, taz, config, silent_log)
    scored_buffers = calculate_road_density(buffers, links, silent_log)
    scored = candidates.merge(
        scored_buffers[["CC_PT", "DENSITY", "DENS_RANK"]], on="CC_PT"
    )
    scored = gpd.GeoDataFrame(scored, geometry="geometry", crs=taz.crs)
    selected = select_connectors(scored, config, silent_log)
    assert len(selected) >= config.minimum_connector_count
    assert scored_buffers["DENS_RANK"].min() == 1
    assert scored_buffers["DENSITY"].max() > 0


def test_circular_angle_difference() -> None:
    assert angular_difference(350, 10) == 20
    assert angular_difference(20, 200) == 180

