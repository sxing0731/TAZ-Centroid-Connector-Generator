# TAZ Connector QAQC Web App

## Purpose

Local web tool for reviewing and manually correcting final TAZ centroid
connectors. The app loads one connector run folder at a time and writes QAQC
outputs back into that same run folder.

## Run

```powershell
.\.venv\Scripts\python.exe qaqc_web.py --run-folder output --port 8765
```

`--run-folder` can point to either a specific `output/run_YYYYMMDD_HHMMSS`
folder or the parent `output` folder. When a parent folder is provided, the app
uses the latest run folder containing `taz_centroid_connectors.gpkg`.

Open:

```text
http://127.0.0.1:8765
```

## Review Scope

- Shows all TAZ polygons as a background review layer.
- Highlights the current TAZ as the main review target.
- Allows zooming and panning to inspect surrounding TAZs.
- Shows HERE Master LINKS and GSTDM LINKS within 1.5 miles of the current TAZ.
- Shows GSTDM nodes within 1.5 miles of the current TAZ.
- Shows final TAZ CC lines for the current TAZ.

## Edit Rules

Only nodes above the major-intersection cutoff are valid snap targets:

- Allowed: `MAJOR_LEVEL = 3`, `MAJOR_LEVEL = 4`, or `MAJOR_LEVEL = 5`
- Blocked: `MAJOR_LEVEL <= 2`
- Blocked: missing `MAJOR_LEVEL`

Workflow:

1. Select a connector line.
2. Drag the orange endpoint handle to a target non-major node, or click a
   non-major node directly.
3. Click **Save Edit**.
4. Move to the next TAZ.

The centroid/start point is fixed. The endpoint is updated to the selected
GSTDM node.

To add a new connector:

1. Click **Add CC**.
2. Click an eligible non-major node in the current TAZ view.
3. The app creates and saves a new connector from the current TAZ centroid to
   that node.

Added connector IDs use `TAZID_ADD#`, for example `1036_ADD1`.

## QAQC Outputs

The app writes these files into the run folder:

- `qaqc_edits.csv`
- `qaqc_edits.geojson`
- `final_connector_lines_qaqc.gpkg`
- `cube_taz_cc.dbf`

## Cube DBF Export

`cube_taz_cc.dbf` contains two records per final connector to represent two-way
links:

| Field | Meaning |
| --- | --- |
| `A` | from node: TAZ ID or snapped node |
| `B` | to node: snapped node or TAZ ID |
| `FCLASS` | always `32` |

Example:

| A | B | FCLASS |
| --- | --- | --- |
| `TAZ_ID` | `SNAP_NODE` | `32` |
| `SNAP_NODE` | `TAZ_ID` | `32` |
