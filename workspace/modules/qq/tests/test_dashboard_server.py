from __future__ import annotations

import json
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path

from workspace.modules.qq.qq_dashboard_server import (
    build_bootstrap_payload,
    read_dashboard_snapshot,
    route_status,
    update_qq_config,
)


class QQDashboardServerTest(unittest.TestCase):
    def test_bootstrap_payload_stays_qq_scoped(self) -> None:
        payload = build_bootstrap_payload(
            connection={"running": True},
            listener={"count": 2},
            logs=["ok"],
        )
        self.assertEqual(payload["module"], "qq")
        self.assertIn("connection", payload)
        self.assertNotIn("finance", payload)

    def test_route_status_returns_ok_payload(self) -> None:
        status, payload = route_status()
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(payload["module"], "qq")
        self.assertEqual(payload["listener"].get("count"), 0)

    def test_update_qq_config_persists_settings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "openclaw.json"
            config_path.write_text(json.dumps({"channels": {"qq": {}}}), encoding="utf-8")
            updated = update_qq_config(
                {
                    "systemPrompt": "你是很会聊天的 QQ 助手",
                    "monitorAgentId": "qqmonitor",
                    "replyAgentId": "qqreply",
                    "monitorSettings": {"enabled": True},
                    "stickerSettings": {"enabled": True},
                },
                config_path,
            )
            self.assertEqual(updated["systemPrompt"], "你是很会聊天的 QQ 助手")
            saved = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["channels"]["qq"]["replyAgentId"], "qqreply")

    def test_read_dashboard_snapshot_uses_config_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "channels": {
                            "qq": {
                                "wsUrl": "ws://localhost:8080",
                                "systemPrompt": "prompt",
                                "allowedGroups": [12345],
                                "monitorSettings": {"enabled": False},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            snapshot = read_dashboard_snapshot(config_path=config_path, workspace_root=root)
            self.assertEqual(snapshot["module"], "qq")
            self.assertEqual(snapshot["config"]["systemPrompt"], "prompt")
            self.assertEqual(snapshot["messages"]["defaultGroupId"], 12345)
            self.assertFalse(snapshot["automation"]["enabled"])


if __name__ == "__main__":
    unittest.main()
