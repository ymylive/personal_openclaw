from __future__ import annotations

import unittest

from workspace.modules.qq.status import build_status_payload


class QQStatusTest(unittest.TestCase):
    def test_status_payload_is_qq_only(self) -> None:
        payload = build_status_payload(running=True, listener_count=2, last_error=None)
        self.assertEqual(payload["module"], "qq")
        self.assertEqual(payload["listenerCount"], 2)
        self.assertNotIn("finance", payload)


if __name__ == "__main__":
    unittest.main()
