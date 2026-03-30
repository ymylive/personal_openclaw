from __future__ import annotations

from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from datetime import date, datetime, timedelta

from workspace.modules.shared.contracts import DeliveryRequest, DeliveryTarget

from .reports import (
    build_class_news_digest_message,
    build_daily_schedule_message,
    build_morning_news_message,
    collect_public_due_items,
)


def build_finance_push_request(
    *,
    job_name: str,
    body: str,
    target_channel: str,
    target_recipient: str,
) -> DeliveryRequest:
    return DeliveryRequest(
        job_name=job_name,
        body=body,
        targets=[DeliveryTarget(channel=target_channel, recipient=target_recipient)],
        metadata={"kind": "finance"},
    )


def orchestrate_morning_news_push(
    *,
    group_id: int,
    dry_run: bool,
    report_provider: Callable[[], str],
    deliver: Callable[[DeliveryRequest], dict],
) -> str | dict:
    report_text = report_provider()
    message = build_morning_news_message(report_text)
    if dry_run:
        return message

    request = build_finance_push_request(
        job_name="morning-news",
        body=message,
        target_channel="qq",
        target_recipient=str(group_id),
    )
    result = deliver(request)
    ok = isinstance(result, dict) and result.get("status") == "ok"
    return {"ok": ok, "group_id": group_id, "result": result}


def orchestrate_daily_schedule_push(
    *,
    group_id: int,
    date_text: str,
    dry_run: bool,
    schedule_fetcher: Callable[[str], dict],
    deliver: Callable[[DeliveryRequest], dict],
) -> str | dict:
    schedule = schedule_fetcher(date_text)
    message = build_daily_schedule_message(schedule, date_text)
    if dry_run:
        return message

    request = build_finance_push_request(
        job_name="daily-schedule",
        body=message,
        target_channel="qq",
        target_recipient=str(group_id),
    )
    result = deliver(request)
    ok = isinstance(result, dict) and result.get("status") == "ok"
    return {"ok": ok, "group_id": group_id, "date": date_text, "result": result}


def orchestrate_class_news_digest_push(
    *,
    group_id: int,
    dry_run: bool,
    news_fetcher: Callable[[], list[dict]],
    deliver: Callable[[DeliveryRequest], dict],
    now_dt: datetime | None = None,
) -> str | dict:
    news = news_fetcher()
    message = build_class_news_digest_message(news, now_dt=now_dt)
    if dry_run:
        return message

    request = build_finance_push_request(
        job_name="class-news-digest",
        body=message,
        target_channel="qq",
        target_recipient=str(group_id),
    )
    result = deliver(request)
    ok = isinstance(result, dict) and result.get("status") == "ok"
    return {"ok": ok, "group_id": group_id, "result": result}


def orchestrate_due_reminders_push(
    *,
    group_id: int,
    dry_run: bool,
    reminder_minutes: int,
    runtime_lock: Callable[[object], AbstractContextManager[bool]],
    lock_path: object,
    load_config: Callable[[], dict],
    load_state: Callable[[], dict],
    save_state: Callable[[dict], None],
    prune_sent_reminders: Callable[[dict, datetime], None],
    now: Callable[[], datetime],
    parse_iso_datetime: Callable[[str], datetime | None],
    get_items_for_date: Callable[[dict, date], Iterable[dict]],
    build_due_message: Callable[[dict], str],
    deliver: Callable[[DeliveryRequest], dict],
    no_due_text: str = "当前没有到点提醒。",
) -> dict | str:
    with runtime_lock(lock_path) as locked:
        if not locked:
            return {"ok": True, "skipped": "locked"}

        config = load_config()
        state = load_state() or {}
        now_dt = now()
        last_check = parse_iso_datetime(str(state.get("qq_last_reminder_check", "")))

        _, due_items = collect_public_due_items(
            now_dt=now_dt,
            last_check=last_check,
            sent_reminders=state.get("sent_reminders", {}),
            reminder_minutes=reminder_minutes,
            get_items_for_date=lambda target_date: get_items_for_date(config, target_date),
        )

        if dry_run:
            if not due_items:
                return no_due_text
            chunks = []
            for item, _ in due_items:
                enriched = dict(item)
                enriched["reminder_minutes"] = int(reminder_minutes)
                chunks.append(build_due_message(enriched))
            return "\n---\n".join(chunks)

        if not due_items:
            state["qq_last_reminder_check"] = now_dt.isoformat()
            prune_sent_reminders(state, now_dt)
            save_state(state)
            return {"ok": True, "sent": 0, "failed": 0}

        sent = 0
        failed_reminder_at: list[datetime] = []
        sent_at = now_dt.isoformat()

        for item, reminder_at in due_items:
            enriched = dict(item)
            enriched["reminder_minutes"] = int(reminder_minutes)
            message = build_due_message(enriched)
            request = build_finance_push_request(
                job_name="due-reminder",
                body=message,
                target_channel="qq",
                target_recipient=str(group_id),
            )
            result = deliver(request)
            if not (isinstance(result, dict) and result.get("status") == "ok"):
                failed_reminder_at.append(reminder_at)
                continue

            state_key = f"qq:{enriched.get('occurrence_id') or ''}:{int(reminder_minutes)}"
            state.setdefault("sent_reminders", {})[state_key] = sent_at
            prune_sent_reminders(state, now_dt)
            save_state(state)
            sent += 1

        next_check = min(failed_reminder_at) - timedelta(seconds=1) if failed_reminder_at else now_dt
        state["qq_last_reminder_check"] = next_check.isoformat()
        prune_sent_reminders(state, now_dt)
        save_state(state)
        return {"ok": len(failed_reminder_at) == 0, "sent": sent, "failed": len(failed_reminder_at)}

# sentinel
