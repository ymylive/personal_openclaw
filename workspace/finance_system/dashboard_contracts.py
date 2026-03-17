from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping

PUSH_STAGES = ("news", "morning", "noon", "health")
DEFAULT_ENTRY_ROUTE = "/finance"
DEFAULT_TELEGRAM_ROUTE = "/finance/access/<daily-key>"
DEFAULT_POLL_SECONDS = 120


def build_access_delivery(
    *,
    status: str,
    target_route: str,
    message_ids: Iterable[str] | None = None,
    sent_at: str | None = None,
    error: str | None = None,
) -> dict:
    return {
        "mode": "url_only",
        "status": status,
        "target_route": target_route,
        "sent_at": sent_at,
        "message_ids": [str(item) for item in (message_ids or [])],
        "error": error,
    }


def build_error_payload(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def build_index_payload(
    *,
    date: str,
    generated_at: str,
    content: Mapping[str, Mapping[str, Any]],
    history_dates: Iterable[str],
    entry_route: str = DEFAULT_ENTRY_ROUTE,
    telegram_access_route: str = DEFAULT_TELEGRAM_ROUTE,
    valid_until: str | None = None,
) -> dict:
    latest_available_dates = {}
    latest = {}
    for stage in PUSH_STAGES:
        payload = dict(content.get(stage) or {})
        ready = str(payload.get("status", "")).lower() in {"ready", "not_triggered"}
        latest[f"{stage}_ready"] = ready
        latest_available_dates[stage] = payload.get("date") or (date if ready else None)
    return {
        "date": date,
        "generated_at": generated_at,
        "latest": latest,
        "latest_available_dates": latest_available_dates,
        "access": {
            "entry_route": entry_route,
            "telegram_access_route": telegram_access_route,
            "session_valid_until": valid_until,
            "access_mode": "daily_key_to_cookie",
        },
        "history_dates": list(history_dates),
    }


def build_day_payload(
    *,
    mode: str,
    date: str,
    valid_until: str,
    content: Mapping[str, Mapping[str, Any]],
    history_dates: Iterable[str],
    authorized: bool = True,
    entry_route: str = DEFAULT_ENTRY_ROUTE,
    telegram_access_route: str = DEFAULT_TELEGRAM_ROUTE,
    recommended_poll_seconds: int = DEFAULT_POLL_SECONDS,
    trading_day: bool = True,
) -> dict:
    normalized = _normalized_content(content)
    top_status = _build_top_status(
        trading_day=trading_day,
        valid_until=valid_until,
        content=normalized,
    )
    return {
        "ok": True,
        "mode": mode,
        "day": {
            "date": date,
            "generated_at": _pick_generated_at(normalized) or valid_until,
            "session": {
                "authorized": authorized,
                "valid_until": valid_until,
            },
            "top_status": top_status,
            "content": normalized,
            "history": {
                "selected_date": date,
                "available_dates": list(history_dates),
            },
            "access": {
                "entry_route": entry_route,
                "telegram_access_route": telegram_access_route,
                "access_mode": "daily_key_to_cookie",
            },
            "refresh": {
                "recommended_poll_seconds": recommended_poll_seconds,
            },
        },
    }


def build_status_payload(
    *,
    date: str,
    valid_until: str,
    content: Mapping[str, Mapping[str, Any]],
    now: str,
    authorized: bool = True,
    recommended_poll_seconds: int = DEFAULT_POLL_SECONDS,
) -> dict:
    normalized = _normalized_content(content)
    pushes = {}
    latest_generated_at = ""
    for stage in PUSH_STAGES:
        stage_payload = normalized.get(stage) or {}
        generated_at = str(stage_payload.get("generated_at") or "")
        if generated_at and generated_at > latest_generated_at:
            latest_generated_at = generated_at
        pushes[stage] = {"status": stage_payload.get("status", "pending")}
    return {
        "ok": True,
        "authorized": authorized,
        "date": date,
        "now": now,
        "valid_until": valid_until,
        "latest_generated_at": latest_generated_at or now,
        "pushes": pushes,
        "recommended_poll_seconds": recommended_poll_seconds,
    }


def build_history_index_payload(*, latest_date: str, available_dates: Iterable[str], authorized: bool = True) -> dict:
    return {
        "ok": True,
        "authorized": authorized,
        "latest_date": latest_date,
        "available_dates": list(available_dates),
    }


def _normalized_content(content: Mapping[str, Mapping[str, Any]]) -> Dict[str, dict]:
    normalized: Dict[str, dict] = {}
    for stage in PUSH_STAGES:
        payload = dict(content.get(stage) or {})
        if "telegram_delivery" not in payload:
            payload["telegram_delivery"] = build_access_delivery(
                status="not_triggered",
                target_route=DEFAULT_TELEGRAM_ROUTE,
            )
        normalized[stage] = deepcopy(payload)
    return normalized


def _build_top_status(*, trading_day: bool, valid_until: str, content: Mapping[str, Mapping[str, Any]]) -> dict:
    morning = dict(content.get("morning") or {})
    noon = dict(content.get("noon") or {})
    market_temperatures = {}
    for market in ("A", "HK", "US"):
        market_temperatures[market] = (
            (((morning.get("markets") or {}).get(market) or {}).get("temperature")) or "未更新"
        )
    portfolio_summary = dict(noon.get("portfolio_summary") or {})
    positions = list(noon.get("positions") or [])
    return {
        "trading_day": trading_day,
        "last_refresh_at": _pick_generated_at(content) or valid_until,
        "pushes": {
            stage: {
                "status": (content.get(stage) or {}).get("status", "pending"),
                "generated_at": (content.get(stage) or {}).get("generated_at"),
                "telegram_delivery": deepcopy((content.get(stage) or {}).get("telegram_delivery")),
            }
            for stage in PUSH_STAGES
        },
        "market_temperatures": market_temperatures,
        "portfolio_summary": {
            "portfolio_value": portfolio_summary.get("portfolio_value", 0.0),
            "daily_pnl_pct": portfolio_summary.get("daily_pnl_pct", 0.0),
            "turnover_pct": portfolio_summary.get("turnover_pct", 0.0),
            "holding_count": len(positions),
        },
    }


def _pick_generated_at(content: Mapping[str, Mapping[str, Any]]) -> str:
    values: List[str] = []
    for payload in content.values():
        generated_at = str((payload or {}).get("generated_at") or "")
        if generated_at:
            values.append(generated_at)
    return max(values) if values else ""
