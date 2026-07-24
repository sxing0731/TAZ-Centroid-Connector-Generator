# TAZ Centroid Connector Generator - Project and Technical Summary

Updated: July 22, 2026

## 1. Project Overview

The TAZ Centroid Connector Generator is a standalone GIS workflow for creating,
reviewing, editing, and exporting centroid connectors for Georgia Traffic
Analysis Zones (TAZs). It replaces an ArcGIS Pro/ArcPy-dependent process with a
maintainable Python application and browser-based QA/QC tools.

The project provides three connected capabilities:

1. A Python GIS engine that creates an initial set of centroid connectors.
2. A local, writable QA/QC web application for editing generated results.
3. A static browser QA/QC application for statewide review, status tracking,
   file replacement, and final export.

The authoritative project location is:

```text
C:\Projects\TAZ_Centroid_Connector_Generator
```

## 2. Primary Objectives

The project is designed to:

- generate reasonable initial TAZ centroid connectors automatically;
- use HERE roadway density to identify useful connector directions;
- snap final connectors to valid GSTDM master nodes;
- enforce hard spatial and network rules consistently;
- provide visual QA/QC and manual correction tools;
- track the review status and notes for every TAZ;
- export two-way connector records suitable for Cube; and
- operate without ArcGIS Pro or ArcPy.

## 3. System Architecture

The overall data flow is:

```text
TAZ polygons
HERE Master LINKS
GSTDM LINKS
GSTDM Master NODES
        |
        v
Python validation and connector-generation engine
        |
        +--> GeoPackage, CSV, field dictionary, and run configuration
        |
        +--> Local QA/QC server --> edited GeoPackage and Cube DBF
        |
        +--> Static-data generator --> core JSON and MVT tiles
                                      |
                                      v
                              MapLibre browser QA/QC
                                      |
                                      v
                          Final DBF/CSV and TAZ QC status
```

### 3.1 Python Processing Layer

The Python layer validates the source GIS data, creates candidate directions,
calculates road density, matches candidate directions to nodes, selects the
final connectors, enforces hard rules, and writes the production outputs.

Primary modules:

| Module | Responsibility |
| --- | --- |
| `main.py` | Command-line entry point and optional Tkinter launch |
| `ui.py` | Desktop Tkinter interface |
| `config.py` | Typed configuration and parameter validation |
| `defaults.py` | Default Georgia input paths and parameters |
| `validation.py` | Input loading, geometry checks, field checks, and CRS validation |
| `geometry.py` | Centroids, sectors, node levels, matching, snapping, and crossing checks |
| `density.py` | Spatially indexed HERE road-density calculations |
| `selection.py` | Density ranking and angular connector selection |
| `processing.py` | End-to-end workflow orchestration and final rule enforcement |
| `export.py` | GeoPackage, CSV, field dictionary, and configuration exports |
| `make_review_maps.py` | Static PNG review-map generation |

### 3.2 Local QA/QC Layer

`qaqc_web.py` provides a lightweight local HTTP server and API. It loads a
specific connector run, or automatically resolves the latest valid `run_*`
folder under `output`.

The local application supports:

- TAZ-by-TAZ connector review;
- adding, moving, and deleting connectors;
- undo and redo;
- marking TAZs as reviewed;
- validation against connector rules; and
- writing revised GIS and Cube outputs back to the run folder.

### 3.3 Static Browser QA/QC Layer

The static application is stored under `docs/`. Its current development version
uses MapLibre GL and standard Mapbox Vector Tiles (MVT) for statewide map
display. Browser-local review data is stored in `localStorage`.

The static application supports:

- statewide TAZ, connector, node, and GSTDM network display;
- OpenStreetMap and optional Esri satellite basemaps;
- viewport-based WebGL rendering with local MVT data, with supplemental JSON
  spatial tiles used for browser-side hit testing and editing;
- TAZ selection from the map or review queue;
- connector addition, deletion, endpoint reassignment, and QC notes;
- DBF, CSV, SHP plus DBF, GeoJSON, and JSON connector-file loading;
- replacement of the default connectors with an uploaded connector dataset;
- published DBF/CSV defaults containing 14,921 Global CC pairs (1,467 in the
  New-TAZ core subset) and 28 HERE_MISS pairs;
