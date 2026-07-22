from __future__ import annotations

import json
import math
import shutil
import argparse
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd


CONTEXT_FEET = 1.5 * 5280
ROUND_DIGITS = 1


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
    issue_rank = 0 if item.get("issue") == "NO_ELIGIBLE_SECTOR_NODE" else 1
    flag_rank = 0 if item.get("flag") == "Y" else 1
    try:
        numeric_id: int | str = int(item["id"])
    except ValueError:
        numeric_id = item["id"]
    return (flag_rank, issue_rank, numeric_id)


def write_json(path: Path, data: Any) -> None:
    text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(text, encoding="utf-8")
    tmp_path.replace(path)


def connector_item(row: Any, taz_id: str) -> dict[str, Any]:
    return {
        "tazId": taz_id,
        "ccPt": str(row.get("CC_PT") or ""),
        "nodeId": id_text(row.get("CC_NODE")),
        "density": number(row.get("DENSITY"), 0),
        "rank": int(number(row.get("DENS_RANK"), 0) or 0),
        "majorLevel": number(row.get("MAJOR_LEVEL")),
        "outsideLen": number(row.get("OUTSIDE_LEN"), 0),
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
    return {
        "schemaVersion": 2,
        "generatedFrom": run_folder.name,
        "nodeSource": run_folder.name,
        "count": len(taz_order),
        "contextFeet": CONTEXT_FEET,
        "tazOrder": taz_order,
        "tazs": taz_items,
        "centroids": centroid_items,
        "connectors": connector_items,
        "nodes": [node_item(row) for _, row in nodes.iterrows()],
        "links": [link_item(row) for _, row in review_links.iterrows()],
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
        "schemaVersion": 2,
        "generatedFrom": index.get("generatedFrom", "existing-static-data"),
        "count": len(order),
        "contextFeet": CONTEXT_FEET,
        "tazOrder": order,
        "tazs": taz_items,
        "centroids": centroids,
        "connectors": connectors,
        "nodes": list(nodes_by_id.values()),
        "links": list(links_by_id.values()),
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
    parser = argparse.ArgumentParser(description="Build one deduplicated static QAQC data file.")
    parser.add_argument(
        "--from-existing-static",
        action="store_true",
        help="Migrate the existing per-TAZ docs data without changing its run contents.",
    )
    parser.add_argument(
        "--from-existing-all",
        action="store_true",
        help="Revalidate and repair the existing docs/data/all.json without changing its run contents.",
    )
    parser.add_argument(
        "--keep-per-taz",
        action="store_true",
        help="Keep legacy docs/data/taz JSON files after all.json is verified.",
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
    added_nodes = ensure_connector_nodes(payload)
    write_json(all_path, payload)
    verified = json.loads(all_path.read_text(encoding="utf-8"))
    if verified.get("schemaVersion") != 2 or len(verified.get("tazs", [])) != len(verified.get("tazOrder", [])):
        raise SystemExit("Generated all.json failed validation; legacy files were kept.")
    if not args.keep_per_taz:
        taz_dir = (docs_data / "taz").resolve()
        if taz_dir.exists() and taz_dir.parent == docs_data.resolve():
            shutil.rmtree(taz_dir)
        legacy_index = (docs_data / "index.json").resolve()
        if legacy_index.exists() and legacy_index.parent == docs_data.resolve():
            legacy_index.unlink()
    print(
        f"Wrote {all_path}: {len(payload['tazs'])} TAZs, {len(payload['connectors'])} CCs, "
        f"{len(payload['nodes'])} nodes, {len(payload['links'])} links from {payload['generatedFrom']} "
        f"({added_nodes} connector endpoint nodes added, {augmented_nodes} full-layer nodes added)"
    )


if __name__ == "__main__":
    main()
