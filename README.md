# TAZ Centroid Connector Generator

A maintainable Python/Tkinter desktop GIS application that creates centroid
connectors for TAZ polygons without ArcGIS Pro or ArcPy.

## Requirements

- Python 3.12 or newer
- A projected CRS in feet for every input layer
- TAZ polygons: Polygon or MultiPolygon
- Master links: LineString or MultiLineString
- Master nodes: Point or MultiPoint

The application verifies that all three layers have the same projected CRS.
It assumes Georgia State Plane West in feet; it does not silently reproject
data.

## Installation

From this project directory:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Tkinter is included with the standard Windows Python installer. If
`import tkinter` fails, modify the Python installation and add Tcl/Tk support.

## Run

```powershell
python main.py
```

Choose the TAZ, master-link, and master-node datasets, map the TAZ and node ID
fields, choose an output folder, adjust parameters, and select **Run**.

For a layer inside a multi-layer GeoPackage, the text field accepts:

```text
C:\data\network.gpkg::master_links
```

The Browse button enters only the file path. Add `::layer_name` manually when
the desired layer is not the first layer.

## Processing

1. Load and validate all source layers.
2. Create inside-polygon points with `representative_point()`.
3. Sample each polygon boundary, generating at least
   `max(target connectors × 4, 12)` candidates when the boundary is usable.
4. Buffer candidates and clip buffers to the parent TAZ.
5. Query links with a spatial index and calculate clipped road length divided
   by clipped buffer area.
6. Rank candidates by density and select them with angular separation.
7. Relax the angle threshold in 5-degree increments when needed to reach the
   minimum connector count.
8. Snap selected candidates to the nearest master node.
9. Create straight connector lines from the interior centroid to the snapped
   node.
10. Export GIS layers and tables.

All distances are interpreted in source-CRS units, expected to be feet.

## Outputs

The output folder contains:

- `taz_centroid_connectors.gpkg`
  - `taz_centroids`
  - `boundary_candidate_points`
  - `candidate_buffers`
  - `candidate_connector_lines`
  - `final_selected_boundary_points`
  - `final_snapped_nodes`
  - `final_connector_lines`
- `connector_table.csv`
- `field_dictionary.csv`
- `run_configuration.json`

Empty layers are reported as warnings and are not written because some
GeoPackage drivers cannot create an empty layer reliably.

## Module Layout

- `main.py` — application entry point
- `ui.py` — Tkinter UI only
- `processing.py` — workflow orchestration, independent of Tkinter
- `validation.py` — data loading and validation
- `geometry.py` — centroid, boundary, buffer, line, and snapping geometry
- `density.py` — indexed road-density calculations
- `selection.py` — density ranking and angular selection
- `export.py` — GeoPackage and CSV output
- `config.py` — typed configuration model

## Validation and Error Behavior

Processing stops with a clear error for missing/unprojected/mismatched CRS,
unsupported or invalid geometry, empty layers, missing required fields, null
TAZ IDs, or duplicate TAZ IDs. Warnings are logged for empty clipped buffers,
zero-density candidates, relaxed angle thresholds, insufficient candidates,
and nodes beyond the configured maximum snap distance.

## QA Checks

For production acceptance, inspect:

- every `taz_centroids` point is covered by its source TAZ;
- selected counts meet the configured target where angular geometry permits;
- `DENS_RANK` starts at 1 within each TAZ;
- selected bearings satisfy `ANGLE_THRESHOLD`;
- `NEAR_DIST` and `SNAP_OK` agree with the maximum snap distance;
- all output layers retain the source CRS;
- the GeoPackage and CSV outputs reopen successfully.

