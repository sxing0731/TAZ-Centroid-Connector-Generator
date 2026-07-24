# Report Build Notes

## Analytical scope

- Cohort: the same 658 New TAZ IDs preserved in Git commit `5a2a8be`.
- Earliest baseline: `run_20260715_114631`, preserved in
  `5a2a8be:docs/data/all.json`.
- Stabilized algorithm baseline: `run_20260722_033549`, preserved in
  `276731f:docs/data/all.json` and the local output GPKG/CSV.
- Current final: `input/default/cube_taz_cc_public.csv`, validated against
  `docs/data/core.json` for 1,467 unique TAZ-node pairs.
- Comparison grain: unique `(TAZ ID, node ID)` pairs. The earliest file has
  2,632 feature records but 2,606 unique pairs.

## Chart map

| Section | Analytical question | Chart | Fields | Supported takeaway | Palette |
|---|---|---|---|---|---|
| Version history | How much of the earliest-to-final difference occurred before and after human review? | Vertical bar | stage, connector_pairs | Multiple algorithm revisions precede the human-edited publish. | Single blue root |
| Count distribution | Did the final preserve a fixed connector quota? | Grouped vertical bar | connector_count, taz_count, stage | Final counts vary by TAZ and restore coverage to all 658. | Three restrained category roots |
| Density retention | Does higher road-density rank explain final retention? | Grouped vertical bar | rank_bucket, retention_pct, baseline | Rank 1 helps modestly, but density is not a monotonic governing rule. | Two-root cap |
| Edit pattern | How were stable-run TAZs changed? | Vertical bar | edit_pattern, taz_count | Same-count endpoint replacement is the most common pattern. | Single blue root |

## QA

- Analysis script completed and validated current input against the current web
  data at the pair level.
- Python source compiled successfully.
- Canonical artifact validation and portable packaging passed.
- Portable verification was structural only because no local Chromium
  headless-shell executable was available.
