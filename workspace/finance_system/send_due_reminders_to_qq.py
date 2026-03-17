#!/usr/bin/env python3
import argparse
import asyncio
import json
from datetime import timedelta

import schedule_reminder as sr
from qq_direct_utils import load_qq_ws_config, send_group_message

DEFAULT_GROUP_ID = 1061966199
QQ_REMINDER_MINUTES = 30
QQ_CONFIRM_POLL_INTERVAL_SECONDS = 1.5
QQ_CONFIRM_POLL_COUNT = 8
QQ_DUE_LOCK_FILE = sr.BASE_DIR / "schedule_qq_due.lock"
PUBLIC_TAG = "公事"
NO_DUE_TEXT = "当前没有到点提醒。"


def is_public_event(item: dict) -> bool:
    text = f"{item.get('title', '')} {item.get('notes', '')}"
    return PUBLIC_TAG in text


def collect_due_items(config: dict, state: dict):
    now_dt = sr.now_cn()
    last_check = sr.parse_iso_datetime(state.get("qq_last_reminder_check", ""))
    if last_check is None or last_check > now_dt:
        last_check = now_dt - timedelta(seconds=70)

    due_items = []
    seen = set()
    for offset in (0, 1):
        target_date = (now_dt + timedelta(days=offset)).date()
        for item in sr.get_schedule_for_date(config, target_date):
            kind = item.get("kind")
            if kind == "event" and not is_public_event(item):
                continue
            key = f"qq:{sr.reminder_key(item)}"
            if key in seen:
                continue
            seen.add(key)
            reminder_at = item["start_dt"] - timedelta(minutes=QQ_REMINDER_MINUTES)
            if reminder_at <= last_check or reminder_at > now_dt + timedelta(seconds=10):
                continue
            if key in state.get("sent_reminders", {}):
                continue
            due_items.append((item, reminder_at))

    due_items.sort(key=lambda row: row[1])
    return now_dt, due_items


def main() -> None:
    parser = argparse.ArgumentParser(description="Send schedule due reminders to QQ groups")
    parser.add_argument("--group-id", type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    with sr.runtime_lock(QQ_DUE_LOCK_FILE) as locked:
        if not locked:
            print(json.dumps({"ok": True, "skipped": "locked"}, ensure_ascii=False))
            return

        config = sr.load_config()
        state = sr.load_state()
        now_dt, due_items = collect_due_items(config, state)

        if args.dry_run:
            if not due_items:
                print(NO_DUE_TEXT)
                return
            for item, _ in due_items:
                item = dict(item)
                item["reminder_minutes"] = QQ_REMINDER_MINUTES
                print(sr.build_due_message(item))
                print("---")
            return

        if not due_items:
            state["qq_last_reminder_check"] = now_dt.isoformat()
            sr.prune_sent_reminders(state, now_dt)
            sr.save_json(sr.STATE_FILE, state)
            print(json.dumps({"ok": True, "sent": 0, "failed": 0}, ensure_ascii=False))
            return

        ws_url, token = load_qq_ws_config()
        sent = 0
        failed_reminder_at = []
        sent_at = now_dt.isoformat()
        for item, reminder_at in due_items:
            item = dict(item)
            item["reminder_minutes"] = QQ_REMINDER_MINUTES
            message = sr.build_due_message(item)
            result = asyncio.run(
                send_group_message(
                    ws_url,
                    token,
                    args.group_id,
                    message,
                    "qq-due",
                    attempts=1,
                    confirm_poll_interval_seconds=QQ_CONFIRM_POLL_INTERVAL_SECONDS,
                    confirm_poll_count=QQ_CONFIRM_POLL_COUNT,
                )
            )
            if result.get("status") != "ok":
                failed_reminder_at.append(reminder_at)
                print(json.dumps({"ok": False, "item": item["occurrence_id"], "error": result}, ensure_ascii=False))
                continue
            state.setdefault("sent_reminders", {})[f"qq:{sr.reminder_key(item)}"] = sent_at
            sr.prune_sent_reminders(state, now_dt)
            sr.save_json(sr.STATE_FILE, state)
            sent += 1

        next_check = min(failed_reminder_at) - timedelta(seconds=1) if failed_reminder_at else now_dt
        state["qq_last_reminder_check"] = next_check.isoformat()
        sr.prune_sent_reminders(state, now_dt)
        sr.save_json(sr.STATE_FILE, state)
        print(json.dumps({"ok": len(failed_reminder_at) == 0, "sent": sent, "failed": len(failed_reminder_at)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
