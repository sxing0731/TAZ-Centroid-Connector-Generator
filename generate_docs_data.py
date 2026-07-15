from __future__ import annotations

import json
import math
import shutil
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


def main() -> None:
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

    docs_data = Path("docs") / "data"
    taz_dir = docs_data / "taz"
    taz_dir.mkdir(parents=True, exist_ok=True)

    flags = gpd.read_file(gpkg, layer="taz_snap_flags")
    centroids = gpd.read_file(gpkg, layer="taz_centroids")
    connectors = gpd.read_file(gpkg, layer="final_connector_lines")
    nodes = gpd.read_file(gpkg, layer="gstdm_master_nodes")
    links = gpd.read_file(gpkg, layer="gstdm_links")

    for frame in (flags, centroids, connectors, nodes, links):
        frame["_ID"] = frame["N"].map(id_text) if "N" in frame.columns else ""
    centroids_by_id = centroids.set_index("_ID")
    connectors_by_taz = {key: group.copy() for key, group in connectors.groupby("_ID", sort=False)}

    taz_order: list[dict[str, Any]] = []
    all_taz: list[dict[str, Any]] = []
    valid_ids: set[str] = set()

    for _, row in flags.iterrows():
        taz_id = id_text(row["N"])
        valid_ids.add(taz_id)
        flag = str(row.get("SNAP_FLAG") or "N")
        issue = str(row.get("SNAP_ISSUE") or "").strip()
        selected = int(number(row.get("SELECTED"), 0) or 0)
        target = int(number(row.get("TARGET"), 4) or 4)
        minimum = int(number(row.get("MINIMUM"), 2) or 2)
        taz_connectors = connectors_by_taz.get(taz_id, connectors.iloc[[]])

        order_item = {
            "id": taz_id,
            "flag": flag,
            "issue": issue,
            "connectors": int(len(taz_connectors)),
            "file": f"data/taz/{taz_id}.json",
        }
        taz_order.append(order_item)
        all_taz.append({"id": taz_id, "flag": flag, "issue": issue, "geom": geom_json(row.geometry, 120)})

        centroid_geom = centroids_by_id.loc[taz_id].geometry if taz_id in centroids_by_id.index else row.geometry.centroid
        context = row.geometry.buffer(CONTEXT_FEET)
        context_nodes = spatial_subset(nodes, context)
        context_links = spatial_subset(links, context)

        connector_items = []
        for _, c in taz_connectors.iterrows():
            connector_items.append(
                {
                    "ccPt": str(c.get("CC_PT") or ""),
                    "nodeId": id_text(c.get("CC_NODE")),
                    "density": number(c.get("DENSITY"), 0),
                    "rank": int(number(c.get("DENS_RANK"), 0) or 0),
                    "majorLevel": number(c.get("MAJOR_LEVEL")),
                    "outsideLen": number(c.get("OUTSIDE_LEN"), 0),
                    "lineNodeDist": number(c.get("LINE_NODE_DIST"), 0),
                    "status": "unreviewed",
                    "geom": geom_json(c.geometry),
                }
            )

        node_items = []
        for _, n in context_nodes.iterrows():
            major_level = number(n.get("MAJOR_LEVEL"))
            node_items.append(
                {
                    "id": id_text(n.get("N")),
                    "x": round(float(n.geometry.x), ROUND_DIGITS),
                    "y": round(float(n.geometry.y), ROUND_DIGITS),
                    "majorLevel": major_level,
                    "majorInt": str(n.get("MAJOR_INT") or "N"),
                    "eligible": bool(major_level is not None and major_level > 2),
                }
            )

        link_items = []
        for _, link in context_links.iterrows():
            clipped = link.geometry.intersection(context)
            if clipped.is_empty:
                continue
            link_items.append(
                {
                    "a": id_text(link.get("A")),
                    "b": id_text(link.get("B")),
                    "linkId": id_text(link.get("LINK_ID")),
                    "funcClass": str(link.get("FUNC_CLASS") or ""),
                    "geom": geom_json(clipped, 10),
                }
            )

        payload = {
            "tazId": taz_id,
            "flag": flag,
            "issue": issue,
            "selected": selected,
            "target": target,
            "minimum": minimum,
            "taz": geom_json(row.geometry, 25),
            "centroid": [round(float(centroid_geom.x), ROUND_DIGITS), round(float(centroid_geom.y), ROUND_DIGITS)],
            "connectors": connector_items,
            "nodes": node_items,
            "links": link_items,
        }
        write_json(taz_dir / f"{taz_id}.json", payload)

    for old_file in taz_dir.glob("*.json"):
        if old_file.stem not in valid_ids:
            old_file.unlink()

    taz_order.sort(key=sort_key)
    all_taz.sort(key=lambda item: sort_key({"id": item["id"], "flag": item["flag"], "issue": item["issue"]}))
    index = {
        "generatedFrom": run_folder.name,
        "count": len(taz_order),
        "tazOrder": taz_order,
        "allTaz": all_taz,
    }
    write_json(docs_data / "index.json", index)
    print(f"Wrote {len(taz_order)} TAZ files from {run_folder}")


if __name__ == "__main__":
    main()
