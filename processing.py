"""UI-independent processing workflow."""

from __future__ import annotations

from datetime import datetime
import logging
from pathlib import Path
from typing import Callable

import geopandas as gpd

from config import ProcessingConfig
from density import calculate_road_density
from export import export_results
from geometry import (
    attach_node_major_levels,
    attach_centroid_geometry,
    create_candidate_lines,
    create_interior_centroids,
    create_sector_buffers,
    generate_sector_candidates,
    match_candidates_to_nodes,
    snap_candidates_to_nodes,
)
from selection import select_connectors
from validation import load_and_validate_inputs

LOGGER = logging.getLogger(__name__)
ProgressFn = Callable[[int, str], None]
LogFn = Callable[[str, int], None]


def _default_progress(percent: int, message: str) -> None:
    LOGGER.info("%d%% %s", percent, message)


def _default_log(message: str, level: int = logging.INFO) -> None:
    LOGGER.log(level, message)


def _make_run_output_folder(base_folder: str) -> str:
    """Create a unique child output folder for this processing run."""
    base = Path(base_folder)
    timestamp = datetime.now().strftime("run_%Y%m%d_%H%M%S")
    candidate = base / timestamp
    suffix = 1
    while candidate.exists():
        suffix += 1
        candidate = base / f"{timestamp}_{suffix}"
    candidate.mkdir(parents=True, exist_ok=False)
    return str(candidate)


def _build_taz_snap_flags(
    taz: gpd.GeoDataFrame,
    candidates: gpd.GeoDataFrame,
    selected: gpd.GeoDataFrame,
    config: ProcessingConfig,
) -> gpd.GeoDataFrame:
    """Summarize snap-node availability and connector count by TAZ."""
    eligible_counts = (
        candidates[candidates["SNAP_ALLOWED"].fillna(False).astype(bool)]
        .groupby("N")
        .size()
        .to_dict()
    )
    selected_counts = selected.groupby("N").size().to_dict() if not selected.empty else {}
    records: list[dict[str, object]] = []
    for _, row in taz.iterrows():
        taz_id = row[config.fields.taz_id]
        eligible = int(eligible_counts.get(taz_id, 0))
        selected_count = int(selected_counts.get(taz_id, 0))
        if eligible == 0:
            issue = "NO_ELIGIBLE_SECTOR_NODE"
        elif selected_count < config.minimum_connector_count:
            issue = "BELOW_MINIMUM_CONNECTORS"
        elif selected_count < config.target_connector_count:
            issue = "BELOW_TARGET_CONNECTORS"
        else:
            issue = ""
        records.append(
            {
                "N": taz_id,
                "SECTOR_COUNT": config.sector_count,
                "ELIG_SECT": eligible,
                "SELECTED": selected_count,
                "TARGET": config.target_connector_count,
                "MINIMUM": config.minimum_connector_count,
                "SNAP_FLAG": (
                    "Y"
                    if issue in {"NO_ELIGIBLE_SECTOR_NODE", "BELOW_MINIMUM_CONNECTORS"}
                    else "N"
                ),
                "SNAP_ISSUE": issue,
                "geometry": row.geometry,
            }
        )
    return gpd.GeoDataFrame(records, geometry="geometry", crs=taz.crs)


def run_processing(
    config: ProcessingConfig,
    progress: ProgressFn = _default_progress,
    log: LogFn = _default_log,
) -> dict[str, gpd.GeoDataFrame]:
    """Execute the complete centroid-connector workflow."""
    config.output_folder = _make_run_output_folder(config.output_folder)
    log(f"Run output folder: {config.output_folder}", logging.INFO)

    progress(2, "Loading and validating inputs")
    taz, here_links, gstdm_links, nodes = load_and_validate_inputs(config)
    nodes = attach_node_major_levels(nodes, gstdm_links, config)

    progress(12, "Creating interior centroids")
    centroids = create_interior_centroids(taz, config)
    inside = [
        polygon.covers(point)
        for polygon, point in zip(taz.geometry, centroids.geometry)
    ]
    if not all(inside):
        raise RuntimeError("One or more representative points are outside their TAZ.")

    progress(22, "Generating angular sector candidates")
    candidates = generate_sector_candidates(taz, centroids, config, log)

    progress(32, "Creating clipped sector density zones")
    buffers = create_sector_buffers(candidates, log)

    progress(45, "Calculating HERE road-link density")
    buffers = calculate_road_density(buffers, here_links, log)
    candidate_scores = candidates.merge(
        buffers[["CC_PT", "DENSITY", "DENS_RANK"]],
        on="CC_PT",
        how="left",
        validate="one_to_one",
    )
    candidate_scores = gpd.GeoDataFrame(
        candidate_scores, geometry="geometry", crs=taz.crs
    )

    progress(55, "Matching candidate directions to GSTDM master nodes")
    candidate_scores = match_candidates_to_nodes(
        candidate_scores, centroids, taz, nodes, config, gstdm_links
    )

    progress(62, "Selecting connectors by density and angle")
    selected = select_connectors(candidate_scores, config, log)
    taz_snap_flags = _build_taz_snap_flags(taz, candidate_scores, selected, config)
    flagged_count = int((taz_snap_flags["SNAP_FLAG"] == "Y").sum())
    if flagged_count:
        log(
            f"{flagged_count} TAZs do not have enough valid non-major nodes "
            f"under the {config.boundary_endpoint_tolerance:g}-ft outside-TAZ and GSTDM-crossing rules; "
            "see taz_snap_flags.",
            logging.WARNING,
        )

    progress(70, "Snapping selected candidates to master nodes")
    selected_with_centroids = attach_centroid_geometry(selected, centroids)
    snapped_nodes, final_lines = snap_candidates_to_nodes(
        selected_with_centroids, nodes, taz, config, log, gstdm_links
    )
    crossing_count = int(final_lines["CROSSES_TAZ"].sum()) if not final_lines.empty else 0
    if crossing_count:
        log(
            f"{crossing_count} final connectors extend outside their parent TAZ; "
            "see CROSSES_TAZ and OUTSIDE_LEN.",
            logging.WARNING,
        )
    gstdm_crossing_count = (
        int(final_lines["CROSSES_GSTDM"].sum()) if not final_lines.empty else 0
    )
    if gstdm_crossing_count:
        raise RuntimeError(
            f"{gstdm_crossing_count} final connectors cross GSTDM links."
        )
    shared_nodes = (
        final_lines.groupby("CC_NODE")["N"].nunique()
        if not final_lines.empty
        else {}
    )
    cross_taz_shared_count = int((shared_nodes > 1).sum()) if len(shared_nodes) else 0
    if cross_taz_shared_count:
        raise RuntimeError(
            f"{cross_taz_shared_count} GSTDM nodes are used by connectors from multiple TAZs."
        )

    progress(82, "Building candidate connector lines")
    candidate_lines = create_candidate_lines(candidate_scores, centroids)

    layers = {
        "taz_centroids": centroids,
        "gstdm_links": gstdm_links,
        "gstdm_master_nodes": nodes,
        "taz_snap_flags": taz_snap_flags,
        "boundary_candidate_points": candidate_scores,
        "sector_density_zones": buffers,
        "candidate_connector_lines": candidate_lines,
        "final_selected_boundary_points": selected,
        "final_snapped_nodes": snapped_nodes,
        "final_connector_lines": final_lines,
    }

    progress(90, "Exporting outputs")
    output_path = export_results(layers, snapped_nodes, config, log)
    log(f"Output written to {output_path}", logging.INFO)
    progress(100, "Completed")
    return layers
