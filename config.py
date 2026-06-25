"""Application configuration models."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class FieldMapping:
    """Source-field names required by the processing engine."""

    taz_id: str = "TAZ_N"
    node_id: str = "NODE_ID"


@dataclass(slots=True)
class ProcessingConfig:
    """All editable processing parameters and input/output locations."""

    taz_path: str = ""
    links_path: str = ""
    nodes_path: str = ""
    output_folder: str = ""
    fields: FieldMapping = field(default_factory=FieldMapping)
    boundary_spacing: float = 2000.0
    buffer_radius: float = 5000.0
    target_connector_count: int = 4
    minimum_connector_count: int = 3
    minimum_angle: float = 60.0
    maximum_snap_distance: float | None = None
    output_format: str = "GPKG"

    def validate_parameters(self) -> None:
        """Validate non-spatial configuration values."""
        if self.boundary_spacing <= 0:
            raise ValueError("Boundary spacing must be greater than zero.")
        if self.buffer_radius <= 0:
            raise ValueError("Buffer radius must be greater than zero.")
        if self.target_connector_count < 1:
            raise ValueError("Target connectors must be at least 1.")
        if self.minimum_connector_count < 1:
            raise ValueError("Minimum connectors must be at least 1.")
        if self.minimum_connector_count > self.target_connector_count:
            raise ValueError("Minimum connectors cannot exceed target connectors.")
        if not 0 <= self.minimum_angle <= 180:
            raise ValueError("Minimum angle must be between 0 and 180 degrees.")
        if self.maximum_snap_distance is not None and self.maximum_snap_distance < 0:
            raise ValueError("Maximum snap distance cannot be negative.")
        if not self.fields.taz_id.strip():
            raise ValueError("TAZ ID field is required.")
        if not self.fields.node_id.strip():
            raise ValueError("Node ID field is required.")

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
        return cls(**data)

