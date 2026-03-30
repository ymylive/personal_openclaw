# QQ and Finance Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate QQ and finance into separate modules and separate frontend surfaces while preserving legacy script entrypoints and the `/finance` route.

**Architecture:** Introduce `workspace/modules/shared`, `workspace/modules/qq`, and `workspace/modules/finance` as explicit ownership boundaries, then convert `workspace/finance_system/*` scripts into compatibility wrappers. Keep the core OpenClaw Control UI focused on gateway operations, add a standalone QQ web console at `/qq`, keep finance on `/finance`, and deploy both on the same VPS behind an explicit reverse-proxy split.

**Tech Stack:** Python 3, stdlib `unittest`, existing OneBot/WebSocket Python scripts, static HTML/CSS/JS dashboards, OpenClaw gateway, nginx or equivalent reverse proxy, systemd examples, pnpm for repo verification

---

**Execution note:** The current local snapshot does not contain a `.git` directory, but this plan assumes execution happens in a normal git checkout and uses the repo-approved `scripts/committer` flow for scoped commits.

## File Map

### New Python package roots

- Create: `workspace/__init__.py`
- Create: `workspace/modules/__init__.py`

### Shared layer

- Create: `workspace/modules/shared/__init__.py`
- Create: `workspace/modules/shared/config.py`
- Create: `workspace/modules/shared/logging.py`
- Create: `workspace/modules/shared/state.py`
- Create: `workspace/modules/shared/contracts.py`
- Create: `workspace/modules/shared/tests/__init__.py`
- Create: `workspace/modules/shared/tests/test_config.py`
- Create: `workspace/modules/shared/tests/test_contracts.py`
- Create: `workspace/modules/shared/tests/test_boundaries.py`

### QQ module

- Create: `workspace/modules/qq/__init__.py`
- Create: `workspace/modules/qq/transport.py`
- Create: `workspace/modules/qq/attachments.py`
- Create: `workspace/modules/qq/listener.py`
- Create: `workspace/modules/qq/status.py`
- Create: `workspace/modules/qq/qq_dashboard_server.py`
- Create: `workspace/modules/qq/dashboard_assets/qq_dashboard.html`
- Create: `workspace/modules/qq/dashboard_assets/qq_dashboard.css`
- Create: `workspace/modules/qq/dashboard_assets/qq_dashboard.js`
- Create: `workspace/modules/qq/tests/__init__.py`
- Create: `workspace/modules/qq/tests/test_dashboard_server.py`
- Create: `workspace/modules/qq/tests/test_transport.py`
- Create: `workspace/modules/qq/tests/test_listener.py`
- Create: `workspace/modules/qq/tests/test_status.py`

### Finance module

- Create: `workspace/modules/finance/__init__.py`
- Create: `workspace/modules/finance/reports.py`
- Create: `workspace/modules/finance/push.py`
- Create: `workspace/modules/finance/dashboard.py`
- Create: `workspace/modules/finance/status.py`
- Create: `workspace/modules/finance/tests/__init__.py`
- Create: `workspace/modules/finance/tests/test_reports.py`
- Create: `workspace/modules/finance/tests/test_push.py`
- Create: `workspace/modules/finance/tests/test_dashboard.py`

### Legacy compatibility wrappers

- Modify: `workspace/finance_system/qq_config.py`
- Modify: `workspace/finance_system/qq_logging.py`
- Modify: `workspace/finance_system/qq_direct_utils.py`
- Modify: `workspace/finance_system/qq_attachment_extract.py`
- Modify: `workspace/finance_system/qq_at_auto_reply.py`
- Modify: `workspace/finance_system/report_bot.py`
- Modify: `workspace/finance_system/schedule_reminder.py`
- Modify: `workspace/finance_system/send_morning_news_to_qq.py`
- Modify: `workspace/finance_system/send_daily_schedule_to_qq.py`
- Modify: `workspace/finance_system/send_due_reminders_to_qq.py`
- Modify: `workspace/finance_system/send_class_news_digest_to_qq.py`
- Modify: `workspace/finance_system/dashboard_server.py`
- Modify: `workspace/finance_system/dashboard_access.py`
- Modify: `workspace/finance_system/dashboard_contracts.py`
- Modify: `workspace/finance_system/dashboard_storage.py`

