#!/usr/bin/env python3
"""QQ @消息自动回复

监听QQ群中的@消息，自动提取和分析图片、文件等附件内容并回复。
支持多种媒体类型和智能上下文关联。
"""
import argparse
import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import websockets

from qq_config import get_config
from qq_logging import qq_reply_logger as logger


def _ensure_workspace_importable() -> None:
    repo_root = None
    current = Path(__file__).resolve()
    for ancestor in current.parents:
        if (ancestor / "workspace").is_dir():
            repo_root = ancestor
            break
    if repo_root is None:
        repo_root = current.parents[-1]
    repo_root_str = str(repo_root)
    if repo_root_str not in sys.path:
        sys.path.insert(0, repo_root_str)


_ensure_workspace_importable()

from workspace.modules.qq.attachments import extract_image_urls_from_segments
from workspace.modules.qq.listener import should_handle_at_message

# 状态存储路径
STATE_DIR = Path('/home/node/.openclaw/workspace/finance_system/qq_at_reply_state')
LEGACY_STATE_PATH = Path('/home/node/.openclaw/workspace/finance_system/qq_at_reply_state.json')
BLACKLIST_PATH = Path('/home/node/.openclaw/workspace/finance_system/qq_group_blacklist.json')

# 默认群组ID
DEFAULT_GROUP_ID = 1061966199

# 最大已回复消息ID数量
MAX_REPLIED_IDS = 500

# 正则表达式模式
IMAGE_RE = re.compile(r'\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]')
REPLY_RE = re.compile(r'\[CQ:reply,[^\]]*(?:id|message_id)=([^,\]]+)[^\]]*\]')
IMAGE_INTENT_RE = re.compile(r'图片|这图|这张图|看图|识图|OCR|提取文字|图里|题图|截图')
FILE_INTENT_RE = re.compile(r'文件|附件|文档|表格|pdf|word|ppt|压缩包|源码|代码')
SUMMARIZE_RE = re.compile(r'总结|概括|摘要|简要分析|分析|说说|讲讲|解释')
TEXT_RE = re.compile(r'提取|文字|识别|ocr|转文字')
QUESTION_RE = re.compile(r'题|题目|答案|解读|什么意思')

# 支持的文本文件扩展名
TEXT_FILE_EXTS = {
    '.txt', '.md', '.markdown', '.json', '.csv', '.py', '.c', '.cpp', '.cc',
    '.h', '.hpp', '.java', '.js', '.ts', '.html', '.xml', '.yml', '.yaml', '.log'
}

# 附件提取器路径
ATTACH_EXTRACTOR = Path('/home/node/.openclaw/workspace/finance_system/qq_attachment_extract.py')


def load_cfg() -> tuple[str, str]:
    """加载QQ配置

    Returns:
        (ws_url, token) 元组

    Raises:
        RuntimeError: 如果配置未找到
    """
    config = get_config()
    return config.get_ws_config()


def load_blacklist() -> set[int]:
    """加载黑名单群组

    Returns:
        黑名单群组ID集合
    """
    if not BLACKLIST_PATH.exists():
        return set()

    try:
        data = json.loads(BLACKLIST_PATH.read_text(encoding='utf-8'))
        groups = data.get('groups') or []
        blacklist = {
            int(item['group_id'])
            for item in groups
            if str(item.get('group_id', '')).isdigit()
        }
        logger.info(f'Loaded {len(blacklist)} blacklisted groups')
        return blacklist
    except Exception as e:
        logger.error(f'Failed to load blacklist: {e}')
        return set()


