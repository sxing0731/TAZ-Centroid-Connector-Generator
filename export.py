"""Output writers."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import geopandas as gpd
import pandas as pd

from config import ProcessingConfig

LogFn = Callable[[str, int], None]

OUTPUT_FIELDS = [
    "N",
    "CC_PT",
    "SECTOR_ID",
    "CC_NODE",
    "DENSITY",
    "DENS_RANK",
    "ANGLE_DEG",
    "NEAR_DIST",
    "SNAP_OK",
    "LINE_NODE_DIST",
    "MATCH_BND_DIST",
    "MAJOR_LEVEL",
    "MAJOR_INT",
    "SNAP_ALLOWED",
    "SNAP_FAIL_REASON",
    "INTERIOR_FALLBACK",
    "NODE_CONFLICTS_AVOIDED",
    "END_BND_DIST",
    "END_ON_BND",
    "CROSSES_TAZ",
    "OUTSIDE_LEN",
    "CROSSES_GSTDM",
]

FIELD_DICTIONARY = [
    ("N", "Source TAZ number"),
    ("CC_PT", "Generated connector candidate identifier"),
    ("SECTOR_ID", "Angular sector sequence around the TAZ centroid"),
    ("CC_NODE", "Nearest snapped master-node identifier"),
    ("DENSITY", "Clipped road length divided by clipped sector area"),
    ("DENS_RANK", "Road-density rank within the parent TAZ"),
    ("ANGLE_DEG", "Candidate bearing clockwise from north"),
    ("NEAR_DIST", "Distance from boundary candidate to nearest master node"),
    ("SNAP_OK", "Whether the nearest node satisfies maximum snap distance"),
    ("LINE_NODE_DIST", "Distance from snapped node to the centroid-to-boundary candidate line"),
    ("MATCH_BND_DIST", "Distance from candidate matched node to the parent TAZ boundary"),
    ("MAJOR_LEVEL", "Highest GSTDM functional class touching the snapped node; lower numeric values are more major"),
    ("MAJOR_INT", "Y when MAJOR_LEVEL is 1 or 2; N for 3, 4, 5, or missing"),
    ("SNAP_ALLOWED", "Whether the snapped non-major node passes the outside-TAZ and GSTDM-link crossing rules"),
    ("SNAP_FAIL_REASON", "Reason a candidate could not be matched to an eligible snap node"),
    ("INTERIOR_FALLBACK", "Whether no valid boundary-near node was available and an internal TAZ node was used"),
    ("NODE_CONFLICTS_AVOIDED", "Number of candidate endpoints skipped because another TAZ reserved the node"),
    ("END_BND_DIST", "Distance from snapped node to the parent TAZ boundary"),
    ("END_ON_BND", "Whether snapped endpoint is within the boundary tolerance"),
    ("CROSSES_TAZ", "Whether any final connector segment lies outside its parent TAZ"),
    ("OUTSIDE_LEN", "Length of final connector lying outside its parent TAZ"),
    ("CROSSES_GSTDM", "Whether the connector intersects a GSTDM link before its target-node endpoint"),
]


def _clean_for_file(layer: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Remove temporary Shapely-valued non-active columns."""
    removable = [
        column
        for column in layer.columns
        if column != layer.geometry.name
        and any(hasattr(value, "geom_type") for value in layer[column].dropna().head(5))
    ]
    return layer.drop(columns=removable)


def export_results(
    layers: dict[str, gpd.GeoDataFrame],
    final_table: gpd.GeoDataFrame,
    config: ProcessingConfig,
    log: LogFn,
) -> Path:
    """Write GeoPackage layers and companion CSV tables."""
    output_dir = Path(config.output_folder)
    output_dir.mkdir(parents=True, exist_ok=True)
    gpkg_path = output_dir / "taz_centroid_connectors.gpkg"
    if gpkg_path.exists():
        gpkg_path.unlink()

    written = 0
    for layer_name, layer in layers.items():
        if layer.empty:
            log(f"Output layer '{layer_name}' is empty and was not written.", 30)
            continue
        _clean_for_file(layer).to_file(gpkg_path, layer=layer_name, driver="GPKG")
        written += 1
    if not written:
        raise RuntimeError("No non-empty GIS output layers were generated.")

    table_columns = [column for column in OUTPUT_FIELDS if column in final_table.columns]
    pd.DataFrame(final_table.drop(columns="geometry"))[table_columns].to_csv(
        output_dir / "connector_table.csv",
        index=False,
    )
    pd.DataFrame(FIELD_DICTIONARY, columns=["FIELD", "DESCRIPTION"]).to_csv(
        output_dir / "field_dictionary.csv",
        index=False,
    )
    config.save_json(output_dir / "run_configuration.json")
    return gpkg_path
