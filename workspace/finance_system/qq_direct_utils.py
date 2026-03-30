#!/usr/bin/env python3
"""QQ消息发送工具库

提供QQ群消息发送、历史记录查询、消息确认等功能。
支持自动重试和消息送达确认。
"""
import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Optional

import websockets

from qq_config import load_qq_ws_config
from qq_logging import qq_direct_logger as logger, log_api_call
from workspace.modules.qq.transport import (
    authorization_headers,
    build_send_group_payload,
    encode_payload,
)

# 可重试的返回码
RETRYABLE_RETCODES = {1200}

# 默认发送尝试次数
DEFAULT_SEND_ATTEMPTS = 2

# 发送确认轮询间隔（秒）
SEND_CONFIRM_POLL_INTERVAL_SECONDS = 1.2

# 发送确认轮询次数
SEND_CONFIRM_POLL_COUNT = 2


async def onebot_call_once(
    ws_url: str,
    token: str,
    action: str,
    params: dict,
    echo: str,
    timeout_seconds: float = 15
) -> dict:
    """执行一次OneBot API调用

    Args:
        ws_url: WebSocket URL
        token: 访问令牌
        action: API动作名称
        params: API参数
        echo: 回显标识
        timeout_seconds: 超时时间（秒）

    Returns:
        API响应数据

    Raises:
        asyncio.TimeoutError: 请求超时
        websockets.WebSocketException: WebSocket连接错误
    """
    start_time = datetime.now()
    headers = authorization_headers(token)

    try:
        async with websockets.connect(
            ws_url,
            additional_headers=headers,
            open_timeout=10,
            ping_interval=20,
            ping_timeout=20
        ) as ws:
            payload = {"action": action, "params": params, "echo": echo}
            await ws.send(encode_payload(payload))

            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout_seconds)
                data = json.loads(raw)
                if data.get("echo") == echo:
                    duration_ms = (datetime.now() - start_time).total_seconds() * 1000
                    log_api_call(
                        logger,
                        f'onebot_{action}',
                        'websocket',
                        params={'action': action},
                        response=data,
                        duration_ms=duration_ms
                    )
                    return data
    except Exception as e:
        duration_ms = (datetime.now() - start_time).total_seconds() * 1000
        log_api_call(
            logger,
            f'onebot_{action}',
            'websocket',
            params={'action': action},
            error=e,
            duration_ms=duration_ms
        )
        raise


async def send_group_message_once(
    ws_url: str,
    token: str,
    group_id: int,
    message: str,
    echo: str
) -> dict:
    """发送一次群消息

    Args:
        ws_url: WebSocket URL
        token: 访问令牌
        group_id: 群组ID
        message: 消息内容
        echo: 回显标识

    Returns:
        发送结果
    """
    logger.debug(f'Sending message to group {group_id}')
    payload = build_send_group_payload(group_id=group_id, message=message, echo=echo)
    return await onebot_call_once(
        ws_url,
        token,
        payload["action"],
        payload["params"],
        payload["echo"],
    )


def should_retry_send(result: dict) -> bool:
    """判断是否应该重试发送

    Args:
        result: 发送结果

    Returns:
        如果应该重试返回True，否则返回False
    """
    if not isinstance(result, dict) or result.get("status") == "ok":
        return False

    try:
        retcode = int(result.get("retcode") or 0)
    except Exception:
        retcode = 0

    text = f"{result.get('message', '')} {result.get('wording', '')}".lower()
    should_retry = retcode in RETRYABLE_RETCODES or "timeout" in text

    if should_retry:
        logger.info(f'Message send failed with retryable error: retcode={retcode}, text={text[:100]}')

    return should_retry


def normalize_compare_text(text: str) -> str:
    """规范化文本用于比较

    Args:
        text: 原始文本

    Returns:
        规范化后的文本
    """
    return " ".join(str(text or "").replace("\r", "\n").split())


def extract_history_text(message: dict) -> str:
    """从历史消息中提取文本内容

    Args:
        message: 消息对象

    Returns:
        提取的文本内容
    """
    raw = message.get("raw_message")
    if raw:
        return normalize_compare_text(str(raw))

    parts = []
    for segment in message.get("message") or []:
        if not isinstance(segment, dict):
            continue
        if segment.get("type") != "text":
            continue
        parts.append(str((segment.get("data") or {}).get("text") or ""))

    return normalize_compare_text("".join(parts))


