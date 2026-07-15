"""Default local paths for the bundled Georgia input data."""

from __future__ import annotations

from pathlib import Path

from config import FieldMapping, ProcessingConfig

ROOT = Path(__file__).resolve().parent
INPUT = ROOT / "input"

TAZ_PATH = INPUT / "GSTDM2025_New_TAZ_projected.gpkg"
HERE_LINKS_PATH = INPUT / "HERE Master LINKS" / "GEORGIA_2025_GA_Clean_Attributes.shp"
GSTDM_LINKS_PATH = INPUT / "GSTDM LINKS" / "GSTDM_2025_GA_LINK_0710.shp"
GSTDM_NODES_PATH = INPUT / "GSTDM NOTES" / "GSTDM_2025_GA_NODE_0710.shp"


def default_config(output_folder: str | Path | None = None) -> ProcessingConfig:
    """Return a ProcessingConfig for the checked-in local input folder."""
    return ProcessingConfig(
        taz_path=f"{TAZ_PATH}::taz",
        here_links_path=str(HERE_LINKS_PATH),
        gstdm_links_path=str(GSTDM_LINKS_PATH),
        nodes_path=str(GSTDM_NODES_PATH),
        output_folder=str(output_folder or ROOT / "output"),
        fields=FieldMapping(
            taz_id="NEWID",
            node_id="N",
            link_from_node="A",
            link_to_node="B",
            link_func_class="FUNC_CLASS",
        ),
        sector_count=10,
        target_connector_count=4,
        minimum_connector_count=2,
        minimum_angle=60.0,
        maximum_snap_distance=None,
        blocked_major_level=2,
        snap_blocked_major_level=2,
        boundary_endpoint_tolerance=200.0,
    )
