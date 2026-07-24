from __future__ import annotations

import itertools
import json
import math
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

import geopandas as gpd
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
BASELINE_GPKG = ROOT / "output" / "run_20260722_033549" / "taz_centroid_connectors.gpkg"
BASELINE_TABLE = ROOT / "output" / "run_20260722_033549" / "connector_table.csv"
CURRENT_CC = ROOT / "input" / "default" / "cube_taz_cc_public.csv"
CURRENT_CORE = ROOT / "docs" / "data" / "core.json"

STAGES = [
    {
        "order": 1,
        "label": "Earliest road-density baseline",
        "commit": "5a2a8be",
        "path": "docs/data/all.json",
        "generated_from": "run_20260715_114631",
    },
    {
        "order": 2,
        "label": "QC rules",
        "commit": "5165a05",
        "path": "docs/data/all.json",
        "generated_from": "run_20260722_014023",
    },
    {
        "order": 3,
        "label": "No cross-TAZ node sharing",
        "commit": "cae055d",
        "path": "docs/data/all.json",
        "generated_from": "run_20260722_020207",
    },
    {
        "order": 4,
        "label": "Improved connector rules",
        "commit": "53f4e36",
        "path": "docs/data/all.json",
        "generated_from": "run_20260722_024527",
    },
    {
        "order": 5,
        "label": "Stabilized road-density run",
        "commit": "276731f",
        "path": "docs/data/all.json",
        "generated_from": "run_20260722_033549",
    },
    {
        "order": 6,
        "label": "Published algorithm snapshot",
        "commit": "428f28b",
        "path": "docs/data/core.json",
        "generated_from": "run_20260722_033549",
    },
    {
        "order": 7,
        "label": "First human-edited publish",
        "commit": "7a8f077",
        "path": "docs/data/core.json",
        "generated_from": "run_20260722_033549",
    },
]


def git_json(commit: str, path: str) -> dict[str, Any]:
    raw = subprocess.check_output(
        ["git", "show", f"{commit}:{path}"], cwd=ROOT
    )
    return json.loads(raw)


def normalize_pair(taz_id: Any, node_id: Any) -> tuple[int, int]:
    return int(float(taz_id)), int(float(node_id))


def connector_pair(connector: dict[str, Any]) -> tuple[int, int]:
    return normalize_pair(connector["tazId"], connector["nodeId"])


def endpoint(connector: dict[str, Any]) -> tuple[float, float]:
    coords = connector["geom"]["coordinates"]
    x, y = coords[-1]
    return float(x), float(y)


def pair_set(connectors: Iterable[dict[str, Any]]) -> set[tuple[int, int]]:
    return {connector_pair(item) for item in connectors}


def pct(numerator: int | float, denominator: int | float) -> float | None:
    if not denominator:
        return None
    return 100.0 * float(numerator) / float(denominator)


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def summarize_numbers(values: Iterable[Any]) -> dict[str, float | int | None]:
    clean = np.asarray(
        [number for value in values if (number := finite(value)) is not None],
        dtype=float,
    )
    if not len(clean):
        return {"n": 0, "median": None, "p90": None, "mean": None}
    return {
        "n": int(len(clean)),
        "median": float(np.median(clean)),
        "p90": float(np.quantile(clean, 0.90)),
        "mean": float(np.mean(clean)),
    }


def rank_bucket(rank: Any) -> str:
    value = int(float(rank))
    if value == 1:
        return "1"
    if value == 2:
        return "2"
    if value <= 4:
        return "3-4"
    if value <= 6:
        return "5-6"
    return "7-10"