async def fetch_group_history(
    ws_url: str,
    token: str,
    group_id: int,
    echo_prefix: str
) -> list[dict]:
    """获取群组历史消息

    Args:
        ws_url: WebSocket URL
        token: 访问令牌
        group_id: 群组ID
        echo_prefix: 回显前缀

    Returns:
        历史消息列表
    """
    echo = f"{echo_prefix}-history-{int(datetime.now().timestamp())}"
    logger.debug(f'Fetching history for group {group_id}')

    result = await onebot_call_once(
        ws_url,
        token,
        "get_group_msg_history",
        {"group_id": group_id},
        echo
    )

    messages = list(((result.get("data") or {}).get("messages") or []))
    logger.debug(f'Fetched {len(messages)} messages from group {group_id}')
    return messages


async def capture_history_snapshot(
    ws_url: str,
    token: str,
    group_id: int,
    echo_prefix: str
) -> tuple[int, int]:
    """Return the max message id and time observed before sending."""
    try:
        messages = await fetch_group_history(ws_url, token, group_id, f"{echo_prefix}-baseline")
    except Exception as exc:
        logger.warning(f'Failed to capture history snapshot: {exc}')
        return 0, 0

    max_id = 0
    max_time = 0
    for message in messages or []:
        message_id = int(message.get("message_id") or 0)
        msg_time = int(message.get("time") or 0)
        if message_id > max_id:
            max_id = message_id
        if msg_time > max_time:
            max_time = msg_time

    return max_id, max_time


async def fetch_self_user_id(
    ws_url: str,
    token: str,
    echo_prefix: str
) -> int:
    """获取当前登录用户ID

    Args:
        ws_url: WebSocket URL
        token: 访问令牌
        echo_prefix: 回显前缀

    Returns:
        用户ID
    """
    echo = f"{echo_prefix}-self-{int(datetime.now().timestamp())}"
    result = await onebot_call_once(ws_url, token, "get_login_info", {}, echo)
    user_id = int(((result.get("data") or {}).get("user_id") or 0) or 0)
    logger.debug(f'Self user ID: {user_id}')
    return user_id


def find_history_match(
    messages: list[dict],
    expected_text: str,
    sent_after_ts: int,
    self_user_id: int = 0,
    min_message_id: int = 0
) -> Optional[dict]:
    """在历史消息中查找匹配的消息

    Args:
        messages: 历史消息列表
        expected_text: 期望的消息文本
        sent_after_ts: 发送时间戳下限
        self_user_id: 自己的用户ID（用于过滤）

    Returns:
        匹配的消息信息，如果未找到则返回None
    """
    target = normalize_compare_text(expected_text)
    if not target:
        return None

    for message in reversed(messages or []):
        msg_time = int(message.get("time") or 0)
        if sent_after_ts and msg_time and msg_time < sent_after_ts - 5:
            continue

        user_id = int(message.get("user_id") or ((message.get("sender") or {}).get("user_id") or 0) or 0)
        if self_user_id and user_id and user_id != self_user_id:
            continue

        history_text = extract_history_text(message)
        message_id = int(message.get("message_id") or 0)
        if min_message_id and message_id and message_id <= min_message_id:
            continue
        if history_text == target:
            logger.debug(f'Found matching message: {message.get("message_id")}')
            return {
                "message_id": message.get("message_id"),
                "time": msg_time,
                "user_id": user_id,
                "text": history_text,
            }

    return None


async def confirm_group_message_delivery(
    ws_url: str,
    token: str,
    group_id: int,
    message: str,
    sent_after_ts: int,
    echo_prefix: str,
    self_user_id: int = 0,
    poll_interval_seconds: float = SEND_CONFIRM_POLL_INTERVAL_SECONDS,
    poll_count: int = SEND_CONFIRM_POLL_COUNT,
    baseline_message_id: int = 0,
) -> Optional[dict]:
    """确认群消息送达

    通过轮询群历史消息来确认消息是否成功送达。

    Args:
        ws_url: WebSocket URL
        token: 访问令牌
        group_id: 群组ID
        message: 消息内容
        sent_after_ts: 发送时间戳
        echo_prefix: 回显前缀
        self_user_id: 自己的用户ID
        poll_interval_seconds: 轮询间隔（秒）
        poll_count: 轮询次数

    Returns:
        匹配的消息信息，如果未找到则返回None
    """
    logger.debug(f'Confirming message delivery for group {group_id}')

    for attempt in range(max(1, int(poll_count))):
        if attempt > 0:
            await asyncio.sleep(max(0.1, float(poll_interval_seconds)))

        try:
            history = await fetch_group_history(ws_url, token, group_id, echo_prefix)
        except Exception as e:
            logger.warning(f'Failed to fetch history on attempt {attempt + 1}: {e}')
            continue

        matched = find_history_match(
            history,
            message,
            sent_after_ts,
            self_user_id=self_user_id,
            min_message_id=baseline_message_id,
        )
        if matched:
            logger.info(f'Message delivery confirmed: {matched.get("message_id")}')
            return matched

    logger.warning(f'Failed to confirm message delivery after {poll_count} attempts')
    return None