- browser-local HERE_MISS link editing between any two visible detailed nodes;
- hover and selection highlighting for connector nodes, CCs, and HERE_MISS links;
- a separate HERE_MISS map layer with right-click deletion and undo/redo;
- synchronized CC, Missing Links, and TAZ Status tables in a resizable right
  panel;
- inline editing for connector fields, missing-link attributes, TAZ review
  status, and TAZ QC notes;
- table-row selection highlighting and double-click zoom for HERE_MISS links;
- blank-map-click deselection for selected CC and HERE_MISS links;
- categorized Navigate, Edit, Data, Export, and Help dropdown menus that keep
  the complete action set accessible on small screens;
- preprocessing exclusion of red major nodes, with manual red-node overrides
  allowed only after a large persistent warning is shown;
- Review + Previous and Review + Next navigation through the current review list;
- browser-persistent layer order and visibility preferences;
- browser-persistent right-panel width;
- mobile pinch zoom;
- final Cube DBF or CSV export, with DBF selected by default;
- optional QCNOTES companion-file export, disabled by default;
- TAZ QC status export as DBF, CSV, or a polygon Shapefile ZIP, with DBF
  selected by default; and
- dedicated HERE_MISS DBF or CSV export, with DBF selected by default.

## 4. Input Data

The default workflow uses four source datasets.

### 4.1 TAZ Polygons

```text
input/GSTDM2025_New_TAZ_projected.gpkg::taz
```

Default TAZ ID field: `NEWID`

### 4.2 HERE Master LINKS

```text
input/HERE Master LINKS/GEORGIA_2025_GA_Clean_Attributes.shp
```

HERE links are used only to calculate road-link density within each candidate
sector.

### 4.3 GSTDM LINKS

```text
input/GSTDM LINKS/GSTDM_2025_GA_LINK_0710.shp
```

GSTDM links provide display and output context, determine node functional-class
levels, and support connector-crossing validation.

Default network fields:

- from node: `A`
- to node: `B`
- functional class: `FUNC_CLASS`

### 4.4 GSTDM Master NODES

```text
input/GSTDM NOTES/GSTDM_2025_GA_NODE_0710.shp
```

GSTDM master nodes are the final connector endpoints.

Default node ID field: `N`

## 5. Input Requirements and Validation

All input layers must use the same projected CRS, with distances interpreted in
feet. The application assumes a Georgia State Plane feet-based workflow and does
not silently reproject source data.

Processing stops when it encounters:

- a missing or unprojected CRS;
- mismatched coordinate systems;
- missing required fields;
- empty required layers;
- unsupported or invalid geometry;
- null TAZ identifiers; or
- duplicate TAZ identifiers.

TAZ geometries must be Polygon or MultiPolygon features, road layers must be
LineString or MultiLineString features, and the node layer must contain Point or
MultiPoint features.

## 6. Connector-Generation Algorithm

### Step 1: Create Interior TAZ Points

The engine uses `representative_point()` to create one point guaranteed to fall
inside each TAZ polygon.

### Step 2: Generate Angular Sectors

The area around each interior point is divided into equal angular sectors. The
default configuration uses 10 sectors per TAZ. Each sector includes a radial
direction and a sector polygon clipped to the parent TAZ.

### Step 3: Calculate HERE Road Density

HERE links are spatially indexed and clipped to each sector. Density is
calculated as:

```text
clipped HERE road length / clipped sector area
```

The sectors are ranked by density within each TAZ.

### Step 4: Classify GSTDM Nodes

Each GSTDM node receives a `MAJOR_LEVEL` from the functional classes of the
GSTDM links connected through their `A` and `B` fields.

Lower numeric functional classes represent more major roadways. If a node is
connected to functional classes 1, 3, and 5, its `MAJOR_LEVEL` is 1.

With the current default thresholds:

- `MAJOR_LEVEL <= 2` produces `MAJOR_INT = Y`;
- `MAJOR_LEVEL <= 2` is blocked from snapping; and
- only `MAJOR_LEVEL` 3, 4, or 5 is snap-eligible.

`MAJOR_INT` is a functional-class-based major-intersection flag. It is not a
generic geometric or node-degree intersection detector. It must remain
conceptually separate from snap eligibility, even though the current default
threshold is 2 for both rules.

### Step 5: Match Sector Directions to Nodes

For each candidate direction, the engine searches for a valid GSTDM node near
the centroid-to-boundary radial line.

Boundary-near nodes are preferred. Valid candidates are ranked in progressive
distance bands:

