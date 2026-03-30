#!/usr/bin/env python3
import argparse
import asyncio
import json
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import List, Dict
from xml.etree import ElementTree as ET

import requests
from qq_direct_utils import load_qq_ws_config, send_group_message
from workspace.modules.finance.push import build_finance_push_request
from zoneinfo import ZoneInfo

__all__ = ["build_finance_push_request"]

DEFAULT_GROUP_ID = 1061966199  # 258班学习交流群
TZ = ZoneInfo('Asia/Shanghai')
RSS_URL = 'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
LOOKBACK_HOURS = 24
MAX_ITEMS = 8



def fetch_recent_news() -> List[Dict[str, str]]:
    resp = requests.get(RSS_URL, timeout=20)
    resp.raise_for_status()
    root = ET.fromstring(resp.text)
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=LOOKBACK_HOURS)

    items: List[Dict[str, str]] = []
    for item in root.findall('./channel/item'):
        title = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        pub = (item.findtext('pubDate') or '').strip()
        if not title or not link or not pub:
            continue
        try:
            dt = parsedate_to_datetime(pub).astimezone(timezone.utc)
        except Exception:
            continue
        if dt < cutoff:
            continue
        items.append({
            'title': title,
            'link': link,
            'published': dt.astimezone(TZ).strftime('%m-%d %H:%M'),
        })
        if len(items) >= MAX_ITEMS:
            break
    return items


def classify_topics(news: List[Dict[str, str]]) -> Dict[str, int]:
    buckets = {'政策治理': 0, '科技教育': 0, '社会民生': 0, '国际局势': 0}
    for n in news:
        t = n['title']
        if any(k in t for k in ['国务院', '政策', '会议', '改革', '法治', '治理']):
            buckets['政策治理'] += 1
        elif any(k in t for k in ['AI', '人工智能', '芯片', '高校', '教育', '科研', '科技']):
            buckets['科技教育'] += 1
        elif any(k in t for k in ['就业', '医疗', '住房', '交通', '校园', '安全', '民生']):
            buckets['社会民生'] += 1
        else:
            buckets['国际局势'] += 1
    return buckets


def build_message(news: List[Dict[str, str]]) -> str:
    date_text = datetime.now(TZ).strftime('%Y-%m-%d %H:%M')
    lines = [f'【24小时新闻与重大事件简报｜{date_text}】', '（班级群通用版：偏综合时事，不含个人金融分析）', '']

    if not news:
        lines.append('过去24小时未抓取到足够的新资讯，建议稍后重试。')
        return '\n'.join(lines)

    lines.append('📰 过去24小时重点新闻')
    for i, n in enumerate(news, 1):
        lines.append(f'{i}) [{n["published"]}] {n["title"]}')

    topic_count = classify_topics(news)
    top_topics = sorted(topic_count.items(), key=lambda x: x[1], reverse=True)

    lines.extend([
        '',
        '🔎 简要分析（班级讨论版）',
        f'- 信息重心：{top_topics[0][0]}、{top_topics[1][0]}话题出现较多，说明舆论关注点偏向公共事务与现实影响。',
        '- 对同学们的启发：关注“政策变化—行业趋势—就业/升学机会”的传导链，形成长期信息敏感度。',
        '- 讨论建议：可围绕“这类事件对大学生学习/就业有什么实际影响”展开，避免只停留在标题层面。',
        '',
        '📌 今日建议关注',
        '- 是否有与高校、就业、科技创新、社会治理直接相关的后续政策/通报；',
        '- 同一事件在不同媒体叙事中的差异，训练信息辨别能力。',
    ])
    return '\n'.join(lines)



def main() -> None:
    parser = argparse.ArgumentParser(description='发送班级群24小时新闻与重大事件简报')
    parser.add_argument('--group-id', type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    news = fetch_recent_news()
    message = build_message(news)

    if args.dry_run:
        print(message)
        return

    ws_url, token = load_qq_ws_config()
    result = asyncio.run(send_group_message(ws_url, token, args.group_id, message, 'class-news'))
    if result.get('status') != 'ok':
        raise RuntimeError(f'发送失败: {json.dumps(result, ensure_ascii=False)}')
    print(json.dumps({'ok': True, 'group_id': args.group_id, 'result': result}, ensure_ascii=False))


if __name__ == '__main__':
    main()
