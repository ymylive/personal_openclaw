#!/usr/bin/env python3
import argparse
import asyncio
import json
import sys
from pathlib import Path

script_dir = Path(__file__).resolve().parent
workspace_root = script_dir.parent
project_root = workspace_root.parent
for candidate in (workspace_root, project_root):
    candidate_path = str(candidate)
    if candidate_path not in sys.path:
        sys.path.insert(0, candidate_path)

from workspace.modules.finance.push import orchestrate_morning_news_push
from workspace.modules.finance.reports import load_morning_report_from_report_bot

REPORT_BOT = Path("/home/node/.openclaw/workspace/finance_system/report_bot.py")
DEFAULT_GROUP_ID = 1061966199  # 258班学习交流群

def main() -> None:
    parser = argparse.ArgumentParser(description='发送早间24小时新闻与分析到QQ班群')
    parser.add_argument('--group-id', type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument("--report-bot", default=str(REPORT_BOT))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    def report_provider() -> str:
        return load_morning_report_from_report_bot(report_bot_path=Path(args.report_bot))

    if args.dry_run:
        print(
            orchestrate_morning_news_push(
                group_id=args.group_id,
                dry_run=True,
                report_provider=report_provider,
                deliver=lambda _request: {"status": "dry-run"},
            )
        )
        return

    from qq_direct_utils import load_qq_ws_config, send_group_message

    ws_url, token = load_qq_ws_config()
    result = orchestrate_morning_news_push(
        group_id=args.group_id,
        dry_run=False,
        report_provider=report_provider,
        deliver=lambda request: asyncio.run(
            send_group_message(ws_url, token, args.group_id, request.body, "morning-news")
        ),
    )
    if not result.get("ok"):
        raise RuntimeError(f"发送失败: {json.dumps(result, ensure_ascii=False)}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
