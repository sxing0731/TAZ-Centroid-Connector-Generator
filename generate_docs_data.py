from __future__ import annotations

import json
import math
import shutil
import argparse
from collections import defaultdict
from pathlib import Path
from typing import Any

import geopandas as gpd
import mapbox_vector_tile
import pandas as pd
from pyproj import Transformer
from shapely import line_merge
from shapely.geometry import LineString, MultiLineString, Point, box, shape
from shapely.ops import transform as shapely_transform


CONTEXT_FEET = 1.5 * 5280
ROUND_DIGITS = 1
VIEWPORT_TILE_SIZE_FEET = 80000
MEDIUM_CLUSTER_SIZE_FEET = 20000
COARSE_CLUSTER_SIZE_FEET = 80000
MVT_MIN_ZOOM = 6
MVT_DETAIL_ZOOM = 12
MVT_EXTENT = 4096
MVT_BUFFER = 96
OVERVIEW_SIMPLIFY_FEET_BY_ZOOM = {
    6: 3000,
    7: 1800,
    8: 1000,
    9: 500,
    10: 200,
    11: 60,
}
OVERVIEW_MIN_LENGTH_FEET_BY_ZOOM = {
    6: 2000,
    7: 1200,
    8: 800,
    9: 400,
    10: 200,
    11: 0,
}
WEB_MERCATOR_HALF_WORLD = 20037508.342789244
SOURCE_CRS = (
    "+proj=lcc +lat_0=0 +lon_0=-83.5 +lat_1=31.4166666666667 "
    "+lat_2=34.2833333333333 +x_0=0 +y_0=0 +datum=NAD83 +units=us-ft +no_defs +type=crs"
)
SOURCE_TO_MERCATOR = Transformer.from_crs(SOURCE_CRS, "EPSG:3857", always_xy=True)
SOURCE_TO_WGS84 = Transformer.from_crs(SOURCE_CRS, "EPSG:4326", always_xy=True)
DEFAULT_CC_PATH = Path("input/default/cube_taz_cc_public.csv")
DEFAULT_MISSING_LINK_PATH = Path("input/default/HERE_MISS_links.csv")


def id_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value)
    return text[:-2] if text.endswith(".0") else text


def number(value: Any, default: float | int | None = None) -> float | int | None:
    if value is None or pd.isna(value):
        return default
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def rounded(value: Any) -> Any:
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return round(value, ROUND_DIGITS)
    if isinstance(value, list):
        return [rounded(item) for item in value]
    if isinstance(value, tuple):
        return [rounded(item) for item in value]
    if isinstance(value, dict):
        return {key: rounded(item) for key, item in value.items()}
    return value


def geom_json(geom: Any, simplify: float = 0) -> dict[str, Any] | None:
    if geom is None or geom.is_empty:
        return None
    if simplify:
        geom = geom.simplify(simplify, preserve_topology=True)
    return rounded(geom.__geo_interface__)


def spatial_subset(frame: gpd.GeoDataFrame, geom: Any) -> gpd.GeoDataFrame:
    idx = list(frame.sindex.query(geom, predicate="intersects"))
    if not idx:
        return frame.iloc[[]]
    return frame.iloc[idx]


def sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
    try:
        return (0, float(item["id"]), str(item["id"]))
    except (TypeError, ValueError):
        return (1, str(item["id"]), str(item["id"]))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(text, encoding="utf-8")
    tmp_path.replace(path)


def tile_position(x: float, y: float, size: int = VIEWPORT_TILE_SIZE_FEET) -> tuple[int, int]:
    return math.floor(x / size), math.floor(y / size)


def tile_key(column: int, row: int) -> str:
    return f"{column}_{row}"


def tile_bounds(column: int, row: int, size: int = VIEWPORT_TILE_SIZE_FEET) -> list[int]:
    return [column * size, row * size, (column + 1) * size, (row + 1) * size]


def coordinate_bounds(coordinates: list[list[float]]) -> tuple[float, float, float, float]:
    xs = [point[0] for point in coordinates]
    ys = [point[1] for point in coordinates]
    return min(xs), min(ys), max(xs), max(ys)


def cluster_nodes(nodes: list[dict[str, Any]], size: int) -> list[dict[str, Any]]:
    groups: dict[tuple[int, int], list[float]] = {}
    for node in nodes:
        key = tile_position(float(node["x"]), float(node["y"]), size)
        stats = groups.setdefault(key, [0.0, 0.0, 0.0, 0.0])
        stats[0] += float(node["x"])
        stats[1] += float(node["y"])
        stats[2] += 1
        stats[3] += 1 if node.get("eligible") else 0
    return [
        {
            "x": round(stats[0] / stats[2], ROUND_DIGITS),
            "y": round(stats[1] / stats[2], ROUND_DIGITS),
            "count": int(stats[2]),
            "eligible": int(stats[3]),
        }
        for stats in groups.values()
    ]


def build_gstdm_overview(lines: list[list[list[float]]], zoom: int) -> list[list[list[float]]]:
    """Generalize the network without snapping coordinates to a square grid."""
    tolerance = OVERVIEW_SIMPLIFY_FEET_BY_ZOOM[zoom]
    minimum_length = OVERVIEW_MIN_LENGTH_FEET_BY_ZOOM[zoom]
    simplified_lines: list[list[list[float]]] = []
    for coordinates in lines:
        if len(coordinates) < 2:
            continue
        line = LineString(coordinates)
        if line.length < minimum_length:
            continue
        generalized = line.simplify(tolerance, preserve_topology=True)
        if generalized.is_empty or generalized.geom_type != "LineString" or len(generalized.coords) < 2:
            continue
        simplified_lines.append(rounded(list(generalized.coords)))
    return simplified_lines


