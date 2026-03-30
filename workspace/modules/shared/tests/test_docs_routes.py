from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


class DocsRoutesTest(unittest.TestCase):
    def test_docs_reference_qq_and_finance_routes(self) -> None:
        qq_doc = (ROOT / "docs" / "web" / "qq-dashboard.md").read_text(encoding="utf-8")
        finance_doc = (ROOT / "docs" / "web" / "dashboard.md").read_text(encoding="utf-8")
        self.assertIn("/qq/", qq_doc)
        self.assertIn("/finance/", finance_doc)


if __name__ == "__main__":
    unittest.main()
