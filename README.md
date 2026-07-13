# TAZ Centroid Connector Generator

A maintainable Python/Tkinter desktop GIS application that creates centroid
connectors for TAZ polygons without ArcGIS Pro or ArcPy.

## Requirements

- Python 3.12 or newer
- A projected CRS in feet for every input layer
- TAZ polygons: Polygon or MultiPolygon
- HERE Master LINKS for road-link density: LineString or MultiLineString
- GSTDM LINKS for display/output context: LineString or MultiLineString
- GSTDM Master NODES for final snapping: Point or MultiPoint

The application verifies that all input layers have the same projected CRS.
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

Choose the TAZ, HERE Master LINKS, GSTDM LINKS, and GSTDM Master NODES datasets,
map the TAZ and node ID fields, choose an output folder, adjust parameters, and
select **Run**.

For the checked-in local input folder, run the full workflow directly:

```powershell
python main.py --run-default --maps --output output
```

The `--output` value is a parent folder. Each run creates a timestamped child
folder such as `output/run_20260712_154500`; connector outputs and review PNGs
are written inside that run folder.

For a layer inside a multi-layer GeoPackage, the text field accepts:

```text
C:\data\network.gpkg::master_links
```

The Browse button enters only the file path. Add `::layer_name` manually when
the desired layer is not the first layer.

## Processing

1. Load and validate all source layers.
2. Create inside-polygon points with `representative_point()`.
3. Split 360 degrees around each centroid into `sector_count` equal angular
   sectors (default 10). Each sector has a centerline direction and a clipped
   sector polygon inside the parent TAZ.
4. Query HERE Master LINKS with a spatial index and calculate clipped road
   length divided by clipped sector area for each sector.
5. Define each GSTDM Master NODE's `MAJOR_LEVEL` from connected GSTDM LINKS
   using A/B/FUNC_CLASS. Lower numeric functional classes are more major, so a
   node touching classes 1, 3, and 5 gets `MAJOR_LEVEL = 1`.
6. For each sector direction, find the nearest eligible GSTDM Master NODE to
   the centroid-to-boundary radial line. A node is eligible only when
   `MAJOR_LEVEL > blocked_major_level` (default 2, so 3/4/5 snap nodes are
   allowed), its centroid-to-node bearing falls inside the sector, and it is
   within `boundary_endpoint_tolerance` feet of the parent TAZ boundary
   (default 200). If no sector/boundary-valid node exists, the engine falls
   back to the nearest eligible non-major node.
7. Rank snap-eligible sectors by HERE road-link density and enforce angular
   separation so the chosen directions are not clustered.
8. Relax the angle threshold in 5-degree increments when needed to reach the
   minimum of 2 connectors; select 4 connectors by default.
9. Snap selected candidates to the matched GSTDM Master NODE.
10. Create straight connector lines from the interior centroid to the snapped
   node.
11. Flag any final line segment that extends outside its parent TAZ.
12. Flag TAZs with no eligible sector snap nodes or fewer than the configured
    minimum connector count. TAZs below the target count still keep
    `SNAP_ISSUE = BELOW_TARGET_CONNECTORS` for review, but `SNAP_FLAG = N`.
13. Export GIS layers and tables, including the GSTDM LINKS display layer.

All distances are interpreted in source-CRS units, expected to be feet.

## Outputs

The output folder contains:

- `taz_centroid_connectors.gpkg`
  - `taz_centroids`
  - `gstdm_links`
  - `gstdm_master_nodes`
  - `taz_snap_flags`
  - `boundary_candidate_points`
  - `sector_density_zones`
  - `candidate_connector_lines`
  - `final_selected_boundary_points`
  - `final_snapped_nodes`
  - `final_connector_lines`
- `connector_table.csv`
- `field_dictionary.csv`
- `run_configuration.json`

The source TAZ identifier is exported as `N`. QA fields include
`LINE_NODE_DIST`, `MATCH_BND_DIST`, `MAJOR_LEVEL`, `MAJOR_INT`,
`SNAP_ALLOWED`, `SNAP_FAIL_REASON`, `END_BND_DIST`, `END_ON_BND`,
`CROSSES_TAZ`, and `OUTSIDE_LEN`.

Empty layers are reported as warnings and are not written because some
GeoPackage drivers cannot create an empty layer reliably.

## Module Layout

- `main.py` — CLI entry point and optional Tkinter launch
- `defaults.py` — local input paths and default processing config
- `processing.py` — workflow orchestration
- `validation.py` — data loading and validation
- `geometry.py` — centroids, angular sectors, node levels, snapping
- `density.py` — indexed road-density calculations
- `selection.py` — density ranking and angular selection
- `export.py` — GeoPackage and CSV output
- `make_review_maps.py` — QA review PNG generation
- `ui.py` — Tkinter UI
- `config.py` — typed configuration model

## Validation and Error Behavior

Processing stops with a clear error for missing/unprojected/mismatched CRS,
unsupported or invalid geometry, empty layers, missing required fields, null
TAZ IDs, or duplicate TAZ IDs. Warnings are logged for empty clipped sectors,
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