def minimum_distance_matches(
    removed: list[dict[str, Any]], added: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], dict[str, Any], float]]:
    if not removed or not added:
        return []
    match_count = min(len(removed), len(added))
    best: tuple[float, list[tuple[dict[str, Any], dict[str, Any], float]]] | None = None
    if len(removed) <= len(added):
        for selected_added in itertools.combinations(added, match_count):
            for permuted_added in itertools.permutations(selected_added):
                matches = []
                total = 0.0
                for old, new in zip(removed, permuted_added):
                    ox, oy = endpoint(old)
                    nx, ny = endpoint(new)
                    distance = math.hypot(nx - ox, ny - oy)
                    total += distance
                    matches.append((old, new, distance))
                if best is None or total < best[0]:
                    best = (total, matches)
    else:
        for selected_removed in itertools.combinations(removed, match_count):
            for permuted_removed in itertools.permutations(selected_removed):
                matches = []
                total = 0.0
                for old, new in zip(permuted_removed, added):
                    ox, oy = endpoint(old)
                    nx, ny = endpoint(new)
                    distance = math.hypot(nx - ox, ny - oy)
                    total += distance
                    matches.append((old, new, distance))
                if best is None or total < best[0]:
                    best = (total, matches)
    return [] if best is None else best[1]


def major_level_bucket(value: Any) -> str:
    number = finite(value)
    return "unknown" if number is None else str(int(number))


def count_distribution(pairs: set[tuple[int, int]], taz_ids: set[int]) -> dict[str, int]:
    counts = Counter(taz for taz, _ in pairs)
    return dict(
        sorted(Counter(counts.get(taz, 0) for taz in taz_ids).items())
    )


