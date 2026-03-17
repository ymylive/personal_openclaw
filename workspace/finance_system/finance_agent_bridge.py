#!/usr/bin/env python3
import json
import os
import subprocess
import time
import uuid
from typing import Any, Dict

OPENCLAW_BIN = os.getenv("OPENCLAW_BIN", "openclaw")
AGENT_TIMEOUT_SECONDS = int(os.getenv("FINANCE_AGENT_TIMEOUT_SECONDS", "180"))


def _extract_payload_text(raw: str) -> str:
    try:
        data = json.loads(raw)
    except Exception:
        return ""
    payloads = (((data or {}).get("result") or {}).get("payloads") or [])
    if not isinstance(payloads, list):
        return ""
    parts = [str(item.get("text", "")).strip() for item in payloads if isinstance(item, dict)]
    return "\n".join(part for part in parts if part).strip()


def _run_agent(agent_id: str, prompt: str, session_prefix: str, thinking: str = "low") -> str:
    session_id = f"{session_prefix}-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    env = os.environ.copy()
    env.setdefault("LANG", "C.UTF-8")
    env.setdefault("LC_ALL", "C.UTF-8")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    try:
        result = subprocess.run(
            [
                OPENCLAW_BIN,
                "agent",
                "--agent", agent_id,
                "--session-id", session_id,
                "--message", prompt,
                "--thinking", thinking,
                "--timeout", str(AGENT_TIMEOUT_SECONDS),
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=AGENT_TIMEOUT_SECONDS + 20,
            env=env,
            check=False,
        )
    except Exception:
        return ""
    if result.returncode != 0:
        return ""
    return _extract_payload_text(result.stdout)


def render_finance_news_report(fallback_text: str, context: Dict[str, Any]) -> str:
    prompt = "\n".join([
        "Task: rewrite the provided structured finance morning digest into one clean Chinese Telegram report.",
        "Use only the provided facts. Do not add outside news, prices, or claims.",
        "Keep the scope limited to major events from the last 24 hours.",
        "Structured context:",
        json.dumps(context, ensure_ascii=False, indent=2),
        "Reference draft:",
        fallback_text,
    ])
    return _run_agent("finance-news", prompt, "finance-news", thinking="low") or fallback_text


def render_finance_noon_report(fallback_text: str, context: Dict[str, Any]) -> str:
    prompt = "\n".join([
        "Task: rewrite the provided structured noon finance analysis into one clean Chinese Telegram report.",
        "Use only the provided facts and numbers. Do not invent data.",
        "If any symbol still uses cache fallback, explicitly keep the market data freshness note.",
        "Preserve the section order from the reference draft.",
        "Structured context:",
        json.dumps(context, ensure_ascii=False, indent=2),
        "Reference draft:",
        fallback_text,
    ])
    return _run_agent("finance-noon", prompt, "finance-noon", thinking="low") or fallback_text
