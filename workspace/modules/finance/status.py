from __future__ import annotations


def build_finance_status(*, latest_job: str | None, push_enabled: bool) -> dict:
    return {"module": "finance", "latestJob": latest_job, "pushEnabled": push_enabled}
