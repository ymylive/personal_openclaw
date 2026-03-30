"""Logging helpers shared across workspace modules."""

from __future__ import annotations

import logging
from pathlib import Path


def build_logger(name: str, log_path: Path) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(log_path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger
