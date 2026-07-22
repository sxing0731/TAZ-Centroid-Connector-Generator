# TAZ Centroid Connector Generator - Project Handoff

Updated: July 12, 2026

## Project Location

`C:\Projects\TAZ_Centroid_Connector_Generator`

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
   centroid-to-boundary radial line. `MAJOR_INT` is `Y` for
   `MAJOR_LEVEL <= 2`, while snap eligibility also excludes
   `MAJOR_LEVEL <= 2`; only non-major levels 3/4/5 can be used as snap nodes.
   A connector may have at most 200 ft outside its TAZ and cannot cross a GSTDM
   LINK before reaching the target-node endpoint. These limits are never relaxed.
10. A GSTDM target node may be used by only one TAZ. When TAZs compete for the
    same node, the TAZ with more valid alternatives is redirected to its next
    nearby fully valid node.
11. Final connectors are straight lines from the interior centroid to the snapped
   GSTDM node.
12. Keep between 1 and 3 connectors per TAZ. Flag a TAZ only when no valid
    connector can satisfy all hard rules.
13. The output TAZ number field is `N`.

Corner avoidance and major-intersection avoidance are no longer active rules.
Barrier-layer rejection was also dropped.

## Current Inputs

TAZ polygons:

`input/GSTDM2025_New_TAZ_projected.gpkg::taz`

Current TAZ ID mapping:

`NEWID`

HERE Master LINKS for density:

`input/HERE Master LINKS/GEORGIA_2025_GA_Clean_Attributes.shp`

GSTDM LINKS for display/output context:

`input/GSTDM LINKS/GSTDM_2025_GA_LINK_0710.shp`

GSTDM Master NODES:

`input/GSTDM NOTES/GSTDM_2025_GA_NODE_0710.shp`

Current node ID mapping:

`N`

## Current Parameters

- Sector count: 10
- Maximum connectors: 3
- Minimum connectors: 1
- Minimum angle: 60 degrees
- Maximum snap distance: optional/unlimited when blank
- Major-intersection level ceiling: 2
- Snap blocked major level ceiling: 2
- Maximum connector length outside TAZ: 200 ft

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
- `MAJOR_INT`: `Y` when `MAJOR_LEVEL` is 1 or 2; otherwise `N`
- `SNAP_ALLOWED`: snapped node passes the snap blocked major-level threshold
- `END_BND_DIST`: snapped-node distance from parent TAZ boundary
- `END_ON_BND`: endpoint falls within the boundary tolerance
- `CROSSES_TAZ`: final connector has geometry outside its parent TAZ
- `OUTSIDE_LEN`: length of connector outside its parent TAZ
- `CROSSES_GSTDM`: connector intersects a GSTDM link before its target endpoint

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

1. Decide a production maximum snap distance beyond the current hard rules.
2. Review QA images before publishing another build.
