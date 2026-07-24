from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point, mapping


PROJECTED_CRS = "ESRI:102604"


def clean_id(value: Any) -> str:
    number = pd.to_numeric(value, errors="coerce")
    if pd.isna(number):
        return str(value).strip().removesuffix(".0")
    return str(int(number))


def rounded_geometry(geometry: Any, digits: int = 1) -> dict[str, Any]:
    value = mapping(geometry)

    def rounded(coordinates: Any) -> Any:
        if coordinates and isinstance(coordinates[0], (int, float)):
            return [round(float(coordinate), digits) for coordinate in coordinates]
        return [rounded(part) for part in coordinates]

    return {"type": value["type"], "coordinates": rounded(value["coordinates"])}


def locate_sources(root: Path) -> tuple[Path, Path]:
    taz_matches = sorted(root.rglob("GSTDM_2025TAZ_06_16_2026.shp"))
    cc_matches = sorted(root.rglob("GSTDM2025_TAZ_CC_LINK.shp"))
    if len(taz_matches) != 1 or len(cc_matches) != 1:
        raise SystemExit(
            f"Expected one Global TAZ and one Global CC shapefile below {root}; "
            f"found {len(taz_matches)} TAZ and {len(cc_matches)} CC files."
        )
    return taz_matches[0], cc_matches[0]


def node_major_levels(gpkg: Path | None) -> dict[str, float]:
    if not gpkg or not gpkg.exists():
        return {}
    nodes = gpd.read_file(gpkg, layer="gstdm_master_nodes")
    if "N" not in nodes or "MAJOR_LEVEL" not in nodes:
        return {}
    return {
        clean_id(node_id): float(major_level)
        for node_id, major_level in zip(nodes["N"], nodes["MAJOR_LEVEL"])
        if pd.notna(node_id) and pd.notna(major_level)
    }


def build_payload(
    taz_path: Path,
    cc_path: Path,
    *,
    simplify_feet: float,
    node_levels: dict[str, float],
) -> dict[str, Any]:
    taz = gpd.read_file(taz_path).to_crs(PROJECTED_CRS)
    cc = gpd.read_file(cc_path).to_crs(PROJECTED_CRS)
    if "NEWID" not in taz:
        raise SystemExit(f"{taz_path} is missing NEWID.")
    for field in ("A", "B"):
        if field not in cc:
            raise SystemExit(f"{cc_path} is missing {field}.")

    taz["_ID"] = taz["NEWID"].map(clean_id)
    if taz["_ID"].duplicated().any():
        duplicates = sorted(taz.loc[taz["_ID"].duplicated(False), "_ID"].unique())
        raise SystemExit(f"Duplicate Global TAZ IDs: {duplicates[:10]}")

    taz_by_id = dict(zip(taz["_ID"], taz.geometry))
    taz_ids = set(taz_by_id)
    cc["TAZ_ID"] = cc["A"].map(clean_id)
    cc["NODE_ID"] = cc["B"].map(clean_id)
    forward = cc[cc["TAZ_ID"].isin(taz_ids) & ~cc["NODE_ID"].isin(taz_ids)].copy()
    if len(forward) * 2 != len(cc):
        raise SystemExit(
            "Global CC records are not complete reciprocal TAZ-to-node pairs: "
            f"{len(forward)} forward records from {len(cc)} total records."
        )

    forward = forward.sort_values(
        ["TAZ_ID", "NODE_ID"], key=lambda values: values.map(lambda item: int(item))
    )
    counts = Counter(forward["TAZ_ID"])
    connector_rows: list[dict[str, Any]] = []
    centroids_from_cc: dict[str, tuple[float, float]] = {}
    sequence: defaultdict[str, int] = defaultdict(int)

    for row in forward.itertuples(index=False):
        taz_id = str(row.TAZ_ID)
        node_id = str(row.NODE_ID)
        coordinates = list(row.geometry.coords)
        if len(coordinates) < 2:
            continue
        centroid_xy = (float(coordinates[0][0]), float(coordinates[0][1]))
        centroids_from_cc[taz_id] = centroid_xy
        endpoint = Point(coordinates[-1])
        polygon = taz_by_id[taz_id]
        sequence[taz_id] += 1
        connector_rows.append(
            {
                "tazId": taz_id,
                "ccPt": f"{taz_id}_GLOBAL{sequence[taz_id]}",
                "nodeId": node_id,
                "density": 0,
                "rank": 0,
                "majorLevel": node_levels.get(node_id),
                "outsideLen": round(float(row.geometry.difference(polygon).length), 3),
                "endBoundaryDist": round(float(endpoint.distance(polygon.boundary)), 3),
                "interiorFallback": endpoint.distance(polygon.boundary) > 200.000001,
                "lineNodeDist": 0,
                "status": "unreviewed",
                "geom": rounded_geometry(row.geometry),
            }
        )

    taz_rows: list[dict[str, Any]] = []
    centroid_rows: list[dict[str, Any]] = []
    order_rows: list[dict[str, Any]] = []
    for taz_id in sorted(taz_ids, key=int):
        polygon = taz_by_id[taz_id]
        display_geometry = polygon.simplify(simplify_feet, preserve_topology=True)
        centroid = centroids_from_cc.get(taz_id)
        if centroid is None:
            point = polygon.centroid
            centroid = (float(point.x), float(point.y))
        connector_count = int(counts[taz_id])
        issue = "NO_GLOBAL_CC" if connector_count == 0 else ""
        flag = "Y" if connector_count == 0 else "N"
        order_rows.append(
            {"id": taz_id, "flag": flag, "issue": issue, "connectors": connector_count}
        )
        taz_rows.append(
            {
                "id": taz_id,
                "flag": flag,
                "issue": issue,
                "selected": connector_count,
                "target": connector_count,
                "minimum": 0,
                "geom": rounded_geometry(display_geometry),
            }
        )
        centroid_rows.append(
            {"id": taz_id, "x": round(centroid[0], 1), "y": round(centroid[1], 1)}
        )

    return {
        "schemaVersion": 1,
        "dataset": "GSTDM2025 Global TAZ and Global CC",
        "sourceTaz": taz_path.as_posix(),
        "sourceCc": cc_path.as_posix(),
        "sourceCrs": PROJECTED_CRS,
        "simplifyFeet": simplify_feet,
        "count": len(taz_rows),
        "counts": {
            "tazs": len(taz_rows),
            "connectors": len(connector_rows),
            "zeroConnectorTazs": sum(1 for item in order_rows if item["connectors"] == 0),
            "connectorNodeMajorLevels": sum(
                1 for item in connector_rows if item["majorLevel"] is not None
            ),
        },
        "tazOrder": order_rows,
        "tazs": taz_rows,
        "centroids": centroid_rows,
        "connectors": connector_rows,
    }


