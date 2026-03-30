from __future__ import annotations

import unittest

from workspace.modules.finance.dashboard import build_finance_bootstrap_payload


class FinanceDashboardTest(unittest.TestCase):
    def test_finance_bootstrap_payload_has_finance_scope(self) -> None:
        payload = build_finance_bootstrap_payload(
            date="2026-03-30",
            history_dates=["2026-03-29"],
            delivery={"latestJob": "morning-news"},
        )
        self.assertEqual(payload["module"], "finance")
        self.assertEqual(payload["date"], "2026-03-30")
        self.assertNotIn("qq", payload)


if __name__ == "__main__":
    unittest.main()
