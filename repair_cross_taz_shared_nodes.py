"""Repair cross-TAZ shared centroid-connector endpoints.

The browser export contains reciprocal A/B rows but no geometry.  This utility
normalizes those rows to TAZ-to-node pairs, keeps one owner on every shared
node, moves the remaining connector(s) to nearby eligible and unused GSTDM
nodes, and rebuilds a reciprocal line shapefile plus audit files.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
from shapely import STRtree
from shapely.geometry import LineString, Point


PROJECTED_CRS = "ESRI:102604"
BOUNDARY_TOLERANCE_FEET = 200.0
ANGLE_TOLERANCE_DEGREES = 70.0


def clean_id(value: Any) -> str:
    number = pd.to_numeric(value, errors="coerce")
    if pd.isna(number):
        return str(value).strip().removesuffix(".0")
    return str(int(number))


def numeric_key(value: str) -> tuple[int, float | str, str]:
    try:
        return 0, float(value), value
    except (TypeError, ValueError):
        return 1, value, value


def bearing(origin: Point, destination: Point) -> float:
    dx = destination.x - origin.x
    dy = destination.y - origin.y
    return float((math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0)


def angular_difference(first: float, second: float) -> float:
    difference = abs(first - second) % 360.0
    return min(difference, 360.0 - difference)


def normalize_cc_pairs(frame: pd.DataFrame, taz_ids: set[str]) -> list[tuple[str, str]]:
    missing = {"A", "B", "FCLASS"} - set(frame.columns)
    if missing:
        raise SystemExit(f"CC input is missing field(s): {', '.join(sorted(missing))}")
    pairs: set[tuple[str, str]] = set()
    invalid = 0
    for row in frame.itertuples(index=False):
        a = clean_id(row.A)
        b = clean_id(row.B)
        fclass = clean_id(row.FCLASS)
        if fclass != "32":
            invalid += 1
            continue
        if a in taz_ids and b not in taz_ids:
            pairs.add((a, b))
        elif b in taz_ids and a not in taz_ids:
            pairs.add((b, a))
        else:
            invalid += 1
    if invalid:
        raise SystemExit(f"CC input contains {invalid} invalid or ambiguous directional record(s).")
    if len(pairs) * 2 != len(frame):
        raise SystemExit(
            "CC input is not a complete reciprocal export: "
            f"{len(frame)} record(s), {len(pairs)} unique pair(s)."
        )
    return sorted(pairs, key=lambda item: (numeric_key(item[0]), numeric_key(item[1])))


def centroid_lookup(
    source_cc: gpd.GeoDataFrame,
    taz_ids: set[str],
    taz_geometries: dict[str, Any],
) -> dict[str, Point]:
    result: dict[str, Point] = {}
    for row in source_cc.itertuples(index=False):
        a = clean_id(row.A)
        b = clean_id(row.B)
        if a not in taz_ids or b in taz_ids or row.geometry is None or row.geometry.is_empty:
            continue
        coordinates = list(row.geometry.coords)
        if coordinates:
            result.setdefault(a, Point(coordinates[0]))
    for taz_id, geometry in taz_geometries.items():
        result.setdefault(taz_id, geometry.centroid)
    return result


def node_levels_and_outside(
    links: gpd.GeoDataFrame,
) -> tuple[dict[str, float], set[str]]:
    func_class = pd.to_numeric(links["FUNC_CLASS"], errors="coerce")
    a_ids = links["A"].map(clean_id)
    b_ids = links["B"].map(clean_id)
    endpoints = pd.concat(
        [
            pd.DataFrame({"node": a_ids, "level": func_class}),
            pd.DataFrame({"node": b_ids, "level": func_class}),
        ],
        ignore_index=True,
    ).dropna()
    levels = endpoints.groupby("node", sort=False)["level"].min().to_dict()

    nonga = pd.to_numeric(links.get("NONGA"), errors="coerce").fillna(0).eq(1)
    nonga_nodes = set(a_ids[nonga]) | set(b_ids[nonga])
    ga_nodes = set(a_ids[~nonga]) | set(b_ids[~nonga])
    return levels, nonga_nodes - ga_nodes


def crosses_network(
    connector: LineString,
    endpoint: Point,
    link_tree: STRtree,
    link_geometries: list[Any],
) -> bool:
    endpoint_zone = endpoint.buffer(0.01)
    for raw_index in link_tree.query(connector, predicate="intersects"):
        intersection = connector.intersection(link_geometries[int(raw_index)])
        if not intersection.difference(endpoint_zone).is_empty:
            return True
    return False


def build_directional_rows(
    pairs: list[tuple[str, str]],
    centroids: dict[str, Point],
    node_points: dict[str, Point],
) -> gpd.GeoDataFrame:
    records: list[dict[str, Any]] = []
    for taz_id, node_id in pairs:
        centroid = centroids[taz_id]
        endpoint = node_points[node_id]
        forward = LineString([centroid, endpoint])
        records.append({"A": int(taz_id), "B": int(node_id), "FCLASS": 32, "geometry": forward})
        records.append(
            {
                "A": int(node_id),
                "B": int(taz_id),
                "FCLASS": 32,
                "geometry": LineString(list(forward.coords)[::-1]),
            }
        )
    return gpd.GeoDataFrame(records, geometry="geometry", crs=PROJECTED_CRS)


def repair_pairs(
    pairs: list[tuple[str, str]],
    taz_geometries: dict[str, Any],
    centroids: dict[str, Point],
    nodes: gpd.GeoDataFrame,
    links: gpd.GeoDataFrame,
) -> tuple[list[tuple[str, str]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    node_ids = [clean_id(value) for value in nodes["N"]]
    node_geometries = list(nodes.geometry)
    node_points = dict(zip(node_ids, node_geometries))
    node_index = {node_id: index for index, node_id in enumerate(node_ids)}
    levels, outside_ga = node_levels_and_outside(links)
    eligible_indices = [
        index
        for index, node_id in enumerate(node_ids)
        if node_id in outside_ga or levels.get(node_id, -1) > 2
    ]
    eligible_geometries = [node_geometries[index] for index in eligible_indices]
    eligible_tree = STRtree(eligible_geometries)
    link_geometries = list(links.geometry)
    link_tree = STRtree(link_geometries)

    owners_by_node: defaultdict[str, set[str]] = defaultdict(set)
    nodes_by_taz: defaultdict[str, set[str]] = defaultdict(set)
    for taz_id, node_id in pairs:
        owners_by_node[node_id].add(taz_id)
        nodes_by_taz[taz_id].add(node_id)
    original_conflicts = {
        node_id: set(owners)
        for node_id, owners in owners_by_node.items()
        if len(owners) > 1
    }
    occupied_nodes = set(owners_by_node)
    pair_set = set(pairs)
    audit: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    candidates_cache: dict[str, list[int]] = {}

    def candidate_indices(taz_id: str) -> list[int]:
        if taz_id not in candidates_cache:
            search_geometry = taz_geometries[taz_id].buffer(BOUNDARY_TOLERANCE_FEET)
            local_indices = eligible_tree.query(search_geometry, predicate="intersects")
            candidates_cache[taz_id] = sorted(
                (eligible_indices[int(index)] for index in local_indices),
                key=lambda index: numeric_key(node_ids[index]),
            )
        return candidates_cache[taz_id]

    def ranked_candidates(taz_id: str, old_node_id: str) -> list[dict[str, Any]]:
        polygon = taz_geometries[taz_id]
        centroid = centroids[taz_id]
        old_point = node_points[old_node_id]
        other_nodes = nodes_by_taz[taz_id] - {old_node_id}
        other_bearings = [
            bearing(centroid, node_points[node_id])
            for node_id in other_nodes
            if node_id in node_points
        ]
        ranked: list[dict[str, Any]] = []
        ranked_node_ids: set[str] = set()

        def collect(pool: list[int], enforce_boundary: bool) -> None:
            for index in pool:
                new_node_id = node_ids[index]
                if (
                    new_node_id == old_node_id
                    or new_node_id in occupied_nodes
                    or new_node_id in other_nodes
                    or new_node_id in ranked_node_ids
                ):
                    continue
                endpoint = node_geometries[index]
                connector = LineString([centroid, endpoint])
                outside_length = float(connector.difference(polygon).length)
                if enforce_boundary and outside_length > BOUNDARY_TOLERANCE_FEET + 1e-6:
                    continue
                new_bearing = bearing(centroid, endpoint)
                minimum_angle = min(
                    (angular_difference(new_bearing, value) for value in other_bearings),
                    default=180.0,
                )
                distance = float(old_point.distance(endpoint))
                ranked.append(
                    {
                        "node_id": new_node_id,
                        "node_index": index,
                        "distance": distance,
                        "outside_length": outside_length,
                        "minimum_angle": minimum_angle,
                        "connector": connector,
                        "endpoint": endpoint,
                        "crosses": None,
                        "major_level": levels.get(new_node_id),
                        "outside_ga": new_node_id in outside_ga,
                        "boundary_fallback": not enforce_boundary,
                        "score": (
                            distance,
                            1 if minimum_angle + 1e-9 < ANGLE_TOLERANCE_DEGREES else 0,
                        )
                        + (numeric_key(new_node_id),),
                    }
                )
                ranked_node_ids.add(new_node_id)

        strict_pool = sorted(
            candidate_indices(taz_id),
            key=lambda index: old_point.distance(node_geometries[index]),
        )[:250]
        collect(strict_pool, True)
        # Also consider the nearest spatial neighbors even when they lie beyond
        # the TAZ boundary override threshold.  This prevents a very large
        # external TAZ from selecting an in-zone node tens of miles away.
        fallback_pool: list[int] = []
        for radius in (500.0, 1000.0, 2500.0, 5000.0, 10000.0, 25000.0, 50000.0, 100000.0):
            nearby = eligible_tree.query(old_point.buffer(radius), predicate="intersects")
            available = [
                eligible_indices[int(index)]
                for index in nearby
                if node_ids[eligible_indices[int(index)]] not in occupied_nodes
            ]
            if available:
                fallback_pool = sorted(
                    available,
                    key=lambda index: old_point.distance(node_geometries[index]),
                )[:100]
                break
        collect(fallback_pool, False)
        ranked.sort(key=lambda item: item["score"])
        if not ranked:
            return []
        # Road-crossing checks are much more expensive than spatial candidate
        # lookup.  Check the closest well-angled options lazily and stop at the
        # first clean candidate.  If all checked options cross, retain the
        # nearest candidate and record a manual-review warning.
        checked: list[dict[str, Any]] = []
        for item in ranked[:20]:
            item["crosses"] = crosses_network(
                item["connector"],
                item["endpoint"],
                link_tree,
                link_geometries,
            )
            checked.append(item)
            if not item["crosses"]:
                return [item]
        return [checked[0]]

    for old_node_id in sorted(original_conflicts, key=numeric_key):
        current_owners = sorted(owners_by_node[old_node_id], key=numeric_key)
        alternatives = {
            taz_id: ranked_candidates(taz_id, old_node_id)
            for taz_id in current_owners
        }

        def keeper_difficulty(taz_id: str) -> tuple[Any, ...]:
            choices = alternatives[taz_id]
            if not choices:
                return (2, float("inf"), numeric_key(taz_id))
            best = choices[0]
            return (
                int(bool(best["crosses"])) + int(best["minimum_angle"] < ANGLE_TOLERANCE_DEGREES),
                best["distance"],
                numeric_key(taz_id),
            )

        keeper = max(current_owners, key=keeper_difficulty)
        movers = sorted(
            (taz_id for taz_id in current_owners if taz_id != keeper),
            key=lambda taz_id: (
                alternatives[taz_id][0]["score"] if alternatives[taz_id] else (9, 9, float("inf"), (9, "", "")),
                numeric_key(taz_id),
            ),
        )
        for taz_id in movers:
            choices = ranked_candidates(taz_id, old_node_id)
            if not choices:
                unresolved.append(
                    {
                        "TAZ_ID": taz_id,
                        "OLD_NODE_ID": old_node_id,
                        "KEEPER_TAZ_ID": keeper,
                        "REASON": "NO_ELIGIBLE_UNUSED_NODE_WITHIN_TAZ_OR_200FT",
                    }
                )
                continue
            choice = choices[0]
            new_node_id = str(choice["node_id"])
            pair_set.remove((taz_id, old_node_id))
            pair_set.add((taz_id, new_node_id))
            nodes_by_taz[taz_id].remove(old_node_id)
            nodes_by_taz[taz_id].add(new_node_id)
            owners_by_node[old_node_id].remove(taz_id)
            owners_by_node[new_node_id].add(taz_id)
            occupied_nodes.add(new_node_id)
            audit.append(
                {
                    "TAZ_ID": taz_id,
                    "OLD_SHARED_NODE_ID": old_node_id,
                    "NEW_NODE_ID": new_node_id,
                    "KEEPER_TAZ_ID": keeper,
                    "OLD_OWNER_COUNT": len(current_owners),
                    "NEW_NODE_DISTANCE_FT": round(float(choice["distance"]), 3),
                    "NEW_NODE_MAJOR_LEVEL": choice["major_level"],
                    "NEW_NODE_OUTSIDE_GA": int(bool(choice["outside_ga"])),
                    "OUTSIDE_TAZ_LENGTH_FT": round(float(choice["outside_length"]), 3),
                    "MIN_ANGLE_DEG": round(float(choice["minimum_angle"]), 3),
                    "CROSSES_GSTDM": int(bool(choice["crosses"])),
                    "BOUNDARY_FALLBACK": int(bool(choice["boundary_fallback"])),
                    "REVIEW_WARNING": "; ".join(
                        item
                        for item in (
                            "GSTDM_CROSSING" if choice["crosses"] else "",
                            "ANGLE_LT_70" if choice["minimum_angle"] < ANGLE_TOLERANCE_DEGREES else "",
                            "OUTSIDE_TAZ_GT_200"
                            if choice["outside_length"] > BOUNDARY_TOLERANCE_FEET + 1e-6
                            else "",
                        )
                        if item
                    ),
                }
            )

    repaired_pairs = sorted(
        pair_set,
        key=lambda item: (numeric_key(item[0]), numeric_key(item[1])),
    )
    final_owners: defaultdict[str, set[str]] = defaultdict(set)
    for taz_id, node_id in repaired_pairs:
        final_owners[node_id].add(taz_id)
    remaining = [
        {
            "NODE_ID": node_id,
            "OWNER_COUNT": len(owners),
            "TAZ_IDS": "|".join(sorted(owners, key=numeric_key)),
        }
        for node_id, owners in sorted(final_owners.items(), key=lambda item: numeric_key(item[0]))
        if len(owners) > 1
    ]
    summary = {
        "inputPairs": len(pairs),
        "outputPairs": len(repaired_pairs),
        "originalSharedNodes": len(original_conflicts),
        "originalAffectedTazs": len(set().union(*original_conflicts.values())),
        "requiredMoves": sum(len(owners) - 1 for owners in original_conflicts.values()),
        "completedMoves": len(audit),
        "unresolvedMoves": len(unresolved),
        "remainingSharedNodes": len(remaining),
        "movedTazs": len({row["TAZ_ID"] for row in audit}),
        "newNodeCrossingWarnings": sum(int(row["CROSSES_GSTDM"]) for row in audit),
        "newNodeAngleWarnings": sum("ANGLE_LT_70" in row["REVIEW_WARNING"] for row in audit),
        "newNodeIneligible": 0,
        "newNodeOutsideTolerance": sum(
            float(row["OUTSIDE_TAZ_LENGTH_FT"]) > BOUNDARY_TOLERANCE_FEET + 1e-6
            for row in audit
        ),
        "originalOwnerHistogram": dict(
            sorted(Counter(len(owners) for owners in original_conflicts.values()).items())
        ),
    }
    return repaired_pairs, audit, unresolved, {"remaining": remaining, "summary": summary}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cc-dbf", type=Path, required=True)
    parser.add_argument("--taz-shp", type=Path, required=True)
    parser.add_argument("--node-shp", type=Path, required=True)
    parser.add_argument("--link-shp", type=Path, required=True)
    parser.add_argument("--source-cc-shp", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    taz = gpd.read_file(args.taz_shp).to_crs(PROJECTED_CRS)
    nodes = gpd.read_file(args.node_shp).to_crs(PROJECTED_CRS)
    links = gpd.read_file(args.link_shp, columns=["A", "B", "FUNC_CLASS", "NONGA"]).to_crs(
        PROJECTED_CRS
    )
    source_cc = gpd.read_file(args.source_cc_shp).to_crs(PROJECTED_CRS)
    cc = gpd.read_file(args.cc_dbf)
    taz["_ID"] = taz["NEWID"].map(clean_id)
    taz_geometries = dict(zip(taz["_ID"], taz.geometry))
    taz_ids = set(taz_geometries)
    pairs = normalize_cc_pairs(cc, taz_ids)
    centroids = centroid_lookup(source_cc, taz_ids, taz_geometries)
    node_points = dict(zip(nodes["N"].map(clean_id), nodes.geometry))
    missing_nodes = sorted({node_id for _, node_id in pairs} - set(node_points), key=numeric_key)
    if missing_nodes:
        raise SystemExit(f"CC input references {len(missing_nodes)} missing GSTDM node(s): {missing_nodes[:10]}")

    repaired_pairs, audit, unresolved, result = repair_pairs(
        pairs,
        taz_geometries,
        centroids,
        nodes,
        links,
    )
    directional = build_directional_rows(repaired_pairs, centroids, node_points)
    shape_path = output_dir / "GSTDM2025_TAZ_CC_LINK.shp"
    directional.to_file(shape_path, driver="ESRI Shapefile", index=False)
    directional.drop(columns="geometry").to_csv(
        output_dir / "cube_taz_cc_public.csv",
        index=False,
    )
    pd.DataFrame(audit).to_csv(output_dir / "shared_node_repair_audit.csv", index=False)
    pd.DataFrame(unresolved).to_csv(output_dir / "shared_node_repair_unresolved.csv", index=False)
    pd.DataFrame(result["remaining"]).to_csv(
        output_dir / "remaining_cross_taz_shared_nodes.csv",
        index=False,
    )
    review_payload = {
        "schemaVersion": 1,
        "dataset": "TAZs changed by automatic cross-TAZ shared-node repair",
        "count": len({row["TAZ_ID"] for row in audit}),
        "tazIds": sorted({row["TAZ_ID"] for row in audit}, key=numeric_key),
    }
    (output_dir / "review-auto-fixed-shared.json").write_text(
        json.dumps(review_payload, indent=2),
        encoding="utf-8",
    )
    (output_dir / "shared_node_repair_summary.json").write_text(
        json.dumps(result["summary"], indent=2),
        encoding="utf-8",
    )
    print(json.dumps(result["summary"], indent=2))
    if unresolved or result["remaining"]:
        raise SystemExit("Repair did not resolve every cross-TAZ shared node; inspect audit outputs.")


if __name__ == "__main__":
    main()
