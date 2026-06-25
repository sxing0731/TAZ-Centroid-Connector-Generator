"""UI-independent processing workflow."""

from __future__ import annotations

import logging
from typing import Callable

import geopandas as gpd

from config import ProcessingConfig
from density import calculate_road_density
from export import export_results
from geometry import (
    attach_centroid_geometry,
    create_candidate_buffers,
    create_candidate_lines,
    create_interior_centroids,
    generate_boundary_candidates,
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


def run_processing(
    config: ProcessingConfig,
    progress: ProgressFn = _default_progress,
    log: LogFn = _default_log,
) -> dict[str, gpd.GeoDataFrame]:
    """Execute the complete centroid-connector workflow."""
    progress(2, "Loading and validating inputs")
    taz, links, nodes = load_and_validate_inputs(config)

    progress(12, "Creating interior centroids")
    centroids = create_interior_centroids(taz, config)
    inside = [
        polygon.covers(point)
        for polygon, point in zip(taz.geometry, centroids.geometry)
    ]
    if not all(inside):
        raise RuntimeError("One or more representative points are outside their TAZ.")

    progress(22, "Generating boundary candidate points")
    candidates = generate_boundary_candidates(taz, centroids, config, log)

    progress(32, "Creating clipped candidate buffers")
    buffers = create_candidate_buffers(candidates, taz, config, log)

    progress(45, "Calculating road density")
    buffers = calculate_road_density(buffers, links, log)
    candidate_scores = candidates.merge(
        buffers[["CC_PT", "DENSITY", "DENS_RANK"]],
        on="CC_PT",
        how="left",
        validate="one_to_one",
    )
    candidate_scores = gpd.GeoDataFrame(
        candidate_scores, geometry="geometry", crs=taz.crs
    )

    progress(60, "Selecting connectors by density and angle")
    selected = select_connectors(candidate_scores, config, log)

    progress(70, "Snapping selected candidates to master nodes")
    selected_with_centroids = attach_centroid_geometry(selected, centroids)
    snapped_nodes, final_lines = snap_candidates_to_nodes(
        selected_with_centroids, nodes, config, log
    )

    progress(82, "Building candidate connector lines")
    candidate_lines = create_candidate_lines(candidate_scores, centroids)

    layers = {
        "taz_centroids": centroids,
        "boundary_candidate_points": candidate_scores,
        "candidate_buffers": buffers,
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