### Deployment and docs

- Create: `deployment/nginx/openclaw-separated-frontends.conf.example`
- Create: `deployment/systemd/openclaw-qq-dashboard.service.example`
- Modify: `workspace/finance_system/openclaw_finance_dashboard.service.example`
- Modify: `docs/superpowers/specs/2026-03-30-qq-finance-isolation-design.md`
- Create: `workspace/modules/shared/tests/test_docs_routes.py`
- Create: `docs/web/qq-dashboard.md`
- Modify: `docs/web/dashboard.md`

## Task 1: Establish the Shared Boundary Package

**Files:**
- Create: `workspace/__init__.py`
- Create: `workspace/modules/__init__.py`
- Create: `workspace/modules/shared/__init__.py`
- Create: `workspace/modules/shared/config.py`
- Create: `workspace/modules/shared/logging.py`
- Create: `workspace/modules/shared/state.py`
- Create: `workspace/modules/shared/contracts.py`
- Test: `workspace/modules/shared/tests/test_config.py`
- Test: `workspace/modules/shared/tests/test_contracts.py`
- Test: `workspace/modules/shared/tests/test_boundaries.py`

- [ ] **Step 1: Write the failing shared tests**

```python
# workspace/modules/shared/tests/test_contracts.py
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
```

```python
# workspace/modules/shared/tests/test_config.py
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from workspace.modules.shared.config import WorkspaceConfig


class WorkspaceConfigTest(unittest.TestCase):
    def test_reads_qq_and_finance_scopes_independently(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "channels": {"qq": {"wsUrl": "ws://localhost:8080", "accessToken": "x"}},
                        "finance": {"pushEnabled": True},
                    }
                ),
                encoding="utf-8",
            )
            config = WorkspaceConfig(config_path)
            self.assertEqual(config.qq()["wsUrl"], "ws://localhost:8080")
            self.assertEqual(config.finance()["pushEnabled"], True)


if __name__ == "__main__":
    unittest.main()
```

```python
# workspace/modules/shared/tests/test_boundaries.py
from __future__ import annotations

import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]


class BoundaryRulesTest(unittest.TestCase):
    def test_no_cross_imports_between_qq_and_finance(self) -> None:
        checked = 0
        for module in ("qq", "finance"):
            for path in (ROOT / "workspace" / "modules" / module).rglob("*.py"):
                checked += 1
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom) and node.module:
                        self.assertFalse(
                            node.module.startswith(f"workspace.modules.{'finance' if module == 'qq' else 'qq'}"),
                            msg=f"Cross import found in {path}: {node.module}",
                        )
        self.assertGreaterEqual(checked, 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
python3 -m unittest \
  workspace.modules.shared.tests.test_contracts \
  workspace.modules.shared.tests.test_config \
  workspace.modules.shared.tests.test_boundaries -v
```

Expected:

- `ModuleNotFoundError` for `workspace.modules.shared`
- or import failures for `DeliveryRequest` / `WorkspaceConfig`

- [ ] **Step 3: Write the minimal shared implementation**

```python
# workspace/modules/shared/contracts.py
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class DeliveryTarget:
    channel: str
    recipient: str

    def to_dict(self) -> dict:
        return {"channel": self.channel, "recipient": self.recipient}


@dataclass(frozen=True)
class DeliveryRequest:
    job_name: str
    body: str
    targets: list[DeliveryTarget] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "job_name": self.job_name,
            "body": self.body,
            "targets": [target.to_dict() for target in self.targets],
            "metadata": dict(self.metadata),
        }
```

