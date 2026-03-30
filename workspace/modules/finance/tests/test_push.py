from __future__ import annotations

import unittest

from workspace.modules.finance.push import build_finance_push_request


class FinancePushTest(unittest.TestCase):
    def test_build_finance_push_request_returns_delivery_contract(self) -> None:
        request = build_finance_push_request(
            job_name="morning-news",
            body="market summary",
            target_channel="qq",
            target_recipient="1061961969",
        )
        payload = request.to_dict()
        self.assertEqual(payload["metadata"]["kind"], "finance")
        self.assertEqual(payload["targets"][0]["channel"], "qq")


if __name__ == "__main__":
    unittest.main()
