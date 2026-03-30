from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo

from workspace.modules.finance.reports import (
    build_class_news_digest_message,
    build_daily_schedule_message,
    build_morning_analysis,
    build_morning_news_message,
    build_public_due_reminder_message,
    classify_class_news_topics,
    collect_public_due_items,
    prepare_class_news_digest_message_from_rss,
    prepare_daily_schedule_message_from_schedule_cli,
    prepare_morning_news_message_from_report_bot,
)


class FinanceReportsTest(unittest.TestCase):
    def test_build_morning_analysis_mentions_finance_only_context(self) -> None:
        text = build_morning_analysis("CPI and Fed remain market focus")
        self.assertIn("金融", text)
        self.assertNotIn("QQ", text)
        self.assertIn("【简要分析】", text)
        self.assertNotIn("CPI", text)

    def test_build_morning_news_message_combines_report_and_analysis(self) -> None:
        report = "【24小时重大新闻】\n1) Foo"
        message = build_morning_news_message(report)
        self.assertIn(report, message)
        self.assertIn("【简要分析】", message)
        self.assertTrue(message.startswith("【24小时重大新闻】"))

    def test_build_daily_schedule_message_filters_private_events(self) -> None:
        schedule = {
            "items": [
                {
                    "kind": "class",
                    "title": "概率论",
                    "start_time": "08:00",
                    "end_time": "09:40",
                    "location": "A101",
                },
                {
                    "kind": "event",
                    "title": "去医院复诊",
                    "notes": "",
                    "start_time": "10:00",
                    "end_time": "11:00",
                },
                {
                    "kind": "event",
                    "title": "部门会议（公事）",
                    "notes": "同步OKR 公事",
                    "start_time": "14:00",
                    "end_time": "15:00",
                },
            ]
        }
        message = build_daily_schedule_message(schedule, "2026-03-30")
        self.assertIn("概率论", message)
        self.assertIn("部门会议", message)
        self.assertNotIn("去医院复诊", message)
        self.assertIn("私人日程", message)

    def test_build_daily_schedule_message_handles_empty_items(self) -> None:
        message = build_daily_schedule_message({"items": []}, "2026-03-30")
        self.assertIn("今天没有课程或已登记日程", message)

    def test_classify_class_news_topics_counts(self) -> None:
        news = [
            {"title": "国务院召开会议部署改革", "published": "03-30 08:00", "link": "x"},
            {"title": "AI芯片与高校科研合作升级", "published": "03-30 09:00", "link": "y"},
            {"title": "就业与医疗保障新进展", "published": "03-30 10:00", "link": "z"},
            {"title": "国际局势持续紧张", "published": "03-30 11:00", "link": "w"},
        ]
        buckets = classify_class_news_topics(news)
        self.assertEqual(buckets["政策治理"], 1)
        self.assertEqual(buckets["科技教育"], 1)
        self.assertEqual(buckets["社会民生"], 1)
        self.assertEqual(buckets["国际局势"], 1)

    def test_build_class_news_digest_message_mentions_top_topics(self) -> None:
        tz = ZoneInfo("Asia/Shanghai")
        now_dt = datetime(2026, 3, 30, 8, 30, tzinfo=tz)
        news = [
            {"title": "国务院会议研究改革政策", "published": "03-30 08:00", "link": "x"},
            {"title": "政策治理继续推进法治建设", "published": "03-30 08:10", "link": "y"},
            {"title": "AI与教育融合加速", "published": "03-30 08:20", "link": "z"},
        ]
        message = build_class_news_digest_message(news, now_dt=now_dt)
        self.assertIn("【24小时新闻与重大事件简报｜2026-03-30 08:30】", message)
        self.assertIn("📰 过去24小时重点新闻", message)
        self.assertIn("信息重心：政策治理、科技教育", message)

    def test_collect_public_due_items_selects_due_and_public_only(self) -> None:
        tz = ZoneInfo("Asia/Shanghai")
        now_dt = datetime(2026, 3, 30, 10, 0, tzinfo=tz)
        last_check = now_dt - timedelta(minutes=15)

        class_item = {
            "kind": "class",
            "occurrence_id": "class:c1:2026-03-30:10:25",
            "title": "高等数学",
            "notes": "",
            "start_dt": now_dt + timedelta(minutes=25),
        }
        private_event = {
            "kind": "event",
            "occurrence_id": "event:e1:2026-03-30:10:25",
            "title": "去医院复诊",
            "notes": "",
            "start_dt": now_dt + timedelta(minutes=25),
        }
        public_event = {
            "kind": "event",
            "occurrence_id": "event:e2:2026-03-30:10:25",
            "title": "部门会议",
            "notes": "公事 同步OKR",
            "start_dt": now_dt + timedelta(minutes=25),
        }
        future_item = {
            "kind": "class",
            "occurrence_id": "class:c2:2026-03-30:10:40",
            "title": "线性代数",
            "notes": "",
            "start_dt": now_dt + timedelta(minutes=40),
        }

        items_by_date = {now_dt.date(): [class_item, private_event, public_event, future_item]}

        def get_items_for_date(target_date):
            return items_by_date.get(target_date, [])

        # Mark the public_event as already sent.
        sent_key = "qq:event:e2:2026-03-30:10:25:30"
        sent_reminders = {sent_key: now_dt.isoformat()}

        _, due_items = collect_public_due_items(
            now_dt=now_dt,
            last_check=last_check,
            sent_reminders=sent_reminders,
            reminder_minutes=30,
            get_items_for_date=get_items_for_date,
        )
        titles = [row[0]["title"] for row in due_items]
        self.assertIn("高等数学", titles)
        self.assertNotIn("去医院复诊", titles)
        self.assertNotIn("部门会议", titles)
        self.assertNotIn("线性代数", titles)

    def test_collect_public_due_items_normalizes_future_last_check(self) -> None:
        tz = ZoneInfo("Asia/Shanghai")
        now_dt = datetime(2026, 3, 30, 10, 0, tzinfo=tz)
        last_check = now_dt + timedelta(hours=1)
        item = {
            "kind": "class",
            "occurrence_id": "class:c1:2026-03-30:10:25",
            "title": "高等数学",
            "notes": "",
            # Make reminder_at land within the default 70s backfill window:
            # reminder_at = start_dt - reminder_minutes ~= now_dt - 20s
            "start_dt": now_dt + timedelta(minutes=30) - timedelta(seconds=20),
        }

        def get_items_for_date(_):
            return [item]

        _, due_items = collect_public_due_items(
            now_dt=now_dt,
            last_check=last_check,
            sent_reminders={},
            reminder_minutes=30,
            get_items_for_date=get_items_for_date,
        )
        self.assertEqual(len(due_items), 1)

    def test_prepare_morning_news_message_from_report_bot_runs_report_bot(self) -> None:
        class DummyResult:
            def __init__(self, returncode: int, stdout: str, stderr: str = "") -> None:
                self.returncode = returncode
                self.stdout = stdout
                self.stderr = stderr

        calls = []

        def runner(cmd, *, capture_output: bool, text: bool, check: bool, timeout: int | None = None):
            calls.append(cmd)
            self.assertTrue(capture_output)
            self.assertTrue(text)
            self.assertFalse(check)
            return DummyResult(0, "【24小时重大新闻】\n1) Foo\n")

        report_bot_path = Path("/tmp/report_bot.py")
        message = prepare_morning_news_message_from_report_bot(report_bot_path=report_bot_path, runner=runner)
        self.assertIn("【24小时重大新闻】", message)
        self.assertIn("【简要分析】", message)
        self.assertTrue(calls)
        self.assertEqual(calls[0][0], "python3")
        self.assertEqual(calls[0][1], str(report_bot_path))
        self.assertIn("--mode", calls[0])
        self.assertIn("news", calls[0])
        self.assertIn("--dry-run", calls[0])

    def test_prepare_daily_schedule_message_from_schedule_cli_fetches_and_formats(self) -> None:
        class DummyResult:
            def __init__(self, returncode: int, stdout: str, stderr: str = "") -> None:
                self.returncode = returncode
                self.stdout = stdout
                self.stderr = stderr

        date_text = "2026-03-30"
        schedule_payload = {
            "date": date_text,
            "count": 3,
            "items": [
                {"kind": "class", "title": "概率论", "start_time": "08:00", "end_time": "09:40"},
                {"kind": "event", "title": "去医院复诊", "notes": "", "start_time": "10:00", "end_time": "11:00"},
                {"kind": "event", "title": "部门会议（公事）", "notes": "同步OKR 公事", "start_time": "14:00", "end_time": "15:00"},
            ],
        }

        calls = []

        def runner(cmd, *, capture_output: bool, text: bool, check: bool, timeout: int | None = None):
            calls.append(cmd)
            return DummyResult(0, json.dumps(schedule_payload, ensure_ascii=False))

        schedule_cli_path = Path("/tmp/schedule_reminder.py")
        message = prepare_daily_schedule_message_from_schedule_cli(
            schedule_cli_path=schedule_cli_path,
            date_text=date_text,
            runner=runner,
        )
        self.assertIn(f"【今日课表日程总结｜{date_text}】", message)
        self.assertIn("概率论", message)
        self.assertIn("部门会议", message)
        self.assertNotIn("去医院复诊", message)
        self.assertTrue(calls)
        self.assertEqual(calls[0][:2], ["python3", str(schedule_cli_path)])
        self.assertIn("list", calls[0])
        self.assertIn("--date", calls[0])

    def test_prepare_class_news_digest_message_from_rss_filters_by_lookback(self) -> None:
        now_dt = datetime(2026, 3, 30, 1, 0, tzinfo=timezone.utc)
        xml_text = """<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>Google News</title>
    <item>
      <title>Too Old</title>
      <link>https://example.com/old</link>
      <pubDate>Sun, 29 Mar 2026 00:59:00 GMT</pubDate>
    </item>
    <item>
      <title>In Window</title>
      <link>https://example.com/new</link>
      <pubDate>Sun, 29 Mar 2026 01:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
"""

        def fetch_text(url: str, *, timeout_seconds: int) -> str:
            self.assertIn("example", url)
            self.assertGreater(timeout_seconds, 0)
            return xml_text

        message = prepare_class_news_digest_message_from_rss(
            rss_url="https://example.com/rss",
            now_dt=now_dt,
            lookback_hours=24,
            max_items=8,
            fetch_text=fetch_text,
        )
        self.assertIn("【24小时新闻与重大事件简报｜2026-03-30 09:00】", message)
        self.assertIn("In Window", message)
        self.assertNotIn("Too Old", message)
        self.assertIn("[03-29 09:00]", message)

    def test_build_public_due_reminder_message_formats(self) -> None:
        item = {
            "kind": "class",
            "title": "高等数学",
            "date": "2026-03-30",
            "start_time": "10:30",
            "end_time": "12:00",
            "location": "A101",
            "teacher": "张老师",
            "notes": "带作业",
        }
        message = build_public_due_reminder_message(item, reminder_minutes=30)
        self.assertIn("【龙虾课程提醒】", message)
        self.assertIn("还有 30 分钟：高等数学", message)
        self.assertIn("时间：2026-03-30 10:30-12:00", message)
        self.assertIn("地点：A101", message)
        self.assertIn("老师：张老师", message)
        self.assertIn("备注：带作业", message)


if __name__ == "__main__":
    unittest.main()