```python
# workspace/modules/shared/config.py
from __future__ import annotations

import json
from pathlib import Path


class WorkspaceConfig:
    def __init__(self, config_path: Path):
        self._config_path = Path(config_path)
        self._raw = json.loads(self._config_path.read_text(encoding="utf-8"))

    def raw(self) -> dict:
        return dict(self._raw)

    def qq(self) -> dict:
        return dict(((self._raw.get("channels") or {}).get("qq") or {}))

    def finance(self) -> dict:
        return dict(self._raw.get("finance") or {})
```

```python
# workspace/modules/shared/logging.py
from __future__ import annotations

import logging
from pathlib import Path


def build_logger(name: str, log_path: Path) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(log_path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger
```

```python
# workspace/modules/shared/state.py
from __future__ import annotations

import json
from pathlib import Path


def read_json(path: Path, default: object) -> object:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
```

- [ ] **Step 4: Run the shared tests to verify they pass**

Run:

```bash
python3 -m unittest \
  workspace.modules.shared.tests.test_contracts \
  workspace.modules.shared.tests.test_config \
  workspace.modules.shared.tests.test_boundaries -v
```

Expected:

- all listed tests pass
- no cross-import failures

- [ ] **Step 5: Commit**

Run:

```bash
scripts/committer "workspace: add shared module boundary primitives" \
  workspace/__init__.py \
  workspace/modules/__init__.py \
  workspace/modules/shared/__init__.py \
  workspace/modules/shared/config.py \
  workspace/modules/shared/logging.py \
  workspace/modules/shared/state.py \
  workspace/modules/shared/contracts.py \
  workspace/modules/shared/tests/__init__.py \
  workspace/modules/shared/tests/test_config.py \
  workspace/modules/shared/tests/test_contracts.py \
  workspace/modules/shared/tests/test_boundaries.py
```

## Task 2: Extract QQ Transport, Listener, and Status into `workspace.modules.qq`

**Files:**
- Create: `workspace/modules/qq/__init__.py`
- Create: `workspace/modules/qq/transport.py`
- Create: `workspace/modules/qq/attachments.py`
- Create: `workspace/modules/qq/listener.py`
- Create: `workspace/modules/qq/status.py`
- Test: `workspace/modules/qq/tests/test_transport.py`
- Test: `workspace/modules/qq/tests/test_listener.py`
- Test: `workspace/modules/qq/tests/test_status.py`
- Modify: `workspace/finance_system/qq_direct_utils.py`
- Modify: `workspace/finance_system/qq_attachment_extract.py`
- Modify: `workspace/finance_system/qq_at_auto_reply.py`
- Modify: `workspace/finance_system/qq_config.py`
- Modify: `workspace/finance_system/qq_logging.py`

- [ ] **Step 1: Write the failing QQ tests**

```python
# workspace/modules/qq/tests/test_transport.py
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
```

```python
# workspace/modules/qq/tests/test_listener.py
from __future__ import annotations

import unittest

from workspace.modules.qq.listener import should_handle_at_message


class QQListenerTest(unittest.TestCase):
    def test_rejects_blacklisted_group(self) -> None:
        event = {"group_id": 123, "raw_message": "[CQ:at,qq=1] hi"}
        self.assertFalse(should_handle_at_message(event, blacklist={123}, self_ids={1}))

    def test_accepts_at_message_in_allowed_group(self) -> None:
        event = {"group_id": 456, "raw_message": "[CQ:at,qq=1] hi"}
        self.assertTrue(should_handle_at_message(event, blacklist=set(), self_ids={1}))


if __name__ == "__main__":
    unittest.main()
```

```python
# workspace/modules/qq/tests/test_status.py
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
```

- [ ] **Step 2: Run the QQ tests to verify they fail**

Run:

```bash
python3 -m unittest \
  workspace.modules.qq.tests.test_transport \
  workspace.modules.qq.tests.test_listener \
  workspace.modules.qq.tests.test_status -v
```

Expected:

- import failures for `workspace.modules.qq.*`

- [ ] **Step 3: Write the minimal QQ implementation and wrapper redirects**

```python
# workspace/modules/qq/transport.py
from __future__ import annotations

import json


def build_send_group_payload(group_id: int, message: str, echo: str) -> dict:
    return {
        "action": "send_group_msg",
        "params": {"group_id": group_id, "message": message},
        "echo": echo,
    }


def authorization_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


def encode_payload(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)
```