- 0-25 feet;
- 25-50 feet;
- 50-100 feet; and
- 100-200 feet.

The ranking considers endpoint distance from the TAZ boundary, the length of the
connector outside the TAZ, and angular fit.

If no boundary-near node satisfies every hard rule, an internal node can be used
and the connector is marked `INTERIOR_FALLBACK = True`.

### Step 6: Select Connector Directions

Snap-eligible candidates are ranked primarily by HERE road density. Angular
separation is enforced so that the selected connectors do not cluster in one
direction.

The current defaults are:

- target connectors per TAZ: 3;
- minimum connectors per TAZ: 1;
- maximum connectors per TAZ: 3; and
- hard minimum angle: 70 degrees.

The 70-degree minimum angle is never relaxed. A lower-priority connector is
discarded if it cannot fit without violating the rule.

### Step 7: Enforce Cross-TAZ Node Ownership

A GSTDM target node may be used by connectors from only one TAZ. When multiple
TAZs compete for the same node, the workflow preserves the assignment for the
TAZ with fewer valid alternatives and redirects the other TAZ to another fully
valid node.

### Step 8: Build and Validate Final Connector Lines

Final connectors are straight lines from the interior TAZ point to the selected
GSTDM master node.

The following hard rules are enforced:

- the target node must be snap-eligible;
- the connector may extend outside its TAZ by no more than 200 feet;
- the connector may not cross a GSTDM link away from its target endpoint;
- final connector bearings within one TAZ must remain at least 70 degrees apart;
- a GSTDM node may not be shared by different TAZs; and
- no more than three connectors may be retained for one TAZ.

## 7. Default Configuration

| Parameter | Default |
| --- | ---: |
| Angular sectors per TAZ | 10 |
| Target connectors | 3 |
| Minimum connectors | 1 |
| Maximum connectors | 3 |
| Minimum final angle | 70 degrees |
| Maximum snap distance | Unlimited when blank |
| `MAJOR_INT` level ceiling | 2 |
| Snap-blocked level ceiling | 2 |
| Maximum connector length outside TAZ | 200 feet |

## 8. Processing Outputs

Every processing run creates a timestamped output folder such as:

```text
output/run_20260722_033549
```

The primary files are:

- `taz_centroid_connectors.gpkg`
- `connector_table.csv`
- `field_dictionary.csv`
- `run_configuration.json`

The GeoPackage contains the following principal layers:

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

Important QA fields include:

- `N`
- `CC_PT`
- `CC_NODE`
- `DENSITY`
- `DENS_RANK`
- `ANGLE_DEG`
- `NEAR_DIST`
- `SNAP_OK`
- `LINE_NODE_DIST`
- `MATCH_BND_DIST`
- `MAJOR_LEVEL`
- `MAJOR_INT`
- `SNAP_ALLOWED`
- `SNAP_FAIL_REASON`
- `END_BND_DIST`
- `END_ON_BND`
- `INTERIOR_FALLBACK`
- `CROSSES_TAZ`
- `OUTSIDE_LEN`
- `CROSSES_GSTDM`

## 9. QA/QC Outputs

The local QA/QC application can write:

- `qaqc_edits.csv`
- `qaqc_edits.geojson`
- `final_connector_lines_qaqc.gpkg`
- `cube_taz_cc.dbf`

The Cube DBF contains two directed records per connector:

| A | B | FCLASS |
| --- | --- | ---: |
| TAZ ID | GSTDM node | 32 |
| GSTDM node | TAZ ID | 32 |

The static browser application can export the same directed records as DBF or
CSV. It can also generate an optional QCNOTES companion file containing `A`,
`B`, and `QC_NOTES`.

Missing roadway links are stored separately from centroid connectors in the
`HERE_MISS` layer. Each published, loaded, or visually added node pair produces
two directed export records:

| A | B | LANES | HERE_MISS | FCLASS |
| --- | --- | ---: | ---: | ---: |
| First node | Second node | 1 | 1 | 32 |
| Second node | First node | 1 | 1 | 32 |

