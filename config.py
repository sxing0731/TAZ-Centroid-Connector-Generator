"""Application configuration models."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class FieldMapping:
    """Source-field names required by the processing engine."""

    taz_id: str = "N"
    node_id: str = "N"
    link_from_node: str = "A"
    link_to_node: str = "B"
    link_func_class: str = "FUNC_CLASS"


@dataclass(slots=True)
class ProcessingConfig:
    """All editable processing parameters and input/output locations."""

    taz_path: str = ""
    here_links_path: str = ""
    gstdm_links_path: str = ""
    nodes_path: str = ""
    output_folder: str = ""
    fields: FieldMapping = field(default_factory=FieldMapping)
    sector_count: int = 10
    target_connector_count: int = 3
    minimum_connector_count: int = 1
    minimum_angle: float = 60.0
    maximum_snap_distance: float | None = None
    blocked_major_level: int = 2
    snap_blocked_major_level: int = 2
    boundary_endpoint_tolerance: float = 200.0
    output_format: str = "GPKG"

    def validate_parameters(self) -> None:
        """Validate non-spatial configuration values."""
        if not 4 <= self.sector_count <= 72:
            raise ValueError("Sector count must be between 4 and 72.")
        if not 1 <= self.target_connector_count <= min(3, self.sector_count):
            raise ValueError("Target connectors must be between 1 and 3 and cannot exceed sector count.")
        if not 1 <= self.minimum_connector_count <= 3:
            raise ValueError("Minimum connectors must be between 1 and 3.")
        if self.minimum_connector_count > self.target_connector_count:
            raise ValueError("Minimum connectors cannot exceed target connectors.")
        if not 0 <= self.minimum_angle <= 180:
            raise ValueError("Minimum angle must be between 0 and 180 degrees.")
        if self.maximum_snap_distance is not None and self.maximum_snap_distance < 0:
            raise ValueError("Maximum snap distance cannot be negative.")
        if not 1 <= self.blocked_major_level <= 5:
            raise ValueError("Major intersection level ceiling must be between 1 and 5.")
        if not 1 <= self.snap_blocked_major_level <= 5:
            raise ValueError("Snap blocked node major level ceiling must be between 1 and 5.")
        if self.boundary_endpoint_tolerance < 0:
            raise ValueError("Boundary endpoint tolerance cannot be negative.")
        if not self.fields.taz_id.strip():
            raise ValueError("TAZ ID field is required.")
        if not self.fields.node_id.strip():
            raise ValueError("Node ID field is required.")
        if not self.fields.link_from_node.strip():
            raise ValueError("GSTDM link A/from-node field is required.")
        if not self.fields.link_to_node.strip():
            raise ValueError("GSTDM link B/to-node field is required.")
        if not self.fields.link_func_class.strip():
            raise ValueError("GSTDM link functional-class field is required.")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def save_json(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps(self.to_dict(), indent=2),
            encoding="utf-8",
        )

    @classmethod
    def from_json(cls, path: str | Path) -> "ProcessingConfig":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        data["fields"] = FieldMapping(**data.get("fields", {}))
        if "links_path" in data:
            legacy_links_path = data.pop("links_path")
            data.setdefault("here_links_path", legacy_links_path)
            data.setdefault("gstdm_links_path", legacy_links_path)
        return cls(**data)