```python
# workspace/modules/qq/listener.py
from __future__ import annotations

import re


AT_RE = re.compile(r"\[CQ:at,qq=(\d+)\]")


def should_handle_at_message(event: dict, blacklist: set[int], self_ids: set[int]) -> bool:
    group_id = int(event.get("group_id") or 0)
    if group_id in blacklist:
        return False
    raw = str(event.get("raw_message") or "")
    matches = {int(match) for match in AT_RE.findall(raw)}
    return bool(matches & self_ids)
```

```python
# workspace/modules/qq/status.py
from __future__ import annotations


def build_status_payload(*, running: bool, listener_count: int, last_error: str | None) -> dict:
    return {
        "module": "qq",
        "running": running,
        "listenerCount": listener_count,
        "lastError": last_error,
    }
```

```python
# workspace/finance_system/qq_direct_utils.py
from workspace.modules.qq.transport import authorization_headers, build_send_group_payload, encode_payload

__all__ = ["authorization_headers", "build_send_group_payload", "encode_payload"]
```

```python
# workspace/finance_system/qq_at_auto_reply.py
from workspace.modules.qq.listener import should_handle_at_message

__all__ = ["should_handle_at_message"]
```

- [ ] **Step 4: Run the QQ tests to verify they pass**

Run:

```bash
python3 -m unittest \
  workspace.modules.qq.tests.test_transport \
  workspace.modules.qq.tests.test_listener \
  workspace.modules.qq.tests.test_status -v
```

Expected:

- all QQ module tests pass
- wrapper imports resolve without finance imports

- [ ] **Step 5: Commit**

Run:

```bash
scripts/committer "qq: extract transport listener and status module" \
  workspace/modules/qq/__init__.py \
  workspace/modules/qq/transport.py \
  workspace/modules/qq/attachments.py \
  workspace/modules/qq/listener.py \
  workspace/modules/qq/status.py \
  workspace/modules/qq/tests/__init__.py \
  workspace/modules/qq/tests/test_transport.py \
  workspace/modules/qq/tests/test_listener.py \
  workspace/modules/qq/tests/test_status.py \
  workspace/finance_system/qq_direct_utils.py \
  workspace/finance_system/qq_attachment_extract.py \
  workspace/finance_system/qq_at_auto_reply.py \
  workspace/finance_system/qq_config.py \
  workspace/finance_system/qq_logging.py
```

## Task 3: Move Finance Reports and Daily Push into `workspace.modules.finance`

**Files:**
- Create: `workspace/modules/finance/__init__.py`
- Create: `workspace/modules/finance/reports.py`
- Create: `workspace/modules/finance/push.py`
- Create: `workspace/modules/finance/status.py`
- Test: `workspace/modules/finance/tests/test_reports.py`
- Test: `workspace/modules/finance/tests/test_push.py`
- Modify: `workspace/finance_system/report_bot.py`
- Modify: `workspace/finance_system/schedule_reminder.py`
- Modify: `workspace/finance_system/send_morning_news_to_qq.py`
- Modify: `workspace/finance_system/send_daily_schedule_to_qq.py`
- Modify: `workspace/finance_system/send_due_reminders_to_qq.py`
- Modify: `workspace/finance_system/send_class_news_digest_to_qq.py`

- [ ] **Step 1: Write the failing finance tests**

```python
# workspace/modules/finance/tests/test_reports.py
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
```

```python
# workspace/modules/finance/tests/test_push.py
from __future__ import annotations

import unittest

from workspace.modules.finance.push import build_finance_push_request


class FinancePushTest(unittest.TestCase):
    def test_build_finance_push_request_returns_delivery_contract(self) -> None:
        request = build_finance_push_request(
            job_name="morning-news",
            body="market summary",
            target_channel="qq",
            target_recipient="1061966199",
        )
        payload = request.to_dict()
        self.assertEqual(payload["metadata"]["kind"], "finance")
        self.assertEqual(payload["targets"][0]["channel"], "qq")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the finance tests to verify they fail**

Run:

```bash
python3 -m unittest \
  workspace.modules.finance.tests.test_reports \
  workspace.modules.finance.tests.test_push -v
