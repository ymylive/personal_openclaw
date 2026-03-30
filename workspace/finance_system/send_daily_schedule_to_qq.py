#!/usr/bin/env python3
import argparse
import asyncio
import json
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from qq_direct_utils import load_qq_ws_config, send_group_message
from workspace.modules.finance.push import build_finance_push_request

__all__ = ["build_finance_push_request"]

SCHEDULE_CLI = Path('/home/node/.openclaw/workspace/finance_system/schedule_reminder.py')
DEFAULT_GROUP_ID = 1061966199  # 258班学习交流群
TZ = ZoneInfo('Asia/Shanghai')



def fetch_schedule(date_text: str) -> dict:
    cmd = ['python3', str(SCHEDULE_CLI), 'list', '--date', date_text]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f'读取课表失败: {result.stderr or result.stdout}')
    try:
        return json.loads(result.stdout)
    except Exception as exc:
        raise RuntimeError(f'课表输出不是有效 JSON: {exc}')


def build_message(schedule: dict, date_text: str) -> str:
    items = schedule.get('items') or []
    classes = [i for i in items if i.get('kind') == 'class']
    events = [i for i in items if i.get('kind') == 'event']

    public_events = []
    normal_events = []
    for event in events:
        text = f"{event.get('title', '')} {event.get('notes', '')}".lower()
        if '公事' in text:
            public_events.append(event)
        else:
            normal_events.append(event)

    lines = [f'【今日课表日程总结｜{date_text}】']

    if not items:
        lines.append('今天没有课程或已登记日程。')
        return '\n'.join(lines)

    idx = 1
    if classes:
        lines.append('')
        lines.append('📚 课程安排')
        for c in classes:
            lines.append(f"{idx}) {c.get('start_time','??')}-{c.get('end_time','??')} {c.get('title','未命名课程')}")
            if c.get('location'):
                lines.append(f"   📍{c['location']}")
            idx += 1

    if public_events:
        lines.append('')
        lines.append('💼 公事日程（已并入推送）')
        for e in public_events:
            lines.append(f"{idx}) {e.get('start_time','??')}-{e.get('end_time','??')} {e.get('title','未命名日程')}（公事）")
            if e.get('location'):
                lines.append(f"   📍{e['location']}")
            if e.get('notes'):
                lines.append(f"   📝{e['notes']}")
            idx += 1

    lines.append('')
    lines.append(f"✅ 本群推送共 {len(classes) + len(public_events)} 项（课程 {len(classes)} 项，公事 {len(public_events)} 项）。")
    if normal_events:
        lines.append('🔒 未标注“公事”的私人日程已自动排除，不会发送到班级群。')
    return '\n'.join(lines)



def main() -> None:
    parser = argparse.ArgumentParser(description='发送今日课表到QQ班群')
    parser.add_argument('--date', default=datetime.now(TZ).strftime('%Y-%m-%d'))
    parser.add_argument('--group-id', type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    schedule = fetch_schedule(args.date)
    message = build_message(schedule, args.date)

    if args.dry_run:
        print(message)
        return

    ws_url, token = load_qq_ws_config()
    result = asyncio.run(send_group_message(ws_url, token, args.group_id, message, 'daily-schedule'))
    if result.get('status') != 'ok':
        raise RuntimeError(f"发送失败: {json.dumps(result, ensure_ascii=False)}")
    print(json.dumps({'ok': True, 'group_id': args.group_id, 'date': args.date, 'result': result}, ensure_ascii=False))


if __name__ == '__main__':
    main()