def read_current_pairs(taz_ids: set[int]) -> set[tuple[int, int]]:
    frame = pd.read_csv(CURRENT_CC)
    pairs: set[tuple[int, int]] = set()
    ambiguous = 0
    for a_raw, b_raw in frame[["A", "B"]].itertuples(index=False, name=None):
        a, b = int(a_raw), int(b_raw)
        a_is_taz, b_is_taz = a in taz_ids, b in taz_ids
        if a_is_taz ^ b_is_taz:
            pairs.add((a if a_is_taz else b, b if a_is_taz else a))
        elif a_is_taz and b_is_taz:
            ambiguous += 1
    if ambiguous:
        raise RuntimeError(f"Found {ambiguous} current CC rows joining two New TAZ IDs.")
    return pairs


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    stage_objects: list[dict[str, Any]] = []
    for stage in STAGES:
        data = git_json(stage["commit"], stage["path"])
        connectors = data["connectors"]
        stage_objects.append(
            {
                **stage,
                "data": data,
                "connectors": connectors,
                "pairs": pair_set(connectors),
            }
        )

    earliest = stage_objects[0]
    stabilized = stage_objects[4]
    first_human = stage_objects[-1]

    taz_ids = {int(float(item["id"])) for item in earliest["data"]["centroids"]}
    if len(taz_ids) != 658:
        raise RuntimeError(f"Expected 658 New TAZ IDs, found {len(taz_ids)}.")

    current_core = json.loads(CURRENT_CORE.read_text(encoding="utf-8"))
    current_connectors = current_core["connectors"]
    current_core_pairs = pair_set(current_connectors)
    current_pairs = read_current_pairs(taz_ids)
    if current_pairs != current_core_pairs:
        raise RuntimeError(
            "Current input/default CC pairs do not match docs/data/core.json "
            f"(input={len(current_pairs)}, core={len(current_core_pairs)})."
        )

    stage_rows: list[dict[str, Any]] = []
    previous_pairs: set[tuple[int, int]] | None = None
    for stage in stage_objects:
        pairs = stage["pairs"]
        stage_rows.append(
            {
                "order": stage["order"],
                "stage": stage["label"],
                "git_commit": stage["commit"],
                "generated_from": stage["generated_from"],
                "connector_features": len(stage["connectors"]),
                "connector_pairs": len(pairs),
                "duplicate_taz_node_features": len(stage["connectors"]) - len(pairs),
                "taz_with_connector": len({taz for taz, _ in pairs}),
                "added_vs_prior": (
                    None if previous_pairs is None else len(pairs - previous_pairs)
                ),
                "removed_vs_prior": (
                    None if previous_pairs is None else len(previous_pairs - pairs)
                ),
                "retained_vs_prior": (
                    None if previous_pairs is None else len(pairs & previous_pairs)
                ),
            }
        )
        previous_pairs = pairs
    stage_rows.append(
        {
            "order": 8,
            "stage": "Current uploaded final",
            "git_commit": "working tree",
            "generated_from": str(CURRENT_CC.relative_to(ROOT)).replace("\\", "/"),
            "connector_features": len(current_pairs),
            "connector_pairs": len(current_pairs),
            "duplicate_taz_node_features": 0,
            "taz_with_connector": len({taz for taz, _ in current_pairs}),
            "added_vs_prior": len(current_pairs - previous_pairs),
            "removed_vs_prior": len(previous_pairs - current_pairs),
            "retained_vs_prior": len(current_pairs & previous_pairs),
        }
    )
    stage_frame = pd.DataFrame(stage_rows)
    stage_frame.to_csv(OUT / "version_inventory.csv", index=False)

    earliest_pairs = earliest["pairs"]
    stabilized_pairs = stabilized["pairs"]
    first_human_pairs = first_human["pairs"]

    comparisons = {}
    for key, baseline_pairs in [
        ("earliest_to_final", earliest_pairs),
        ("stabilized_to_final", stabilized_pairs),
        ("first_human_to_final", first_human_pairs),
    ]:
        comparisons[key] = {
            "baseline_pairs": len(baseline_pairs),
            "final_pairs": len(current_pairs),
            "unchanged": len(baseline_pairs & current_pairs),
            "removed": len(baseline_pairs - current_pairs),
            "added": len(current_pairs - baseline_pairs),
            "net_change": len(current_pairs) - len(baseline_pairs),
            "exact_retention_pct": pct(
                len(baseline_pairs & current_pairs), len(baseline_pairs)
            ),
        }

    earliest_by_pair = {
        connector_pair(item): item for item in earliest["connectors"]
    }
    stabilized_by_pair = {
        connector_pair(item): item for item in stabilized["connectors"]
    }
    current_by_pair = {connector_pair(item): item for item in current_connectors}

    change_rows: list[dict[str, Any]] = []
    all_pairs = earliest_pairs | stabilized_pairs | current_pairs
    for taz_id, node_id in sorted(all_pairs):
        earliest_item = earliest_by_pair.get((taz_id, node_id))
        stabilized_item = stabilized_by_pair.get((taz_id, node_id))
        current_item = current_by_pair.get((taz_id, node_id))
        if (taz_id, node_id) in earliest_pairs and (taz_id, node_id) in current_pairs:
            earliest_final_status = "unchanged"
        elif (taz_id, node_id) in earliest_pairs:
            earliest_final_status = "removed"
        else:
            earliest_final_status = "added"
        if (taz_id, node_id) in stabilized_pairs and (taz_id, node_id) in current_pairs:
            stabilized_final_status = "unchanged"
        elif (taz_id, node_id) in stabilized_pairs:
            stabilized_final_status = "removed"
        elif (taz_id, node_id) in current_pairs:
            stabilized_final_status = "added"
        else:
            stabilized_final_status = "not_applicable"
        source_item = earliest_item or stabilized_item or current_item or {}
        change_rows.append(
            {
                "taz_id": taz_id,
                "node_id": node_id,
                "earliest_to_final": earliest_final_status,
                "stabilized_to_final": stabilized_final_status,
                "in_earliest": (taz_id, node_id) in earliest_pairs,
                "in_stabilized": (taz_id, node_id) in stabilized_pairs,
                "in_final": (taz_id, node_id) in current_pairs,
                "density": source_item.get("density"),
                "density_rank": source_item.get("rank"),
                "major_level": source_item.get("majorLevel"),
                "outside_len_ft": source_item.get("outsideLen"),
                "line_node_dist_ft": source_item.get("lineNodeDist"),
            }
        )
    pd.DataFrame(change_rows).to_csv(OUT / "connector_changes.csv", index=False)

    taz_rows: list[dict[str, Any]] = []
    earliest_counts = Counter(taz for taz, _ in earliest_pairs)
    stabilized_counts = Counter(taz for taz, _ in stabilized_pairs)
    final_counts = Counter(taz for taz, _ in current_pairs)
    for taz_id in sorted(taz_ids):
        early_set = {node for taz, node in earliest_pairs if taz == taz_id}
        stable_set = {node for taz, node in stabilized_pairs if taz == taz_id}
        final_set = {node for taz, node in current_pairs if taz == taz_id}
        if stable_set == final_set:
            edit_pattern = "no pair change"
        elif len(stable_set) == len(final_set):
            edit_pattern = "same-count replacement"
        elif len(final_set) > len(stable_set):
            edit_pattern = "net increase"
        else:
            edit_pattern = "net reduction"
        taz_rows.append(
            {
                "taz_id": taz_id,
                "earliest_count": earliest_counts.get(taz_id, 0),
                "stabilized_count": stabilized_counts.get(taz_id, 0),
                "final_count": final_counts.get(taz_id, 0),
                "earliest_exact_retained": len(early_set & final_set),
                "stabilized_exact_retained": len(stable_set & final_set),
                "removed_from_stabilized": len(stable_set - final_set),
                "added_to_final": len(final_set - stable_set),
                "edit_pattern": edit_pattern,
            }
        )
    taz_frame = pd.DataFrame(taz_rows)
    taz_frame.to_csv(OUT / "changes_by_taz.csv", index=False)

    quality_rows: list[dict[str, Any]] = []
    rank_rows: list[dict[str, Any]] = []
    for baseline_name, baseline_obj, baseline_pairs in [
        ("earliest", earliest, earliest_pairs),
        ("stabilized", stabilized, stabilized_pairs),
    ]:
        for item in baseline_obj["connectors"]:
            status = (
                "retained" if connector_pair(item) in current_pairs else "removed"
            )
            quality_rows.append(
                {
                    "baseline": baseline_name,
                    "status": status,
                    "taz_id": int(float(item["tazId"])),
                    "node_id": int(float(item["nodeId"])),
                    "density": item.get("density"),
                    "density_rank": item.get("rank"),
                    "rank_bucket": rank_bucket(item.get("rank")),
                    "major_level": item.get("majorLevel"),
                    "outside_len_ft": item.get("outsideLen"),
                    "line_node_dist_ft": item.get("lineNodeDist"),
                }
            )
        frame = pd.DataFrame(
            [row for row in quality_rows if row["baseline"] == baseline_name]
        )
        for bucket, group in frame.groupby("rank_bucket", sort=False):
            retained = int((group["status"] == "retained").sum())
            rank_rows.append(
                {
                    "baseline": baseline_name,
                    "rank_bucket": bucket,
                    "original_connectors": len(group),
                    "retained_in_final": retained,
                    "removed_before_final": len(group) - retained,
                    "retention_pct": pct(retained, len(group)),
                }
            )
    quality_frame = pd.DataFrame(quality_rows)
    quality_frame.to_csv(OUT / "baseline_connector_quality.csv", index=False)
    rank_frame = pd.DataFrame(rank_rows)
    rank_frame.to_csv(OUT / "retention_by_density_rank.csv", index=False)

    candidate_lines = gpd.read_file(
        BASELINE_GPKG, layer="candidate_connector_lines"
    )
    master_nodes = gpd.read_file(BASELINE_GPKG, layer="gstdm_master_nodes")
    node_id_by_index = master_nodes["N"].astype(int).to_dict()
    candidate_lines = candidate_lines[candidate_lines["MATCH_NODE_IDX"] >= 0].copy()
    candidate_lines["taz_id"] = candidate_lines["N"].astype(int)
    candidate_lines["node_id"] = candidate_lines["MATCH_NODE_IDX"].map(
        node_id_by_index
    )
    candidate_pair_metrics: dict[tuple[int, int], dict[str, Any]] = {}
    for (taz_id, node_id), group in candidate_lines.groupby(["taz_id", "node_id"]):
        candidate_pair_metrics[(int(taz_id), int(node_id))] = {
            "candidate_best_rank": int(group["DENS_RANK"].min()),
            "candidate_max_density": float(group["DENSITY"].max()),
            "candidate_sector_count": int(len(group)),
        }

    stable_added_pairs = current_pairs - stabilized_pairs
    addition_rows: list[dict[str, Any]] = []
    for pair in sorted(stable_added_pairs):
        current_item = current_by_pair[pair]
        candidate = candidate_pair_metrics.get(pair, {})
        addition_rows.append(
            {
                "taz_id": pair[0],
                "node_id": pair[1],
                "was_20260722_candidate": bool(candidate),
                "candidate_best_rank": candidate.get("candidate_best_rank"),
                "candidate_max_density": candidate.get("candidate_max_density"),
                "candidate_sector_count": candidate.get("candidate_sector_count"),
                "major_level": current_item.get("majorLevel"),
                "outside_len_ft": current_item.get("outsideLen"),
            }
        )
    addition_frame = pd.DataFrame(addition_rows)
    addition_frame.to_csv(OUT / "final_additions_vs_stabilized.csv", index=False)

    stable_removed = stabilized_pairs - current_pairs
    stable_added = current_pairs - stabilized_pairs
    stable_removed_by_taz: dict[int, list[dict[str, Any]]] = defaultdict(list)
    stable_added_by_taz: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for pair in stable_removed:
        stable_removed_by_taz[pair[0]].append(stabilized_by_pair[pair])
    for pair in stable_added:
        stable_added_by_taz[pair[0]].append(current_by_pair[pair])

    replacement_rows: list[dict[str, Any]] = []
    for taz_id in sorted(taz_ids):
        matches = minimum_distance_matches(
            stable_removed_by_taz.get(taz_id, []),
            stable_added_by_taz.get(taz_id, []),
        )
        for old, new, distance in matches:
            old_pair = connector_pair(old)
            new_pair = connector_pair(new)
            old_major = finite(old.get("majorLevel"))
            new_major = finite(new.get("majorLevel"))
            if old_major is None or new_major is None:
                major_change = "unknown"
            elif new_major < old_major:
                major_change = "more major"
            elif new_major > old_major:
                major_change = "less major"
            else:
                major_change = "same"
            candidate = candidate_pair_metrics.get(new_pair, {})
            replacement_rows.append(
                {
                    "taz_id": taz_id,
                    "old_node_id": old_pair[1],
                    "new_node_id": new_pair[1],
                    "endpoint_shift_ft": distance,
                    "old_density": old.get("density"),
                    "old_density_rank": old.get("rank"),
                    "old_major_level": old.get("majorLevel"),
                    "new_major_level": new.get("majorLevel"),
                    "major_level_change": major_change,
                    "new_was_20260722_candidate": bool(candidate),
                    "new_candidate_best_rank": candidate.get("candidate_best_rank"),
                }
            )
    replacement_frame = pd.DataFrame(replacement_rows)
    replacement_frame.to_csv(OUT / "replacement_matches.csv", index=False)

    summary_quality: dict[str, Any] = {}
    for baseline_name in ["earliest", "stabilized"]:
        summary_quality[baseline_name] = {}
        subset = quality_frame[quality_frame["baseline"] == baseline_name]
        for status in ["retained", "removed"]:
            status_rows = subset[subset["status"] == status]
            summary_quality[baseline_name][status] = {
                "count": int(len(status_rows)),
                "density": summarize_numbers(status_rows["density"]),
                "density_rank": summarize_numbers(status_rows["density_rank"]),
                "outside_len_ft": summarize_numbers(status_rows["outside_len_ft"]),
                "line_node_dist_ft": summarize_numbers(
                    status_rows["line_node_dist_ft"]
                ),
                "major_level": dict(
                    sorted(
                        Counter(
                            major_level_bucket(value)
                            for value in status_rows["major_level"]
                        ).items()
                    )
                ),
            }

    stable_edit_patterns = (
        taz_frame["edit_pattern"].value_counts().sort_index().to_dict()
    )
    candidate_hits = int(addition_frame["was_20260722_candidate"].sum())
    replacement_distance = summarize_numbers(
        replacement_frame["endpoint_shift_ft"]
    )
    replacement_distance_buckets = {
        "<=200 ft": int((replacement_frame["endpoint_shift_ft"] <= 200).sum()),
        "201-500 ft": int(
            (
                (replacement_frame["endpoint_shift_ft"] > 200)
                & (replacement_frame["endpoint_shift_ft"] <= 500)
            ).sum()
        ),
        "501-1000 ft": int(
            (
                (replacement_frame["endpoint_shift_ft"] > 500)
                & (replacement_frame["endpoint_shift_ft"] <= 1000)
            ).sum()
        ),
        ">1000 ft": int((replacement_frame["endpoint_shift_ft"] > 1000).sum()),
    }

    summary = {
        "analysis_scope": {
            "new_taz_count": len(taz_ids),
            "earliest_baseline": {
                "git_commit": earliest["commit"],
                "generated_from": earliest["generated_from"],
                "connector_features": len(earliest["connectors"]),
                "connector_pairs": len(earliest_pairs),
                "duplicate_taz_node_features": (
                    len(earliest["connectors"]) - len(earliest_pairs)
                ),
                "target_connector_count": 4,
                "node_source": earliest["data"].get("nodeSource"),
            },
            "stabilized_baseline": {
                "git_commit": stabilized["commit"],
                "generated_from": stabilized["generated_from"],
                "connector_features": len(stabilized["connectors"]),
                "connector_pairs": len(stabilized_pairs),
                "duplicate_taz_node_features": (
                    len(stabilized["connectors"]) - len(stabilized_pairs)
                ),
                "target_connector_count": 3,
                "node_source": stabilized["data"].get("nodeSource"),
            },
            "current_final": {
                "source": str(CURRENT_CC.relative_to(ROOT)).replace("\\", "/"),
                "connector_pairs": len(current_pairs),
                "taz_with_connector": len({taz for taz, _ in current_pairs}),
            },
            "test_run_needed": False,
            "test_run_reason": (
                "No rerun was needed because Git preserves the earliest published "
                "road-density JSON and the 2026-07-22 GPKG preserves candidates, "
                "selected connectors, and run configuration."
            ),
        },
        "comparisons": comparisons,
        "stage_history": stage_rows,
        "count_distributions": {
            "earliest": count_distribution(earliest_pairs, taz_ids),
            "stabilized": count_distribution(stabilized_pairs, taz_ids),
            "final": count_distribution(current_pairs, taz_ids),
        },
        "stabilized_to_final_patterns": {
            "taz_edit_patterns": stable_edit_patterns,
            "taz_pair_sets_unchanged": int(
                (taz_frame["edit_pattern"] == "no pair change").sum()
            ),
            "taz_pair_sets_changed": int(
                (taz_frame["edit_pattern"] != "no pair change").sum()
            ),
            "previously_unserved_taz_now_served": int(
                (
                    (taz_frame["stabilized_count"] == 0)
                    & (taz_frame["final_count"] > 0)
                ).sum()
            ),
            "final_additions_in_20260722_candidate_universe": candidate_hits,
            "final_additions_not_in_20260722_candidate_universe": int(
                len(addition_frame) - candidate_hits
            ),
            "candidate_hit_pct": pct(candidate_hits, len(addition_frame)),
            "matched_replacements": int(len(replacement_frame)),
            "replacement_endpoint_shift_ft": replacement_distance,
            "replacement_distance_buckets": replacement_distance_buckets,
            "replacement_major_level_change": dict(
                sorted(
                    replacement_frame["major_level_change"]
                    .value_counts()
                    .to_dict()
                    .items()
                )
            ),
        },
        "baseline_quality": summary_quality,
        "source_validation": {
            "current_input_matches_core": True,
            "current_directed_rows": int(len(pd.read_csv(CURRENT_CC))),
            "current_unique_pairs_for_658_taz": len(current_pairs),
            "earliest_unique_pairs": len(earliest_pairs),
            "stabilized_csv_rows": int(len(pd.read_csv(BASELINE_TABLE))),
            "stabilized_unique_pairs": len(stabilized_pairs),
        },
    }

    (OUT / "summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
