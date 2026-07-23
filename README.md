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
   the centroid-to-boundary radial line. `MAJOR_INT` is defined by
   `MAJOR_LEVEL <= blocked_major_level` (default 2). Only non-major nodes with
   `MAJOR_LEVEL` 3/4/5 are eligible. The centroid-to-node connector may extend
   outside its TAZ by at most `boundary_endpoint_tolerance` feet (default 200)
   and may not intersect a GSTDM LINK before reaching its target-node endpoint.
   The engine first searches for nodes within 200 ft of the TAZ boundary and
   ranks valid choices in 0-25, 25-50, 50-100, and 100-200 ft proximity bands,
   considering both endpoint-to-boundary distance and connector length outside
   the TAZ before angular fit. If no
   boundary-near node passes every hard rule, it may use an internal node and
   records `INTERIOR_FALLBACK = True`. It never relaxes the 200-ft outside or
   GSTDM-crossing limits.
7. Rank snap-eligible sectors by HERE road-link density and enforce angular
   separation so the chosen directions are not clustered.
8. Reserve every selected GSTDM target node to a single TAZ. If two TAZs prefer
   the same node, keep it for the TAZ with fewer valid alternatives and redirect
   the other TAZ to its next nearby candidate that satisfies every hard rule.
9. Enforce a hard 70-degree minimum angle between final snapped connectors.
   Never relax this threshold; discard lower-priority candidates that do not fit
   and select no more than 3 connectors per TAZ.
10. Snap selected candidates to the matched GSTDM Master NODE.
11. Create straight connector lines from the interior centroid to the snapped
   node.
12. Reject any connector with more than 200 ft outside its parent TAZ or any
    intersection with a GSTDM LINK away from the target endpoint. Allowed
    outside segments remain documented in `CROSSES_TAZ` and `OUTSIDE_LEN`.
13. Reject output in which a GSTDM target node is shared by different TAZs.
14. Flag TAZs with no eligible sector snap nodes or fewer than the configured
    minimum connector count. TAZs below the target count still keep
    `SNAP_ISSUE = BELOW_TARGET_CONNECTORS` for review, but `SNAP_FLAG = N`.
15. Export GIS layers and tables, including the GSTDM LINKS display layer.

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
`CROSSES_TAZ`, `OUTSIDE_LEN`, and `CROSSES_GSTDM`.
`INTERIOR_FALLBACK` identifies the exceptional connectors whose endpoint is
farther than 200 ft inside the TAZ because no valid boundary-near node existed.

Empty layers are reported as warnings and are not written because some
GeoPackage drivers cannot create an empty layer reliably.

## Static QAQC Data

Generate the browser QAQC dataset with:

```powershell
.\.venv\Scripts\python.exe generate_docs_data.py
```

The generator writes `docs/data/core.json` for QA/QC state and standard Mapbox
Vector Tiles under `docs/data/mvt/{z}/{x}/{y}.pbf`. MapLibre GL renders those MVT
tiles in WebGL and automatically requests only the current viewport. Zooms 6-11
use zoom-dependent, topology-preserving GSTDM simplification and clustered nodes;
coordinates are not snapped to a display grid. Zoom 12 contains full node and
link detail and is overzoomed for closer views. Nodes are hidden below zoom 10,
shown as small count-labeled clusters from zoom 10 to 12, and shown at their
actual locations from zoom 12 onward. Clicking a TAZ in the left list
zooms directly to that TAZ without a per-TAZ JSON request.
The published default review inputs are:

- `input/default/cube_taz_cc_public.csv` — 1,465 default CC pairs; and
- `input/default/HERE_MISS_links.csv` — 11 default HERE_MISS pairs.

The generator validates both directed-record CSVs, rebuilds connector geometry
from the published TAZ centroids and node layer, and embeds HERE_MISS geometry
in `core.json`. Browser uploads can replace either default for the current
browser, while Reset Browser Data restores these published defaults.
Published and newly drawn HERE_MISS links use two directional records with
`LANES=1`, `HERE_MISS=1`, and `FCLASS=32`. The right-side CC, Missing Links, and
TAZ Status tables support inline editing of their business attributes; TAZ IDs
and calculated CC counts remain read-only. Clicking blank map space clears the
current CC or missing-link selection. Top actions are grouped into responsive
Navigate, Edit, Data, Export, and Help dropdown menus.
The browser Final CC Export supports DBF or CSV. The optional QCNOTES companion
contains matching `A`, `B`, and `QC_NOTES` fields for the directed connector
records; disabling the toggle exports only the main `A/B/FCLASS` file.
MapLibre also manages the OpenStreetMap raster basemap and optional Esri satellite
imagery. The custom Canvas is limited to temporary endpoint-edit previews.
Connector labels use the readable `TAZ <integer> - <connector>` format and stay
above selection highlighting. The legend slider controls and browser-saves the
visibility of non-current TAZ boundaries, connectors, labels, and centroids.
TAZ review status uses four values: `WAITING FOR QC` by default, `FLAG` when a
TAZ has no CC, `EDITED` when uploaded CCs differ or browser-saved work changes
the TAZ, and `REVIEWED` after approval.
Right-click a TAZ to set any status manually. Export TAZ QC Status writes
`TAZ_ID`, `QC_STATUS`, and `QC_NOTES` as CSV or a polygon Shapefile ZIP.

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
zero-density candidates, candidates removed by the hard 70-degree threshold, insufficient candidates,
and nodes beyond the configured maximum snap distance.

## QA Checks

For production acceptance, inspect:

- every `taz_centroids` point is covered by its source TAZ;
- selected counts meet the configured target where angular geometry permits;
- `DENS_RANK` starts at 1 within each TAZ;
- selected bearings satisfy `ANGLE_THRESHOLD`;
- every TAZ has 1 to 3 connectors unless it is explicitly flagged for having no
  valid non-major target;
- `OUTSIDE_LEN` does not exceed 200 ft and `CROSSES_GSTDM` is false;
- `NEAR_DIST` and `SNAP_OK` agree with the maximum snap distance;
- all output layers retain the source CRS;
- the GeoPackage and CSV outputs reopen successfully.
