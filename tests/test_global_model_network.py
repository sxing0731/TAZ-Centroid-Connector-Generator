from pathlib import Path

import geopandas as gpd
from shapely.geometry import LineString, Point

import generate_docs_data


def test_global_model_network_replaces_links_and_unlocks_only_outside_ga_nodes(
    monkeypatch,
    tmp_path: Path,
) -> None:
    node_path = tmp_path / "nodes.shp"
    link_path = tmp_path / "links.shp"
    node_path.touch()
    link_path.touch()
    crs = "ESRI:102604"
    nodes = gpd.GeoDataFrame(
        {"N": [1, 2, 3, 4]},
        geometry=[Point(0, 0), Point(1, 0), Point(2, 0), Point(3, 0)],
        crs=crs,
    )
    links = gpd.GeoDataFrame(
        {
            "A": [1, 2, 2, 3],
            "B": [2, 1, 3, 4],
            "LINK_ID": [10, 10, 20, 30],
            "FUNC_CLASS": ["1", "1", "2", "1"],
            "NONGA": [0, 0, 1, 1],
        },
        geometry=[
            LineString([(0, 0), (1, 0)]),
            LineString([(1, 0), (0, 0)]),
            LineString([(1, 0), (2, 0)]),
            LineString([(2, 0), (3, 0)]),
        ],
        crs=crs,
    )

    def fake_read_file(path: Path, columns: list[str]) -> gpd.GeoDataFrame:
        return nodes if Path(path) == node_path else links

    monkeypatch.setattr(generate_docs_data.gpd, "read_file", fake_read_file)
    payload: dict = {}
    stats = generate_docs_data.apply_global_model_network(payload, node_path, link_path)
    by_id = {node["id"]: node for node in payload["nodes"]}

    assert stats == {
        "nodes": 4,
        "outsideGaNodes": 2,
        "directionalLinks": 4,
        "displayLinks": 3,
    }
    assert by_id["1"]["majorInt"] == "Y"
    assert by_id["1"]["eligible"] is False
    assert by_id["2"]["outsideGa"] is False
    assert by_id["2"]["eligible"] is False
    assert by_id["3"]["outsideGa"] is True
    assert by_id["3"]["eligible"] is True
    assert by_id["3"]["majorInt"] == "N"
    assert by_id["4"]["outsideGa"] is True
    assert by_id["4"]["eligible"] is True
    assert payload["gstdmFeature"]["properties"]["sourceFeatureCount"] == 3
    assert payload["gstdmFeature"]["properties"]["directionalSourceFeatureCount"] == 4
    assert payload["networkSource"].endswith("links.shp")
