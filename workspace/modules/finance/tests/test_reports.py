from __future__ import annotations

import unittest

from workspace.modules.finance.reports import build_morning_analysis


class FinanceReportsTest(unittest.TestCase):
    def test_build_morning_analysis_mentions_finance_only_context(self) -> None:
        text = build_morning_analysis("CPI and Fed remain market focus")
        self.assertIn("金融", text)
        self.assertNotIn("QQ", text)


if __name__ == "__main__":
    unittest.main()