def write_chunked_payload(
    payload: dict[str, Any],
    output: Path,
    chunk_size: int,
    target_bytes: int,
) -> int:
    chunk_size = max(1, int(chunk_size))
    chunk_root = output.parent / "global-review-chunks"
    chunk_root.mkdir(parents=True, exist_ok=True)
    connectors_by_taz: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for connector in payload["connectors"]:
        connectors_by_taz[str(connector["tazId"])].append(connector)

    groups: list[list[dict[str, Any]]] = []
    current_group: list[dict[str, Any]] = []
    current_bytes = 0
    for taz in payload["tazs"]:
        taz_id = str(taz["id"])
        estimated_bytes = len(json.dumps(taz, ensure_ascii=True, separators=(",", ":")))
        estimated_bytes += sum(
            len(json.dumps(item, ensure_ascii=True, separators=(",", ":")))
            for item in connectors_by_taz.get(taz_id, [])
        )
        if current_group and (
            len(current_group) >= chunk_size
            or current_bytes + estimated_bytes > target_bytes
        ):
            groups.append(current_group)
            current_group = []
            current_bytes = 0
        current_group.append(taz)
        current_bytes += estimated_bytes
    if current_group:
        groups.append(current_group)

    chunk_items: list[dict[str, Any]] = []
    chunk_by_taz: dict[str, str] = {}
    for chunk_number, chunk_tazs in enumerate(groups):
        chunk_id = f"{chunk_number:04d}"
        taz_ids = [str(item["id"]) for item in chunk_tazs]
        chunk_connectors = [
            connector
            for taz_id in taz_ids
            for connector in connectors_by_taz.get(taz_id, [])
        ]
        chunk_payload = {
            "schemaVersion": 1,
            "chunk": chunk_id,
            "tazs": chunk_tazs,
            "connectors": chunk_connectors,
        }
        chunk_path = chunk_root / f"{chunk_id}.json"
        chunk_path.write_text(
            json.dumps(chunk_payload, ensure_ascii=True, separators=(",", ":")),
            encoding="utf-8",
        )
        for taz_id in taz_ids:
            chunk_by_taz[taz_id] = chunk_id
        chunk_items.append(
            {
                "id": chunk_id,
                "url": f"data/global-review-chunks/{chunk_id}.json",
                "firstTaz": taz_ids[0],
                "lastTaz": taz_ids[-1],
                "tazs": len(chunk_tazs),
                "connectors": len(chunk_connectors),
            }
        )

    index_payload = {
        key: value
        for key, value in payload.items()
        if key not in {"tazs", "connectors"}
    }
    index_payload["schemaVersion"] = 2
    index_payload["tazOrder"] = [
        {**item, "chunk": chunk_by_taz[str(item["id"])]}
        for item in payload["tazOrder"]
    ]
    index_payload["globalReviewChunks"] = {
        "chunkSize": chunk_size,
        "items": chunk_items,
    }
    output.write_text(
        json.dumps(index_payload, ensure_ascii=True, separators=(",", ":")),
        encoding="utf-8",
    )
    return len(chunk_items)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish GSTDM2025 Global TAZ and Global CC as a separate review dataset."
    )
    parser.add_argument("--input-root", type=Path, default=Path("input/GSTDM2025"))
    parser.add_argument("--output", type=Path, default=Path("docs/data/global-review.json"))
    parser.add_argument("--node-gpkg", type=Path)
    parser.add_argument(
        "--simplify-feet",
        type=float,
        default=100.0,
        help="Topology-preserving TAZ simplification used only for the browser review layer.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1000,
        help="Maximum number of Global TAZ geometries in each lazily loaded browser chunk.",
    )
    parser.add_argument(
        "--chunk-target-mib",
        type=float,
        default=2.0,
        help="Approximate maximum serialized size of each chunk before starting a new one.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    taz_path, cc_path = locate_sources(args.input_root)
    payload = build_payload(
        taz_path,
        cc_path,
        simplify_feet=max(0.0, args.simplify_feet),
        node_levels=node_major_levels(args.node_gpkg),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    chunk_count = write_chunked_payload(
        payload,
        args.output,
        max(1, args.chunk_size),
        max(256 * 1024, int(args.chunk_target_mib * 1024 * 1024)),
    )
    print(
        f"Wrote {args.output}: {payload['counts']['tazs']} Global TAZs, "
        f"{payload['counts']['connectors']} Global CCs, "
        f"{payload['counts']['zeroConnectorTazs']} zero-CC TAZs, "
        f"{chunk_count} chunk(s)."
    )


if __name__ == "__main__":
    main()
