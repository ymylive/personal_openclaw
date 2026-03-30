"""Tests for shared delivery contracts."""

from __future__ import annotations

import unittest

from workspace.modules.shared.contracts import DeliveryRequest, DeliveryTarget


class DeliveryContractsTest(unittest.TestCase):
    def test_delivery_request_serializes_channel_target(self) -> None:
        request = DeliveryRequest(
            job_name="morning-news",
            body="market summary",
            targets=[DeliveryTarget(channel="qq", recipient="1061966199")],
            metadata={"kind": "finance"},
        )
        payload = request.to_dict()
        self.assertEqual(payload["job_name"], "morning-news")
        self.assertEqual(payload["targets"][0]["channel"], "qq")
        self.assertEqual(payload["metadata"]["kind"], "finance")


if __name__ == "__main__":
    unittest.main()
