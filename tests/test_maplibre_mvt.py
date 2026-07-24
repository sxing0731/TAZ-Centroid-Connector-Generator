from __future__ import annotations

import json
from pathlib import Path

import mapbox_vector_tile

from generate_docs_data import build_gstdm_overview


ROOT = Path(__file__).resolve().parents[1]
MVT_ROOT = ROOT / "docs" / "data" / "mvt"


def test_generated_mvt_bundle_matches_manifest_and_decodes() -> None:
    manifest = json.loads((MVT_ROOT / "manifest.json").read_text(encoding="utf-8"))
    tiles = sorted(MVT_ROOT.glob("*/*/*.pbf"))

    assert manifest["format"] == "mvt"
    assert manifest["generalizationVersion"] == 3
    assert manifest["generalization"]["method"] == "topology-preserving-simplify"
    assert manifest["minzoom"] == 6
    assert manifest["maxzoom"] == 12
    assert len(tiles) == manifest["tileCount"]
    assert sum(tile.stat().st_size for tile in tiles) == manifest["bytes"]

    low_zoom_layers: set[str] = set()
    for tile in (MVT_ROOT / "8").glob("*/*.pbf"):
        low_zoom_layers.update(mapbox_vector_tile.decode(tile.read_bytes()))
    assert {"taz", "centroids", "connectors", "gstdm", "node_clusters"} <= low_zoom_layers

    candidate_layers: set[str] = set()
    for tile in (MVT_ROOT / "11").glob("*/*.pbf"):
        candidate_layers.update(mapbox_vector_tile.decode(tile.read_bytes()))
        if "candidate_nodes" in candidate_layers:
            break
    assert "candidate_nodes" in candidate_layers

    detail_layers: set[str] = set()
    for tile in (MVT_ROOT / "12").glob("*/*.pbf"):
        detail_layers.update(mapbox_vector_tile.decode(tile.read_bytes()))
        if {"taz", "centroids", "connectors", "gstdm", "nodes"} <= detail_layers:
            break
    assert {"taz", "centroids", "connectors", "gstdm", "nodes"} <= detail_layers


def test_overview_generalization_preserves_endpoints_without_grid_snapping() -> None:
    source = [[[123.4, 567.8], [1075.2, 1850.6], [2222.2, 3333.3]]]

    generalized = build_gstdm_overview(source, 11)

    assert generalized
    assert generalized[0][0] == source[0][0]
    assert generalized[0][-1] == source[0][-1]
    assert any(coordinate % 4000 for point in generalized[0] for coordinate in point)
