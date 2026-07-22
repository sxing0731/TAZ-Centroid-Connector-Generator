from __future__ import annotations

import logging
from pathlib import Path

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
    here_links = gpd.GeoDataFrame(
        {"LINK": [1, 2, 3]},
        geometry=[
            LineString([(0, 1000), (10000, 1000)]),
            LineString([(5000, 0), (5000, 10000)]),
            LineString([(0, 8000), (10000, 8000)]),
        ],
        crs=crs,
    )
    gstdm_links = gpd.GeoDataFrame(
        {
            "LINK": [101, 102],
            "A": [11, 12],
            "B": [12, 13],
            "FUNC_CLASS": [4, 4],
        },
        geometry=[
            LineString([(0, 0), (10000, 0)]),
            LineString([(10000, 0), (10000, 10000)]),
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
    here_links.to_file(source, layer="here_links", driver="GPKG")
    gstdm_links.to_file(source, layer="gstdm_links", driver="GPKG")
    nodes.to_file(source, layer="nodes", driver="GPKG")

    config = ProcessingConfig(
        taz_path=f"{source}::taz",
        here_links_path=f"{source}::here_links",
        gstdm_links_path=f"{source}::gstdm_links",
        nodes_path=f"{source}::nodes",
        output_folder=str(output),
        fields=FieldMapping(taz_id="ZONE", node_id="N"),
        sector_count=10,
        target_connector_count=3,
        minimum_connector_count=1,
        minimum_angle=70,
    )
    layers = run_processing(
        config,
        progress=lambda percent, message: None,
        log=lambda message, level=logging.INFO: None,
    )
    run_output = Path(config.output_folder)

    assert len(layers["taz_centroids"]) == 1
    assert len(layers["gstdm_links"]) == 2
    assert "MAJOR_LEVEL" in layers["gstdm_master_nodes"].columns
    assert "taz_snap_flags" in layers
    assert layers["taz_snap_flags"]["SNAP_FLAG"].iloc[0] in {"Y", "N"}
    assert len(layers["boundary_candidate_points"]) == config.sector_count
    assert 1 <= len(layers["final_connector_lines"]) <= 3
    assert "N" in layers["final_connector_lines"].columns
    assert "CROSSES_TAZ" in layers["final_connector_lines"].columns
    assert "OUTSIDE_LEN" in layers["final_connector_lines"].columns
    assert "LINE_NODE_DIST" in layers["final_connector_lines"].columns
    assert "MAJOR_LEVEL" in layers["final_connector_lines"].columns
    assert "MAJOR_INT" in layers["final_connector_lines"].columns
    assert "SNAP_ALLOWED" in layers["final_connector_lines"].columns
    assert "SNAP_FAIL_REASON" in layers["final_connector_lines"].columns
    assert "INTERIOR_FALLBACK" in layers["final_connector_lines"].columns
    assert layers["final_connector_lines"]["SNAP_ALLOWED"].all()
    assert layers["final_connector_lines"]["END_ON_BND"].all()
    assert (layers["final_connector_lines"]["OUTSIDE_LEN"] <= 200.0).all()
    assert not layers["final_connector_lines"]["CROSSES_GSTDM"].any()
    assert not (layers["final_connector_lines"]["MAJOR_LEVEL"].fillna(0) <= 2).any()
    assert layers["final_connector_lines"].groupby("CC_NODE")["N"].nunique().max() == 1
    angles = layers["final_connector_lines"]["ANGLE_DEG"].tolist()
    for index, first in enumerate(angles):
        for second in angles[index + 1 :]:
            difference = abs(float(first) - float(second)) % 360.0
            assert min(difference, 360.0 - difference) >= 70.0
    assert run_output.parent == output
    assert run_output.name.startswith("run_")
    assert (run_output / "taz_centroid_connectors.gpkg").exists()
    assert (run_output / "connector_table.csv").exists()
    assert (run_output / "field_dictionary.csv").exists()
    assert (run_output / "run_configuration.json").exists()
    written = gpd.read_file(
        run_output / "taz_centroid_connectors.gpkg",
        layer="final_connector_lines",
    )
    assert 1 <= len(written) <= 3
    assert written.crs == taz.crs
