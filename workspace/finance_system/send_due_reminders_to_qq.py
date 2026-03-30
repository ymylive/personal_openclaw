#!/usr/bin/env python3
import argparse
import json
import sys

import schedule_reminder as sr
from pathlib import Path

script_path = Path(__file__).resolve().parent
workspace_root = script_path.parent
project_root = workspace_root.parent
for candidate in (workspace_root, project_root):
    candidate_path = str(candidate)
    if candidate_path not in sys.path:
        sys.path.insert(0, candidate_path)

from workspace.modules.finance.push import orchestrate_due_reminders_push
from workspace.modules.finance.reports import build_public_due_reminder_message

DEFAULT_GROUP_ID = 1061966199
QQ_REMINDER_MINUTES = 30
QQ_CONFIRM_POLL_INTERVAL_SECONDS = 1.5
QQ_CONFIRM_POLL_COUNT = 8
QQ_DUE_LOCK_FILE = sr.BASE_DIR / "schedule_qq_due.lock"
NO_DUE_TEXT = "当前没有到点提醒。"


def main() -> None:
    parser = argparse.ArgumentParser(description="Send schedule due reminders to QQ groups")
    parser.add_argument("--group-id", type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    def build_due_message(item: dict) -> str:
        return build_public_due_reminder_message(item, reminder_minutes=int(item["reminder_minutes"]))

    if args.dry_run:
        deliver = lambda _request: {"status": "dry-run"}
    else:
        import asyncio
        from qq_direct_utils import load_qq_ws_config, send_group_message

        ws_cache: dict[str, str] = {}

        def deliver(request) -> dict:
            if not ws_cache:
                ws_url, token = load_qq_ws_config()
                ws_cache["ws_url"] = ws_url
                ws_cache["token"] = token
            target = request.targets[0] if request.targets else None
            group_id = int(target.recipient) if target and target.recipient else args.group_id
            return asyncio.run(
                send_group_message(
                    ws_cache["ws_url"],
                    ws_cache["token"],
                    group_id,
                    request.body,
                    "qq-due",
                    attempts=1,
                    confirm_poll_interval_seconds=QQ_CONFIRM_POLL_INTERVAL_SECONDS,
                    confirm_poll_count=QQ_CONFIRM_POLL_COUNT,
                )
            )

    result = orchestrate_due_reminders_push(
        group_id=args.group_id,
        dry_run=args.dry_run,
        reminder_minutes=QQ_REMINDER_MINUTES,
        runtime_lock=sr.runtime_lock,
        lock_path=QQ_DUE_LOCK_FILE,
        load_config=sr.load_config,
        load_state=sr.load_state,
        save_state=lambda state: sr.save_json(sr.STATE_FILE, state),
        prune_sent_reminders=sr.prune_sent_reminders,
        now=sr.now_cn,
        parse_iso_datetime=sr.parse_iso_datetime,
        get_items_for_date=lambda config, target_date: sr.get_schedule_for_date(config, target_date),
        build_due_message=build_due_message,
        deliver=deliver,
        no_due_text=NO_DUE_TEXT,
    )
    if isinstance(result, str):
        print(result)
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
