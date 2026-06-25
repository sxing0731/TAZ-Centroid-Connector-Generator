"""Output writers."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import geopandas as gpd
import pandas as pd

from config import ProcessingConfig

LogFn = Callable[[str, int], None]

OUTPUT_FIELDS = [
    "TAZ_N",
    "CC_PT",
    "CC_NODE",
    "DENSITY",
    "DENS_RANK",
    "ANGLE_DEG",
    "NEAR_DIST",
    "SNAP_OK",
]

FIELD_DICTIONARY = [
    ("TAZ_N", "Source TAZ identifier"),
    ("CC_PT", "Generated connector candidate identifier"),
    ("CC_NODE", "Nearest snapped master-node identifier"),
    ("DENSITY", "Clipped road length divided by clipped buffer area"),
    ("DENS_RANK", "Road-density rank within the parent TAZ"),
    ("ANGLE_DEG", "Candidate bearing clockwise from north"),
    ("NEAR_DIST", "Distance from boundary candidate to nearest master node"),
    ("SNAP_OK", "Whether the nearest node satisfies maximum snap distance"),
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
