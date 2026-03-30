"""Shared configuration helpers."""

from __future__ import annotations

import json
from pathlib import Path


class WorkspaceConfig:
    def __init__(self, config_path: Path) -> None:
        self._config_path = Path(config_path)
        self._raw = json.loads(self._config_path.read_text(encoding="utf-8"))

    def raw(self) -> dict:
        return dict(self._raw)

    def qq(self) -> dict:
        channels = self._raw.get("channels") or {}
        return dict(channels.get("qq") or {})

    def finance(self) -> dict:
        return dict(self._raw.get("finance") or {})
