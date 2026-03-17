from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta
from http.cookies import SimpleCookie
from typing import Any, Dict
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Shanghai")
COOKIE_NAME = "openclaw_finance_session"
ACCESS_CONTEXT = "finance-access-v1"
SESSION_CONTEXT = "finance-session-v1"


def current_cn_date(now_iso: str | None = None) -> str:
    return _resolve_now(now_iso).date().isoformat()


def valid_until_for_date(date_str: str) -> str:
    day = datetime.fromisoformat(date_str).replace(tzinfo=TZ)
    return day.replace(hour=23, minute=59, second=59, microsecond=0).isoformat()


def build_daily_key(secret: str, date_str: str) -> str:
    return _hmac_digest(secret, f"{ACCESS_CONTEXT}:{date_str}")[:24]


def validate_daily_key(key: str, secret: str, date_str: str) -> bool:
    return hmac.compare_digest(str(key or ""), build_daily_key(secret, date_str))


def build_session_cookie_value(secret: str, date_str: str) -> str:
    signature = _hmac_digest(secret, f"{SESSION_CONTEXT}:{date_str}")[:32]
    return f"{date_str}.{signature}"


def build_session_cookie_header(
    secret: str,
    date_str: str,
    path: str = "/finance",
    now_iso: str | None = None,
) -> str:
    expires = datetime.fromisoformat(valid_until_for_date(date_str))
    now = _resolve_now(now_iso)
    max_age = max(0, int((expires - now).total_seconds()))
    cookie = SimpleCookie()
    cookie[COOKIE_NAME] = build_session_cookie_value(secret, date_str)
    morsel = cookie[COOKIE_NAME]
    morsel["path"] = path
    morsel["httponly"] = True
    morsel["samesite"] = "Lax"
    morsel["max-age"] = str(max_age)
    morsel["expires"] = expires.strftime("%a, %d %b %Y %H:%M:%S GMT")
    return morsel.OutputString()


def parse_session_cookie(cookie_value: str, secret: str, now_iso: str | None = None) -> Dict[str, Any]:
    current_date = current_cn_date(now_iso)
    parsed: Dict[str, Any] = {
        "authorized": False,
        "date": None,
        "valid_until": valid_until_for_date(current_date),
    }
    if not cookie_value or "." not in cookie_value:
        return parsed
    date_str, signature = cookie_value.split(".", 1)
    expected = build_session_cookie_value(secret, date_str)
    if not hmac.compare_digest(cookie_value, expected):
        return parsed
    if date_str != current_date:
        parsed["date"] = date_str
        return parsed
    parsed["authorized"] = True
    parsed["date"] = date_str
    parsed["valid_until"] = valid_until_for_date(date_str)
    return parsed


def parse_session_cookie_from_header(cookie_header: str, secret: str, now_iso: str | None = None) -> Dict[str, Any]:
    cookie = SimpleCookie()
    cookie.load(cookie_header or "")
    morsel = cookie.get(COOKIE_NAME)
    if morsel is None:
        return parse_session_cookie("", secret, now_iso=now_iso)
    return parse_session_cookie(morsel.value, secret, now_iso=now_iso)


def _resolve_now(now_iso: str | None = None) -> datetime:
    if now_iso:
        current = datetime.fromisoformat(now_iso)
        if current.tzinfo is None:
            current = current.replace(tzinfo=TZ)
        return current.astimezone(TZ)
    return datetime.now(TZ)


def _hmac_digest(secret: str, value: str) -> str:
    return hmac.new(
        str(secret or "").encode("utf-8"),
        value.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
