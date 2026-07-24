from __future__ import annotations

import itertools
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point


ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).resolve().parent

PRE_CC_CSV = (
    ROOT
    / "output"
    / "019f9222-2c62-7303-abf3-14e7f9c9bc0e"
    / "shared_node_repair_staging"
    / "cube_taz_cc_public.csv"
)
PRE_CC_SHP = PRE_CC_CSV.parent / "GSTDM2025_TAZ_CC_LINK.shp"
PRE_REPAIR_AUDIT = PRE_CC_CSV.parent / "shared_node_repair_audit.csv"

POST_CC_CSV = ROOT / "input" / "default" / "cube_taz_cc_public.csv"
POST_CC_SHP = (
    ROOT
    / "output"
    / "019f9222-2c62-7303-abf3-14e7f9c9bc0e"
    / "baseline_20260724_input_1_staging"
    / "GSTDM2025_TAZ_CC_LINK.shp"
)
POST_MISS_CSV = ROOT / "input" / "default" / "HERE_MISS_links.csv"

GLOBAL_REVIEW_JSON = ROOT / "docs" / "data" / "global-review.json"
NODE_INDEX_JSON = ROOT / "docs" / "data" / "tiles" / "node-index.json"
NODE_TILE_DIR = ROOT / "docs" / "data" / "tiles" / "nodes"
NETWORK_LINK_SHP = (
    ROOT
    / "input"
    / "GSTDM2025"
    / "GSTDM_2025"
    / "GSTDM_2025_LINK_0721.shp"
)
TAZ_SHP = (
    ROOT
    / "input"
    / "GSTDM2025"
    / "GSTDM_2025TAZ"
    / "GSTDM_2025TAZ"
    / "GSTDM_2025TAZ_06_16_2026.shp"
)
PRE_MISS_PAIR_COUNT = 17