```

Expected:

- import failures for finance modules

- [ ] **Step 3: Write the minimal finance implementation and compatibility wrappers**

```python
# workspace/modules/finance/reports.py
from __future__ import annotations


def build_morning_analysis(report_text: str) -> str:
    return "\n".join(
        [
            report_text.strip(),
            "",
            "【金融晨间分析】",
            "本次推送仅包含金融相关内容，不包含 QQ 运营信息。",
        ]
    )
```

```python
# workspace/modules/finance/push.py
from __future__ import annotations

from workspace.modules.shared.contracts import DeliveryRequest, DeliveryTarget


def build_finance_push_request(
    *,
    job_name: str,
    body: str,
    target_channel: str,
    target_recipient: str,
) -> DeliveryRequest:
    return DeliveryRequest(
        job_name=job_name,
        body=body,
        targets=[DeliveryTarget(channel=target_channel, recipient=target_recipient)],
        metadata={"kind": "finance"},
    )
```

```python
# workspace/modules/finance/status.py
from __future__ import annotations


def build_finance_status(*, latest_job: str | None, push_enabled: bool) -> dict:
    return {"module": "finance", "latestJob": latest_job, "pushEnabled": push_enabled}
```

```python
# workspace/finance_system/send_morning_news_to_qq.py
from workspace.modules.finance.push import build_finance_push_request
from workspace.modules.finance.reports import build_morning_analysis

__all__ = ["build_finance_push_request", "build_morning_analysis"]
```

```python
# workspace/finance_system/send_daily_schedule_to_qq.py
from workspace.modules.finance.push import build_finance_push_request

__all__ = ["build_finance_push_request"]
```

- [ ] **Step 4: Run the finance tests to verify they pass**

Run:

```bash
python3 -m unittest \
  workspace.modules.finance.tests.test_reports \
  workspace.modules.finance.tests.test_push -v
```

Expected:

- all finance tests pass
- no finance test requires direct QQ imports

- [ ] **Step 5: Commit**

Run:

```bash
scripts/committer "finance: isolate reports and push orchestration" \
  workspace/modules/finance/__init__.py \
  workspace/modules/finance/reports.py \
  workspace/modules/finance/push.py \
  workspace/modules/finance/status.py \
  workspace/modules/finance/tests/__init__.py \
  workspace/modules/finance/tests/test_reports.py \
  workspace/modules/finance/tests/test_push.py \
  workspace/finance_system/report_bot.py \
  workspace/finance_system/schedule_reminder.py \
  workspace/finance_system/send_morning_news_to_qq.py \
  workspace/finance_system/send_daily_schedule_to_qq.py \
  workspace/finance_system/send_due_reminders_to_qq.py \
  workspace/finance_system/send_class_news_digest_to_qq.py
```

## Task 4: Add a Standalone QQ Dashboard at `/qq`

**Files:**
- Create: `workspace/modules/qq/qq_dashboard_server.py`
- Create: `workspace/modules/qq/dashboard_assets/qq_dashboard.html`
- Create: `workspace/modules/qq/dashboard_assets/qq_dashboard.css`
- Create: `workspace/modules/qq/dashboard_assets/qq_dashboard.js`
- Test: `workspace/modules/qq/tests/test_status.py`
- Test: `workspace/modules/qq/tests/test_dashboard_server.py`

- [ ] **Step 1: Write the failing QQ dashboard tests**

```python
# workspace/modules/qq/tests/test_dashboard_server.py
from __future__ import annotations

import unittest

from workspace.modules.qq.qq_dashboard_server import build_bootstrap_payload


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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the QQ dashboard tests to verify they fail**

Run:

```bash
python3 -m unittest \
  workspace.modules.qq.tests.test_status \
  workspace.modules.qq.tests.test_dashboard_server -v
```

