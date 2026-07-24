"""Publish a reviewed CC DBF and HERE_MISS DBF as the static app baseline."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import pandas as pd

from repair_cross_taz_shared_nodes import (
    PROJECTED_CRS,
    build_directional_rows,
    centroid_lookup,
    clean_id,
    normalize_cc_pairs,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cc-dbf", type=Path, required=True)
    parser.add_argument("--here-miss-dbf", type=Path, required=True)
    parser.add_argument("--taz-shp", type=Path, required=True)
    parser.add_argument("--node-shp", type=Path, required=True)
    parser.add_argument("--source-cc-shp", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    taz = gpd.read_file(args.taz_shp).to_crs(PROJECTED_CRS)
    nodes = gpd.read_file(args.node_shp).to_crs(PROJECTED_CRS)
    source_cc = gpd.read_file(args.source_cc_shp).to_crs(PROJECTED_CRS)
    cc = gpd.read_file(args.cc_dbf)
    here_miss = gpd.read_file(args.here_miss_dbf)

    taz["_ID"] = taz["NEWID"].map(clean_id)
    taz_geometries = dict(zip(taz["_ID"], taz.geometry))
    taz_ids = set(taz_geometries)
    pairs = normalize_cc_pairs(cc, taz_ids)
    centroids = centroid_lookup(source_cc, taz_ids, taz_geometries)
    node_points = dict(zip(nodes["N"].map(clean_id), nodes.geometry))

    missing_nodes = sorted({node_id for _, node_id in pairs} - set(node_points))
    if missing_nodes:
        raise SystemExit(
            f"CC input references {len(missing_nodes)} missing node(s): {missing_nodes[:10]}"
        )

    owners: defaultdict[str, set[str]] = defaultdict(set)
    for taz_id, node_id in pairs:
        owners[node_id].add(taz_id)
    shared = {node_id: values for node_id, values in owners.items() if len(values) > 1}

    required_here_fields = {"A", "B", "LANES", "HERE_MISS", "FCLASS"}
    missing_fields = required_here_fields - set(here_miss.columns)
    if missing_fields:
        raise SystemExit(
            f"HERE_MISS input is missing field(s): {', '.join(sorted(missing_fields))}"
        )
    here_rows = here_miss[list(required_here_fields)].copy()
    for field in required_here_fields:
        here_rows[field] = pd.to_numeric(here_rows[field], errors="raise").astype("int64")
    here_pairs = {
        tuple(sorted((clean_id(row.A), clean_id(row.B)), key=int))
        for row in here_rows.itertuples(index=False)
    }
    if len(here_pairs) * 2 != len(here_rows):
        raise SystemExit(
            "HERE_MISS input is not a complete reciprocal export: "
            f"{len(here_rows)} record(s), {len(here_pairs)} pair(s)."
        )

    directional = build_directional_rows(pairs, centroids, node_points)
    shape_path = output_dir / "GSTDM2025_TAZ_CC_LINK.shp"
    directional.to_file(shape_path, driver="ESRI Shapefile", index=False)
    directional.drop(columns="geometry").to_csv(
        output_dir / "cube_taz_cc_public.csv",
        index=False,
    )
    here_rows[["A", "B", "LANES", "HERE_MISS", "FCLASS"]].to_csv(
        output_dir / "HERE_MISS_links.csv",
        index=False,
    )
    summary = {
        "ccDirectionalRecords": len(directional),
        "ccPairs": len(pairs),
        "tazsWithConnectors": len({taz_id for taz_id, _ in pairs}),
        "crossTazSharedNodes": len(shared),
        "hereMissDirectionalRecords": len(here_rows),
        "hereMissPairs": len(here_pairs),
    }
    (output_dir / "baseline_summary.json").write_text(
        json.dumps(summary, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
