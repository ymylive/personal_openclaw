#!/usr/bin/env python3
import argparse
import asyncio
import json

import github_trending_digest as trending
import report_bot
from qq_direct_utils import load_qq_ws_config, send_group_message

DEFAULT_QQ_GROUP_IDS = [1016414937, 1061966199]
PREFIX = "【9点 GitHub 热榜】"
NL = chr(10)


def build_message(limit: int, since: str) -> str:
    digest = trending.build_digest(trending.fetch_trending(limit=limit, since=since), since=since)
    if digest.startswith("【GitHub 热榜日报】"):
        lines = digest.splitlines()
        lines[0] = lines[0].replace("【GitHub 热榜日报】", PREFIX, 1)
        return NL.join(lines)
    return f"{PREFIX}{NL}{digest}"


def main() -> int:
    parser = argparse.ArgumentParser(description='?? GitHub ??? Telegram ? QQ ???')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--since', choices=['daily', 'weekly', 'monthly'], default='daily')
    parser.add_argument('--group-id', dest='group_ids', action='append', type=int)
    parser.add_argument('--telegram-chat-id', default='')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    qq_group_ids = args.group_ids or list(DEFAULT_QQ_GROUP_IDS)
    message = build_message(args.limit, args.since)

    if args.dry_run:
        print(message)
        print(json.dumps({'ok': True, 'qq_groups': qq_group_ids}, ensure_ascii=False))
        return 0

    tg_token, tg_chat_id = report_bot.get_telegram_target({}, override_chat_id=args.telegram_chat_id)
    tg_result = report_bot.send_telegram(tg_token, tg_chat_id, message)

    ws_url, token = load_qq_ws_config()
    qq_results = []
    for group_id in qq_group_ids:
        result = asyncio.run(send_group_message(ws_url, token, group_id, message, f'github-trending-{group_id}'))
        qq_results.append({'group_id': group_id, 'result': result})

    ok = bool(tg_result.get('ok')) and all((item['result'] or {}).get('status') == 'ok' for item in qq_results)
    print(json.dumps({'ok': ok, 'telegram': tg_result, 'qq': qq_results}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
