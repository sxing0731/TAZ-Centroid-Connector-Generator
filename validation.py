"""Input loading and GIS validation."""

from __future__ import annotations

from pathlib import Path
import geopandas as gpd

from config import ProcessingConfig

class InputValidationError(ValueError):
    """Raised when source GIS data does not meet project requirements."""


def split_layer_path(value: str) -> tuple[str, str | None]:
    """Support either a normal path or ``path::layer_name``."""
    if "::" in value:
        path, layer = value.rsplit("::", 1)
        return path, layer or None
    return value, None


def read_layer(value: str) -> gpd.GeoDataFrame:
    path, layer = split_layer_path(value)
    if not Path(path).exists():
        raise InputValidationError(f"Input layer does not exist: {path}")
    try:
        return gpd.read_file(path, layer=layer)
    except Exception as exc:
        suffix = f", layer '{layer}'" if layer else ""
        raise InputValidationError(
            f"Could not read vector dataset '{path}'{suffix}: {exc}"
        ) from exc


def _validate_crs(
    named_layers: dict[str, gpd.GeoDataFrame],
) -> None:
    first_name, first = next(iter(named_layers.items()))
    if first.crs is None:
        raise InputValidationError(f"{first_name} layer has no CRS.")
    if not first.crs.is_projected:
        raise InputValidationError(
            f"{first_name} layer uses a geographic CRS. A projected CRS in feet is required."
        )

    for name, layer in named_layers.items():
        if layer.crs is None:
            raise InputValidationError(f"{name} layer has no CRS.")
        if not layer.crs.is_projected:
            raise InputValidationError(
                f"{name} layer uses a geographic CRS. A projected CRS in feet is required."
            )
        if layer.crs != first.crs:
            raise InputValidationError(
                f"CRS mismatch: {name} does not match {first_name} ({first.crs})."
            )


def _validate_geometry(
    name: str,
    layer: gpd.GeoDataFrame,
    allowed_types: set[str],
) -> None:
    if layer.empty:
        raise InputValidationError(f"{name} layer is empty.")
    if layer.geometry.name not in layer.columns:
        raise InputValidationError(f"{name} layer has no active geometry column.")
    if layer.geometry.isna().any() or layer.geometry.is_empty.any():
        raise InputValidationError(f"{name} layer contains null or empty geometry.")
    actual = set(layer.geom_type.unique())
    unsupported = actual - allowed_types
    if unsupported:
        raise InputValidationError(
            f"{name} geometry must be {sorted(allowed_types)}; found {sorted(unsupported)}."
        )
    invalid_count = int((~layer.geometry.is_valid).sum())
    if invalid_count:
        raise InputValidationError(
            f"{name} layer contains {invalid_count} invalid geometries. Repair them before running."
        )


def load_and_validate_inputs(
    config: ProcessingConfig,
) -> tuple[
    gpd.GeoDataFrame,
    gpd.GeoDataFrame,
    gpd.GeoDataFrame,
    gpd.GeoDataFrame,
]:
    """Load all inputs and stop on any validation failure."""
    config.validate_parameters()
    taz = read_layer(config.taz_path)
    here_links = read_layer(config.here_links_path)
    gstdm_links = read_layer(config.gstdm_links_path)
    nodes = read_layer(config.nodes_path)

    _validate_crs(
        {
            "TAZ": taz,
            "HERE Master Links": here_links,
            "GSTDM Links": gstdm_links,
            "GSTDM Master Nodes": nodes,
        }
    )
    _validate_geometry("TAZ", taz, {"Polygon", "MultiPolygon"})
    _validate_geometry("HERE Master Links", here_links, {"LineString", "MultiLineString"})
    _validate_geometry("GSTDM Links", gstdm_links, {"LineString", "MultiLineString"})
    _validate_geometry("GSTDM Master Nodes", nodes, {"Point", "MultiPoint"})

    if config.fields.taz_id not in taz.columns:
        raise InputValidationError(
            f"TAZ field '{config.fields.taz_id}' was not found."
        )
    if config.fields.node_id not in nodes.columns:
        raise InputValidationError(
            f"Node field '{config.fields.node_id}' was not found."
        )
    for field_name, label in (
        (config.fields.link_from_node, "GSTDM link A/from-node"),
        (config.fields.link_to_node, "GSTDM link B/to-node"),
        (config.fields.link_func_class, "GSTDM link functional-class"),
    ):
        if field_name not in gstdm_links.columns:
            raise InputValidationError(f"{label} field '{field_name}' was not found.")
    if taz[config.fields.taz_id].isna().any():
        raise InputValidationError("TAZ ID field contains null values.")
    if taz[config.fields.taz_id].duplicated().any():
        raise InputValidationError("TAZ ID field must contain unique values.")

    return taz, here_links, gstdm_links, nodes
