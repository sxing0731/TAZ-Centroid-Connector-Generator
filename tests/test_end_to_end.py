from __future__ import annotations

import logging

import geopandas as gpd
from shapely.geometry import LineString, Point, Polygon

from config import FieldMapping, ProcessingConfig
from processing import run_processing


def test_complete_workflow_and_exports(tmp_path) -> None:
    crs = "EPSG:2240"
    source = tmp_path / "inputs.gpkg"
    output = tmp_path / "output"

    taz = gpd.GeoDataFrame(
        {"ZONE": [101]},
        geometry=[Polygon([(0, 0), (10000, 0), (10000, 10000), (0, 10000)])],
        crs=crs,
    )
    links = gpd.GeoDataFrame(
        {"LINK": [1, 2, 3]},
        geometry=[
            LineString([(0, 1000), (10000, 1000)]),
            LineString([(5000, 0), (5000, 10000)]),
            LineString([(0, 8000), (10000, 8000)]),
        ],
        crs=crs,
    )
    nodes = gpd.GeoDataFrame(
        {"N": [11, 12, 13, 14]},
        geometry=[
            Point(0, 0),
            Point(10000, 0),
            Point(10000, 10000),
            Point(0, 10000),
        ],
        crs=crs,
    )
    taz.to_file(source, layer="taz", driver="GPKG")
    links.to_file(source, layer="links", driver="GPKG")
    nodes.to_file(source, layer="nodes", driver="GPKG")

    config = ProcessingConfig(
        taz_path=f"{source}::taz",
        links_path=f"{source}::links",
        nodes_path=f"{source}::nodes",
        output_folder=str(output),
        fields=FieldMapping(taz_id="ZONE", node_id="N"),
        boundary_spacing=2000,
        buffer_radius=2500,
        target_connector_count=4,
        minimum_connector_count=3,
        minimum_angle=60,
    )
    layers = run_processing(
        config,
        progress=lambda percent, message: None,
        log=lambda message, level=logging.INFO: None,
    )

    assert len(layers["taz_centroids"]) == 1
    assert len(layers["boundary_candidate_points"]) >= 16
    assert len(layers["final_connector_lines"]) >= 3
    assert (output / "taz_centroid_connectors.gpkg").exists()
    assert (output / "connector_table.csv").exists()
    assert (output / "field_dictionary.csv").exists()
    assert (output / "run_configuration.json").exists()
    written = gpd.read_file(
        output / "taz_centroid_connectors.gpkg",
        layer="final_connector_lines",
    )
    assert len(written) >= 3
    assert written.crs == taz.crs