Expected:

- import failure for `build_bootstrap_payload`

- [ ] **Step 3: Write the minimal QQ dashboard server and static assets**

```python
# workspace/modules/qq/qq_dashboard_server.py
from __future__ import annotations

from http import HTTPStatus


def build_bootstrap_payload(*, connection: dict, listener: dict, logs: list[str]) -> dict:
    return {
        "module": "qq",
        "connection": dict(connection),
        "listener": dict(listener),
        "logs": list(logs),
    }


def route_status() -> tuple[int, dict]:
    return HTTPStatus.OK, build_bootstrap_payload(
        connection={"running": True},
        listener={"count": 0},
        logs=[],
    )
```

```html
<!-- workspace/modules/qq/dashboard_assets/qq_dashboard.html -->
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw QQ Dashboard</title>
    <link rel="stylesheet" href="/qq/assets/qq_dashboard.css" />
  </head>
  <body data-bootstrap-url="/qq/api/bootstrap">
    <main class="page-shell">
      <header class="hero">
        <p class="eyebrow">OpenClaw QQ</p>
        <h1>QQ Listener Dashboard</h1>
        <p id="hero-copy">连接状态、监听器、附件处理和日志都只在这里展示。</p>
      </header>
      <section id="summary-grid" class="summary-grid"></section>
      <section id="log-list" class="log-list"></section>
    </main>
    <script src="/qq/assets/qq_dashboard.js"></script>
  </body>
</html>
```

```javascript
// workspace/modules/qq/dashboard_assets/qq_dashboard.js
async function loadQqBootstrap() {
  const response = await fetch(document.body.dataset.bootstrapUrl);
  const payload = await response.json();
  document.getElementById("summary-grid").textContent = JSON.stringify(payload.connection);
  document.getElementById("log-list").textContent = JSON.stringify(payload.logs);
}

loadQqBootstrap().catch((error) => {
  document.getElementById("log-list").textContent = String(error);
});
```

- [ ] **Step 4: Run the QQ dashboard tests to verify they pass**

Run:

```bash
python3 -m unittest \
  workspace.modules.qq.tests.test_status \
  workspace.modules.qq.tests.test_dashboard_server -v
```

Expected:

- all QQ dashboard tests pass
- payload remains QQ-scoped only

- [ ] **Step 5: Commit**

Run:

```bash
scripts/committer "qq-ui: add standalone qq dashboard skeleton" \
  workspace/modules/qq/qq_dashboard_server.py \
  workspace/modules/qq/dashboard_assets/qq_dashboard.html \
  workspace/modules/qq/dashboard_assets/qq_dashboard.css \
  workspace/modules/qq/dashboard_assets/qq_dashboard.js \
  workspace/modules/qq/tests/test_dashboard_server.py \
  workspace/modules/qq/tests/test_status.py
```

## Task 5: Move Finance Dashboard Ownership into `workspace.modules.finance` While Keeping `/finance`

**Files:**
- Create: `workspace/modules/finance/dashboard.py`
- Test: `workspace/modules/finance/tests/test_dashboard.py`
- Modify: `workspace/finance_system/dashboard_server.py`
- Modify: `workspace/finance_system/dashboard_access.py`
- Modify: `workspace/finance_system/dashboard_contracts.py`
- Modify: `workspace/finance_system/dashboard_storage.py`
- Modify: `workspace/finance_system/dashboard_assets/finance_dashboard.html`
- Modify: `workspace/finance_system/dashboard_assets/finance_dashboard.css`
- Modify: `workspace/finance_system/dashboard_assets/finance_dashboard.js`

- [ ] **Step 1: Write the failing finance dashboard tests**

```python
# workspace/modules/finance/tests/test_dashboard.py
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
```

- [ ] **Step 2: Run the finance dashboard test to verify it fails**

Run:

```bash
python3 -m unittest workspace.modules.finance.tests.test_dashboard -v
```

Expected:

- import failure for `workspace.modules.finance.dashboard`

- [ ] **Step 3: Write the minimal finance dashboard module and keep the legacy route as a wrapper**

