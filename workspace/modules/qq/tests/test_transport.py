from __future__ import annotations

import unittest

from workspace.modules.qq.transport import build_send_group_payload


class QQTransportTest(unittest.TestCase):
    def test_build_send_group_payload_keeps_echo(self) -> None:
        payload = build_send_group_payload(group_id=1061966199, message="hello", echo="job-1")
        self.assertEqual(payload["action"], "send_group_msg")
        self.assertEqual(payload["params"]["group_id"], 1061966199)
        self.assertEqual(payload["echo"], "job-1")


if __name__ == "__main__":
    unittest.main()
