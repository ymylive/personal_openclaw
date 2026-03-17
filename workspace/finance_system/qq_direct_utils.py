#!/usr/bin/env python3
import asyncio
import json
from datetime import datetime
from pathlib import Path

import websockets

CONFIG_CANDIDATES = [
    Path("/home/node/.openclaw/openclaw.json"),
    Path("/root/.openclaw/openclaw.json"),
]
RETRYABLE_RETCODES = {1200}
DEFAULT_SEND_ATTEMPTS = 2
SEND_CONFIRM_POLL_INTERVAL_SECONDS = 1.2
SEND_CONFIRM_POLL_COUNT = 2


def load_qq_ws_config() -> tuple[str, str]:
    for candidate in CONFIG_CANDIDATES:
        if not candidate.exists():
            continue
        cfg = json.loads(candidate.read_text(encoding="utf-8"))
        qq = ((cfg.get("channels") or {}).get("qq") or {})
        ws_url = qq.get("wsUrl")
        token = qq.get("accessToken") or ""
        if ws_url:
            return ws_url, token
    raise RuntimeError("QQ wsUrl not found")


async def onebot_call_once(ws_url: str, token: str, action: str, params: dict, echo: str, timeout_seconds: float = 15) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with websockets.connect(ws_url, additional_headers=headers, open_timeout=10, ping_interval=20, ping_timeout=20) as ws:
        payload = {"action": action, "params": params, "echo": echo}
        await ws.send(json.dumps(payload, ensure_ascii=False))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout_seconds)
            data = json.loads(raw)
            if data.get("echo") == echo:
                return data


async def send_group_message_once(ws_url: str, token: str, group_id: int, message: str, echo: str) -> dict:
    return await onebot_call_once(ws_url, token, "send_group_msg", {"group_id": group_id, "message": message}, echo)


def should_retry_send(result: dict) -> bool:
    if not isinstance(result, dict) or result.get("status") == "ok":
        return False
    try:
        retcode = int(result.get("retcode") or 0)
    except Exception:
        retcode = 0
    text = f"{result.get('message', '')} {result.get('wording', '')}".lower()
    return retcode in RETRYABLE_RETCODES or "timeout" in text


def normalize_compare_text(text: str) -> str:
    return " ".join(str(text or "").replace("\r", "\n").split())


def extract_history_text(message: dict) -> str:
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


async def fetch_group_history(ws_url: str, token: str, group_id: int, echo_prefix: str) -> list[dict]:
    echo = f"{echo_prefix}-history-{int(datetime.now().timestamp())}"
    result = await onebot_call_once(ws_url, token, "get_group_msg_history", {"group_id": group_id}, echo)
    return list(((result.get("data") or {}).get("messages") or []))


async def fetch_self_user_id(ws_url: str, token: str, echo_prefix: str) -> int:
    echo = f"{echo_prefix}-self-{int(datetime.now().timestamp())}"
    result = await onebot_call_once(ws_url, token, "get_login_info", {}, echo)
    return int(((result.get("data") or {}).get("user_id") or 0) or 0)


def find_history_match(messages: list[dict], expected_text: str, sent_after_ts: int, self_user_id: int = 0) -> dict | None:
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
        if history_text == target:
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
) -> dict | None:
    for attempt in range(max(1, int(poll_count))):
        if attempt > 0:
            await asyncio.sleep(max(0.1, float(poll_interval_seconds)))
        try:
            history = await fetch_group_history(ws_url, token, group_id, echo_prefix)
        except Exception:
            continue
        matched = find_history_match(history, message, sent_after_ts, self_user_id=self_user_id)
        if matched:
            return matched
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
    attempts = max(1, attempts)
    last_result = {"status": "failed", "message": "unknown"}
    self_user_id = 0
    for attempt in range(1, attempts + 1):
        send_started_at = int(datetime.now().timestamp())
        echo = f"{echo_prefix}-{send_started_at}-{attempt}"
        try:
            result = await send_group_message_once(ws_url, token, group_id, message, echo)
        except Exception as exc:
            text = str(exc)
            result = {"status": "failed", "retcode": 1200 if "timeout" in text.lower() else -1, "message": text, "wording": text, "echo": echo}
        if result.get("status") == "ok":
            return result
        last_result = result
        retryable = should_retry_send(result)
        if retryable:
            if not self_user_id:
                try:
                    self_user_id = await fetch_self_user_id(ws_url, token, echo_prefix)
                except Exception:
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
            )
            if matched:
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
    return last_result
