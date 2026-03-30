#!/usr/bin/env python3
import argparse
import asyncio
import json
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from workspace.modules.finance.push import build_finance_push_request
from workspace.modules.finance.reports import build_morning_analysis

__all__ = ["build_finance_push_request", "build_morning_analysis"]

import websockets

CONFIG_PATH = Path('/home/node/.openclaw/openclaw.json')
REPORT_BOT = Path('/home/node/.openclaw/workspace/finance_system/report_bot.py')
DEFAULT_GROUP_ID = 1061966199  # 258班学习交流群
TZ = ZoneInfo('Asia/Shanghai')


def load_qq_ws_config() -> tuple[str, str]:
    cfg = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
    qq = ((cfg.get('channels') or {}).get('qq') or {})
    ws_url = qq.get('wsUrl')
    token = qq.get('accessToken') or ''
    if not ws_url:
        raise RuntimeError('QQ wsUrl 未配置')
    return ws_url, token


def run_news_report() -> str:
    cmd = ['python3', str(REPORT_BOT), '--mode', 'news', '--dry-run']
    p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if p.returncode != 0:
        raise RuntimeError(f'新闻总结生成失败: {p.stderr or p.stdout}')
    text = (p.stdout or '').strip()
    if not text:
        raise RuntimeError('新闻总结为空')
    return text


def build_analysis(report_text: str) -> str:
    low = report_text.lower()
    lines = [
        '',
        '【简要分析】',
        '影响链路：宏观数据/地缘事件 → 利率预期与风险偏好 → 股债汇与大宗联动。',
    ]

    if any(k in low for k in ['cpi', 'ppi', '通胀', 'inflation']):
        lines.append('- 通胀数据是当前定价核心，若持续走高，利率下调预期可能后移，成长板块波动会放大。')
    if any(k in low for k in ['oil', '原油', '中东', 'opec']):
        lines.append('- 能源价格与地缘冲突抬升输入型通胀风险，关注航运、化工与高能耗行业成本压力。')
    if any(k in low for k in ['fed', '美联储', 'yield', '利率']):
        lines.append('- 美联储路径仍是全球资产锚，需关注美元与美债收益率对港美股估值压缩效应。')

    lines.extend([
        '',
        '【三情景（24h）】',
        '1) 偏多：风险事件缓和 + 利率预期稳定，权益资产修复。',
        '2) 中性：消息面分化，指数震荡，结构性机会为主。',
        '3) 偏空：地缘或通胀超预期，避险升温，波动加剧。',
        '',
        '【接下来关注】',
        '- 未来24小时：突发政策/地缘消息、主要市场开盘后的成交与波动率。',
        '- 未来7天：关键宏观数据与央行表态是否改变市场对利率路径的预期。',
    ])
    return '\n'.join(lines)


async def send_group_message(ws_url: str, token: str, group_id: int, message: str) -> dict:
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    async with websockets.connect(ws_url, additional_headers=headers, open_timeout=10) as ws:
        echo = f'morning-news-{int(datetime.now().timestamp())}'
        payload = {
            'action': 'send_group_msg',
            'params': {'group_id': group_id, 'message': message},
            'echo': echo,
        }
        await ws.send(json.dumps(payload, ensure_ascii=False))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=15)
            data = json.loads(raw)
            if data.get('echo') == echo:
                return data


def main() -> None:
    parser = argparse.ArgumentParser(description='发送早间24小时新闻与分析到QQ班群')
    parser.add_argument('--group-id', type=int, default=DEFAULT_GROUP_ID)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    report = run_news_report()
    message = report + '\n' + build_analysis(report)

    if args.dry_run:
        print(message)
        return

    ws_url, token = load_qq_ws_config()
    result = asyncio.run(send_group_message(ws_url, token, args.group_id, message))
    if result.get('status') != 'ok':
        raise RuntimeError(f"发送失败: {json.dumps(result, ensure_ascii=False)}")
    print(json.dumps({'ok': True, 'group_id': args.group_id, 'result': result}, ensure_ascii=False))


if __name__ == '__main__':
    main()