def to_web_mercator(geometry: Any) -> Any:
    return shapely_transform(SOURCE_TO_MERCATOR.transform, geometry)


def web_tile_bounds(zoom: int, column: int, row: int) -> tuple[float, float, float, float]:
    span = WEB_MERCATOR_HALF_WORLD * 2 / (2**zoom)
    min_x = -WEB_MERCATOR_HALF_WORLD + column * span
    max_y = WEB_MERCATOR_HALF_WORLD - row * span
    return min_x, max_y - span, min_x + span, max_y


def geometry_tile_range(geometry: Any, zoom: int) -> tuple[int, int, int, int]:
    min_x, min_y, max_x, max_y = geometry.bounds
    count = 2**zoom
    span = WEB_MERCATOR_HALF_WORLD * 2 / count
    min_column = math.floor((min_x + WEB_MERCATOR_HALF_WORLD) / span)
    max_column = math.floor((max_x + WEB_MERCATOR_HALF_WORLD) / span)
    min_row = math.floor((WEB_MERCATOR_HALF_WORLD - max_y) / span)
    max_row = math.floor((WEB_MERCATOR_HALF_WORLD - min_y) / span)
    return (
        max(0, min(count - 1, min_column)),
        max(0, min(count - 1, min_row)),
        max(0, min(count - 1, max_column)),
        max(0, min(count - 1, max_row)),
    )


def add_mvt_feature(
    tile_layers: dict[tuple[int, int], dict[str, list[dict[str, Any]]]],
    zoom: int,
    layer: str,
    geometry: Any,
    properties: dict[str, Any],
) -> None:
    if geometry is None or geometry.is_empty:
        return
    min_column, min_row, max_column, max_row = geometry_tile_range(geometry, zoom)
    feature = {
        "geometry": geometry,
        "properties": {key: value for key, value in properties.items() if value is not None},
    }
    for column in range(min_column, max_column + 1):
        for row in range(min_row, max_row + 1):
            tile_layers.setdefault((column, row), {}).setdefault(layer, []).append(feature)


def encode_mvt_tile(
    layers: dict[str, list[dict[str, Any]]],
    bounds: tuple[float, float, float, float],
) -> bytes:
    min_x, min_y, max_x, max_y = bounds
    span = max_x - min_x
    clip_buffer = span * MVT_BUFFER / MVT_EXTENT
    clip_box = box(min_x - clip_buffer, min_y - clip_buffer, max_x + clip_buffer, max_y + clip_buffer)
    tolerance = span / MVT_EXTENT * 0.35
    encoded_layers: list[dict[str, Any]] = []
    for name, features in layers.items():
        clipped: list[dict[str, Any]] = []
        for feature in features:
            geometry = feature["geometry"]
            if not geometry.intersects(clip_box):
                continue
            if geometry.geom_type not in {"Point", "MultiPoint"}:
                geometry = geometry.intersection(clip_box)
                if geometry.is_empty:
                    continue
                geometry = geometry.simplify(tolerance, preserve_topology=True)
            clipped.append({"geometry": geometry, "properties": feature["properties"]})
        if clipped:
            encoded_layers.append({"name": name, "features": clipped})
    if not encoded_layers:
        return b""
    return mapbox_vector_tile.encode(
        encoded_layers,
        default_options={
            "quantize_bounds": bounds,
            "extents": MVT_EXTENT,
            "y_coord_down": False,
        },
    )


def write_mvt_zoom(
    mvt_root: Path,
    zoom: int,
    tile_layers: dict[tuple[int, int], dict[str, list[dict[str, Any]]]],
) -> dict[str, int]:
    tile_count = 0
    total_bytes = 0
    for (column, row), layers in sorted(tile_layers.items()):
        encoded = encode_mvt_tile(layers, web_tile_bounds(zoom, column, row))
        if not encoded:
            continue
        path = mvt_root / str(zoom) / str(column) / f"{row}.pbf"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
        tile_count += 1
        total_bytes += len(encoded)
    return {"tiles": tile_count, "bytes": total_bytes}


