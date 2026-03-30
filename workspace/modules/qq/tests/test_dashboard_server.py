from __future__ import annotations

import unittest
from http import HTTPStatus

from workspace.modules.qq.qq_dashboard_server import build_bootstrap_payload, route_status


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


if __name__ == "__main__":
    unittest.main()
