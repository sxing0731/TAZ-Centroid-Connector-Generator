"""Application entry point."""

from __future__ import annotations

import logging

from ui import launch


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    launch()


if __name__ == "__main__":
    main()