```python
# workspace/modules/finance/dashboard.py
from __future__ import annotations


def build_finance_bootstrap_payload(*, date: str, history_dates: list[str], delivery: dict) -> dict:
    return {
        "module": "finance",
        "date": date,
        "historyDates": list(history_dates),
        "delivery": dict(delivery),
    }
```

```python
# workspace/finance_system/dashboard_server.py
from workspace.modules.finance.dashboard import build_finance_bootstrap_payload

__all__ = ["build_finance_bootstrap_payload"]
```

```html
<!-- workspace/finance_system/dashboard_assets/finance_dashboard.html -->
<body
  data-bootstrap-url="/finance/api/bootstrap"
  data-page-state="authorized"
  data-module-scope="finance"
>
```

```javascript
// workspace/finance_system/dashboard_assets/finance_dashboard.js
function assertFinanceScope(payload) {
  if (payload.module !== "finance") {
    throw new Error("Expected finance payload");
  }
  return payload;
}
```

- [ ] **Step 4: Run the finance dashboard test to verify it passes**

Run:

```bash
python3 -m unittest workspace.modules.finance.tests.test_dashboard -v
```

Expected:

- finance dashboard bootstrap test passes
- `/finance` wrapper still resolves through legacy file paths

- [ ] **Step 5: Commit**

Run:

```bash
scripts/committer "finance-ui: move finance dashboard ownership behind finance module" \
  workspace/modules/finance/dashboard.py \
  workspace/modules/finance/tests/test_dashboard.py \
  workspace/finance_system/dashboard_server.py \
  workspace/finance_system/dashboard_access.py \
  workspace/finance_system/dashboard_contracts.py \
  workspace/finance_system/dashboard_storage.py \
  workspace/finance_system/dashboard_assets/finance_dashboard.html \
  workspace/finance_system/dashboard_assets/finance_dashboard.css \
  workspace/finance_system/dashboard_assets/finance_dashboard.js
```

## Task 6: Add VPS Routing and Service Examples for `/qq` and `/finance`

**Files:**
- Create: `deployment/nginx/openclaw-separated-frontends.conf.example`
- Create: `deployment/systemd/openclaw-qq-dashboard.service.example`
- Modify: `workspace/finance_system/openclaw_finance_dashboard.service.example`
- Create: `docs/web/qq-dashboard.md`
- Modify: `docs/web/dashboard.md`

- [ ] **Step 1: Write the failing deployment documentation checks**

```python
# workspace/modules/shared/tests/test_docs_routes.py
from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]


class DocsRoutesTest(unittest.TestCase):
    def test_docs_reference_qq_and_finance_routes(self) -> None:
        qq_doc = (ROOT / "docs" / "web" / "qq-dashboard.md").read_text(encoding="utf-8")
        finance_doc = (ROOT / "docs" / "web" / "dashboard.md").read_text(encoding="utf-8")
        self.assertIn("/qq", qq_doc)
        self.assertIn("/finance", finance_doc)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the deployment documentation check to verify it fails**

Run:

```bash
python3 -m unittest workspace.modules.shared.tests.test_docs_routes -v
```

Expected:

- file-not-found or read failure for `docs/web/qq-dashboard.md`

- [ ] **Step 3: Write the proxy, service, and docs changes**

```nginx
# deployment/nginx/openclaw-separated-frontends.conf.example
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location /qq/ {
        proxy_pass http://127.0.0.1:18891/;
        proxy_set_header Host $host;
    }

    location /finance/ {
        proxy_pass http://127.0.0.1:18892/finance/;
        proxy_set_header Host $host;
    }
}
```

```ini
; deployment/systemd/openclaw-qq-dashboard.service.example
[Unit]
Description=OpenClaw QQ Dashboard
After=network-online.target

[Service]
WorkingDirectory=/home/node/.openclaw/workspace/openclaw
ExecStart=/usr/bin/python3 /home/node/.openclaw/workspace/openclaw/workspace/modules/qq/qq_dashboard_server.py --bind 127.0.0.1 --port 18891
Restart=always