The `LANES`, `HERE_MISS`, and `FCLASS` fields are numeric in the DBF output.
The current published defaults are sourced from
`input/default/cube_taz_cc_public.csv` (29,842 directional records / 14,921
Global CC pairs, including 1,467 pairs in the New-TAZ core subset) and
`input/default/HERE_MISS_links.csv` (56 directional records / 28 missing-link
pairs). The generator validates and embeds these inputs so that
they are the initial CC and HERE_MISS layers rather than uploaded edits.
HERE_MISS links are saved in browser local storage, can be selected from the map
or table, deleted through the right-click menu, and restored with Undo. The
static browser application can also load a HERE_MISS DBF or CSV, combine its
two directional records into one map link, resolve A/B geometry from the
published node index, and replace the current layer as an undoable operation.
The Missing Links table can edit A, B, record count, LANES, HERE_MISS, and
FCLASS; newly created and published links default to two records, LANES=1,
HERE_MISS=1, and FCLASS=32. The CC table can edit each displayed connector
attribute, while the TAZ Status table can edit review status and QC notes. TAZ
IDs and live connector counts remain read-only because they are geometry keys
and calculated values.

TAZ review status can be exported as:

- CSV containing `TAZ_ID`, `QC_STATUS`, and `QC_NOTES`; or
- a polygon Shapefile ZIP with the same status information.

## 10. TAZ Review Status Model

The static browser workflow uses four review states:

| Status | Meaning |
| --- | --- |
| `WAITING FOR QC` | The TAZ has connectors but has not been reviewed |
| `FLAG` | The TAZ has no connector or requires attention |
| `EDITED` | Uploaded data differ from the defaults or browser-saved work changed the TAZ |
| `REVIEWED` | The reviewer approved the current connector configuration |

A TAZ with zero connectors remains flagged until a valid connector is added.

## 11. Latest Verified Run

The latest verified run is:

```text
output/run_20260722_033549
```

### 11.1 Production Result Counts

| Metric | Result |
| --- | ---: |
| Total TAZs | 658 |
| TAZs with connectors | 633 |
| TAZs without connectors | 25 |
| Final connectors | 1,550 |
| TAZs with one connector | 72 |
| TAZs with two connectors | 205 |
| TAZs with three connectors | 356 |
| Selected nodes with `MAJOR_LEVEL = 3` | 431 |
| Selected nodes with `MAJOR_LEVEL = 4` | 1,073 |
| Selected nodes with `MAJOR_LEVEL = 5` | 46 |
| Internal-node fallbacks | 4 |
| Connectors with some geometry outside the TAZ | 652 |
| Maximum outside length | 194.58 feet |
| GSTDM crossing violations | 0 |

All 1,550 generated connectors in this run use levels 3, 4, or 5. They have
`MAJOR_INT = N`, `SNAP_ALLOWED = True`, and `SNAP_OK = True`. No final connector
exceeds the 200-foot outside-TAZ limit.

### 11.2 Static Map Dataset

The current static dataset was generated from the same run and contains:

| Dataset item | Count |
| --- | ---: |
| TAZs | 658 |
| Connectors | 1,550 |
| GSTDM nodes | 376,837 |
| GSTDM source features | 214,473 |
| GSTDM line geometries | 176,306 |
| MVT tiles | 3,046 |
| MVT size | Approximately 35.4 MB |

MVT zooms 6 through 11 use zoom-dependent, topology-preserving GSTDM
simplification and clustered node display. Zoom 12 contains full node and link
detail and is overzoomed for closer views.

## 12. Installation and Execution Steps

### Step 1: Create the Python Environment

From the project root:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### Step 2: Run the Default Production Workflow

```powershell
.\.venv\Scripts\python.exe main.py --run-default --maps --output output
```

This creates a new timestamped `output/run_*` folder. Existing run folders are
not overwritten.

To use the desktop interface instead:

```powershell
.\.venv\Scripts\python.exe main.py
```

### Step 3: Inspect the Initial Outputs

Review at least:

- every TAZ with no connector;
- every TAZ with only one connector;
- all `INTERIOR_FALLBACK` connectors;
- connectors with `CROSSES_TAZ = True`;
- final bearing separation;
- node ownership across TAZs;
- `OUTSIDE_LEN`; and
- `CROSSES_GSTDM`.

### Step 4: Start the Local QA/QC Application

```powershell
.\.venv\Scripts\python.exe qaqc_web.py --run-folder output --port 8765
```

Open:

```text
http://127.0.0.1:8765
```

Review the connectors, apply necessary edits, and generate the revised
GeoPackage and Cube DBF.

### Step 5: Generate the Static QA/QC Dataset

```powershell
.\.venv\Scripts\python.exe generate_docs_data.py
```