def write_maplibre_vector_tiles(
    docs_data: Path,
    payload: dict[str, Any],
    overview: dict[str, Any],
) -> dict[str, Any]:
    mvt_root = (docs_data / "mvt").resolve()
    if mvt_root.exists():
        if mvt_root.parent != docs_data.resolve():
            raise SystemExit(f"Refusing to replace unexpected MVT directory: {mvt_root}")
        shutil.rmtree(mvt_root)
    mvt_root.mkdir(parents=True)

    taz_features = [
        (
            to_web_mercator(shape(item["geom"])),
            {"taz_id": str(item["id"]), "flag": str(item.get("flag", "N"))},
        )
        for item in payload.get("tazs", [])
        if item.get("geom")
    ]
    centroid_features = [
        (
            to_web_mercator(Point(float(item["x"]), float(item["y"]))),
            {"taz_id": str(item["id"])},
        )
        for item in payload.get("centroids", [])
    ]
    connector_features = [
        (
            to_web_mercator(shape(item["geom"])),
            {
                "taz_id": str(item.get("tazId", "")),
                "cc_pt": str(item.get("ccPt", "")),
                "node_id": str(item.get("nodeId", "")),
            },
        )
        for item in payload.get("connectors", [])
        if item.get("geom")
    ]
    network_lines = ((payload.get("gstdmFeature") or {}).get("geometry") or {}).get("coordinates") or []
    coarse_clusters = [
        (
            to_web_mercator(Point(float(item["x"]), float(item["y"]))),
            {"count": int(item["count"]), "eligible": int(item.get("eligible", 0))},
        )
        for item in overview.get("coarseClusters", [])
    ]
    medium_clusters = [
        (
            to_web_mercator(Point(float(item["x"]), float(item["y"]))),
            {"count": int(item["count"]), "eligible": int(item.get("eligible", 0))},
        )
        for item in overview.get("mediumClusters", [])
    ]

    totals = {"tiles": 0, "bytes": 0}
    for zoom in range(MVT_MIN_ZOOM, MVT_DETAIL_ZOOM):
        tile_layers: dict[tuple[int, int], dict[str, list[dict[str, Any]]]] = {}
        overview_lines = build_gstdm_overview(network_lines, zoom)
        for geometry, properties in taz_features:
            add_mvt_feature(tile_layers, zoom, "taz", geometry, properties)
        for geometry, properties in centroid_features:
            add_mvt_feature(tile_layers, zoom, "centroids", geometry, properties)
        for geometry, properties in connector_features:
            add_mvt_feature(tile_layers, zoom, "connectors", geometry, properties)
        for index, coordinates in enumerate(overview_lines):
            add_mvt_feature(
                tile_layers,
                zoom,
                "gstdm",
                to_web_mercator(LineString(coordinates)),
                {"segment": index},
            )
        clusters = coarse_clusters if zoom <= 9 else medium_clusters
        for geometry, properties in clusters:
            add_mvt_feature(tile_layers, zoom, "node_clusters", geometry, properties)
        stats = write_mvt_zoom(mvt_root, zoom, tile_layers)
        totals["tiles"] += stats["tiles"]
        totals["bytes"] += stats["bytes"]
        print(
            f"MVT z{zoom}: {stats['tiles']} tile(s), {len(overview_lines)} generalized GSTDM lines, "
            f"{stats['bytes'] / 1024:.1f} KiB"
        )

    detail_layers: dict[tuple[int, int], dict[str, list[dict[str, Any]]]] = {}
    for geometry, properties in taz_features:
        add_mvt_feature(detail_layers, MVT_DETAIL_ZOOM, "taz", geometry, properties)
    for geometry, properties in centroid_features:
        add_mvt_feature(detail_layers, MVT_DETAIL_ZOOM, "centroids", geometry, properties)
    for geometry, properties in connector_features:
        add_mvt_feature(detail_layers, MVT_DETAIL_ZOOM, "connectors", geometry, properties)
    for node in payload.get("nodes", []):
        geometry = to_web_mercator(Point(float(node["x"]), float(node["y"])))
        add_mvt_feature(
            detail_layers,
            MVT_DETAIL_ZOOM,
            "nodes",
            geometry,
            {
                "node_id": str(node.get("id", "")),
                "x": float(node["x"]),
                "y": float(node["y"]),
                "major_level": number(node.get("majorLevel")),
                "eligible": bool(node.get("eligible")),
            },
        )
    for line_id, coordinates in enumerate(network_lines):
        if len(coordinates) < 2:
            continue
        add_mvt_feature(
            detail_layers,
            MVT_DETAIL_ZOOM,
            "gstdm",
            to_web_mercator(LineString(coordinates)),
            {"segment": line_id},
        )
    detail_stats = write_mvt_zoom(mvt_root, MVT_DETAIL_ZOOM, detail_layers)
    totals["tiles"] += detail_stats["tiles"]
    totals["bytes"] += detail_stats["bytes"]
    print(f"MVT z{MVT_DETAIL_ZOOM}: {detail_stats['tiles']} tile(s), {detail_stats['bytes'] / 1024 / 1024:.2f} MiB")

    source_bounds = [math.inf, math.inf, -math.inf, -math.inf]
    for geometry, _ in taz_features:
        min_x, min_y, max_x, max_y = geometry.bounds
        source_bounds[0] = min(source_bounds[0], min_x)
        source_bounds[1] = min(source_bounds[1], min_y)
        source_bounds[2] = max(source_bounds[2], max_x)
        source_bounds[3] = max(source_bounds[3], max_y)
    mercator_to_wgs84 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    west, south = mercator_to_wgs84.transform(source_bounds[0], source_bounds[1])
    east, north = mercator_to_wgs84.transform(source_bounds[2], source_bounds[3])
    manifest = {
        "schemaVersion": 1,
        "generalizationVersion": 2,
        "format": "mvt",
        "tiles": "data/mvt/{z}/{x}/{y}.pbf",
        "minzoom": MVT_MIN_ZOOM,
        "maxzoom": MVT_DETAIL_ZOOM,
        "bounds": [west, south, east, north],
        "tileCount": totals["tiles"],
        "bytes": totals["bytes"],
        "layers": ["taz", "centroids", "connectors", "gstdm", "node_clusters", "nodes"],
        "generalization": {
            "method": "topology-preserving-simplify",
            "simplifyFeetByZoom": OVERVIEW_SIMPLIFY_FEET_BY_ZOOM,
            "minimumLengthFeetByZoom": OVERVIEW_MIN_LENGTH_FEET_BY_ZOOM,
        },
    }
    write_json(mvt_root / "manifest.json", manifest)
    return manifest