def state_path_for(group_id: int) -> Path:
    """获取群组状态文件路径

    Args:
        group_id: 群组ID

    Returns:
        状态文件路径
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    return STATE_DIR / f'group_{group_id}.json'


def load_state(group_id: int) -> dict:
    """加载群组状态

    Args:
        group_id: 群组ID

    Returns:
        状态字典
    """
    paths = [state_path_for(group_id)]
    if group_id == DEFAULT_GROUP_ID:
        paths.append(LEGACY_STATE_PATH)

    for path in paths:
        if not path.exists():
            continue

        try:
            state = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(state, dict):
                raise ValueError('state must be a dict')

            state.setdefault('last_message_id', 0)
            replied_ids = state.get('replied_message_ids') or []

            if not isinstance(replied_ids, list):
                replied_ids = []

            state['replied_message_ids'] = [
                int(x) for x in replied_ids if str(x).isdigit()
            ][-MAX_REPLIED_IDS:]

            logger.debug(f'Loaded state for group {group_id}')
            return state
        except Exception as e:
            logger.warning(f'Failed to load state from {path}: {e}')

    return {'last_message_id': 0, 'replied_message_ids': []}


def save_state(group_id: int, state: dict) -> None:
    """保存群组状态

    Args:
        group_id: 群组ID
        state: 状态字典
    """
    state = dict(state)
    replied_ids = state.get('replied_message_ids') or []
    state['replied_message_ids'] = replied_ids[-MAX_REPLIED_IDS:]

    try:
        state_path_for(group_id).write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8'
        )
        logger.debug(f'Saved state for group {group_id}')
    except Exception as e:
        logger.error(f'Failed to save state for group {group_id}: {e}')


async def call(ws, action: str, params: dict, echo: str) -> dict:
    """调用OneBot API

    Args:
        ws: WebSocket连接
        action: API动作
        params: 参数字典
        echo: 回显标识

    Returns:
        API响应数据
    """
    await ws.send(json.dumps({'action': action, 'params': params, 'echo': echo}, ensure_ascii=False))

    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        data = json.loads(raw)
        if data.get('echo') == echo:
            return data


def update_state(group_id: int, state: dict, replied_id_list: list, max_seen_id: int) -> None:
    """更新并保存状态

    Args:
        group_id: 群组ID
        state: 状态字典
        replied_id_list: 已回复消息ID列表
        max_seen_id: 最大已见消息ID
    """
    state['last_message_id'] = max_seen_id
    state['replied_message_ids'] = replied_id_list[-MAX_REPLIED_IDS:]
    save_state(group_id, state)


def clean_text(text: str) -> str:
    """清理文本，移除CQ码

    Args:
        text: 原始文本

    Returns:
        清理后的文本
    """
    text = re.sub(r'\[CQ:[^\]]+\]', ' ', str(text or ''))
    return re.sub(r'\s+', ' ', text).strip()


def extract_image_urls_from_raw(raw: str) -> List[str]:
    """从原始消息中提取图片URL

    Args:
        raw: 原始消息文本

    Returns:
        图片URL列表
    """
    return [
        m.group(1).strip()
        for m in IMAGE_RE.finditer(raw or '')
        if m.group(1).strip()
    ]


def looks_like_media_request(text: str) -> bool:
    """判断文本是否像媒体请求

    Args:
        text: 文本内容

    Returns:
        如果像媒体请求返回True
    """
    t = clean_text(text).lower()
    return bool(
        IMAGE_INTENT_RE.search(t) or
        FILE_INTENT_RE.search(t) or
        '这个' in t or
        '这个题' in t or
        '最新' in t
    )


def extract_segments(message: Any) -> List[Dict[str, Any]]:
    """提取消息段

    Args:
        message: 消息对象

    Returns:
        消息段列表
    """
    return message if isinstance(message, list) else []


def display_name(message: Dict[str, Any]) -> str:
    """获取发送者显示名称

    Args:
        message: 消息对象

    Returns:
        显示名称
    """
    sender = message.get('sender') or {}
    return str(
        sender.get('nickname') or
        sender.get('card') or
        message.get('user_id') or
        'unknown'
    )


async def get_file_url(ws, group_id: int, seg: Dict[str, Any]) -> Optional[str]:
    """获取文件URL

    Args:
        ws: WebSocket连接
        group_id: 群组ID
        seg: 消息段

    Returns:
        文件URL，如果获取失败返回None
    """
    data = seg.get('data') or {}

    if isinstance(data.get('url'), str) and data['url'].strip():
        return data['url'].strip()

    file_id = data.get('file_id')
    if not file_id:
        return None

    try:
        info = await call(ws, 'get_group_file_url', {
            'group_id': group_id,
            'file_id': file_id,
            'busid': data.get('busid'),
        }, f'file-{group_id}-{file_id}')

        url = ((info.get('data') or {}).get('url')) if isinstance(info.get('data'), dict) else info.get('url')
        return url.strip() if isinstance(url, str) and url.strip() else None
    except Exception as e:
        logger.warning(f'Failed to get file URL: {e}')
        return None


def extract_reply_message_id(message: Dict[str, Any]) -> int:
    for seg in extract_segments(message.get('message')):
        if not isinstance(seg, dict) or seg.get('type') != 'reply':
            continue
        data = seg.get('data') or {}
        for key in ('id', 'message_id'):
            value = data.get(key)
            if str(value).isdigit():
                return int(value)
    raw = str(message.get('raw_message') or '')
    matched = REPLY_RE.search(raw)
    if matched and matched.group(1).isdigit():
        return int(matched.group(1))
    return 0


async def extract_media_from_message(ws, group_id: int, message: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(message, dict):
        return {'image': None, 'file': None}
    sender_name = display_name(message)
    raw = str(message.get('raw_message') or '')
    image_urls = extract_image_urls_from_segments(message.get('message')) or extract_image_urls_from_raw(raw)
    image = None
    if image_urls:
        image = {
            'message_id': int(message.get('message_id') or 0),
            'user_id': int(message.get('user_id') or 0),
            'sender_name': sender_name,
            'url': image_urls[0],
            'raw': raw,
        }

    latest_file = None
    for seg in extract_segments(message.get('message')):
        if seg.get('type') != 'file':
            continue
        file_url = await get_file_url(ws, group_id, seg)
        latest_file = {
            'message_id': int(message.get('message_id') or 0),
            'user_id': int(message.get('user_id') or 0),
            'sender_name': sender_name,
            'name': ((seg.get('data') or {}).get('name') or (seg.get('data') or {}).get('file') or '未命名文件'),
            'url': file_url,
        }
        break
    return {'image': image, 'file': latest_file}


async def fetch_message_by_id(ws, message_id: int) -> Optional[Dict[str, Any]]:
    if not message_id:
        return None
    try:
        info = await call(ws, 'get_msg', {'message_id': message_id}, f'msg-{message_id}')
    except Exception:
        return None
    payload = info.get('data') if isinstance(info, dict) else None
    return payload if isinstance(payload, dict) else None


def with_media_source(media: Dict[str, Any], source: str) -> Dict[str, Any]:
    return {
        'image': media.get('image'),
        'file': media.get('file'),
        'source': source,
    }


async def resolve_requested_media(ws, group_id: int, self_id: int, message: Dict[str, Any], before_message_id: int) -> Dict[str, Any]:
    current_media = await extract_media_from_message(ws, group_id, message)
    if current_media.get('image') or current_media.get('file'):
        return with_media_source(current_media, 'current')

    reply_message_id = extract_reply_message_id(message)
    if reply_message_id:
        replied = await fetch_message_by_id(ws, reply_message_id)
        replied_media = await extract_media_from_message(ws, group_id, replied or {})
        if replied_media.get('image') or replied_media.get('file'):
            return with_media_source(replied_media, 'reply')

    recent_media = await find_recent_media(ws, group_id, self_id, before_message_id)
    return with_media_source(recent_media, 'recent')


async def find_recent_media(ws, group_id: int, self_id: int, before_message_id: int) -> Dict[str, Any]:
    hist = await call(ws, 'get_group_msg_history', {'group_id': group_id}, f'hist-{group_id}-{before_message_id}')
    msgs = (hist.get('data') or {}).get('messages') or []
    msgs = sorted(msgs, key=lambda x: int(x.get('message_id') or 0), reverse=True)
    latest_image = None
    latest_file = None
    for m in msgs:
        mid = int(m.get('message_id') or 0)
        uid = int(m.get('user_id') or 0)
        if not mid or mid >= before_message_id:
            continue
        if uid == self_id:
            continue
        media = await extract_media_from_message(ws, group_id, m)
        if latest_image is None and media.get('image'):
            latest_image = media['image']
        if latest_file is None and media.get('file'):
            latest_file = media['file']
        if latest_image and latest_file:
            break
    return {'image': latest_image, 'file': latest_file}

def extract_attachment_with_llm(source: str, query: str) -> dict:
    if not ATTACH_EXTRACTOR.exists():
        return {'ok': False, 'error': 'qq_attachment_extract.py not found'}
    try:
        proc = subprocess.run(
            ['python3', str(ATTACH_EXTRACTOR), source, '--query', query, '--json'],
            capture_output=True,
            text=True,
            timeout=240,
            check=False,
        )
    except Exception as exc:
        return {'ok': False, 'error': f'extractor failed: {exc}'}
    stdout = (proc.stdout or '').strip()
    stderr = (proc.stderr or '').strip()
    if not stdout:
        return {'ok': False, 'error': stderr or 'extractor produced no output'}
    try:
        data = json.loads(stdout)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {'ok': proc.returncode == 0, 'text': stdout[:2000], 'kind': 'text' if proc.returncode == 0 else 'unknown', 'error': stderr or 'invalid extractor output'}
def image_subject(source: str) -> str:
    if source == 'current':
        return '你刚发这张图'
    if source == 'reply':
        return '你回的那张图'
    return '最新那张图'


def file_subject(file_info: Dict[str, Any], source: str) -> str:
    name = str((file_info or {}).get('name') or '未命名文件')
    if source == 'current':
        return f"你刚发的文件《{name}》"
    if source == 'reply':
        return f"你回的文件《{name}》"
    return f"最新文件《{name}》"


def compose_media_reply(request_text: str, media: Dict[str, Any]) -> Optional[str]:
    req = clean_text(request_text)
    latest_image = media.get('image')
    latest_file = media.get('file')
    source = str(media.get('source') or 'recent')
    if latest_image and (IMAGE_INTENT_RE.search(req) or (not latest_file and looks_like_media_request(req))):
        extracted = extract_attachment_with_llm(latest_image['url'], req)
        text = str(extracted.get('text') or '').strip()
        subject = image_subject(source)
        if not extracted.get('ok') or not text:
            return f"[CQ:at,qq={{uid}}] {subject}我看了，是 {latest_image['sender_name']} 发的，但这会儿没顺利读出来。你让他发清楚点的原图，或者直接回那张图再叫我。"
        if TEXT_RE.search(req):
            return f"[CQ:at,qq={{uid}}] 我按你的问题看了{subject}，能提出来的内容在这：\n{text[:1200]}"
        if QUESTION_RE.search(req):
            brief = text[:500].replace('\n', ' ')
            return f"[CQ:at,qq={{uid}}] 我看的是 {latest_image['sender_name']} 发的{subject}，大意就是：{brief}"
        if SUMMARIZE_RE.search(req):
            brief = text[:700].replace('\n', ' ')
            return f"[CQ:at,qq={{uid}}] 我看了下{subject}，核心就是这些：{brief}"
        return f"[CQ:at,qq={{uid}}] {latest_image['sender_name']} 发的{subject}我先按你的问题读了一遍：\n{text[:1000]}"
    if latest_file and (FILE_INTENT_RE.search(req) or looks_like_media_request(req)):
        subject = file_subject(latest_file, source)
        if not latest_file.get('url'):
            return f"[CQ:at,qq={{uid}}] {subject}我翻到了，但这会儿没拿到下载链接。让他重发一遍，或者你直接把要看的那段贴出来。"
        extracted = extract_attachment_with_llm(latest_file['url'], req)
        text = str(extracted.get('text') or '').strip()
        if not extracted.get('ok') or not text:
            return f"[CQ:at,qq={{uid}}] {subject}我看见了，但这会儿没顺利读出来。最好重发一下，或者直接说你要我看哪段。"
        if TEXT_RE.search(req):
            return f"[CQ:at,qq={{uid}}] {subject}里和你这句最相关的内容在这：\n{text[:1200]}"
        if SUMMARIZE_RE.search(req) or QUESTION_RE.search(req):
            compact = text[:900].replace('\n', ' ')
            return f"[CQ:at,qq={{uid}}] 我瞄了一眼{subject}，大意就这些：{compact}"
        return f"[CQ:at,qq={{uid}}] {subject}我先读了一遍，关键信息给你：\n{text[:1000]}"
    return None

async def maybe_reply(ws, message, group_id, self_id, dry_run, replied_ids, replied_id_list, max_seen_id, blacklisted_groups):
    post_type = message.get('post_type')
    message_type = message.get('message_type')
    sub_type = message.get('sub_type')
    if post_type != 'message' or message_type != 'group' or sub_type == 'group_self':
        return 0, max_seen_id
    msg_group_id = int(message.get('group_id') or 0)
    if msg_group_id != group_id or msg_group_id in blacklisted_groups:
        return 0, max_seen_id
    mid = int(message.get('message_id') or 0)
    uid = int(message.get('user_id') or 0)
    raw = str(message.get('raw_message') or '')
    if mid > max_seen_id:
        max_seen_id = mid
    if not mid or mid in replied_ids:
        return 0, max_seen_id
    if uid == self_id:
        return 0, max_seen_id
    event = {"group_id": msg_group_id, "raw_message": raw}
    if not should_handle_at_message(event, blacklist=blacklisted_groups, self_ids={self_id}):
        return 0, max_seen_id
    req = clean_text(raw)
    reply = None
    if looks_like_media_request(req):
        media = await resolve_requested_media(ws, group_id, self_id, message, mid)
        reply = compose_media_reply(req, media)
        if reply:
            reply = reply.replace('{uid}', str(uid))
    if not reply:
        return 0, max_seen_id
    if dry_run:
        print(json.dumps({'match_message_id': mid, 'reply': reply}, ensure_ascii=False), flush=True)
        replied_ids.add(mid)
        replied_id_list.append(mid)
        return 1, max_seen_id
    ret = await call(ws, 'send_group_msg', {'group_id': group_id, 'message': reply}, f'send-{mid}')
    if ret.get('status') != 'ok':
        raise RuntimeError(f"回复消息 {mid} 失败: {json.dumps(ret, ensure_ascii=False)}")
    replied_ids.add(mid)
    replied_id_list.append(mid)
    return 1, max_seen_id
async def run(group_ids: List[int], dry_run: bool, listen: bool):
    ws_url, token = load_cfg()
    blacklisted_groups = load_blacklist()
    selected_group_ids = []
    for group_id in group_ids:
        group_id = int(group_id)
        if group_id not in selected_group_ids:
            selected_group_ids.append(group_id)
    group_state = {}
    for group_id in selected_group_ids:
        state = load_state(group_id)
        group_state[group_id] = {
            'state': state,
            'last_id': int(state.get('last_message_id') or 0),
            'replied_ids': set(int(x) for x in (state.get('replied_message_ids') or [])),
            'replied_id_list': list(state.get('replied_message_ids') or []),
            'max_seen_id': int(state.get('last_message_id') or 0),
        }
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    async with websockets.connect(ws_url, additional_headers=headers, open_timeout=10, ping_interval=20, ping_timeout=20) as ws:
        me = await call(ws, 'get_login_info', {}, 'me')
        self_id = int(((me.get('data') or {}).get('user_id')) or 0)
        sent = 0
        for group_id in selected_group_ids:
            entry = group_state[group_id]
            hist = await call(ws, 'get_group_msg_history', {'group_id': group_id}, f'hist-{group_id}')
            msgs = (hist.get('data') or {}).get('messages') or []
            msgs = sorted(msgs, key=lambda x: int(x.get('message_id') or 0))
            max_seen_id = entry['max_seen_id']
            for m in msgs:
                mid = int(m.get('message_id') or 0)
                if mid <= entry['last_id']:
                    if mid > max_seen_id:
                        max_seen_id = mid
                    continue
                delta, max_seen_id = await maybe_reply(ws, m, group_id, self_id, dry_run, entry['replied_ids'], entry['replied_id_list'], max_seen_id, blacklisted_groups)
                sent += delta
            entry['max_seen_id'] = max_seen_id
            update_state(group_id, entry['state'], entry['replied_id_list'], max_seen_id)
        print(json.dumps({'ok': True, 'sent': sent, 'groups': selected_group_ids, 'mode': 'listening' if listen else 'once'}, ensure_ascii=False), flush=True)
        if not listen:
            return
        while True:
            raw = await ws.recv()
            data = json.loads(raw)
            if data.get('post_type') != 'message':
                continue
            msg_group_id = int(data.get('group_id') or 0)
            if msg_group_id not in group_state:
                continue
            entry = group_state[msg_group_id]
            delta, max_seen_id = await maybe_reply(ws, data, msg_group_id, self_id, dry_run, entry['replied_ids'], entry['replied_id_list'], entry['max_seen_id'], blacklisted_groups)
            entry['max_seen_id'] = max_seen_id
            if delta:
                update_state(msg_group_id, entry['state'], entry['replied_id_list'], max_seen_id)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--group-id', type=int, action='append', dest='group_ids')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--listen', action='store_true', help='持续监听新消息（不适合 cron 频繁触发）')
    args = ap.parse_args()
    group_ids = args.group_ids or [DEFAULT_GROUP_ID]
    asyncio.run(run(group_ids, args.dry_run, args.listen))
if __name__ == '__main__':
    main()