This generates:

- `docs/data/core.json`;
- `docs/data/mvt/{z}/{x}/{y}.pbf`; and
- the corresponding tile manifests and supporting static data.

### Step 6: Complete Browser-Based Review

In the static QA/QC application:

1. Use the published default connectors or load a replacement CC file.
2. Review each TAZ in the queue.
3. Add, remove, or reassign connector endpoints as needed.
4. Use the CC, Missing Links, and TAZ Status tabs to inspect the corresponding
   records; selecting a map feature highlights its table row.
5. Add missing roadway links by selecting two nodes, and double-click a Missing
   Links table row to zoom to that link.
6. Record QC notes in the field below the tables.
7. Mark acceptable TAZs as `REVIEWED`.
8. Resolve or document every `FLAG`.
9. Export the final Cube DBF or CSV.
10. Load an existing HERE_MISS DBF/CSV when needed, then export the reviewed
    HERE_MISS records as DBF or CSV.
11. Export the TAZ QC status dataset.
12. Archive the source run, review status, final connectors, HERE_MISS links,
   and QC notes
   together.

### Step 7: Run Automated Tests

Python tests:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

JavaScript tests, with Node.js available on `PATH`:

```powershell
node --test tests/*.js
```

Current verified results:

- Python: 19 passed
- JavaScript: 13 scripts passed

## 13. Technology Stack

### Python and GIS

- Python 3.12 or newer
- GeoPandas
- Shapely
- Pandas
- NumPy
- PyProj
- Pyogrio
- Rtree
- mapbox-vector-tile
- Tkinter

### Browser

- Native HTML, CSS, and JavaScript
- MapLibre GL
- Mapbox Vector Tiles
- OpenStreetMap raster basemap
- Optional Esri satellite imagery
- Browser `localStorage`

### Data Formats

- GeoPackage
- Shapefile
- DBF
- CSV
- GeoJSON/JSON
- MVT/PBF
- PNG review maps

## 14. Project Evolution

The project has progressed through six principal phases:

1. Creation of the standalone Python/Tkinter connector-generation engine.
2. Addition of local QA/QC maps, editing controls, and Cube export.
3. Refinement of major-node, snapping, boundary-distance, and angular rules.
4. Addition of statewide QC status, cross-TAZ node ownership, stricter hard-rule
   enforcement, and mobile interaction.
5. Current migration of the static statewide map to MapLibre and standard MVT,
   together with enhanced file replacement, manual overrides, status export,
   and browser-based review features.
6. Addition of browser-local HERE_MISS link creation, DBF/CSV loading, and two-way export,
   synchronized QAQC tables, selectable and deletable missing links, resizable
   table layout, and table-driven map zoom.
7. Addition of inline table editing, blank-map-click deselection, FCLASS=32
   HERE_MISS defaults, and responsive grouped toolbar menus.

## 15. Current Development Status

The July 23, 2026 development state includes the MapLibre/MVT statewide map,
replacement CC-file loading, manual override handling, TAZ status export,
published CC/HERE_MISS default inputs, HERE_MISS editing, import, and export,
the three-tab QAQC table interface, editable table attributes, blank-map-click
deselection, and categorized responsive toolbar menus.

The current change set has passed the Python and JavaScript automated suites.
Desktop browser QA has also verified map loading, CC and missing-link row
selection, HERE_MISS creation and two-direction export, right-click deletion,
Undo/Redo, TAZ status display, right-panel resizing and persistence, and
double-click zoom from the Missing Links table. The July 23 QA additionally
verified grouped dropdown menus, blank-map-click deselection, FCLASS editing
with Undo, and the published 14,921-Global-CC / 28-missing-link defaults. No browser
console errors were observed during those checks.

## 16. Recommended Next Steps

1. Complete a mobile visual review of the MapLibre static app and its three
   QAQC tables.
2. Review the 25 zero-connector TAZs and document whether each requires a manual
   connector or an accepted flag.
3. Review all four `INTERIOR_FALLBACK` cases.
4. Confirm that the generated MVT and supplemental JSON tile directories contain
   only the data intended for publication.
5. Re-run both automated test suites after any generated-data refresh.
6. Publish the source, tests, documentation, and required generated data as a
   clearly defined release unit.
7. Archive the accepted run configuration, final connector file, HERE_MISS
   export, QC notes, and TAZ review-status export together for reproducibility.
