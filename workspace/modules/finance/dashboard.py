from __future__ import annotations

from collections.abc import Iterable, Mapping


def build_finance_bootstrap_payload(
    *,
    date: str,
    history_dates: Iterable[str],
    delivery: Mapping[str, object],
) -> dict:
    delivery_payload = dict(delivery or {})
    return {
        **delivery_payload,
        "module": "finance",
        "date": date,
        "historyDates": list(history_dates),
        "delivery": dict(delivery_payload),
    }
