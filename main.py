"""Application entry point."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

from defaults import ROOT, default_config
from make_review_maps import create_review_maps
from processing import run_processing
from ui import launch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="TAZ centroid connector generator",
    )
    parser.add_argument(
        "--run-default",
        action="store_true",
        help="Run the bundled local input data without opening the UI.",
    )
    parser.add_argument(
        "--maps",
        action="store_true",
        help="Create review maps after a --run-default processing run.",
    )
    parser.add_argument(
        "--output",
        default=str(ROOT / "output"),
        help="Parent output folder for --run-default; each run creates a timestamped child folder.",
    )
    parser.add_argument(
        "--map-count",
        type=int,
        default=5,
        help="Number of individual review maps to create.",
    )
    return parser.parse_args()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = parse_args()
    if args.run_default:
        config = default_config(args.output)
        run_processing(config)
        if args.maps:
            create_review_maps(Path(config.output_folder), count=args.map_count)
        return
    launch()


if __name__ == "__main__":
    main()