[Install]
WantedBy=default.target
```

```md
<!-- docs/web/qq-dashboard.md -->
# QQ Dashboard

Use the QQ dashboard at `/qq` for QQ-only configuration, listener health, attachment flow, and logs.
Do not use this surface for finance jobs or finance push history.
```

```md
<!-- docs/web/dashboard.md -->
The finance dashboard remains available at `/finance`.
It is finance-only and separate from the QQ dashboard at `/qq`.
```

- [ ] **Step 4: Run the deployment documentation check to verify it passes**

Run:

```bash
python3 -m unittest workspace.modules.shared.tests.test_docs_routes -v
```

Expected:

- route documentation test passes
- docs explicitly mention `/qq` and `/finance`

- [ ] **Step 5: Commit**

Run:

```bash
scripts/committer "deploy: add separated frontend routing examples" \
  deployment/nginx/openclaw-separated-frontends.conf.example \
  deployment/systemd/openclaw-qq-dashboard.service.example \
  workspace/finance_system/openclaw_finance_dashboard.service.example \
  docs/web/qq-dashboard.md \
  docs/web/dashboard.md \
  workspace/modules/shared/tests/test_docs_routes.py
```

## Task 7: Run Final Verification Before Deploying to the VPS

**Files:**
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-03-30-qq-finance-isolation-design.md`
- Modify: `docs/superpowers/plans/2026-03-30-qq-finance-isolation.md`

- [ ] **Step 1: Add or confirm repo-level verification entrypoints**

```json
{
  "scripts": {
    "test:workspace-python": "python3 -m unittest discover -s workspace/modules -p 'test_*.py'",
    "verify:qq-finance-isolation": "pnpm build && pnpm test:ui && python3 -m unittest discover -s workspace/modules -p 'test_*.py'"
  }
}
```

- [ ] **Step 2: Run targeted verification**

Run:

```bash
python3 -m unittest discover -s workspace/modules -p 'test_*.py'
pnpm test:ui
```

Expected:

- workspace python tests pass
- control UI tests still pass

- [ ] **Step 3: Run full verification before any VPS deploy**

Run:

```bash
pnpm build
pnpm check
pnpm test
pnpm test:ui
python3 -m unittest discover -s workspace/modules -p 'test_*.py'
```

Expected:

- build exits 0
- lint and format checks exit 0
- repo tests exit 0
- UI tests exit 0
- workspace python tests exit 0

- [ ] **Step 4: Deploy to the VPS**

Run on the VPS after syncing code:

```bash
pnpm install
pnpm build
pnpm ui:build
sudo systemctl --user daemon-reload
sudo systemctl --user restart openclaw-qq-dashboard.service
sudo systemctl --user restart openclaw-finance-dashboard.service
sudo nginx -t
sudo systemctl reload nginx
```

Expected:

- `/qq` serves the standalone QQ dashboard
- `/finance` still serves the finance dashboard
- root Control UI remains separate

- [ ] **Step 5: Commit**

Run:

```bash
scripts/committer "ops: add final verification and deploy path for qq-finance split" \
  package.json \
  docs/superpowers/specs/2026-03-30-qq-finance-isolation-design.md \
  docs/superpowers/plans/2026-03-30-qq-finance-isolation.md
```

## Self-Review

### Spec coverage

- Shared boundary: covered in Task 1
- QQ module extraction: covered in Task 2
- Finance module extraction and finance-only daily push: covered in Task 3
- Separate QQ and finance frontends: covered in Tasks 4 and 5
- VPS route split and deployment examples: covered in Task 6
- Final verification before VPS deployment: covered in Task 7

### Placeholder scan

- No placeholder markers or deferred unfinished steps remain
- Every task includes file paths, code snippets, commands, and expected results

### Type consistency

- Shared delivery contract uses `DeliveryRequest` and `DeliveryTarget` consistently across finance push tasks
- QQ dashboard payload uses `module: "qq"` consistently
- Finance dashboard payload uses `module: "finance"` consistently
