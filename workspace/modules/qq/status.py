from __future__ import annotations


def build_status_payload(*, running: bool, listener_count: int, last_error: str | None) -> dict:
    return {
        "module": "qq",
        "running": running,
        "listenerCount": listener_count,
        "lastError": last_error,
    }
