from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta
import unittest
from zoneinfo import ZoneInfo

from workspace.modules.finance.push import build_finance_push_request
from workspace.modules.finance.push import (
    orchestrate_class_news_digest_push,
    orchestrate_daily_schedule_push,
    orchestrate_due_reminders_push,
    orchestrate_morning_news_push,
)


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

    def test_orchestrate_morning_news_push_dry_run_skips_delivery(self) -> None:
        calls: list[str] = []

        def report_provider() -> str:
            calls.append("report")
            return "【24小时重大新闻】\n1) Foo"

        def deliver(_request) -> dict:
            calls.append("deliver")
            return {"status": "ok"}

        result = orchestrate_morning_news_push(
            group_id=1061966199,
            dry_run=True,
            report_provider=report_provider,
            deliver=deliver,
        )
        self.assertIsInstance(result, str)
        self.assertIn("【24小时重大新闻】", result)
        self.assertIn("【简要分析】", result)
        self.assertEqual(calls, ["report"])

    def test_orchestrate_morning_news_push_delivers_delivery_request(self) -> None:
        delivered = []

        def report_provider() -> str:
            return "【24小时重大新闻】\n1) Foo"

        def deliver(request) -> dict:
            delivered.append(request)
            return {"status": "ok", "retcode": 0}

        result = orchestrate_morning_news_push(
            group_id=123,
            dry_run=False,
            report_provider=report_provider,
            deliver=deliver,
        )
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["group_id"], 123)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0].job_name, "morning-news")
        self.assertEqual(delivered[0].targets[0].recipient, "123")
        self.assertIn("【简要分析】", delivered[0].body)

    def test_orchestrate_daily_schedule_push_dry_run_returns_message(self) -> None:
        calls: list[str] = []

        def schedule_fetcher(date_text: str) -> dict:
            calls.append(f"fetch:{date_text}")
            return {"items": []}

        def deliver(_request) -> dict:
            calls.append("deliver")
            return {"status": "ok"}

        result = orchestrate_daily_schedule_push(
            group_id=1,
            date_text="2026-03-30",
            dry_run=True,
            schedule_fetcher=schedule_fetcher,
            deliver=deliver,
        )
        self.assertIsInstance(result, str)
        self.assertIn("2026-03-30", result)
        self.assertEqual(calls, ["fetch:2026-03-30"])

    def test_orchestrate_class_news_digest_push_uses_fixed_now_dt(self) -> None:
        delivered = []
        tz = ZoneInfo("Asia/Shanghai")
        now_dt = datetime(2026, 3, 30, 8, 30, tzinfo=tz)

        def news_fetcher():
            return [{"title": "国务院召开会议部署改革", "published": "03-30 08:00", "link": "x"}]

        def deliver(request) -> dict:
            delivered.append(request)
            return {"status": "ok"}

        result = orchestrate_class_news_digest_push(
            group_id=999,
            dry_run=False,
            news_fetcher=news_fetcher,
            deliver=deliver,
            now_dt=now_dt,
        )
        self.assertEqual(result["ok"], True)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0].job_name, "class-news-digest")
        self.assertIn("2026-03-30 08:30", delivered[0].body)

    def test_orchestrate_due_reminders_push_returns_locked_skip(self) -> None:
        calls: list[str] = []

        @contextmanager
        def runtime_lock(_path):
            calls.append("lock")
            yield False

        result = orchestrate_due_reminders_push(
            group_id=1061966199,
            dry_run=False,
            reminder_minutes=30,
            runtime_lock=runtime_lock,
            lock_path="ignored",
            load_config=lambda: calls.append("config"),
            load_state=lambda: calls.append("state"),
            save_state=lambda _state: calls.append("save"),
            prune_sent_reminders=lambda _state, _now: calls.append("prune"),
            now=lambda: datetime.now(ZoneInfo("Asia/Shanghai")),
            parse_iso_datetime=lambda _value: None,
            get_items_for_date=lambda _config, _date: [],
            build_due_message=lambda _item: "msg",
            deliver=lambda _request: {"status": "ok"},
        )
        self.assertEqual(result, {"ok": True, "skipped": "locked"})
        self.assertEqual(calls, ["lock"])

    def test_orchestrate_due_reminders_push_dry_run_with_no_due_items(self) -> None:
        tz = ZoneInfo("Asia/Shanghai")
        now_dt = datetime(2026, 3, 30, 10, 0, tzinfo=tz)
        saved: list[dict] = []

        @contextmanager
        def runtime_lock(_path):
            yield True

        result = orchestrate_due_reminders_push(
            group_id=1061966199,
            dry_run=True,
            reminder_minutes=30,
            runtime_lock=runtime_lock,
            lock_path="ignored",
            load_config=lambda: {},
            load_state=lambda: {"qq_last_reminder_check": (now_dt - timedelta(minutes=5)).isoformat()},
            save_state=lambda state: saved.append(dict(state)),
            prune_sent_reminders=lambda _state, _now: None,
            now=lambda: now_dt,
            parse_iso_datetime=lambda value: datetime.fromisoformat(value) if value else None,
            get_items_for_date=lambda _config, _date: [],
            build_due_message=lambda _item: "msg",
            deliver=lambda _request: {"status": "ok"},
            no_due_text="NO_DUE",
        )
        self.assertEqual(result, "NO_DUE")
        self.assertEqual(saved, [])

    def test_orchestrate_due_reminders_push_sends_and_updates_state(self) -> None:
        tz = ZoneInfo("Asia/Shanghai")
        now_dt = datetime(2026, 3, 30, 10, 0, tzinfo=tz)
        state = {"qq_last_reminder_check": (now_dt - timedelta(minutes=5)).isoformat(), "sent_reminders": {}}
        saved: list[dict] = []
        delivered = []

        @contextmanager
        def runtime_lock(_path):
            yield True

        def build_due_message(item: dict) -> str:
            return f"DUE:{item['occurrence_id']}:{item['reminder_minutes']}"

        def deliver(request) -> dict:
            delivered.append(request)
            return {"status": "ok"}

        due_item = {
            "kind": "class",
            "occurrence_id": "class:c1:2026-03-30:10:25",
            "title": "高等数学",
            "notes": "",
            "start_dt": now_dt + timedelta(minutes=30) - timedelta(seconds=1),
        }

        result = orchestrate_due_reminders_push(
            group_id=1061966199,
            dry_run=False,
            reminder_minutes=30,
            runtime_lock=runtime_lock,
            lock_path="ignored",
            load_config=lambda: {},
            load_state=lambda: state,
            save_state=lambda new_state: saved.append(dict(new_state)),
            prune_sent_reminders=lambda _state, _now: None,
            now=lambda: now_dt,
            parse_iso_datetime=lambda value: datetime.fromisoformat(value) if value else None,
            get_items_for_date=lambda _config, _date: [due_item],
            build_due_message=build_due_message,
            deliver=deliver,
        )
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["sent"], 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0].job_name, "due-reminder")
        self.assertIn("DUE:class:c1", delivered[0].body)
        self.assertGreaterEqual(len(saved), 1)
        self.assertIn("qq:class:c1:2026-03-30:10:25:30", saved[-1]["sent_reminders"])


if __name__ == "__main__":
    unittest.main()
