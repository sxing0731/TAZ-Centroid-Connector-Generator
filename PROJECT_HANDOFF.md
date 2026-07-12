# TAZ Centroid Connector Generator - Project Handoff

Updated: July 12, 2026

## Project Location

`C:\Users\xings\iCloudDrive\Codex\TAZ_Centroid_Connector_Generator`

The local working tree contains uncommitted changes and input/output GIS data.
Do not discard or reset these changes.

## Objective

Maintain a standalone Python/Tkinter desktop GIS application that creates
centroid connectors for TAZ polygons without ArcGIS Pro or ArcPy.

## Current Business Rules

1. Create one interior TAZ point with `representative_point()`.
2. Candidate directions are equal angular sectors around the TAZ centroid.
3. HERE Master LINKS are used for road-link density only.
4. GSTDM LINKS are included for final display/output context.
5. GSTDM Master NODES are used for final snapping.
6. Each TAZ is split into `sector_count` equal angular sectors, default 10.
   Sector polygons are clipped to the parent TAZ and used for density.
7. Each GSTDM node gets `MAJOR_LEVEL` from connected GSTDM LINKS using
   A/B/FUNC_CLASS. Lower numeric functional classes are more major, so classes
   1, 3, and 5 produce `MAJOR_LEVEL = 1`.
8. Candidate selection is based on HERE road-link density and angular separation.
9. For each selected sector direction, find the nearest GSTDM node to the
   centroid-to-boundary radial line, excluding nodes with
   `MAJOR_LEVEL >= blocked_major_level` (default 3).
10. Final connectors are straight lines from the interior centroid to the snapped
   GSTDM node.
11. If any part of a final connector lies outside its parent TAZ, flag it.
12. The output TAZ number field is `N`.

Corner avoidance and major-intersection avoidance are no longer active rules.
Barrier-layer rejection was also dropped.

## Current Inputs

TAZ polygons:

`input/GSTDM2025_New_TAZ_projected.gpkg::taz`

Current TAZ ID mapping:

`NEWID`

HERE Master LINKS for density:

`input/Master LINKS/GEORGIA_2025_LINK_GA_Cleaned_New_TAZ.shp`

GSTDM LINKS for display/output context:

`input/Master LINKS/GSTDM_2025_GA_LINK_0710.shp`

GSTDM Master NODES:

`input/Master NODES/GEORGIA_2025_NODE_GA_NEW_TAZ.shp`

Current node ID mapping:

`N`

## Current Parameters

- Sector count: 10
- Target connectors: 4
- Minimum connectors: 2
- Minimum angle: 60 degrees
- Maximum snap distance: optional/unlimited when blank
- Blocked node major level: 3
- Endpoint boundary tolerance: 100 ft

## Output Fields

- `N`: source TAZ number
- `CC_PT`: candidate point ID
- `CC_NODE`: snapped GSTDM master-node ID
- `DENSITY`: clipped HERE road length / clipped sector area
- `DENS_RANK`: density rank within TAZ
- `ANGLE_DEG`: connector bearing
- `NEAR_DIST`: sector direction endpoint to snapped-node distance
- `SNAP_OK`: maximum snap-distance result
- `LINE_NODE_DIST`: snapped-node distance to candidate radial line
- `MAJOR_LEVEL`: highest GSTDM functional class touching snapped node
- `MAJOR_INT`: `Y` when `MAJOR_LEVEL` is 1, 2, or 3; otherwise `N`
- `SNAP_ALLOWED`: snapped node is below the blocked major-level threshold
- `END_BND_DIST`: snapped-node distance from parent TAZ boundary
- `END_ON_BND`: endpoint falls within the boundary tolerance
- `CROSSES_TAZ`: final connector has geometry outside its parent TAZ
- `OUTSIDE_LEN`: length of connector outside its parent TAZ

## Selection Priority

1. Higher HERE road-link density.
2. Stable candidate ID ordering.
3. Angular-separation rules.
4. Relax the angle threshold in 5-degree increments if needed to satisfy the
   minimum connector count.

## Verification

Latest test command:

```powershell
.\.venv\Scripts\python.exe -m pytest
```

Latest result: `7 passed`.

## Main Modules

- `main.py`: application entry point
- `ui.py`: Tkinter UI
- `config.py`: configuration dataclasses and validation
- `validation.py`: GIS input loading and validation
- `geometry.py`: centroids, angular sectors, radial node
  matching, snapping, and crossing calculations
- `density.py`: road-density calculation
- `selection.py`: density and angle selection
- `processing.py`: complete workflow
- `export.py`: GeoPackage and CSV exports
- `make_review_maps.py`: QA screenshot generation

## Recommended Next Decisions

1. Decide a production maximum snap distance.
2. Confirm whether connectors outside the TAZ should only be flagged or should
   be rejected and replaced automatically.
3. Review QA images before publishing another build.
