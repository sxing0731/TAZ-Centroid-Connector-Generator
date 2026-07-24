from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


HERE = Path(__file__).resolve().parent
PROJECT_REL = "analysis/new_taz_658_road_density_loopback_20260724"


def file_source(source_id: str, label: str, path: str) -> dict[str, str]:
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
    versions = pd.read_csv(HERE / "version_inventory.csv")
    rank_retention = pd.read_csv(HERE / "retention_by_density_rank.csv")
    changes_by_taz = pd.read_csv(HERE / "changes_by_taz.csv")

    generated_at = (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )

    versions["short_stage"] = [
        "Earliest\n2,632 features",
        "QC rules",
        "No shared\nnodes",
        "Improved\nrules",
        "Stable\nalgorithm",
        "Published\nalgorithm",
        "First human\npublish",
        "Current\nfinal",
    ]
    versions["stage_order"] = versions["order"].astype(int)

    count_distribution_rows = []
    stage_labels = {
        "earliest": "Earliest road-density",
        "stabilized": "Stable algorithm",
        "final": "Current final",
    }
    for stage, distribution in summary["count_distributions"].items():
        for connector_count, taz_count in distribution.items():
            count_distribution_rows.append(
                {
                    "stage": stage_labels[stage],
                    "connector_count": str(connector_count),
                    "taz_count": int(taz_count),
                }
            )
    count_distribution = pd.DataFrame(count_distribution_rows)

    rank_retention["baseline_label"] = rank_retention["baseline"].map(
        {
            "earliest": "Earliest road-density",
            "stabilized": "Stable algorithm",
        }
    )
    rank_order = {"1": 1, "2": 2, "3-4": 3, "5-6": 4, "7-10": 5}
    rank_retention["rank_order"] = rank_retention["rank_bucket"].map(rank_order)

    pattern_order = {
        "no pair change": 1,
        "same-count replacement": 2,
        "net reduction": 3,
        "net increase": 4,
    }
    edit_patterns = (
        changes_by_taz.groupby("edit_pattern", as_index=False)
        .size()
        .rename(columns={"size": "taz_count"})
    )
    edit_patterns["pattern_order"] = edit_patterns["edit_pattern"].map(
        pattern_order
    )
    edit_patterns["edit_pattern"] = edit_patterns["edit_pattern"].map(
        {
            "no pair change": "No pair change",
            "same-count replacement": "Same-count replacement",
            "net reduction": "Net reduction",
            "net increase": "Net increase",
        }
    )

    version_sql = """
SELECT short_stage AS stage,
       CAST(connector_pairs AS INTEGER) AS connector_pairs,
       CAST(stage_order AS INTEGER) AS stage_order
FROM versions
ORDER BY stage_order
""".strip()
    count_sql = """
SELECT stage,
       connector_count,
       taz_count
FROM count_distribution
ORDER BY CASE stage
           WHEN 'Earliest road-density' THEN 1
           WHEN 'Stable algorithm' THEN 2
           ELSE 3
         END,
         CAST(connector_count AS INTEGER)
""".strip()
    rank_sql = """
SELECT baseline_label AS baseline,
       rank_bucket,
       ROUND(retention_pct, 1) AS retention_pct,
       CAST(original_connectors AS INTEGER) AS original_connectors
FROM rank_retention
ORDER BY rank_order,
         CASE baseline WHEN 'Earliest road-density' THEN 1 ELSE 2 END
""".strip()
    pattern_sql = """
SELECT edit_pattern,
       CAST(taz_count AS INTEGER) AS taz_count
FROM edit_patterns
ORDER BY pattern_order
""".strip()
    version_table_sql = """
SELECT stage,
       generated_from,
       CAST(connector_features AS INTEGER) AS connector_features,
       CAST(connector_pairs AS INTEGER) AS unique_pairs,
       CAST(duplicate_taz_node_features AS INTEGER) AS duplicate_features,
       CAST(taz_with_connector AS INTEGER) AS covered_taz
FROM versions
ORDER BY stage_order
""".strip()

    connection = sqlite3.connect(":memory:")
    versions.to_sql("versions", connection, index=False, if_exists="replace")
    count_distribution.to_sql(
        "count_distribution", connection, index=False, if_exists="replace"
    )
    rank_retention.to_sql(
        "rank_retention", connection, index=False, if_exists="replace"
    )
    edit_patterns.to_sql(
        "edit_patterns", connection, index=False, if_exists="replace"
    )
    version_rows = pd.read_sql_query(version_sql, connection).to_dict(
        orient="records"
    )
    count_rows = pd.read_sql_query(count_sql, connection).to_dict(orient="records")
    rank_rows = pd.read_sql_query(rank_sql, connection).to_dict(orient="records")
    pattern_rows = pd.read_sql_query(pattern_sql, connection).to_dict(
        orient="records"
    )
    version_table_rows = pd.read_sql_query(
        version_table_sql, connection
    ).to_dict(orient="records")
    connection.close()

    summary_source = file_source(
        "analysis_summary",
        "Road-density to final comparison summary",
        f"{PROJECT_REL}/summary.json",
    )
    method_source = file_source(
        "analysis_method",
        "Reproducible comparison script",
        f"{PROJECT_REL}/analyze_road_density_to_final.py",
    )
    versions_source = query_source(
        "version_history_query",
        "Version inventory query",
        f"{PROJECT_REL}/version_inventory.csv",
        version_sql,
        "Returns unique connector-pair counts for the eight preserved stages.",
        generated_at,
        ["versions"],
    )
    count_source = query_source(
        "connector_count_distribution_query",
        "Per-TAZ connector-count distribution query",
        f"{PROJECT_REL}/changes_by_taz.csv",
        count_sql,
        "Counts New TAZs by connector count at the earliest, stable, and final stages.",
        generated_at,
        ["count_distribution"],
    )
    rank_source = query_source(
        "density_rank_retention_query",
        "Density-rank retention query",
        f"{PROJECT_REL}/retention_by_density_rank.csv",
        rank_sql,
        "Calculates final exact-pair retention by original density-rank bucket.",
        generated_at,
        ["rank_retention"],
    )
    pattern_source = query_source(
        "edit_pattern_query",
        "TAZ edit-pattern query",
        f"{PROJECT_REL}/changes_by_taz.csv",
        pattern_sql,
        "Counts TAZs by stable-algorithm-to-final edit pattern.",
        generated_at,
        ["edit_patterns"],
    )
    version_table_source = query_source(
        "version_inventory_table_query",
        "Version inventory table query",
        f"{PROJECT_REL}/version_inventory.csv",
        version_table_sql,
        "Returns the exact feature, pair, duplicate, and coverage counts for each stage.",
        generated_at,
        ["versions"],
    )
    canonical_sources = [
        summary_source,
        versions_source,
        count_source,
        rank_source,
        pattern_source,
        version_table_source,
        method_source,
    ]

    earliest_comparison = summary["comparisons"]["earliest_to_final"]
    stable_comparison = summary["comparisons"]["stabilized_to_final"]
    patterns = summary["stabilized_to_final_patterns"]
    stable_quality = summary["baseline_quality"]["stabilized"]

    title = "From Road Density to Final Connectors: 658 New TAZ Loopback"
    manifest = {
        "version": 1,
        "surface": "report",
        "title": title,
        "description": (
            "Comparison of the earliest road-density-generated centroid connectors, "
            "the stabilized algorithm output, and the current uploaded final CCs "
            "for the same 658 New TAZs."
        ),
        "generatedAt": generated_at,
        "charts": [
            {
                "id": "version_counts",
                "title": "Unique connector pairs by preserved stage",
                "subtitle": (
                    "Same 658 New TAZ cohort; earliest file has 2,632 features "
                    "but 2,606 unique TAZ-node pairs"
                ),
                "type": "bar",
                "dataset": "version_counts",
                "source": versions_source,
                "valueFormat": "number",
                "encodings": {
                    "x": {
                        "field": "stage",
                        "type": "nominal",
                        "label": "Stage",
                    },
                    "y": {
                        "field": "connector_pairs",
                        "type": "quantitative",
                        "label": "Unique connector pairs",
                    },
                    "tooltip": [
                        {
                            "field": "connector_pairs",
                            "type": "quantitative",
                            "label": "Unique pairs",
                            "format": "number",
                        }
                    ],
                },
            },
            {
                "id": "count_distribution",
                "title": "Connector count per TAZ",
                "subtitle": (
                    "Number of the 658 New TAZs with each unique connector count"
                ),
                "type": "bar",
                "dataset": "count_distribution",
                "source": count_source,
                "valueFormat": "number",
                "encodings": {
                    "x": {
                        "field": "connector_count",
                        "type": "ordinal",
                        "label": "Connectors per TAZ",
                    },
                    "y": {
                        "field": "taz_count",
                        "type": "quantitative",
                        "label": "TAZ count",
                    },
                    "color": {
                        "field": "stage",
                        "type": "nominal",
                        "label": "Stage",
                    },
                    "tooltip": [
                        {"field": "stage", "type": "nominal", "label": "Stage"},
                        {
                            "field": "taz_count",
                            "type": "quantitative",
                            "label": "TAZ count",
                            "format": "number",
                        },
                    ],
                },
            },
            {
                "id": "density_rank_retention",
                "title": "Exact final retention by original density rank",
                "subtitle": (
                    "Percent of baseline connector records retained as the same "
                    "TAZ-node pair in the current final"
                ),
                "type": "bar",
                "dataset": "density_rank_retention",
                "source": rank_source,
                "valueFormat": "percent",
                "encodings": {
                    "x": {
                        "field": "rank_bucket",
                        "type": "ordinal",
                        "label": "Original density rank",
                    },
                    "y": {
                        "field": "retention_pct",
                        "type": "quantitative",
                        "label": "Retained (%)",
                    },
                    "color": {
                        "field": "baseline",
                        "type": "nominal",
                        "label": "Baseline",
                    },
                    "tooltip": [
                        {
                            "field": "baseline",
                            "type": "nominal",
                            "label": "Baseline",
                        },
                        {
                            "field": "retention_pct",
                            "type": "quantitative",
                            "label": "Retained (%)",
                            "format": "number",
                        },
                        {
                            "field": "original_connectors",
                            "type": "quantitative",
                            "label": "Original records",
                            "format": "number",
                        },
                    ],
                },
            },
            {
                "id": "edit_patterns",
                "title": "TAZ-level edit pattern after the stable algorithm run",
                "subtitle": "All 658 New TAZs; exact TAZ-node pair comparison",
                "type": "bar",
                "dataset": "edit_patterns",
                "source": pattern_source,
                "valueFormat": "number",
                "encodings": {
                    "x": {
                        "field": "edit_pattern",
                        "type": "nominal",
                        "label": "Edit pattern",
                    },
                    "y": {
                        "field": "taz_count",
                        "type": "quantitative",
                        "label": "TAZ count",
                    },
                    "tooltip": [
                        {
                            "field": "taz_count",
                            "type": "quantitative",
                            "label": "TAZ count",
                            "format": "number",
                        }
                    ],
                },
            },
        ],
        "tables": [
            {
                "id": "version_inventory",
                "title": "Preserved version inventory",
                "subtitle": (
                    "Feature counts can exceed unique pairs when multiple sectors "
                    "snap to the same TAZ-node pair"
                ),
                "dataset": "version_inventory",
                "source": version_table_source,
                "defaultSort": {"field": "stage", "direction": "asc"},
                "columns": [
                    {"field": "stage", "label": "Stage", "type": "text"},
                    {
                        "field": "generated_from",
                        "label": "Run / source",
                        "type": "text",
                    },
                    {
                        "field": "connector_features",
                        "label": "Features",
                        "format": "number",
                    },
                    {
                        "field": "unique_pairs",
                        "label": "Unique pairs",
                        "format": "number",
                    },
                    {
                        "field": "duplicate_features",
                        "label": "Duplicates",
                        "format": "number",
                    },
                    {
                        "field": "covered_taz",
                        "label": "TAZ covered",
                        "format": "number",
                    },
                ],
            }
        ],
        "sources": canonical_sources,
        "blocks": [
            {"id": "title", "type": "markdown", "body": f"# {title}"},
            {
                "id": "executive_summary",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Executive Summary\n\n"
                    "- **The final CCs are not a lightly edited copy of the earliest "
                    "road-density output.** The earliest preserved file contains 2,632 "
                    "connector features (2,606 unique TAZ-node pairs); the current final "
                    f"contains 1,467 pairs. Only {earliest_comparison['unchanged']} "
                    f"earliest pairs remain exact matches ({earliest_comparison['exact_retention_pct']:.1f}%). "
                    "Most of that gap reflects multiple algorithm revisions before human review.\n"
                    "- **Against the stabilized 1,550-pair algorithm output, human editing "
                    "is still structural.** The final retains 639 exact pairs, removes 911, "
                    "and adds 828. Pair sets changed in 535 of 658 TAZs; 298 TAZs kept the "
                    "same count but replaced one or more endpoints.\n"
                    "- **Road density is a weak preference, not the governing decision rule.** "
                    "Stable-run rank-1 connectors have the highest retention at 45.3%, "
                    "but other rank groups retain 35.1% to 43.7%, and removed connectors "
                    "have slightly higher median density than retained connectors.\n"
                    "- **Human review expands the candidate universe and prioritizes coverage.** "
                    "All 25 TAZs left without a connector by the stable run are served in "
                    "the final. Of 828 added pairs, 731 were not among the 2026-07-22 "
                    "generator's matched candidates."
                ),
            },
            {
                "id": "history",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Algorithm evolution explains much of the earliest-to-final gap\n\n"
                    "**The earliest road-density run should be treated as the starting "
                    "concept, not as the direct manual-review baseline.** It targeted four "
                    "connectors per TAZ and used an older node source. Successive QC, "
                    "node-sharing, snapping, and target-count changes reduced and replaced "
                    "many pairs before the first human-edited publish.\n\n"
                    "The direct human loopback is therefore the stable 1,550-pair output "
                    "to the 1,465-pair first human publish, with the current 1,467-pair "
                    "upload as a small subsequent revision. The full earliest-to-final "
                    "comparison remains useful for deciding what the generator should "
                    "ultimately learn."
                ),
            },
            {"id": "version_chart", "type": "chart", "chartId": "version_counts"},
            {
                "id": "version_table_block",
                "type": "table",
                "tableId": "version_inventory",
            },
            {
                "id": "quota",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## The final design replaces a fixed quota with TAZ-specific access\n\n"
                    "**The final connector count is intentionally heterogeneous.** The "
                    "earliest run placed four unique pairs in 640 TAZs. The stable run "
                    "concentrated at two or three and left 25 TAZs unserved. The final "
                    "serves every TAZ, with 139 TAZs using one connector, 257 using two, "
                    "235 using three, 26 using four, and one using five.\n\n"
                    "This is the clearest loopback signal for count selection: three or "
                    "four should be a soft target or maximum search depth, not a required "
                    "output count. Coverage and non-redundant access matter more than a "
                    "uniform quota."
                ),
            },
            {
                "id": "count_chart",
                "type": "chart",
                "chartId": "count_distribution",
            },
            {
                "id": "density",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Density helps choose a direction but does not identify the final node\n\n"
                    "**The review outcome does not show a monotonic keep-high-density rule.** "
                    "In the stable run, rank-1 pairs retain at 45.3%; ranks 5-6 retain at "
                    "43.7%, while rank 2 retains at 35.1%. Median density is 0.00737 for "
                    "retained pairs versus 0.00828 for removed pairs. Boundary-crossing "
                    "length also does not separate retained and removed pairs.\n\n"
                    "Road density should remain a directional accessibility signal, but "
                    "it should not dominate endpoint selection. The generator needs a "
                    "broader node candidate search plus independent checks for practical "
                    "network access and redundancy."
                ),
            },
            {
                "id": "rank_chart",
                "type": "chart",
                "chartId": "density_rank_retention",
            },
            {
                "id": "endpoint_change",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Human edits redraw endpoints more often than they make small nudges\n\n"
                    "**Only 123 TAZs keep the stable-run pair set unchanged.** There are "
                    "298 same-count replacements, 156 net reductions, and 81 net increases. "
                    f"Among {patterns['matched_replacements']} minimum-distance matched "
                    f"replacements, the median endpoint shift is "
                    f"{patterns['replacement_endpoint_shift_ft']['median']:.0f} ft; "
                    f"{patterns['replacement_distance_buckets']['>1000 ft']} shifts exceed "
                    "1,000 ft. Major level stays the same in 696 matched replacements, so "
                    "the edits are not primarily a functional-class upgrade.\n\n"
                    f"Only {patterns['final_additions_in_20260722_candidate_universe']} of "
                    "828 additions appear in the stable run's matched candidate universe. "
                    "The current sector-to-node fallback is therefore the main recall "
                    "constraint: changing the final ranker alone cannot reproduce most "
                    "human-selected endpoints."
                ),
            },
            {
                "id": "pattern_chart",
                "type": "chart",
                "chartId": "edit_patterns",
            },
            {
                "id": "recommendations",
                "type": "markdown",
                "sourceId": "analysis_summary",
                "body": (
                    "## Recommended loopback changes\n\n"
                    "1. **Keep road density as a soft directional prior.** Give a modest "
                    "bonus to high-density sectors, but do not let density rank decide the "
                    "node by itself.\n"
                    "2. **Expand candidate generation before tuning weights.** For each "
                    "sector, retain several eligible nodes and add nearby plausible access "
                    "nodes outside the current matched fallback. Measure candidate recall "
                    "against the 828 human-added pairs; the present recall is only 11.7%.\n"
                    "3. **Select a variable number of non-redundant connectors.** Guarantee "
                    "at least one valid connector per TAZ, then add connectors only when "
                    "they provide a distinct access direction or network branch. Treat "
                    "three as a planning target, not a hard quota.\n"
                    "4. **Separate candidate recall from ranking quality.** First test "
                    "whether the human-selected node appears in top-K candidates; only then "
                    "evaluate how often the ranker places it first. This prevents weight "
                    "tuning from masking a search-space problem.\n"
                    "5. **Capture an edit reason code and accepted alternatives.** Suggested "
                    "codes include `NO_ACCESS`, `WRONG_ROAD`, `REDUNDANT_DIRECTION`, "
                    "`BETTER_NODE`, `ADD_COVERAGE`, and `COUNT_ADJUSTMENT`. The current "
                    "analysis infers intent from outcomes because no reason field exists.\n"
                    "6. **Preserve immutable run and edit snapshots.** Store feature count, "
                    "unique-pair count, input hashes, parameters, candidate sets, and final "
                    "edits together so future loopback can distinguish rule changes from "
                    "human decisions."
                ),
            },
            {
                "id": "further_questions",
                "type": "markdown",
                "body": (
                    "## Further Questions\n\n"
                    "- Which field-review principle caused the 731 additions outside the "
                    "stable candidate universe: road continuity, driveway/access geometry, "
                    "local network knowledge, or another rule?\n"
                    "- Should one-connector TAZs be accepted as complete, or flagged for a "
                    "second independent-access search?\n"
                    "- Are the 26 four-connector and one five-connector outcomes deliberate "
                    "exceptions that can be described with repeatable criteria?\n"
                    "- Can the next editing export include rejected candidate IDs and reason "
                    "codes so candidate recall and ranking accuracy have explicit labels?"
                ),
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": (
                    "## Caveats and Assumptions\n\n"
                    "- The earliest file has 2,632 connector features but only 2,606 unique "
                    "TAZ-node pairs because 26 records repeat a pair across sectors. All "
                    "pair-level comparisons use unique pairs; record-level density summaries "
                    "retain the original feature denominator.\n"
                    "- The earliest run targeted four connectors and references the older "
                    "`run_20260712_155615` node source. The stabilized run targeted three "
                    "and uses the July 22 node source. Earliest-to-final differences therefore "
                    "combine algorithm/input evolution and human editing.\n"
                    "- Candidate-universe recall can be tested only for the preserved "
                    "July 22 GPKG. The earliest selected connectors are preserved in Git, "
                    "but its complete candidate layer is not.\n"
                    "- Replacement pairs are matched within each TAZ by the minimum total "
                    "endpoint shift. This provides a consistent comparison but is not a "
                    "recorded reviewer mapping.\n"
                    "- No test run was needed: Git preserves the earliest road-density JSON, "
                    "and the July 22 GPKG preserves its run configuration, candidate layers, "
                    "and final algorithm selections."
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
                "version_counts": version_rows,
                "count_distribution": count_rows,
                "density_rank_retention": rank_rows,
                "edit_patterns": pattern_rows,
                "version_inventory": version_table_rows,
            },
        },
        "sources": canonical_sources,
    }
    (HERE / "artifact.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
