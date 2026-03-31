from __future__ import annotations


def build_status_payload(
    *,
    running: bool,
    listener_count: int,
    last_error: str | None,
    generated_at: str = "",
    summary: str = "",
) -> dict:
    last_error_text = str(last_error or "").strip()
    if last_error_text:
        level = "critical"
    elif running:
        level = "good"
    else:
        level = "warn"

    summary_text = summary.strip() or (
        "QQ listeners active" if running else "QQ listeners are idle or not configured yet"
    )

    return {
        "module": "qq",
        "running": running,
        "listenerCount": listener_count,
        "lastError": last_error_text,
        "generatedAt": generated_at,
        "health": {
            "level": level,
            "summary": summary_text,
        },
    }
