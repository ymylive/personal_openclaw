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

from workspace.modules.finance.push import orchestrate_class_news_digest_push
from workspace.modules.finance.reports import fetch_class_news_from_rss

DEFAULT_GROUP_ID = 1061966199  # 258班学习交流群
RSS_URL = "https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans"
LOOKBACK_HOURS = 24
MAX_ITEMS = 8

def main() -> None:
    parser = argparse.ArgumentParser(description='发送班级群24小时新闻与重大事件简报')
    parser.add_argument('--group-id', type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument("--rss-url", default=RSS_URL)
    parser.add_argument("--lookback-hours", type=int, default=LOOKBACK_HOURS)
    parser.add_argument("--max-items", type=int, default=MAX_ITEMS)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    def news_fetcher():
        return fetch_class_news_from_rss(
            rss_url=args.rss_url,
            lookback_hours=args.lookback_hours,
            max_items=args.max_items,
        )

    if args.dry_run:
        print(
            orchestrate_class_news_digest_push(
                group_id=args.group_id,
                dry_run=True,
                news_fetcher=news_fetcher,
                deliver=lambda _request: {"status": "dry-run"},
            )
        )
        return

    from qq_direct_utils import load_qq_ws_config, send_group_message

    ws_url, token = load_qq_ws_config()
    result = orchestrate_class_news_digest_push(
        group_id=args.group_id,
        dry_run=False,
        news_fetcher=news_fetcher,
        deliver=lambda request: asyncio.run(
            send_group_message(ws_url, token, args.group_id, request.body, 'class-news')
        ),
    )
    if not result.get("ok"):
        raise RuntimeError(f'发送失败: {json.dumps(result, ensure_ascii=False)}')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