def write_viewport_bundle(docs_data: Path, payload: dict[str, Any]) -> dict[str, Any]:
    tiles_root = (docs_data / "tiles").resolve()
    if tiles_root.exists():
        if tiles_root.parent != docs_data.resolve():
            raise SystemExit(f"Refusing to replace unexpected tile directory: {tiles_root}")
        shutil.rmtree(tiles_root)
    (tiles_root / "nodes").mkdir(parents=True)
    (tiles_root / "links").mkdir(parents=True)

    nodes = payload.get("nodes", [])
    gstdm_feature = payload.get("gstdmFeature") or {}
    lines = (gstdm_feature.get("geometry") or {}).get("coordinates") or []
    node_tiles: dict[str, list[dict[str, Any]]] = defaultdict(list)
    node_index: dict[str, str] = {}
    tile_metadata: dict[str, dict[str, Any]] = {}
    for node in nodes:
        column, row = tile_position(float(node["x"]), float(node["y"]))
        key = tile_key(column, row)
        node_tiles[key].append(node)
        node_index[str(node["id"])] = key
        tile_metadata.setdefault(key, {"bbox": tile_bounds(column, row), "nodes": 0, "lines": 0})["nodes"] += 1

    line_tiles: dict[str, list[list[Any]]] = defaultdict(list)
    for line_id, coordinates in enumerate(lines):
        if len(coordinates) < 2:
            continue
        min_x, min_y, max_x, max_y = coordinate_bounds(coordinates)
        min_column, min_row = tile_position(min_x, min_y)
        max_column, max_row = tile_position(max_x, max_y)
        for column in range(min_column, max_column + 1):
            for row in range(min_row, max_row + 1):
                key = tile_key(column, row)
                line_tiles[key].append([line_id, coordinates])
                tile_metadata.setdefault(key, {"bbox": tile_bounds(column, row), "nodes": 0, "lines": 0})["lines"] += 1

    for key, items in node_tiles.items():
        write_json(tiles_root / "nodes" / f"{key}.json", {"nodes": items})
    for key, items in line_tiles.items():
        write_json(tiles_root / "links" / f"{key}.json", {"lines": items})

    overview = {
        "coarseClusters": cluster_nodes(nodes, COARSE_CLUSTER_SIZE_FEET),
        "mediumClusters": cluster_nodes(nodes, MEDIUM_CLUSTER_SIZE_FEET),
        "gstdmLines": build_gstdm_overview(lines, 8),
    }
    write_json(tiles_root / "overview.json", overview)
    write_json(tiles_root / "node-index.json", node_index)
    vector_tiles = write_maplibre_vector_tiles(docs_data, payload, overview)
    manifest = {
        "schemaVersion": 1,
        "crs": "NAD83 / Georgia Statewide Lambert (US ft)",
        "tileSizeFeet": VIEWPORT_TILE_SIZE_FEET,
        "paddingFeet": CONTEXT_FEET,
        "detailScale": 0.006,
        "overviewScale": 0.0012,
        "tiles": tile_metadata,
        "overview": "data/tiles/overview.json",
        "nodeIndex": "data/tiles/node-index.json",
    }
    write_json(tiles_root / "manifest.json", manifest)

    connector_ids = {str(connector.get("nodeId", "")) for connector in payload.get("connectors", [])}
    connector_nodes = [node for node in nodes if str(node.get("id", "")) in connector_ids]
    core = {
        key: payload[key]
        for key in (
            "generatedFrom",
            "nodeSource",
            "count",
            "contextFeet",
            "tazOrder",
            "tazs",
            "centroids",
            "connectors",
        )
    }
    for key in ("defaultMissingLinks", "defaultInputs"):
        if key in payload:
            core[key] = payload[key]
    core.update({
        "schemaVersion": 5,
        "connectorNodes": connector_nodes,
        "counts": {
            "tazs": len(payload.get("tazs", [])),
            "connectors": len(payload.get("connectors", [])),
            "nodes": len(nodes),
            "gstdmSourceFeatures": int((gstdm_feature.get("properties") or {}).get("sourceFeatureCount", 0)),
            "gstdmLines": len(lines),
        },
        "tileManifest": "data/tiles/manifest.json",
        "vectorTiles": vector_tiles,
    })
    write_json(docs_data / "core.json", core)
    return {
        "tiles": len(tile_metadata),
        "connectorNodes": len(connector_nodes),
        "overviewLines": len(overview["gstdmLines"]),
        "coarseClusters": len(overview["coarseClusters"]),
        "mediumClusters": len(overview["mediumClusters"]),
        "mvtTiles": vector_tiles["tileCount"],
        "mvtBytes": vector_tiles["bytes"],
    }


