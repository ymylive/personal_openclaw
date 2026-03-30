"""Tests for shared workspace config helpers."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from workspace.modules.shared.config import WorkspaceConfig


class WorkspaceConfigTest(unittest.TestCase):
    def test_reads_qq_and_finance_scopes_independently(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "channels": {"qq": {"wsUrl": "ws://localhost:8080", "accessToken": "x"}},
                        "finance": {"pushEnabled": True},
                    }
                ),
                encoding="utf-8",
            )
            config = WorkspaceConfig(config_path)
            self.assertEqual(config.qq()["wsUrl"], "ws://localhost:8080")
            self.assertEqual(config.finance()["pushEnabled"], True)


if __name__ == "__main__":
    unittest.main()
