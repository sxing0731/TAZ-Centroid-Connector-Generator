"""Local web QAQC tool for reviewing and editing final TAZ CC outputs."""

from __future__ import annotations

from datetime import datetime
import csv
import json
import mimetypes
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, mapping

from defaults import HERE_LINKS_PATH, ROOT, TAZ_PATH

FEET_PER_MILE = 5280.0
CONTEXT_MILES = 1.5
CONTEXT_FEET = FEET_PER_MILE * CONTEXT_MILES


def _id_text(value: object) -> str:
    if pd.isna(value):
        return ""
    try:
        numeric = float(value)
        if numeric.is_integer():
            return str(int(numeric))
    except (TypeError, ValueError):
        pass
    return str(value)


def _json_response(handler: BaseHTTPRequestHandler, payload: object, status: int = 200) -> None:
    data = json.dumps(payload, allow_nan=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _error(handler: BaseHTTPRequestHandler, message: str, status: int = 400) -> None:
    _json_response(handler, {"error": message}, status=status)


def _geojson(
    gdf: gpd.GeoDataFrame,
    keep_fields: list[str] | None = None,
    simplify_tolerance: float | None = None,
) -> dict:
    if gdf.empty:
        return {"type": "FeatureCollection", "features": []}
    frame = gdf.copy()
    if keep_fields is not None:
        columns = [column for column in keep_fields if column in frame.columns]
        frame = frame[[*columns, frame.geometry.name]]
    if simplify_tolerance is not None and simplify_tolerance > 0:
        frame[frame.geometry.name] = frame.geometry.simplify(
            simplify_tolerance,
            preserve_topology=True,
        )
    return json.loads(frame.to_json(na="null"))


def _display_fields(frame: gpd.GeoDataFrame, preferred: list[str], limit: int = 18) -> list[str]:
    fields: list[str] = []
    for field in preferred:
        if field in frame.columns and field != frame.geometry.name and field not in fields:
            fields.append(field)
    for field in frame.columns:
        if field == frame.geometry.name or field in fields:
            continue
        fields.append(field)
        if len(fields) >= limit:
            break
    return fields


def _latest_run_folder(base: Path) -> Path:
    if (base / "taz_centroid_connectors.gpkg").exists():
        return base
    runs = sorted(
        (path for path in base.glob("run_*") if (path / "taz_centroid_connectors.gpkg").exists()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not runs:
        raise FileNotFoundError(f"No connector run folder found under {base}")
    return runs[0]


def _write_cube_dbf(path: Path, records: list[dict[str, object]]) -> None:
    """Write a minimal dBase III DBF for Cube import: A, B, FCLASS."""
    fields = [("A", "C", 20, 0), ("B", "C", 20, 0), ("FCLASS", "N", 5, 0)]
    header_len = 32 + 32 * len(fields) + 1
    record_len = 1 + sum(field[2] for field in fields)
    now = datetime.now()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        header = bytearray(32)
        header[0] = 0x03
        header[1] = now.year - 1900
        header[2] = now.month
        header[3] = now.day
        header[4:8] = len(records).to_bytes(4, "little")
        header[8:10] = header_len.to_bytes(2, "little")
        header[10:12] = record_len.to_bytes(2, "little")
        fh.write(header)
        for name, field_type, width, decimals in fields:
            descriptor = bytearray(32)
            encoded_name = name.encode("ascii")[:10]
            descriptor[: len(encoded_name)] = encoded_name
            descriptor[11] = ord(field_type)
            descriptor[16] = width
            descriptor[17] = decimals
            fh.write(descriptor)
        fh.write(b"\r")
        for record in records:
            fh.write(b" ")
            for name, field_type, width, _ in fields:
                value = record.get(name, "")
                if field_type == "N":
                    text = str(int(value)).rjust(width)
                else:
                    text = str(value)[:width].ljust(width)
                fh.write(text.encode("ascii", errors="ignore"))
        fh.write(b"\x1a")


class QAQCDataStore:
    def __init__(self, run_folder: Path) -> None:
        self.run_folder = _latest_run_folder(run_folder)
        self.gpkg = self.run_folder / "taz_centroid_connectors.gpkg"
        self.static_dir = ROOT / "qaqc_web" / "static"
        self.taz = gpd.read_file(TAZ_PATH, layer="taz")
        self.here_links = gpd.read_file(HERE_LINKS_PATH)
        self.gstdm_links = gpd.read_file(self.gpkg, layer="gstdm_links")
        self.nodes = gpd.read_file(self.gpkg, layer="gstdm_master_nodes")
        self.centroids = gpd.read_file(self.gpkg, layer="taz_centroids")
        self.flags = gpd.read_file(self.gpkg, layer="taz_snap_flags")
        self.selected_points = gpd.read_file(self.gpkg, layer="final_selected_boundary_points")
        self.lines = gpd.read_file(self.gpkg, layer="final_connector_lines")
        self.undo_stack: list[gpd.GeoDataFrame] = []
        self.redo_stack: list[gpd.GeoDataFrame] = []
        self._prepare_ids()
        self.here_fields = _display_fields(
            self.here_links,
            ["LINK_ID", "ID", "A", "B", "FUNC_CLASS", "FCLASS", "ST_NAME", "DIR_TRAVEL"],
        )
        self.gstdm_fields = _display_fields(
            self.gstdm_links,
            ["LINK", "LINK_ID", "A", "B", "FUNC_CLASS", "FCLASS"],
        )
        self.node_fields = _display_fields(
            self.nodes,
            ["N", "NODE_ID_TEXT", "MAJOR_LEVEL", "MAJOR_INT", "SNAP_ELIG"],
        )
        self._write_outputs()

    def _prepare_ids(self) -> None:
        for frame, field in (
            (self.taz, "NEWID"),
            (self.centroids, "N"),
            (self.flags, "N"),
            (self.selected_points, "N"),
            (self.lines, "N"),
        ):
            frame["TAZ_ID_TEXT"] = frame[field].map(_id_text)
        self.nodes["NODE_ID_TEXT"] = self.nodes["N"].map(_id_text)
        self.nodes["SNAP_ELIG"] = (
            pd.to_numeric(self.nodes.get("MAJOR_LEVEL"), errors="coerce") > 3
        )
        self.lines["QC_STATUS"] = self.lines.get("QC_STATUS", "unreviewed")
        self.lines["QC_NOTE"] = self.lines.get("QC_NOTE", "")
        self.lines["OLD_CC_NODE"] = self.lines.get("OLD_CC_NODE", self.lines["CC_NODE"].map(_id_text))
        self.lines["CC_NODE"] = self.lines["CC_NODE"].map(_id_text)
        self._taz_lookup = self.taz.set_index("TAZ_ID_TEXT")
        self._centroid_lookup = self.centroids.set_index("TAZ_ID_TEXT").geometry
        self._selected_lookup = self.selected_points.set_index("CC_PT").geometry
        self._node_lookup = self.nodes.set_index("NODE_ID_TEXT")

    def state(self) -> dict:
        summary = self.lines.groupby("TAZ_ID_TEXT").size().to_dict()
        flag_lookup = self.flags.set_index("TAZ_ID_TEXT")["SNAP_FLAG"].to_dict()
        issue_lookup = self.flags.set_index("TAZ_ID_TEXT")["SNAP_ISSUE"].to_dict()
        order = []
        for _, row in self.taz.iterrows():
            taz_id = row["TAZ_ID_TEXT"]
            order.append(
                {
                    "id": taz_id,
                    "connectors": int(summary.get(taz_id, 0)),
                    "flag": str(flag_lookup.get(taz_id, "N")),
                    "issue": str(issue_lookup.get(taz_id, "")),
                }
            )
        order.sort(key=lambda item: (item["flag"] != "Y", item["issue"] != "BELOW_TARGET_CONNECTORS", item["id"]))
        return {
            "runFolder": str(self.run_folder),
            "count": len(order),
            "tazOrder": order,
            "firstTaz": order[0]["id"] if order else None,
            "canUndo": bool(self.undo_stack),
            "canRedo": bool(self.redo_stack),
        }

    def all_taz(self) -> dict:
        frame = self.taz[["TAZ_ID_TEXT", "geometry"]].rename(columns={"TAZ_ID_TEXT": "N"})
        return _geojson(frame, ["N"], simplify_tolerance=120.0)

    def taz_payload(self, taz_id: str, include_here: bool = False) -> dict:
        if taz_id not in self._taz_lookup.index:
            raise KeyError(f"TAZ {taz_id} not found")
        polygon = self._taz_lookup.loc[taz_id].geometry
        context = polygon.buffer(CONTEXT_FEET)
        here = (
            self._clip_to_context(self.here_links, context)
            if include_here
            else self.here_links.iloc[0:0].copy()
        )
        gstdm = self._clip_to_context(self.gstdm_links, context)
        nodes = self.nodes.iloc[list(self.nodes.sindex.query(context, predicate="intersects"))].copy()
        lines = self.lines[self.lines["TAZ_ID_TEXT"] == taz_id].copy()
        neighbor_taz = self.taz.iloc[list(self.taz.sindex.query(context, predicate="intersects"))].copy()
        neighbor_taz = neighbor_taz[neighbor_taz["TAZ_ID_TEXT"] != taz_id].copy()
        neighbor_ids = set(neighbor_taz["TAZ_ID_TEXT"].astype(str))
        neighbor_lines = self.lines[self.lines["TAZ_ID_TEXT"].isin(neighbor_ids)].copy()
        centroid = self.centroids[self.centroids["TAZ_ID_TEXT"] == taz_id].copy()
        current_taz = self.taz[self.taz["TAZ_ID_TEXT"] == taz_id].copy()
        context_gdf = gpd.GeoDataFrame({"N": [taz_id]}, geometry=[context], crs=self.taz.crs)
        return {
            "tazId": taz_id,
            "currentTaz": _geojson(
                current_taz.rename(columns={"TAZ_ID_TEXT": "N"}),
                ["N"],
                simplify_tolerance=25.0,
            ),
            "context": _geojson(context_gdf, ["N"], simplify_tolerance=80.0),
            "neighborTaz": _geojson(
                neighbor_taz.rename(columns={"TAZ_ID_TEXT": "N"}),
                ["N"],
                simplify_tolerance=35.0,
            ),
            "hereLinks": _geojson(here, self.here_fields, simplify_tolerance=35.0),
            "gstdmLinks": _geojson(gstdm, self.gstdm_fields, simplify_tolerance=20.0),
            "nodes": _geojson(
                nodes,
                self.node_fields,
            ),
            "centroid": _geojson(centroid, ["N"]),
            "connectors": _geojson(
                lines,
                [
                    "N",
                    "TAZ_ID_TEXT",
                    "CC_PT",
                    "CC_NODE",
                    "DENSITY",
                    "DENS_RANK",
                    "MAJOR_LEVEL",
                    "MAJOR_INT",
                    "NEAR_DIST",
                    "LINE_NODE_DIST",
                    "END_BND_DIST",
                    "OUTSIDE_LEN",
                    "QC_STATUS",
                    "QC_NOTE",
                ],
            ),
            "neighborConnectors": _geojson(
                neighbor_lines,
                [
                    "N",
                    "TAZ_ID_TEXT",
                    "CC_PT",
                    "CC_NODE",
                    "DENSITY",
                    "DENS_RANK",
                    "MAJOR_LEVEL",
                    "MAJOR_INT",
                    "NEAR_DIST",
                    "LINE_NODE_DIST",
                    "END_BND_DIST",
                    "OUTSIDE_LEN",
                    "QC_STATUS",
                    "QC_NOTE",
                ],
            ),
        }

    def _clip_to_context(self, frame: gpd.GeoDataFrame, context) -> gpd.GeoDataFrame:
        subset = frame.iloc[list(frame.sindex.query(context, predicate="intersects"))].copy()
        if subset.empty:
            return subset
        subset["geometry"] = subset.geometry.intersection(context)
        return subset[(~subset.geometry.is_empty) & subset.geometry.notna()]

    def save_edit(self, payload: dict) -> dict:
        cc_pt = str(payload.get("ccPt", ""))
        node_id = _id_text(payload.get("nodeId", ""))
        note = str(payload.get("note", ""))
        if not cc_pt:
            raise ValueError("ccPt is required")
        if node_id not in self._node_lookup.index:
            raise ValueError(f"Node {node_id} not found")
        node_row = self._node_lookup.loc[node_id]
        if not bool(node_row["SNAP_ELIG"]):
            raise ValueError(f"Node {node_id} is not eligible; only MAJOR_LEVEL 4/5 is allowed")
        matches = self.lines.index[self.lines["CC_PT"] == cc_pt].tolist()
        if not matches:
            raise ValueError(f"Connector {cc_pt} not found")
        self._push_history()
        index = matches[0]
        taz_id = self.lines.at[index, "TAZ_ID_TEXT"]
        centroid = self._centroid_lookup.loc[taz_id]
        node = node_row.geometry
        polygon = self._taz_lookup.loc[taz_id].geometry
        boundary_point = self._selected_lookup.get(cc_pt, node)
        radial_line = LineString([centroid, boundary_point])
        connector = LineString([centroid, node])
        self.lines.at[index, "geometry"] = connector
        self.lines.at[index, "CC_NODE"] = node_id
        self.lines.at[index, "NEAR_DIST"] = float(boundary_point.distance(node))
        self.lines.at[index, "LINE_NODE_DIST"] = float(radial_line.distance(node))
        self.lines.at[index, "END_BND_DIST"] = float(node.distance(polygon.boundary))
        self.lines.at[index, "END_ON_BND"] = bool(self.lines.at[index, "END_BND_DIST"] <= 200.0)
        self.lines.at[index, "CROSSES_TAZ"] = bool(connector.difference(polygon).length > 1e-6)
        self.lines.at[index, "OUTSIDE_LEN"] = float(connector.difference(polygon).length)
        self.lines.at[index, "MAJOR_LEVEL"] = node_row["MAJOR_LEVEL"]
        self.lines.at[index, "MAJOR_INT"] = node_row["MAJOR_INT"]
        self.lines.at[index, "QC_STATUS"] = "edited"
        self.lines.at[index, "QC_NOTE"] = note
        self.lines.at[index, "QC_TIME"] = datetime.now().isoformat(timespec="seconds")
        self._write_outputs()
        return {"ok": True, "tazId": taz_id, "ccPt": cc_pt, "nodeId": node_id, **self.history_state()}

    def add_connector(self, payload: dict) -> dict:
        taz_id = _id_text(payload.get("tazId", ""))
        node_id = _id_text(payload.get("nodeId", ""))
        note = str(payload.get("note", ""))
        if not taz_id:
            raise ValueError("tazId is required")
        if taz_id not in self._taz_lookup.index:
            raise ValueError(f"TAZ {taz_id} not found")
        if node_id not in self._node_lookup.index:
            raise ValueError(f"Node {node_id} not found")
        node_row = self._node_lookup.loc[node_id]
        if not bool(node_row["SNAP_ELIG"]):
            raise ValueError(f"Node {node_id} is not eligible; only MAJOR_LEVEL 4/5 is allowed")

        self._push_history()
        centroid = self._centroid_lookup.loc[taz_id]
        node = node_row.geometry
        polygon = self._taz_lookup.loc[taz_id].geometry
        connector = LineString([centroid, node])
        cc_pt = self._next_added_cc_pt(taz_id)
        outside_length = float(connector.difference(polygon).length)
        boundary_distance = float(node.distance(polygon.boundary))
        template = {column: None for column in self.lines.columns if column != "geometry"}
        template.update(
            {
                "N": self._taz_lookup.loc[taz_id].get("NEWID", taz_id),
                "TAZ_ID_TEXT": taz_id,
                "CC_PT": cc_pt,
                "CC_NODE": node_id,
                "OLD_CC_NODE": "",
                "DENSITY": None,
                "DENS_RANK": None,
                "ANGLE_DEG": None,
                "NEAR_DIST": 0.0,
                "SNAP_OK": True,
                "LINE_NODE_DIST": 0.0,
                "MATCH_BND_DIST": boundary_distance,
                "MAJOR_LEVEL": node_row["MAJOR_LEVEL"],
                "MAJOR_INT": node_row["MAJOR_INT"],
                "SNAP_ALLOWED": True,
                "SNAP_FAIL_REASON": "",
                "END_BND_DIST": boundary_distance,
                "END_ON_BND": boundary_distance <= 200.0,
                "CROSSES_TAZ": outside_length > 1e-6,
                "OUTSIDE_LEN": outside_length,
                "QC_STATUS": "added",
                "QC_NOTE": note,
                "QC_TIME": datetime.now().isoformat(timespec="seconds"),
            }
        )
        added = gpd.GeoDataFrame([template], geometry=[connector], crs=self.lines.crs)
        self.lines = gpd.GeoDataFrame(
            pd.concat([self.lines, added], ignore_index=True),
            geometry="geometry",
            crs=self.lines.crs,
        )
        self._write_outputs()
        return {"ok": True, "tazId": taz_id, "ccPt": cc_pt, "nodeId": node_id, **self.history_state()}

    def _next_added_cc_pt(self, taz_id: str) -> str:
        prefix = f"{taz_id}_ADD"
        existing = set(self.lines["CC_PT"].astype(str))
        index = 1
        while f"{prefix}{index}" in existing:
            index += 1
        return f"{prefix}{index}"

    def mark_reviewed(self, taz_id: str, note: str = "") -> dict:
        self._push_history()
        mask = self.lines["TAZ_ID_TEXT"] == taz_id
        self.lines.loc[mask & (self.lines["QC_STATUS"] != "edited"), "QC_STATUS"] = "reviewed"
        self.lines.loc[mask, "QC_NOTE"] = note
        self.lines.loc[mask, "QC_TIME"] = datetime.now().isoformat(timespec="seconds")
        self._write_outputs()
        return {"ok": True, "tazId": taz_id, **self.history_state()}

    def delete_connector(self, payload: dict) -> dict:
        cc_pt = str(payload.get("ccPt", ""))
        if not cc_pt:
            raise ValueError("ccPt is required")
        matches = self.lines.index[self.lines["CC_PT"] == cc_pt].tolist()
        if not matches:
            raise ValueError(f"Connector {cc_pt} not found")
        self._push_history()
        taz_id = self.lines.at[matches[0], "TAZ_ID_TEXT"]
        self.lines = self.lines.drop(index=matches).reset_index(drop=True)
        self._write_outputs()
        return {"ok": True, "tazId": taz_id, "ccPt": cc_pt, **self.history_state()}

    def _push_history(self) -> None:
        self.undo_stack.append(self.lines.copy(deep=True))
        if len(self.undo_stack) > 80:
            self.undo_stack.pop(0)
        self.redo_stack.clear()

    def history_state(self) -> dict:
        return {"canUndo": bool(self.undo_stack), "canRedo": bool(self.redo_stack)}

    def undo(self) -> dict:
        if not self.undo_stack:
            raise ValueError("No edit to undo")
        self.redo_stack.append(self.lines.copy(deep=True))
        self.lines = self.undo_stack.pop().copy(deep=True)
        self._write_outputs()
        return {"ok": True, **self.history_state()}

    def redo(self) -> dict:
        if not self.redo_stack:
            raise ValueError("No edit to redo")
        self.undo_stack.append(self.lines.copy(deep=True))
        self.lines = self.redo_stack.pop().copy(deep=True)
        self._write_outputs()
        return {"ok": True, **self.history_state()}

    def _write_outputs(self) -> None:
        out = self.run_folder
        table = pd.DataFrame(self.lines.drop(columns="geometry"))
        table.to_csv(out / "qaqc_edits.csv", index=False)
        self.lines.to_file(out / "qaqc_edits.geojson", driver="GeoJSON")
        gpkg = out / "final_connector_lines_qaqc.gpkg"
        if gpkg.exists():
            gpkg.unlink()
        self.lines.to_file(gpkg, layer="final_connector_lines_qaqc", driver="GPKG")
        self._write_cube(out / "cube_taz_cc.dbf")

    def _write_cube(self, path: Path) -> None:
        records: list[dict[str, object]] = []
        for row in self.lines.itertuples():
            taz_id = _id_text(row.N)
            node_id = _id_text(row.CC_NODE)
            if not taz_id or not node_id:
                continue
            records.append({"A": taz_id, "B": node_id, "FCLASS": 32})
            records.append({"A": node_id, "B": taz_id, "FCLASS": 32})
        _write_cube_dbf(path, records)


def make_handler(store: QAQCDataStore):
    class QAQCHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            try:
                if path == "/api/state":
                    _json_response(self, store.state())
                elif path == "/api/all-taz":
                    _json_response(self, store.all_taz())
                elif path.startswith("/api/taz/"):
                    params = parse_qs(parsed.query)
                    include_here = params.get("here", ["0"])[0] == "1"
                    _json_response(
                        self,
                        store.taz_payload(
                            path.removeprefix("/api/taz/"),
                            include_here=include_here,
                        ),
                    )
                elif path == "/api/export-cube":
                    _json_response(self, {"path": str(store.run_folder / "cube_taz_cc.dbf")})
                else:
                    self._serve_static(path)
            except Exception as exc:
                _error(self, str(exc), status=500)

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            try:
                if self.path == "/api/save-edit":
                    _json_response(self, store.save_edit(payload))
                elif self.path == "/api/add-connector":
                    _json_response(self, store.add_connector(payload))
                elif self.path == "/api/delete-connector":
                    _json_response(self, store.delete_connector(payload))
                elif self.path == "/api/mark-reviewed":
                    _json_response(self, store.mark_reviewed(str(payload.get("tazId", "")), str(payload.get("note", ""))))
                elif self.path == "/api/undo":
                    _json_response(self, store.undo())
                elif self.path == "/api/redo":
                    _json_response(self, store.redo())
                else:
                    _error(self, f"Unknown endpoint {self.path}", status=404)
            except Exception as exc:
                _error(self, str(exc), status=400)

        def _serve_static(self, path: str) -> None:
            if path == "/":
                path = "/index.html"
            target = (store.static_dir / path.lstrip("/")).resolve()
            if not str(target).startswith(str(store.static_dir.resolve())) or not target.exists():
                _error(self, "Not found", status=404)
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args) -> None:
            print(f"{self.address_string()} - {format % args}")

    return QAQCHandler


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run local TAZ CC QAQC web app.")
    parser.add_argument("--run-folder", default=str(ROOT / "output"), help="Run folder or parent output folder.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    store = QAQCDataStore(Path(args.run_folder))
    server = ThreadingHTTPServer((args.host, args.port), make_handler(store))
    print(f"QAQC web app: http://{args.host}:{args.port}")
    print(f"Run folder: {store.run_folder}")
    server.serve_forever()


if __name__ == "__main__":
    main()