def connector_item(row: Any, taz_id: str) -> dict[str, Any]:
    return {
        "tazId": taz_id,
        "ccPt": str(row.get("CC_PT") or ""),
        "nodeId": id_text(row.get("CC_NODE")),
        "density": number(row.get("DENSITY"), 0),
        "rank": int(number(row.get("DENS_RANK"), 0) or 0),
        "majorLevel": number(row.get("MAJOR_LEVEL")),
        "outsideLen": number(row.get("OUTSIDE_LEN"), 0),
        "endBoundaryDist": number(row.get("END_BND_DIST"), 0),
        "interiorFallback": bool(row.get("INTERIOR_FALLBACK", False)),
        "lineNodeDist": number(row.get("LINE_NODE_DIST"), 0),
        "status": "unreviewed",
        "geom": geom_json(row.geometry),
    }


def node_item(row: Any) -> dict[str, Any]:
    major_level = number(row.get("MAJOR_LEVEL"))
    return {
        "id": id_text(row.get("N")),
        "x": round(float(row.geometry.x), ROUND_DIGITS),
        "y": round(float(row.geometry.y), ROUND_DIGITS),
        "majorLevel": major_level,
        "majorInt": str(row.get("MAJOR_INT") or "N"),
        "eligible": bool(major_level is not None and major_level > 2),
    }


def link_item(row: Any) -> dict[str, Any]:
    return {
        "a": id_text(row.get("A")),
        "b": id_text(row.get("B")),
        "linkId": id_text(row.get("LINK_ID")),
        "funcClass": str(row.get("FUNC_CLASS") or ""),
        "geom": geom_json(row.geometry, 10),
    }


def read_default_csv(path: Path, required_fields: set[str]) -> pd.DataFrame:
    if not path.exists():
        raise SystemExit(f"Default input file not found: {path}")
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    frame.columns = [str(column).strip().upper() for column in frame.columns]
    missing = required_fields - set(frame.columns)
    if missing:
        raise SystemExit(f"{path} is missing required field(s): {', '.join(sorted(missing))}")
    return frame


def numeric_id_sort(value: str) -> tuple[int, float | str, str]:
    try:
        return 0, float(value), value
    except (TypeError, ValueError):
        return 1, value, value


def missing_pair_key(first_id: str, second_id: str) -> str:
    first, second = sorted((first_id, second_id), key=numeric_id_sort)
    return f"{first}|{second}"


def apply_default_inputs(payload: dict[str, Any], cc_path: Path, missing_path: Path) -> dict[str, int]:
    cc_rows = read_default_csv(cc_path, {"A", "B", "FCLASS"})
    missing_rows = read_default_csv(missing_path, {"A", "B", "LANES", "HERE_MISS", "FCLASS"})
    taz_ids = {str(item["id"]) for item in payload.get("tazs", [])}
    taz_by_id = {str(item["id"]): item for item in payload.get("tazs", [])}
    centroid_by_id = {str(item["id"]): item for item in payload.get("centroids", [])}
    node_by_id = {str(item["id"]): item for item in payload.get("nodes", [])}
    previous_by_pair = {
        (str(item.get("tazId", "")), str(item.get("nodeId", ""))): item
        for item in payload.get("connectors", [])
    }

    connectors: list[dict[str, Any]] = []
    seen_connectors: set[tuple[str, str]] = set()
    connector_counts: dict[str, int] = defaultdict(int)
    invalid_cc_rows = 0
    for row in cc_rows.to_dict("records"):
        if id_text(row.get("FCLASS")) != "32":
            invalid_cc_rows += 1
            continue
        a = id_text(row.get("A"))
        b = id_text(row.get("B"))
        if a in taz_ids and b and a != b:
            taz_id, node_id = a, b
        elif b in taz_ids and a and a != b:
            taz_id, node_id = b, a
        else:
            invalid_cc_rows += 1
            continue
        key = (taz_id, node_id)
        if key in seen_connectors:
            continue
        seen_connectors.add(key)
        node = node_by_id.get(node_id)
        centroid = centroid_by_id.get(taz_id)
        taz_item = taz_by_id.get(taz_id)
        if node is None or centroid is None or taz_item is None:
            raise SystemExit(f"Default CC {taz_id}-{node_id} cannot be resolved in the published TAZ/node data.")
        centroid_coord = [float(centroid["x"]), float(centroid["y"])]
        node_coord = [float(node["x"]), float(node["y"])]
        line = LineString([centroid_coord, node_coord])
        taz_geometry = shape(taz_item["geom"])
        end_boundary_dist = float(Point(node_coord).distance(taz_geometry.boundary))
        outside_len = float(line.difference(taz_geometry).length)
        previous = previous_by_pair.get(key, {})
        connector_counts[taz_id] += 1
        connectors.append({
            "tazId": taz_id,
            "ccPt": str(previous.get("ccPt") or f"{taz_id}_INPUT{connector_counts[taz_id]}"),
            "nodeId": node_id,
            "density": number(previous.get("density"), 0),
            "rank": int(number(previous.get("rank"), 0) or 0),
            "majorLevel": number(node.get("majorLevel")),
            "outsideLen": outside_len,
            "endBoundaryDist": end_boundary_dist,
            "interiorFallback": end_boundary_dist > 200.000001,
            "lineNodeDist": number(previous.get("lineNodeDist"), 0),
            "status": "unreviewed",
            "geom": geom_json(line),
        })
    if not connectors or invalid_cc_rows:
        raise SystemExit(
            f"Default CC input produced {len(connectors)} connector(s) and {invalid_cc_rows} invalid record(s)."
        )
    payload["connectors"] = connectors
    for item in payload.get("tazOrder", []):
        item["connectors"] = connector_counts.get(str(item["id"]), 0)

    default_missing_links: list[dict[str, Any]] = []
    seen_missing_pairs: set[str] = set()
    invalid_missing_rows = 0
    for row in missing_rows.to_dict("records"):
        a = id_text(row.get("A"))
        b = id_text(row.get("B"))
        if (
            not a
            or not b
            or a == b
            or id_text(row.get("LANES")) != "1"
            or id_text(row.get("HERE_MISS")) != "1"
            or id_text(row.get("FCLASS")) != "7"
        ):
            invalid_missing_rows += 1
            continue
        pair_key = missing_pair_key(a, b)
        if pair_key in seen_missing_pairs:
            continue
        seen_missing_pairs.add(pair_key)
        first = node_by_id.get(a)
        second = node_by_id.get(b)
        if first is None or second is None:
            raise SystemExit(f"Default HERE_MISS {a}-{b} cannot be resolved in the published node data.")
        default_missing_links.append({
            "pairKey": pair_key,
            "a": a,
            "b": b,
            "aCoord": [float(first["x"]), float(first["y"])],
            "bCoord": [float(second["x"]), float(second["y"])],
        })
    if not default_missing_links or invalid_missing_rows:
        raise SystemExit(
            "Default HERE_MISS input produced "
            f"{len(default_missing_links)} link(s) and {invalid_missing_rows} invalid record(s)."
        )
    payload["defaultMissingLinks"] = default_missing_links
    payload["defaultInputs"] = {
        "cc": cc_path.as_posix(),
        "missingLinks": missing_path.as_posix(),
        "ccDirectionalRecords": int(len(cc_rows)),
        "ccPairs": len(connectors),
        "missingDirectionalRecords": int(len(missing_rows)),
        "missingPairs": len(default_missing_links),
    }
    return {"connectors": len(connectors), "missingLinks": len(default_missing_links)}