async def send_group_message(
    ws_url: str,
    token: str,
    group_id: int,
    message: str,
    echo_prefix: str,
    attempts: int = DEFAULT_SEND_ATTEMPTS,
    confirm_poll_interval_seconds: float = SEND_CONFIRM_POLL_INTERVAL_SECONDS,
    confirm_poll_count: int = SEND_CONFIRM_POLL_COUNT,
) -> dict:
    """发送群消息（带重试和确认）

    支持自动重试和消息送达确认。如果发送失败但可重试，
    会尝试通过查询历史消息来确认消息是否实际送达。

    Args:
        ws_url: WebSocket URL
        token: 访问令牌
        group_id: 群组ID
        message: 消息内容
        echo_prefix: 回显前缀
        attempts: 最大尝试次数
        confirm_poll_interval_seconds: 确认轮询间隔（秒）
        confirm_poll_count: 确认轮询次数

    Returns:
        发送结果字典，包含status、retcode、message等字段

    Example:
        >>> result = await send_group_message(
        ...     ws_url, token, 123456, "Hello",
        ...     echo_prefix="test"
        ... )
        >>> if result.get("status") == "ok":
        ...     print("Message sent successfully")
    """
    attempts = max(1, attempts)
    last_result = {"status": "failed", "message": "unknown"}
    self_user_id = 0

    logger.info(f'Sending message to group {group_id} (max attempts: {attempts})')

    for attempt in range(1, attempts + 1):
        send_started_at = int(datetime.now().timestamp())
        echo = f"{echo_prefix}-{send_started_at}-{attempt}"
        baseline_message_id, _ = await capture_history_snapshot(
            ws_url,
            token,
            group_id,
            f"{echo_prefix}-baseline-{attempt}"
        )

        try:
            result = await send_group_message_once(ws_url, token, group_id, message, echo)
        except Exception as exc:
            text = str(exc)
            result = {
                "status": "failed",
                "retcode": 1200 if "timeout" in text.lower() else -1,
                "message": text,
                "wording": text,
                "echo": echo
            }
            logger.error(f'Send attempt {attempt} failed with exception: {exc}')

        if result.get("status") == "ok":
            logger.info(f'Message sent successfully on attempt {attempt}')
            return result

        last_result = result
        retryable = should_retry_send(result)

        if retryable:
            logger.info(f'Attempting to confirm delivery via history check')

            if not self_user_id:
                try:
                    self_user_id = await fetch_self_user_id(ws_url, token, echo_prefix)
                except Exception as e:
                    logger.warning(f'Failed to fetch self user ID: {e}')
                    self_user_id = 0

            matched = await confirm_group_message_delivery(
                ws_url,
                token,
                group_id,
                message,
                send_started_at,
                echo_prefix,
                self_user_id=self_user_id,
                poll_interval_seconds=confirm_poll_interval_seconds,
                poll_count=confirm_poll_count,
                baseline_message_id=baseline_message_id,
            )

            if matched:
                logger.info(f'Message confirmed via history check')
                return {
                    "status": "ok",
                    "retcode": 0,
                    "message": "confirmed via group history",
                    "wording": "confirmed via group history",
                    "echo": echo,
                    "data": {
                        "confirmed_by": "group_history",
                        "message_id": matched.get("message_id"),
                        "time": matched.get("time"),
                        "user_id": matched.get("user_id"),
                    },
                    "original_result": result,
                }

        if attempt >= attempts or not retryable:
            break

        await asyncio.sleep(min(1.5, 0.6 * attempt))

    logger.error(f'Failed to send message after {attempts} attempts')
    return last_result
