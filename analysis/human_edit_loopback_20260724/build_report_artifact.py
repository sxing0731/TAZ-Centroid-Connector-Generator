from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


HERE = Path(__file__).resolve().parent


def source(source_id: str, label: str, path: str) -> dict[str, str]:
    return {"id": source_id, "label": label, "path": path}


def query_source(
    source_id: str,
    label: str,
    path: str,
    sql: str,
    description: str,
    generated_at: str,
    tables_used: list[str],
) -> dict[str, object]:
    return {
        "id": source_id,
        "label": label,
        "path": path,
        "query": {
            "engine": "sqlite",
            "language": "sql",
            "sql": sql,
            "description": description,
            "executed_at": generated_at,
            "tables_used": tables_used,
        },
    }


def main() -> None:
    summary = json.loads((HERE / "summary.json").read_text(encoding="utf-8"))
    replacements = pd.read_csv(HERE / "cc_replacement_pairs.csv")
    miss_changes = pd.read_csv(HERE / "here_miss_changes.csv")
    added_miss = miss_changes[miss_changes["status"] == "added"].copy()
    added_miss["shared_street_name"] = [
        bool(
            {
                value
                for value in str(old_names).split("|")
                if value and value != "nan"
            }
            & {
                value
                for value in str(new_names).split("|")
                if value and value != "nan"
            }
        )
        for old_names, new_names in zip(
            added_miss["a_street_names"], added_miss["b_street_names"]
        )
    ]

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    generated_at = generated_at.replace("+00:00", "Z")

    operation_input = pd.DataFrame(
        [
            {
                "sort_order": 1,
                "operation": "Within-TAZ replacements",
                "count": summary["cc_change_scope"][
                    "matched_within_taz_replacements"
                ],
            },
            {
                "sort_order": 2,
                "operation": "Unmatched deletions",
                "count": summary["cc_change_scope"]["unmatched_deletions"],
            },
            {
                "sort_order": 3,
                "operation": "Unmatched additions",
                "count": summary["cc_change_scope"]["unmatched_additions"],
            },
        ]
    )
    added_miss["shared_street_name"] = added_miss["shared_street_name"].map(
        lambda value: "Yes" if value else "No"
    )
    added_miss["direct_edge_exists"] = added_miss[
        "already_directly_linked_in_gstdm"
    ].map(lambda value: "Yes" if bool(value) else "No")

    operation_sql = """
SELECT operation, count
FROM cc_edit_operations
ORDER BY sort_order
""".strip()
    degree_sql = """
WITH endpoint_degrees AS (
  SELECT 'Pre-generated target' AS stage, CAST(old_degree AS INTEGER) AS degree
  FROM cc_replacements
  UNION ALL
  SELECT 'Human-selected target' AS stage, CAST(new_degree AS INTEGER) AS degree
  FROM cc_replacements
),
degree_values(degree) AS (
  VALUES (2), (3), (4), (5)
),
stages(stage) AS (
  VALUES ('Pre-generated target'), ('Human-selected target')
)
SELECT stages.stage,
       CAST(degree_values.degree AS TEXT) AS degree,
       COUNT(endpoint_degrees.degree) AS count
FROM stages
CROSS JOIN degree_values
LEFT JOIN endpoint_degrees
  ON endpoint_degrees.stage = stages.stage
 AND endpoint_degrees.degree = degree_values.degree
GROUP BY stages.stage, degree_values.degree
ORDER BY stages.stage DESC, degree_values.degree
""".strip()
    miss_sql = """
SELECT pair_key AS pair,
       ROUND(straight_length_ft, 1) AS gap_ft,
       a_street_names AS road_at_a,
       b_street_names AS road_at_b,
       shared_street_name AS same_road_name,
       direct_edge_exists
FROM added_missing_links
ORDER BY straight_length_ft
""".strip()

    connection = sqlite3.connect(":memory:")
    operation_input.to_sql(
        "cc_edit_operations", connection, index=False, if_exists="replace"
    )
    replacements.to_sql(
        "cc_replacements", connection, index=False, if_exists="replace"
    )
    added_miss.to_sql(
        "added_missing_links", connection, index=False, if_exists="replace"
    )
    operation_rows = pd.read_sql_query(operation_sql, connection).to_dict(
        orient="records"
    )
    degree_rows = pd.read_sql_query(degree_sql, connection).to_dict(
        orient="records"
    )
    miss_rows = pd.read_sql_query(miss_sql, connection).to_dict(orient="records")
    connection.close()

    analysis_source = source(
        "analysis_summary",
        "Human-edit comparison summary",
        "analysis/human_edit_loopback_20260724/summary.json",
    )
    operations_source = query_source(
        "cc_operations_query",
        "CC operation summary query",
        "analysis/human_edit_loopback_20260724/summary.json",
        operation_sql,
        "Reads the reviewed CC edit-operation counts used in the report chart.",
        generated_at,
        ["cc_edit_operations"],
    )
    replacement_source = query_source(
        "cc_replacements",
        "Matched CC replacement evidence",
        "analysis/human_edit_loopback_20260724/cc_replacement_pairs.csv",
        degree_sql,
        "Counts pre-generated and human-selected replacement endpoints by unique-neighbor degree.",
        generated_at,
        ["cc_replacements"],
    )
    miss_source = query_source(
        "here_miss_changes",
        "HERE_MISS change evidence",
        "analysis/human_edit_loopback_20260724/here_miss_changes.csv",
        miss_sql,
        "Selects the 11 added HERE_MISS pairs and their reviewed gap attributes.",
        generated_at,
        ["added_missing_links"],
    )
    method_source = source(
        "analysis_method",
        "Reproducible comparison script",
        "analysis/human_edit_loopback_20260724/analyze_human_edits.py",
    )
    canonical_sources = [
        analysis_source,
        operations_source,
        replacement_source,
        miss_source,
        method_source,
    ]

    title = "Human Edit Loopback: TAZ Connectors and Missing Links"
    manifest = {
        "version": 1,
        "surface": "report",
        "title": title,
        "description": (
            "Evidence-backed comparison of the July 24, 2026 human-edited "
            "Global TAZ CC and HERE_MISS uploads against their pre-generated baselines."
        ),
        "generatedAt": generated_at,
        "charts": [
            {
                "id": "cc_edit_operations",
                "title": "CC edit operations",
                "subtitle": (
                    "Pair-level changes among 14,923 pre-generated Global CC pairs"
                ),
                "type": "bar",
                "dataset": "cc_edit_operations",
                "source": operations_source,
                "valueFormat": "number",
                "encodings": {
                    "x": {
                        "field": "operation",
                        "type": "nominal",
                        "label": "Operation",
                    },
                    "y": {
                        "field": "count",
                        "type": "quantitative",
                        "label": "Connector pairs",
                    },
                    "tooltip": [
                        {
                            "field": "count",
                            "type": "quantitative",
                            "label": "Connector pairs",
                            "format": "number",
                        }
                    ],
                },
            },
            {
                "id": "replacement_degree_shift",
                "title": "Network degree at replacement endpoints",
                "subtitle": (
                    "35 matched within-TAZ replacements; degree is the number of "
                    "unique neighboring GSTDM nodes"
                ),
                "type": "bar",
                "dataset": "replacement_degree_shift",
                "source": replacement_source,
                "valueFormat": "number",
                "encodings": {
                    "x": {
                        "field": "degree",
                        "type": "ordinal",
                        "label": "Unique-neighbor degree",
                    },
                    "y": {
                        "field": "count",
                        "type": "quantitative",
                        "label": "Replacement endpoints",
                    },
                    "color": {
                        "field": "stage",
                        "type": "nominal",
                        "label": "Endpoint",
                    },
                    "tooltip": [
                        {
                            "field": "stage",
                            "type": "nominal",
                            "label": "Endpoint",
                        },
                        {
                            "field": "count",
                            "type": "quantitative",
                            "label": "Endpoints",
                            "format": "number",
                        },
                    ],
                },
            },
        ],
        "tables": [
            {
                "id": "added_missing_links",
                "title": "New HERE_MISS pairs",
                "subtitle": (
                    "11 pairs appended after the 17-pair published baseline; "
                    "straight-line gap length in Georgia Statewide Lambert feet"
                ),
                "dataset": "added_missing_links",
                "source": miss_source,
                "defaultSort": {"field": "gap_ft", "direction": "asc"},
                "columns": [
                    {"field": "pair", "label": "Node pair", "type": "text"},
                    {
                        "field": "gap_ft",
                        "label": "Gap (ft)",
                        "format": "number",
                    },
                    {
                        "field": "same_road_name",
                        "label": "Same road name",
                        "type": "text",
                    },
                    {"field": "road_at_a", "label": "Road at A", "type": "text"},
                    {"field": "road_at_b", "label": "Road at B", "type": "text"},
                    {
                        "field": "direct_edge_exists",
                        "label": "Direct GSTDM edge",
                        "type": "text",
                    },
                ],
            }
        ],
        "sources": canonical_sources,
        "blocks": [
            {
                "id": "title",
                "type": "markdown",
                "body": f"# {title}",
            },
            {
                "id": "executive_summary",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Executive Summary\n\n"
                    "- **Human edits are selective, not a broad rejection of the generator.** "
                    "The upload changes 41 TAZs, removes 42 CC pairs, and adds 40, "
                    "for a net reduction of only two pairs. All edited TAZs are in "
                    "the first 1–1,000 review block.\n"
                    "- **The dominant CC correction is a same-corridor move to a more "
                    "connected node.** Of 35 matched replacements, 32 keep at least "
                    "one road name and 30 move to a higher-degree node. Median bearing "
                    "change is 8.4°, while connector length is almost evenly split "
                    "between shorter and longer outcomes.\n"
                    "- **HERE_MISS edits repair short network discontinuities.** Eleven "
                    "pairs were added; every pair spans 34–92 ft, none already has a "
                    "direct GSTDM edge, and 10 of 11 share a road name across the gap.\n"
                    "- **Loop the behavior back as ranking and review assistance first.** "
                    "Use intersection degree, shared road name, and small direction/shift "
                    "penalties to rank alternatives; flag major-road legacy targets and "
                    "short same-road gaps, but keep human confirmation until later review "
                    "blocks reproduce the pattern."
                ),
            },
            {
                "id": "targeted_scope",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Edits are targeted and confined to the first review block\n\n"
                    "**The edited footprint is small relative to the reviewed block.** "
                    "The first block contained 2,597 pre-generated CC pairs. The 42 "
                    "removed pairs equal 1.62% of that base, and 41 of 1,000 TAZs "
                    "(4.1%) were touched. The edit set resolves into 35 within-TAZ "
                    "replacements, seven unmatched deletions, and five unmatched "
                    "additions.\n\n"
                    "This concentration makes the current evidence useful for improving "
                    "the first-block workflow, but it is not yet a statewide training "
                    "sample. Re-run the comparison after each additional review block."
                ),
            },
            {
                "id": "operations_chart",
                "type": "chart",
                "chartId": "cc_edit_operations",
            },
            {
                "id": "intersection_preference",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Reviewers preserve the corridor but prefer a real junction\n\n"
                    "**The strongest repeated behavior is a local shift along the same "
                    "road to a node with more network choices.** Thirty-two of 35 "
                    "replacement pairs share a road name. Thirty replacements increase "
                    "unique-neighbor degree; the old endpoint is degree 2 in 34 of 35 "
                    "cases, while the human-selected endpoint is degree 3–5 in 30 cases. "
                    "The median endpoint shift is 756 ft and the median angular change "
                    "from the TAZ centroid is only 8.4°.\n\n"
                    "The implication is specific: add an intersection preference within "
                    "the selected corridor. Do not replace the existing hard geometry "
                    "and eligibility rules with a general nearest-node or shortest-line rule."
                ),
            },
            {
                "id": "degree_chart",
                "type": "chart",
                "chartId": "replacement_degree_shift",
            },
            {
                "id": "length_not_driver",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Connector length and TAZ-boundary distance are not the main drivers\n\n"
                    "**The human decisions are nearly neutral on length.** Sixteen "
                    "replacements are shorter, 18 are longer, and one is effectively "
                    "unchanged; the median increase is only 55 ft. Outside-TAZ connector "
                    "length improves in three cases, worsens in three, and is essentially "
                    "unchanged in 29.\n\n"
                    "A length-minimizing loopback would therefore learn the wrong lesson. "
                    "Connectivity and corridor continuity carry more signal than raw distance."
                ),
            },
            {
                "id": "missing_link_pattern",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## HERE_MISS additions are short continuity repairs\n\n"
                    "**The added links form an unusually consistent candidate-detection "
                    "pattern.** All 11 connect two degree-2 nodes with matching functional "
                    "level, span less than 100 ft, and lack an existing direct GSTDM edge. "
                    "Ten pairs also share a road name. One pair uses different loop-road "
                    "names and should remain an explicit exception path.\n\n"
                    "This is strong enough for an automated suggestion layer, but a final "
                    "collinearity and grade-separation check should be added before any "
                    "link is auto-created."
                ),
            },
            {
                "id": "missing_link_table",
                "type": "table",
                "tableId": "added_missing_links",
            },
            {
                "id": "recommendations",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Recommended loopback changes\n\n"
                    "1. **Add a soft intersection bonus to CC candidate ranking.** Prefer "
                    "an eligible degree-3+ node when it shares the selected road/corridor "
                    "and stays close to the original direction. An initial high-confidence "
                    "suggestion envelope of ≤20° angular change and ≤1,800 ft endpoint "
                    "shift matches 23 of the 35 replacements when combined with same-road "
                    "and higher-degree conditions.\n"
                    "2. **Keep MAJOR_LEVEL ≤2 as a review flag, not an automatic deletion.** "
                    "Five of seven unmatched deletions remove level-2 targets, but 56 "
                    "level-2 connectors remain in the first block. The residual count shows "
                    "that reviewers did not apply a universal hard-delete rule.\n"
                    "3. **Generate HERE_MISS suggestions from stable gap signals.** Start "
                    "with node pairs under 100 ft, no direct edge, matching functional level, "
                    "degree-2 endpoints, and a shared road name. Add tangent alignment and "
                    "grade-separation checks; expose same-name failures as manual exceptions.\n"
                    "4. **Capture an edit reason code with every future change.** Suggested "
                    "values are `MOVE_TO_INTERSECTION`, `WRONG_CORRIDOR`, "
                    "`MAJOR_ROAD_TARGET`, `ADD_ACCESS`, `DELETE_REDUNDANT`, and "
                    "`ADD_HERE_MISS`. Reason codes will separate true design intent from "
                    "patterns inferred only from geometry.\n"
                    "5. **Version the pre-upload baseline before regenerating web data.** "
                    "Save immutable CC/HERE_MISS files, counts, and hashes before publishing "
                    "a new baseline so the next loopback does not depend on a mutable "
                    "`core.json`."
                ),
            },
            {
                "id": "further_questions",
                "type": "markdown",
                "body": (
                    "## Further Questions\n\n"
                    "- Was the entire 1–1,000 block reviewed, or only selected TAZs?\n"
                    "- Are the remaining level-2 endpoints intentional legacy connectors "
                    "or items awaiting review?\n"
                    "- Should the same-road rule treat paired facilities such as inner/outer "
                    "loops as equivalent names?\n"
                    "- Can the next export include TAZ status and a reason code so acceptance "
                    "and rejection rates have an explicit denominator?"
                ),
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": (
                    "## Caveats and Assumptions\n\n"
                    "- The CC baseline is an independent staging snapshot and is directly "
                    "comparable to the uploaded file.\n"
                    "- The pre-upload HERE_MISS `core.json` was regenerated in place during "
                    "analysis. Its published 17-pair baseline was reconstructed from the "
                    "first 17 ordered pairs retained in the current export, consistent with "
                    "the counts documented before refresh; no independent 17-pair file "
                    "snapshot remains.\n"
                    "- Replacement matching is performed within each TAZ using the smallest "
                    "endpoint-shift assignment when multiple nodes changed.\n"
                    "- No reviewer reason codes were available, so intent is inferred from "
                    "street names, topology, functional level, geometry, and edit clustering."
                ),
            },
        ],
    }

    artifact = {
        "surface": "report",
        "manifest": manifest,
        "snapshot": {
            "version": 1,
            "generatedAt": generated_at,
            "status": "ready",
            "datasets": {
                "cc_edit_operations": operation_rows,
                "replacement_degree_shift": degree_rows,
                "added_missing_links": miss_rows,
            },
        },
        "sources": canonical_sources,
    }
    (HERE / "artifact.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