def merged_gstdm_feature_from_lines(lines: list[list[list[float]]], source_count: int) -> dict[str, Any]:
    """Store the display network as one feature and join degree-two line chains."""
    merged = line_merge(MultiLineString(lines)) if lines else MultiLineString([])
    if merged.geom_type == "LineString":
        merged_lines = [rounded(list(merged.coords))]
    else:
        merged_lines = [rounded(list(line.coords)) for line in merged.geoms]
    return {
        "type": "Feature",
        "properties": {
            "sourceFeatureCount": source_count,
            "lineCount": len(merged_lines),
        },
        "geometry": {
            "type": "MultiLineString",
            "coordinates": merged_lines,
        },
    }


def merged_gstdm_feature(links: list[dict[str, Any]]) -> dict[str, Any]:
    lines: list[list[list[float]]] = []
    for link in links:
        geometry = link.get("geom") or {}
        if geometry.get("type") == "LineString":
            coordinates = geometry.get("coordinates") or []
            if len(coordinates) >= 2:
                lines.append(coordinates)
        elif geometry.get("type") == "MultiLineString":
            lines.extend(line for line in (geometry.get("coordinates") or []) if len(line) >= 2)
    return merged_gstdm_feature_from_lines(lines, len(links))


def merge_payload_gstdm(payload: dict[str, Any]) -> None:
    existing = payload.get("gstdmFeature")
    if existing:
        payload.pop("links", None)
        geometry = existing.get("geometry") or {}
        lines = geometry.get("coordinates") or []
        source_count = int((existing.get("properties") or {}).get("sourceFeatureCount", len(lines)))
        payload["gstdmFeature"] = merged_gstdm_feature_from_lines(lines, source_count)
    else:
        payload["gstdmFeature"] = merged_gstdm_feature(payload.pop("links", []))
    payload["schemaVersion"] = 3