def as_text(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        try:
            return str(int(float(text)))
        except ValueError:
            return text
    return text


def unordered_numeric_pair(first: object, second: object) -> tuple[str, str]:
    return tuple(sorted((as_text(first), as_text(second)), key=int))


def pct(numerator: int | float, denominator: int | float) -> float | None:
    return round(100.0 * numerator / denominator, 4) if denominator else None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def quantiles(values: list[float]) -> dict[str, float | None]:
    clean = [float(v) for v in values if pd.notna(v)]
    if not clean:
        return {"min": None, "p25": None, "median": None, "p75": None, "max": None}
    series = pd.Series(clean)
    return {
        "min": round(float(series.min()), 3),
        "p25": round(float(series.quantile(0.25)), 3),
        "median": round(float(series.median()), 3),
        "p75": round(float(series.quantile(0.75)), 3),
        "max": round(float(series.max()), 3),
    }


def circular_difference_degrees(first: float, second: float) -> float:
    return abs((second - first + 180.0) % 360.0 - 180.0)


def bearing_degrees(start: tuple[float, float], end: tuple[float, float]) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def directed_profile(frame: pd.DataFrame, expected_columns: list[str]) -> dict[str, object]:
    rows = [
        tuple(as_text(row[column]) for column in expected_columns)
        for _, row in frame.iterrows()
    ]
    directed_ab = [(row[0], row[1]) for row in rows]
    directed_set = set(directed_ab)
    pair_set = {unordered_numeric_pair(*pair) for pair in directed_ab}
    return {
        "rows": len(rows),
        "pairs": len(pair_set),
        "columns": list(frame.columns),
        "duplicate_directed_rows": len(directed_ab) - len(directed_set),
        "missing_reverse_records": sum(
            (b, a) not in directed_set for a, b in directed_set
        ),
        "self_loops": sum(a == b for a, b in directed_set),
    }


def canonical_cc_pairs(frame: pd.DataFrame, taz_ids: set[str]) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    ambiguous: list[tuple[str, str]] = []
    for a, b in zip(frame["A"], frame["B"]):
        a_text, b_text = as_text(a), as_text(b)
        membership = (a_text in taz_ids, b_text in taz_ids)
        if membership == (True, False):
            pairs.add((a_text, b_text))
        elif membership == (False, True):
            pairs.add((b_text, a_text))
        elif tuple(sorted((a_text, b_text))) not in {
            tuple(sorted(pair)) for pair in pairs
        }:
            ambiguous.append((a_text, b_text))
    if ambiguous:
        raise ValueError(f"Ambiguous CC endpoint roles: {ambiguous[:10]}")
    return pairs


def canonical_miss_pairs(frame: pd.DataFrame) -> set[tuple[str, str]]:
    return {
        unordered_numeric_pair(a, b)
        for a, b in zip(frame["A"], frame["B"])
    }


def ordered_miss_pairs(frame: pd.DataFrame) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for a, b in zip(frame["A"], frame["B"]):
        pair = unordered_numeric_pair(a, b)
        if pair not in seen:
            seen.add(pair)
            result.append(pair)
    return result


def load_node_attributes(node_ids: set[str]) -> dict[str, dict[str, object]]:
    node_index = json.loads(NODE_INDEX_JSON.read_text(encoding="utf-8"))
    by_tile: dict[str, set[str]] = defaultdict(set)
    missing_index: list[str] = []
    for node_id in node_ids:
        tile_id = node_index.get(node_id)
        if tile_id is None:
            missing_index.append(node_id)
        else:
            by_tile[tile_id].add(node_id)

    result: dict[str, dict[str, object]] = {}
    for tile_id, wanted in by_tile.items():
        payload = json.loads((NODE_TILE_DIR / f"{tile_id}.json").read_text(encoding="utf-8"))
        for row in payload["nodes"]:
            node_id = as_text(row["id"])
            if node_id in wanted:
                result[node_id] = {
                    "x": float(row["x"]),
                    "y": float(row["y"]),
                    "major_level": row.get("majorLevel"),
                    "eligible": bool(row.get("eligible")),
                    "outside_ga": bool(row.get("outsideGa")),
                }
    missing = sorted(node_ids - set(result))
    if missing or missing_index:
        raise ValueError(f"Node attributes missing for {sorted(set(missing + missing_index))}")
    return result


def load_network_node_stats(
    node_ids: set[str],
) -> tuple[dict[str, dict[str, object]], set[tuple[str, str]]]:
    links = gpd.read_file(
        NETWORK_LINK_SHP,
        columns=[
            "A",
            "B",
            "FUNC_CLASS",
            "NONGA",
            "ST_NAME",
            "RAMP",
            "HERE_MISS",
        ],
        ignore_geometry=True,
    )
    links["A"] = links["A"].map(as_text)
    links["B"] = links["B"].map(as_text)
    relevant = links[links["A"].isin(node_ids) | links["B"].isin(node_ids)].copy()

    neighbors: dict[str, set[str]] = defaultdict(set)
    classes: dict[str, list[int]] = defaultdict(list)
    names: dict[str, Counter[str]] = defaultdict(Counter)
    nongas: dict[str, list[int]] = defaultdict(list)
    ramps: dict[str, list[str]] = defaultdict(list)
    incident_records: Counter[str] = Counter()
    direct_pairs: set[tuple[str, str]] = set()

    for _, row in relevant.iterrows():
        a, b = row["A"], row["B"]
        direct_pairs.add(unordered_numeric_pair(a, b))
        for node_id, neighbor in ((a, b), (b, a)):
            if node_id not in node_ids:
                continue
            incident_records[node_id] += 1
            neighbors[node_id].add(neighbor)
            func_class = pd.to_numeric(row.get("FUNC_CLASS"), errors="coerce")
            if pd.notna(func_class):
                classes[node_id].append(int(func_class))
            name = as_text(row.get("ST_NAME"))
            if name:
                names[node_id][name] += 1
            nonga = pd.to_numeric(row.get("NONGA"), errors="coerce")
            if pd.notna(nonga):
                nongas[node_id].append(int(nonga))
            ramp = as_text(row.get("RAMP")).upper()
            if ramp:
                ramps[node_id].append(ramp)

    result: dict[str, dict[str, object]] = {}
    for node_id in sorted(node_ids):
        node_classes = classes.get(node_id, [])
        node_nonga = nongas.get(node_id, [])
        node_ramps = ramps.get(node_id, [])
        result[node_id] = {
            "unique_neighbor_degree": len(neighbors.get(node_id, set())),
            "incident_records": int(incident_records[node_id]),
            "derived_major_level": min(node_classes) if node_classes else None,
            "functional_classes": "|".join(map(str, sorted(set(node_classes)))),
            "outside_ga_share": (
                round(sum(value == 1 for value in node_nonga) / len(node_nonga), 4)
                if node_nonga
                else None
            ),
            "ramp_share": (
                round(sum(value == "Y" for value in node_ramps) / len(node_ramps), 4)
                if node_ramps
                else None
            ),
            "top_street_names": "|".join(
                name for name, _ in names.get(node_id, Counter()).most_common(3)
            ),
        }
    return result, direct_pairs


def connector_geometry_lookup(path: Path, taz_ids: set[str]) -> tuple[dict[tuple[str, str], object], object]:
    frame = gpd.read_file(path)
    lookup: dict[tuple[str, str], object] = {}
    for _, row in frame.iterrows():
        a, b = as_text(row["A"]), as_text(row["B"])
        if a in taz_ids and b not in taz_ids:
            lookup[(a, b)] = row.geometry
    return lookup, frame.crs


def match_replacements(
    taz_id: str,
    removed_nodes: list[str],
    added_nodes: list[str],
    pre_geoms: dict[tuple[str, str], object],
    post_geoms: dict[tuple[str, str], object],
) -> tuple[list[tuple[str, str]], list[str], list[str]]:
    if not removed_nodes or not added_nodes:
        return [], removed_nodes, added_nodes

    if len(removed_nodes) <= len(added_nodes):
        best = min(
            itertools.permutations(added_nodes, len(removed_nodes)),
            key=lambda permutation: sum(
                Point(list(pre_geoms[(taz_id, old)].coords)[-1]).distance(
                    Point(list(post_geoms[(taz_id, new)].coords)[-1])
                )
                for old, new in zip(removed_nodes, permutation)
            ),
        )
        matches = list(zip(removed_nodes, best))
        unmatched_removed: list[str] = []
        unmatched_added = sorted(set(added_nodes) - set(best), key=int)
    else:
        best = min(
            itertools.permutations(removed_nodes, len(added_nodes)),
            key=lambda permutation: sum(
                Point(list(pre_geoms[(taz_id, old)].coords)[-1]).distance(
                    Point(list(post_geoms[(taz_id, new)].coords)[-1])
                )
                for old, new in zip(permutation, added_nodes)
            ),
        )
        matches = list(zip(best, added_nodes))
        unmatched_removed = sorted(set(removed_nodes) - set(best), key=int)
        unmatched_added = []
    return matches, unmatched_removed, unmatched_added


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    global_review = json.loads(GLOBAL_REVIEW_JSON.read_text(encoding="utf-8"))
    taz_ids = {as_text(row["id"]) for row in global_review["tazOrder"]}
    centroids = {
        as_text(row["id"]): (float(row["x"]), float(row["y"]))
        for row in global_review["centroids"]
    }

    pre_cc = pd.read_csv(PRE_CC_CSV, dtype=str)
    post_cc = pd.read_csv(POST_CC_CSV, dtype=str)
    post_miss = pd.read_csv(POST_MISS_CSV, dtype=str)
    ordered_post_miss_pairs = ordered_miss_pairs(post_miss)
    if len(ordered_post_miss_pairs) < PRE_MISS_PAIR_COUNT:
        raise ValueError(
            f"Expected at least {PRE_MISS_PAIR_COUNT} ordered HERE_MISS pairs"
        )
    # The pre-upload core.json was regenerated in place during this analysis.
    # README.md and PROJECT_SUMMARY.md both record 17 published pairs, and the
    # browser export preserves the published rows first and appends new pairs.
    pre_miss_pairs = set(ordered_post_miss_pairs[:PRE_MISS_PAIR_COUNT])
    pre_miss = post_miss[
        [
            unordered_numeric_pair(a, b) in pre_miss_pairs
            for a, b in zip(post_miss["A"], post_miss["B"])
        ]
    ].copy()
    reconstructed_miss_path = (
        OUT_DIR / "here_miss_baseline_reconstructed_17_pairs.csv"
    )
    pre_miss.to_csv(reconstructed_miss_path, index=False)

    pre_pairs = canonical_cc_pairs(pre_cc, taz_ids)
    post_pairs = canonical_cc_pairs(post_cc, taz_ids)
    removed_pairs = pre_pairs - post_pairs
    added_pairs = post_pairs - pre_pairs

    pre_geoms, connector_crs = connector_geometry_lookup(PRE_CC_SHP, taz_ids)
    post_geoms, post_connector_crs = connector_geometry_lookup(POST_CC_SHP, taz_ids)
    if connector_crs != post_connector_crs:
        raise ValueError(f"Connector CRS mismatch: {connector_crs} vs {post_connector_crs}")

    removed_by_taz: dict[str, list[str]] = defaultdict(list)
    added_by_taz: dict[str, list[str]] = defaultdict(list)
    for taz_id, node_id in removed_pairs:
        removed_by_taz[taz_id].append(node_id)
    for taz_id, node_id in added_pairs:
        added_by_taz[taz_id].append(node_id)
    for values in removed_by_taz.values():
        values.sort(key=int)
    for values in added_by_taz.values():
        values.sort(key=int)

    replacement_pairs: list[tuple[str, str, str]] = []
    unmatched_removed: list[tuple[str, str]] = []
    unmatched_added: list[tuple[str, str]] = []
    for taz_id in sorted(set(removed_by_taz) | set(added_by_taz), key=int):
        matches, remaining_removed, remaining_added = match_replacements(
            taz_id,
            removed_by_taz.get(taz_id, []),
            added_by_taz.get(taz_id, []),
            pre_geoms,
            post_geoms,
        )
        replacement_pairs.extend((taz_id, old, new) for old, new in matches)
        unmatched_removed.extend((taz_id, node_id) for node_id in remaining_removed)
        unmatched_added.extend((taz_id, node_id) for node_id in remaining_added)

    post_miss_pairs = canonical_miss_pairs(post_miss)
    added_miss_pairs = post_miss_pairs - pre_miss_pairs
    removed_miss_pairs = pre_miss_pairs - post_miss_pairs

    block_0000_pre_pairs_set = {
        (taz_id, node_id)
        for taz_id, node_id in pre_pairs
        if 1 <= int(taz_id) <= 1000
    }
    block_0000_post_pairs_set = {
        (taz_id, node_id)
        for taz_id, node_id in post_pairs
        if 1 <= int(taz_id) <= 1000
    }
    block_0000_nodes = {
        node_id
        for _, node_id in block_0000_pre_pairs_set | block_0000_post_pairs_set
    }
    all_relevant_nodes = {
        node_id for _, node_id in removed_pairs | added_pairs
    } | {
        node_id for pair in pre_miss_pairs | post_miss_pairs for node_id in pair
    } | block_0000_nodes
    node_attrs = load_node_attributes(all_relevant_nodes)
    network_stats, direct_network_pairs = load_network_node_stats(all_relevant_nodes)
    for node_id in all_relevant_nodes:
        node_attrs[node_id].update(network_stats[node_id])

    changed_taz_ids = sorted(
        set(taz_id for taz_id, _ in removed_pairs | added_pairs), key=int
    )
    tazs = gpd.read_file(TAZ_SHP)
    tazs["TAZ_ID"] = tazs["NEWID"].map(as_text)
    tazs = tazs[tazs["TAZ_ID"].isin(changed_taz_ids)][["TAZ_ID", "geometry"]]
    tazs = tazs.to_crs(connector_crs)
    taz_geometry = {
        row["TAZ_ID"]: row.geometry.buffer(0) for _, row in tazs.iterrows()
    }

    repair_audit = pd.read_csv(PRE_REPAIR_AUDIT, dtype=str)
    repaired_nodes = {
        (as_text(taz_id), as_text(node_id))
        for taz_id, node_id in zip(
            repair_audit["TAZ_ID"], repair_audit["NEW_NODE_ID"]
        )
    }

    cc_change_rows: list[dict[str, object]] = []
    replacement_id_by_pair: dict[tuple[str, str], str] = {}
    for index, (taz_id, old_node, new_node) in enumerate(
        sorted(replacement_pairs, key=lambda row: (int(row[0]), int(row[1]))),
        start=1,
    ):
        replacement_id = f"R{index:02d}"
        replacement_id_by_pair[(taz_id, old_node)] = replacement_id
        replacement_id_by_pair[(taz_id, new_node)] = replacement_id

    def cc_row(
        taz_id: str,
        node_id: str,
        change_type: str,
        geometry: object,
        replacement_id: str = "",
    ) -> dict[str, object]:
        centroid = centroids[taz_id]
        target = (float(geometry.coords[-1][0]), float(geometry.coords[-1][1]))
        polygon = taz_geometry[taz_id]
        target_point = Point(target)
        attrs = node_attrs[node_id]
        return {
            "taz_id": taz_id,
            "node_id": node_id,
            "change_type": change_type,
            "replacement_id": replacement_id,
            "connector_length_ft": round(float(geometry.length), 3),
            "bearing_deg": round(bearing_degrees(centroid, target), 3),
            "outside_taz_length_ft": round(float(geometry.difference(polygon).length), 3),
            "target_outside_taz_ft": round(float(target_point.distance(polygon)), 3),
            "target_boundary_distance_ft": round(
                float(target_point.distance(polygon.boundary)), 3
            ),
            "node_major_level": attrs["major_level"],
            "node_eligible": attrs["eligible"],
            "node_outside_ga": attrs["outside_ga"],
            "unique_neighbor_degree": attrs["unique_neighbor_degree"],
            "functional_classes": attrs["functional_classes"],
            "ramp_share": attrs["ramp_share"],
            "top_street_names": attrs["top_street_names"],
            "was_shared_node_auto_repair_choice": (taz_id, node_id) in repaired_nodes,
        }

    for taz_id, node_id in sorted(removed_pairs, key=lambda row: (int(row[0]), int(row[1]))):
        replacement_id = replacement_id_by_pair.get((taz_id, node_id), "")
        change_type = "replacement_old" if replacement_id else "deletion"
        cc_change_rows.append(
            cc_row(taz_id, node_id, change_type, pre_geoms[(taz_id, node_id)], replacement_id)
        )
    for taz_id, node_id in sorted(added_pairs, key=lambda row: (int(row[0]), int(row[1]))):
        replacement_id = replacement_id_by_pair.get((taz_id, node_id), "")
        change_type = "replacement_new" if replacement_id else "addition"
        cc_change_rows.append(
            cc_row(taz_id, node_id, change_type, post_geoms[(taz_id, node_id)], replacement_id)
        )
    cc_changes = pd.DataFrame(cc_change_rows)
    cc_changes.to_csv(OUT_DIR / "cc_changes.csv", index=False)

    replacement_rows: list[dict[str, object]] = []
    for taz_id, old_node, new_node in sorted(
        replacement_pairs, key=lambda row: (int(row[0]), int(row[1]))
    ):
        old_row = cc_changes[
            (cc_changes["taz_id"] == taz_id)
            & (cc_changes["node_id"] == old_node)
        ].iloc[0]
        new_row = cc_changes[
            (cc_changes["taz_id"] == taz_id)
            & (cc_changes["node_id"] == new_node)
        ].iloc[0]
        old_target = Point(list(pre_geoms[(taz_id, old_node)].coords)[-1])
        new_target = Point(list(post_geoms[(taz_id, new_node)].coords)[-1])
        replacement_rows.append(
            {
                "replacement_id": replacement_id_by_pair[(taz_id, old_node)],
                "taz_id": taz_id,
                "old_node_id": old_node,
                "new_node_id": new_node,
                "endpoint_shift_ft": round(float(old_target.distance(new_target)), 3),
                "angle_change_deg": round(
                    circular_difference_degrees(
                        float(old_row["bearing_deg"]), float(new_row["bearing_deg"])
                    ),
                    3,
                ),
                "old_length_ft": old_row["connector_length_ft"],
                "new_length_ft": new_row["connector_length_ft"],
                "length_delta_ft": round(
                    float(new_row["connector_length_ft"])
                    - float(old_row["connector_length_ft"]),
                    3,
                ),
                "length_ratio": round(
                    float(new_row["connector_length_ft"])
                    / float(old_row["connector_length_ft"]),
                    4,
                )
                if float(old_row["connector_length_ft"])
                else None,
                "old_outside_taz_length_ft": old_row["outside_taz_length_ft"],
                "new_outside_taz_length_ft": new_row["outside_taz_length_ft"],
                "outside_taz_delta_ft": round(
                    float(new_row["outside_taz_length_ft"])
                    - float(old_row["outside_taz_length_ft"]),
                    3,
                ),
                "old_target_outside_taz_ft": old_row["target_outside_taz_ft"],
                "new_target_outside_taz_ft": new_row["target_outside_taz_ft"],
                "old_major_level": old_row["node_major_level"],
                "new_major_level": new_row["node_major_level"],
                "old_degree": old_row["unique_neighbor_degree"],
                "new_degree": new_row["unique_neighbor_degree"],
                "degree_delta": int(new_row["unique_neighbor_degree"])
                - int(old_row["unique_neighbor_degree"]),
                "old_street_names": old_row["top_street_names"],
                "new_street_names": new_row["top_street_names"],
            }
        )
    replacements = pd.DataFrame(replacement_rows)
    replacements.to_csv(OUT_DIR / "cc_replacement_pairs.csv", index=False)

    cc_taz_summary_rows: list[dict[str, object]] = []
    pre_count_by_taz = Counter(taz_id for taz_id, _ in pre_pairs)
    post_count_by_taz = Counter(taz_id for taz_id, _ in post_pairs)
    for taz_id in changed_taz_ids:
        removed_nodes = sorted(
            [node_id for row_taz, node_id in removed_pairs if row_taz == taz_id],
            key=int,
        )
        added_nodes = sorted(
            [node_id for row_taz, node_id in added_pairs if row_taz == taz_id],
            key=int,
        )
        cc_taz_summary_rows.append(
            {
                "taz_id": taz_id,
                "pre_connector_count": pre_count_by_taz[taz_id],
                "post_connector_count": post_count_by_taz[taz_id],
                "net_change": post_count_by_taz[taz_id] - pre_count_by_taz[taz_id],
                "removed_count": len(removed_nodes),
                "added_count": len(added_nodes),
                "removed_nodes": "|".join(removed_nodes),
                "added_nodes": "|".join(added_nodes),
            }
        )
    cc_taz_summary = pd.DataFrame(cc_taz_summary_rows)
    cc_taz_summary.to_csv(OUT_DIR / "cc_changes_by_taz.csv", index=False)

    changed_cc_nodes = {node_id for _, node_id in removed_pairs | added_pairs}
    added_cc_nodes = {node_id for _, node_id in added_pairs}
    miss_rows: list[dict[str, object]] = []
    for pair in sorted(pre_miss_pairs | post_miss_pairs, key=lambda row: (int(row[0]), int(row[1]))):
        a, b = pair
        a_attrs, b_attrs = node_attrs[a], node_attrs[b]
        length = Point(a_attrs["x"], a_attrs["y"]).distance(
            Point(b_attrs["x"], b_attrs["y"])
        )
        status = (
            "added"
            if pair in added_miss_pairs
            else "removed"
            if pair in removed_miss_pairs
            else "unchanged"
        )
        miss_rows.append(
            {
                "pair_key": f"{a}|{b}",
                "a": a,
                "b": b,
                "status": status,
                "straight_length_ft": round(float(length), 3),
                "already_directly_linked_in_gstdm": pair in direct_network_pairs,
                "a_major_level": a_attrs["major_level"],
                "b_major_level": b_attrs["major_level"],
                "a_degree": a_attrs["unique_neighbor_degree"],
                "b_degree": b_attrs["unique_neighbor_degree"],
                "a_street_names": a_attrs["top_street_names"],
                "b_street_names": b_attrs["top_street_names"],
                "touches_any_changed_cc_node": bool(set(pair) & changed_cc_nodes),
                "touches_any_added_cc_node": bool(set(pair) & added_cc_nodes),
            }
        )
    miss_changes = pd.DataFrame(miss_rows)
    miss_changes.to_csv(OUT_DIR / "here_miss_changes.csv", index=False)

    replacement_length_delta = replacements["length_delta_ft"].astype(float).tolist()
    replacement_outside_delta = replacements["outside_taz_delta_ft"].astype(float).tolist()
    added_miss = miss_changes[miss_changes["status"] == "added"]
    unchanged_miss = miss_changes[miss_changes["status"] == "unchanged"]

    block_0000_pre = len(block_0000_pre_pairs_set)
    block_0000_post = len(block_0000_post_pairs_set)
    changed_taz_set = set(changed_taz_ids)

    block_pre_degrees = Counter(
        node_attrs[node_id]["unique_neighbor_degree"]
        for _, node_id in block_0000_pre_pairs_set
    )
    block_post_degrees = Counter(
        node_attrs[node_id]["unique_neighbor_degree"]
        for _, node_id in block_0000_post_pairs_set
    )
    block_pre_major_levels = Counter(
        as_text(node_attrs[node_id]["major_level"])
        for _, node_id in block_0000_pre_pairs_set
    )
    block_post_major_levels = Counter(
        as_text(node_attrs[node_id]["major_level"])
        for _, node_id in block_0000_post_pairs_set
    )

    def street_name_overlap(old_names: object, new_names: object) -> bool:
        old_set = {
            value for value in as_text(old_names).split("|") if value and value != "nan"
        }
        new_set = {
            value for value in as_text(new_names).split("|") if value and value != "nan"
        }
        return bool(old_set & new_set)

    replacements["shares_street_name"] = [
        street_name_overlap(old_names, new_names)
        for old_names, new_names in zip(
            replacements["old_street_names"], replacements["new_street_names"]
        )
    ]
    replacements.to_csv(OUT_DIR / "cc_replacement_pairs.csv", index=False)
    high_confidence_pattern = (
        replacements["shares_street_name"]
        & (replacements["degree_delta"] > 0)
        & (replacements["angle_change_deg"] <= 20)
        & (replacements["endpoint_shift_ft"] <= 1800)
    )

    added_miss_street_overlap = []
    for _, row in added_miss.iterrows():
        added_miss_street_overlap.append(
            street_name_overlap(row["a_street_names"], row["b_street_names"])
        )

    major_transitions = Counter(
        f"{as_text(old)}->{as_text(new)}"
        for old, new in zip(
            replacements["old_major_level"], replacements["new_major_level"]
        )
    )
    summary = {
        "analysis_date": "2026-07-24",
        "comparison_basis": {
            "pre_generated_cc": str(PRE_CC_CSV.relative_to(ROOT)),
            "human_edited_cc": str(POST_CC_CSV.relative_to(ROOT)),
            "pre_generated_here_miss": str(
                reconstructed_miss_path.relative_to(ROOT)
            ),
            "pre_generated_here_miss_reconstruction_note": (
                "Reconstructed from the first 17 ordered pairs in "
                "input/default/HERE_MISS_links.csv, using the pre-refresh "
                "published count documented in README.md and PROJECT_SUMMARY.md"
            ),
            "human_edited_here_miss": str(POST_MISS_CSV.relative_to(ROOT)),
            "connector_geometry_pre": str(PRE_CC_SHP.relative_to(ROOT)),
            "connector_geometry_post": str(POST_CC_SHP.relative_to(ROOT)),
            "sha256": {
                "pre_generated_cc": sha256(PRE_CC_CSV),
                "human_edited_cc": sha256(POST_CC_CSV),
                "pre_generated_here_miss_reconstructed": sha256(
                    reconstructed_miss_path
                ),
                "human_edited_here_miss": sha256(POST_MISS_CSV),
                "global_review_index": sha256(GLOBAL_REVIEW_JSON),
            },
        },
        "quality_checks": {
            "pre_cc": directed_profile(pre_cc, ["A", "B", "FCLASS"]),
            "post_cc": directed_profile(post_cc, ["A", "B", "FCLASS"]),
            "pre_here_miss": directed_profile(
                pre_miss, ["A", "B", "LANES", "HERE_MISS", "FCLASS"]
            ),
            "post_here_miss": directed_profile(
                post_miss, ["A", "B", "LANES", "HERE_MISS", "FCLASS"]
            ),
            "post_cc_all_fclass_32": bool(
                (pd.to_numeric(post_cc["FCLASS"], errors="coerce") == 32).all()
            ),
            "post_here_miss_all_defaults": {
                "lanes_1": bool(
                    (pd.to_numeric(post_miss["LANES"], errors="coerce") == 1).all()
                ),
                "here_miss_1": bool(
                    (pd.to_numeric(post_miss["HERE_MISS"], errors="coerce") == 1).all()
                ),
                "fclass_32": bool(
                    (pd.to_numeric(post_miss["FCLASS"], errors="coerce") == 32).all()
                ),
            },
        },
        "cc_change_scope": {
            "pre_pairs": len(pre_pairs),
            "post_pairs": len(post_pairs),
            "net_pairs": len(post_pairs) - len(pre_pairs),
            "removed_pairs": len(removed_pairs),
            "added_pairs": len(added_pairs),
            "matched_within_taz_replacements": len(replacement_pairs),
            "unmatched_deletions": len(unmatched_removed),
            "unmatched_additions": len(unmatched_added),
            "changed_tazs": len(changed_taz_set),
            "changed_taz_min": min(map(int, changed_taz_set)),
            "changed_taz_max": max(map(int, changed_taz_set)),
            "all_changed_tazs_in_block_0000": all(
                1 <= int(taz_id) <= 1000 for taz_id in changed_taz_set
            ),
            "block_0000_pre_pairs": block_0000_pre,
            "block_0000_post_pairs": block_0000_post,
            "removed_share_of_block_0000_pre_pairs_pct": pct(
                len(removed_pairs), block_0000_pre
            ),
            "changed_taz_share_of_block_0000_pct": pct(
                len(changed_taz_set), 1000
            ),
            "changed_taz_ids": changed_taz_ids,
            "block_0000_pre_degree_distribution": {
                str(key): value for key, value in sorted(block_pre_degrees.items())
            },
            "block_0000_post_degree_distribution": {
                str(key): value for key, value in sorted(block_post_degrees.items())
            },
            "block_0000_pre_major_level_distribution": dict(
                sorted(block_pre_major_levels.items())
            ),
            "block_0000_post_major_level_distribution": dict(
                sorted(block_post_major_levels.items())
            ),
            "block_0000_pre_ineligible_connector_count": sum(
                not node_attrs[node_id]["eligible"]
                for _, node_id in block_0000_pre_pairs_set
            ),
            "block_0000_post_ineligible_connector_count": sum(
                not node_attrs[node_id]["eligible"]
                for _, node_id in block_0000_post_pairs_set
            ),
        },
        "cc_replacement_patterns": {
            "endpoint_shift_ft": quantiles(
                replacements["endpoint_shift_ft"].astype(float).tolist()
            ),
            "angle_change_deg": quantiles(
                replacements["angle_change_deg"].astype(float).tolist()
            ),
            "old_length_ft": quantiles(
                replacements["old_length_ft"].astype(float).tolist()
            ),
            "new_length_ft": quantiles(
                replacements["new_length_ft"].astype(float).tolist()
            ),
            "length_delta_ft": quantiles(replacement_length_delta),
            "shorter_count": sum(value < -1 for value in replacement_length_delta),
            "longer_count": sum(value > 1 for value in replacement_length_delta),
            "roughly_same_length_count": sum(
                abs(value) <= 1 for value in replacement_length_delta
            ),
            "old_outside_taz_length_ft": quantiles(
                replacements["old_outside_taz_length_ft"].astype(float).tolist()
            ),
            "new_outside_taz_length_ft": quantiles(
                replacements["new_outside_taz_length_ft"].astype(float).tolist()
            ),
            "outside_taz_delta_ft": quantiles(replacement_outside_delta),
            "outside_taz_improved_count": sum(
                value < -1 for value in replacement_outside_delta
            ),
            "outside_taz_worsened_count": sum(
                value > 1 for value in replacement_outside_delta
            ),
            "outside_taz_roughly_same_count": sum(
                abs(value) <= 1 for value in replacement_outside_delta
            ),
            "old_degree": quantiles(
                replacements["old_degree"].astype(float).tolist()
            ),
            "new_degree": quantiles(
                replacements["new_degree"].astype(float).tolist()
            ),
            "degree_increased_count": int((replacements["degree_delta"] > 0).sum()),
            "degree_decreased_count": int((replacements["degree_delta"] < 0).sum()),
            "degree_unchanged_count": int((replacements["degree_delta"] == 0).sum()),
            "major_level_transitions": dict(sorted(major_transitions.items())),
            "same_street_name_count": int(replacements["shares_street_name"].sum()),
            "same_street_name_pct": pct(
                int(replacements["shares_street_name"].sum()), len(replacements)
            ),
            "angle_change_le_20_deg_count": int(
                (replacements["angle_change_deg"] <= 20).sum()
            ),
            "endpoint_shift_le_1800_ft_count": int(
                (replacements["endpoint_shift_ft"] <= 1800).sum()
            ),
            "high_confidence_intersection_shift_count": int(
                high_confidence_pattern.sum()
            ),
            "high_confidence_intersection_shift_pct": pct(
                int(high_confidence_pattern.sum()), len(replacements)
            ),
            "removed_nodes_that_were_shared_node_repair_choices": int(
                cc_changes[
                    cc_changes["change_type"].isin(["replacement_old", "deletion"])
                ]["was_shared_node_auto_repair_choice"].sum()
            ),
        },
        "here_miss_change_scope": {
            "pre_pairs": len(pre_miss_pairs),
            "post_pairs": len(post_miss_pairs),
            "added_pairs": len(added_miss_pairs),
            "removed_pairs": len(removed_miss_pairs),
            "added_length_ft": quantiles(
                added_miss["straight_length_ft"].astype(float).tolist()
            ),
            "preexisting_length_ft": quantiles(
                unchanged_miss["straight_length_ft"].astype(float).tolist()
            ),
            "added_pairs_already_directly_linked_in_gstdm": int(
                added_miss["already_directly_linked_in_gstdm"].sum()
            ),
            "added_pairs_touching_changed_cc_nodes": int(
                added_miss["touches_any_changed_cc_node"].sum()
            ),
            "added_pairs_touching_added_cc_nodes": int(
                added_miss["touches_any_added_cc_node"].sum()
            ),
            "added_pairs_with_shared_street_name": sum(added_miss_street_overlap),
            "added_pairs_with_shared_street_name_pct": pct(
                sum(added_miss_street_overlap), len(added_miss)
            ),
        },
    }
    (OUT_DIR / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
