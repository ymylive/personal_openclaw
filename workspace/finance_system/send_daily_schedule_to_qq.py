#!/usr/bin/env python3
import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

script_dir = Path(__file__).resolve().parent
workspace_root = script_dir.parent
project_root = workspace_root.parent
for candidate in (workspace_root, project_root):
    candidate_path = str(candidate)
    if candidate_path not in sys.path:
        sys.path.insert(0, candidate_path)

from workspace.modules.finance.push import orchestrate_daily_schedule_push
from workspace.modules.finance.reports import load_schedule_from_schedule_cli

SCHEDULE_CLI = Path("/home/node/.openclaw/workspace/finance_system/schedule_reminder.py")
DEFAULT_GROUP_ID = 1061966199  # 258班学习交流群
TZ = ZoneInfo("Asia/Shanghai")



def main() -> None:
    parser = argparse.ArgumentParser(description='发送今日课表到QQ班群')
    parser.add_argument('--date', default=datetime.now(TZ).strftime('%Y-%m-%d'))
    parser.add_argument('--group-id', type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument("--schedule-cli", default=str(SCHEDULE_CLI))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    def schedule_fetcher(date_text: str) -> dict:
        return load_schedule_from_schedule_cli(
            schedule_cli_path=Path(args.schedule_cli),
            date_text=date_text,
        )

    if args.dry_run:
        print(
            orchestrate_daily_schedule_push(
                group_id=args.group_id,
                date_text=args.date,
                dry_run=True,
                schedule_fetcher=schedule_fetcher,
                deliver=lambda _request: {"status": "dry-run"},
            )
        )
        return

    from qq_direct_utils import load_qq_ws_config, send_group_message

    ws_url, token = load_qq_ws_config()
    result = orchestrate_daily_schedule_push(
        group_id=args.group_id,
        date_text=args.date,
        dry_run=False,
        schedule_fetcher=schedule_fetcher,
        deliver=lambda request: asyncio.run(
            send_group_message(ws_url, token, args.group_id, request.body, 'daily-schedule')
        ),
    )
    if not result.get("ok"):
        raise RuntimeError(f"发送失败: {json.dumps(result, ensure_ascii=False)}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