def build_from_gpkg() -> dict[str, Any]:
    output_root = Path("output")
    run_folders = sorted(
        [
            path
            for path in output_root.glob("run_*")
            if path.is_dir() and (path / "taz_centroid_connectors.gpkg").exists()
        ]
    )
    if not run_folders:
        raise SystemExit("No completed output/run_* folders found.")
    run_folder = run_folders[-1]
    gpkg = run_folder / "taz_centroid_connectors.gpkg"
    if not gpkg.exists():
        raise SystemExit(f"Missing GeoPackage: {gpkg}")

    flags = gpd.read_file(gpkg, layer="taz_snap_flags")
    centroids = gpd.read_file(gpkg, layer="taz_centroids")
    connectors = gpd.read_file(gpkg, layer="final_connector_lines")
    nodes = gpd.read_file(gpkg, layer="gstdm_master_nodes")
    links = gpd.read_file(gpkg, layer="gstdm_links")

    for frame in (flags, centroids, connectors, nodes, links):
        frame["_ID"] = frame["N"].map(id_text) if "N" in frame.columns else ""
    centroids_by_id = centroids.set_index("_ID")
    connectors_by_taz = {key: group.copy() for key, group in connectors.groupby("_ID", sort=False)}
    review_area = flags.geometry.buffer(CONTEXT_FEET).union_all()
    review_links = spatial_subset(links, review_area)

    taz_order: list[dict[str, Any]] = []
    taz_items: list[dict[str, Any]] = []
    centroid_items: list[dict[str, Any]] = []
    connector_items: list[dict[str, Any]] = []

    for _, row in flags.iterrows():
        taz_id = id_text(row["N"])
        flag = str(row.get("SNAP_FLAG") or "N")
        issue = str(row.get("SNAP_ISSUE") or "").strip()
        selected = int(number(row.get("SELECTED"), 0) or 0)
        target = int(number(row.get("TARGET"), 3) or 3)
        minimum = int(number(row.get("MINIMUM"), 1) or 1)
        taz_connectors = connectors_by_taz.get(taz_id, connectors.iloc[[]])

        order_item = {
            "id": taz_id,
            "flag": flag,
            "issue": issue,
            "connectors": int(len(taz_connectors)),
        }
        taz_order.append(order_item)
        centroid_geom = centroids_by_id.loc[taz_id].geometry if taz_id in centroids_by_id.index else row.geometry.centroid
        taz_items.append(
            {
                "id": taz_id,
                "flag": flag,
                "issue": issue,
                "selected": selected,
                "target": target,
                "minimum": minimum,
                "geom": geom_json(row.geometry, 25),
            }
        )
        centroid_items.append(
            {
                "id": taz_id,
                "x": round(float(centroid_geom.x), ROUND_DIGITS),
                "y": round(float(centroid_geom.y), ROUND_DIGITS),
            }
        )
        for _, c in taz_connectors.iterrows():
            connector_items.append(connector_item(c, taz_id))

    taz_order.sort(key=sort_key)
    taz_items.sort(key=lambda item: sort_key({"id": item["id"], "flag": item["flag"], "issue": item["issue"]}))
    link_items = [link_item(row) for _, row in review_links.iterrows()]
    return {
        "schemaVersion": 3,
        "generatedFrom": run_folder.name,
        "nodeSource": run_folder.name,
        "count": len(taz_order),
        "contextFeet": CONTEXT_FEET,
        "tazOrder": taz_order,
        "tazs": taz_items,
        "centroids": centroid_items,
        "connectors": connector_items,
        "nodes": [node_item(row) for _, row in nodes.iterrows()],
        "gstdmFeature": merged_gstdm_feature(link_items),
    }


def build_from_existing_static(docs_data: Path) -> dict[str, Any]:
    index_path = docs_data / "index.json"
    taz_dir = docs_data / "taz"
    if not index_path.exists() or not taz_dir.exists():
        raise SystemExit("Existing docs/data/index.json and docs/data/taz are required for migration.")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    taz_items: list[dict[str, Any]] = []
    centroids: list[dict[str, Any]] = []
    connectors: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    links_by_id: dict[str, dict[str, Any]] = {}
    for position, order_item in enumerate(index["tazOrder"], start=1):
        path = docs_data.parent / order_item["file"]
        payload = json.loads(path.read_text(encoding="utf-8"))
        taz_id = str(payload["tazId"])
        taz_items.append(
            {
                "id": taz_id,
                "flag": payload.get("flag", "N"),
                "issue": payload.get("issue", ""),
                "selected": payload.get("selected", 0),
                "target": payload.get("target", 3),
                "minimum": payload.get("minimum", 1),
                "geom": payload.get("taz"),
            }
        )
        centroid = payload.get("centroid") or [None, None]
        centroids.append({"id": taz_id, "x": centroid[0], "y": centroid[1]})
        for connector in payload.get("connectors", []):
            connectors.append({"tazId": taz_id, **connector})
        for node in payload.get("nodes", []):
            nodes_by_id.setdefault(str(node["id"]), node)
        for link in payload.get("links", []):
            key = str(link.get("linkId") or f'{link.get("a", "")}|{link.get("b", "")}')
            previous = links_by_id.get(key)
            if previous is None or len(json.dumps(link.get("geom"))) > len(json.dumps(previous.get("geom"))):
                links_by_id[key] = link
        if position % 50 == 0:
            print(f"Migrated {position}/{len(index['tazOrder'])} TAZ payloads")
    order = [{key: value for key, value in item.items() if key != "file"} for item in index["tazOrder"]]
    return {
        "schemaVersion": 3,
        "generatedFrom": index.get("generatedFrom", "existing-static-data"),
        "count": len(order),
        "contextFeet": CONTEXT_FEET,
        "tazOrder": order,
        "tazs": taz_items,
        "centroids": centroids,
        "connectors": connectors,
        "nodes": list(nodes_by_id.values()),
        "gstdmFeature": merged_gstdm_feature(list(links_by_id.values())),
    }


def ensure_connector_nodes(payload: dict[str, Any]) -> int:
    nodes_by_id = {str(node.get("id", "")): node for node in payload.get("nodes", [])}
    added = 0
    for connector in payload.get("connectors", []):
        node_id = str(connector.get("nodeId", ""))
        if not node_id or node_id in nodes_by_id:
            continue
        geom = connector.get("geom") or {}
        coordinates = geom.get("coordinates") or []
        if geom.get("type") == "MultiLineString":
            coordinates = coordinates[0] if coordinates else []
        if geom.get("type") not in {"LineString", "MultiLineString"} or not coordinates:
            continue
        endpoint = coordinates[-1]
        major_level = number(connector.get("majorLevel"))
        node = {
            "id": node_id,
            "x": endpoint[0],
            "y": endpoint[1],
            "majorLevel": major_level,
            "majorInt": "Y" if major_level is not None and major_level <= 2 else "N",
            "eligible": bool(major_level is not None and major_level > 2),
        }
        payload["nodes"].append(node)
        nodes_by_id[node_id] = node
        added += 1
    return added


