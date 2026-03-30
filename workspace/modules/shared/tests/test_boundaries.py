"""Boundary tests preventing cross-imports between qq and finance modules."""

from __future__ import annotations

import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]


class BoundaryRulesTest(unittest.TestCase):
    def test_no_cross_imports_between_qq_and_finance(self) -> None:
        module_dirs = {
            module: ROOT / "workspace" / "modules" / module for module in ("qq", "finance")
        }
        for module, module_dir in module_dirs.items():
            self.assertTrue(
                module_dir.exists() and module_dir.is_dir(),
                msg=f"Required module directory missing: {module_dir}",
            )

        for module, module_dir in module_dirs.items():
            for path in module_dir.rglob("*.py"):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom) and node.module:
                        self.assertFalse(
                            node.module.startswith(
                                f"workspace.modules.{'finance' if module == 'qq' else 'qq'}"
                            ),
                            msg=f"Cross import found in {path}: {node.module}",
                        )


if __name__ == "__main__":
    unittest.main()