def augment_all_nodes_from_latest_gpkg(payload: dict[str, Any]) -> int:
    run_folders = sorted(
        path
        for path in Path("output").glob("run_*")
        if path.is_dir() and (path / "taz_centroid_connectors.gpkg").exists()
    )
    if not run_folders:
        return 0
    run_folder = run_folders[-1]
    source_nodes = gpd.read_file(run_folder / "taz_centroid_connectors.gpkg", layer="gstdm_master_nodes")
    source_items = [node_item(row) for _, row in source_nodes.iterrows()]
    existing = {str(item["id"]): item for item in payload.get("nodes", [])}
    mismatches = 0
    for item in source_items:
        old = existing.get(str(item["id"]))
        if old and (abs(float(old["x"]) - float(item["x"])) > 0.11 or abs(float(old["y"]) - float(item["y"])) > 0.11):
            mismatches += 1
    if mismatches:
        raise SystemExit(f"Refusing to mix node sources: {mismatches} overlapping node coordinates differ.")
    merged = {str(item["id"]): item for item in source_items}
    for item in payload.get("nodes", []):
        merged.setdefault(str(item["id"]), item)
    before = len(payload.get("nodes", []))
    payload["nodes"] = list(merged.values())
    payload["nodeSource"] = run_folder.name
    return len(payload["nodes"]) - before


def main() -> None:
    parser = argparse.ArgumentParser(description="Build viewport-loaded static QAQC core data and vector tiles.")
    parser.add_argument(
        "--from-existing-static",
        action="store_true",
        help="Migrate the existing per-TAZ docs data without changing its run contents.",
    )
    parser.add_argument(
        "--from-existing-all",
        action="store_true",
        help="Convert the existing docs/data/all.json into viewport vector tiles without changing its run contents.",
    )
    parser.add_argument(
        "--keep-per-taz",
        action="store_true",
        help="Keep legacy docs/data/taz JSON files after all.json is verified.",
    )
    parser.add_argument(
        "--default-cc",
        type=Path,
        default=DEFAULT_CC_PATH,
        help="Directed A/B/FCLASS=32 CSV to publish as the default CC baseline.",
    )
    parser.add_argument(
        "--default-missing-links",
        type=Path,
        default=DEFAULT_MISSING_LINK_PATH,
        help="Directed A/B/LANES/HERE_MISS/FCLASS CSV to publish as default missing links.",
    )
    args = parser.parse_args()
    docs_data = Path("docs") / "data"
    docs_data.mkdir(parents=True, exist_ok=True)
    all_path = docs_data / "all.json"
    augmented_nodes = 0
    if args.from_existing_all:
        if not all_path.exists():
            raise SystemExit("Existing docs/data/all.json is required.")
        payload = json.loads(all_path.read_text(encoding="utf-8"))
        augmented_nodes = augment_all_nodes_from_latest_gpkg(payload)
    elif args.from_existing_static:
        payload = build_from_existing_static(docs_data)
    else:
        payload = build_from_gpkg()
        augmented_nodes = 0
    merge_payload_gstdm(payload)
    default_stats = apply_default_inputs(payload, args.default_cc, args.default_missing_links)
    added_nodes = ensure_connector_nodes(payload)
    bundle_stats = write_viewport_bundle(docs_data, payload)
    core_path = docs_data / "core.json"
    manifest_path = docs_data / "tiles" / "manifest.json"
    verified_core = json.loads(core_path.read_text(encoding="utf-8"))
    verified_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        verified_core.get("schemaVersion") != 5
        or len(verified_core.get("tazs", [])) != len(verified_core.get("tazOrder", []))
        or verified_core.get("counts", {}).get("nodes") != len(payload.get("nodes", []))
        or verified_manifest.get("schemaVersion") != 1
        or not verified_manifest.get("tiles")
    ):
        raise SystemExit("Generated viewport data failed validation; legacy files were kept.")
    if all_path.exists():
        all_path.unlink()
    if not args.keep_per_taz:
        taz_dir = (docs_data / "taz").resolve()
        if taz_dir.exists() and taz_dir.parent == docs_data.resolve():
            shutil.rmtree(taz_dir)
        legacy_index = (docs_data / "index.json").resolve()
        if legacy_index.exists() and legacy_index.parent == docs_data.resolve():
            legacy_index.unlink()
    gstdm_properties = payload["gstdmFeature"]["properties"]
    print(
        f"Wrote {core_path} and {bundle_stats['tiles']} viewport tiles: "
        f"{len(payload['tazs'])} TAZs, {len(payload['connectors'])} CCs, {len(payload['nodes'])} nodes, "
        f"1 merged GSTDM feature "
        f"({gstdm_properties['sourceFeatureCount']} source links) from {payload['generatedFrom']} "
        f"({bundle_stats['overviewLines']} overview lines, {bundle_stats['coarseClusters']} coarse clusters, "
        f"{bundle_stats['mediumClusters']} medium clusters; {added_nodes} connector endpoint nodes added, "
        f"{augmented_nodes} full-layer nodes added; {default_stats['connectors']} default CCs and "
        f"{default_stats['missingLinks']} default HERE_MISS links)"
    )


if __name__ == "__main__":
    main()
