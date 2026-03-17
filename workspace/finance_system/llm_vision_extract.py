#!/usr/bin/env python3
import argparse
import base64
import json
import os
from pathlib import Path

import requests

OPENCLAW_CONFIG = Path(os.getenv("OPENCLAW_CONFIG", "/home/node/.openclaw/openclaw.json"))
DEFAULT_BASE_URL = "https://gmn.chuangzuoli.com/v1"
DEFAULT_MODEL = "gpt-5.4"
UA = "curl/8.6.0"


def guess_mime(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(ext, "application/octet-stream")


def _extract_output_text(data: dict) -> str:
    out = []
    for item in data.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                text = (content.get("text") or "").strip()
                if text:
                    out.append(text)
    return "\n".join(out).strip()


def _resolve_runtime_settings() -> tuple[str, str, str]:
    env_base_url = os.getenv("FINANCE_LLM_BASE_URL", "").strip()
    env_api_key = os.getenv("FINANCE_LLM_API_KEY", "").strip()
    env_model = os.getenv("FINANCE_LLM_MODEL", "").strip()
    if env_base_url and env_api_key:
        return env_base_url.rstrip("/"), env_api_key, env_model or DEFAULT_MODEL

    try:
        cfg = json.loads(OPENCLAW_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        cfg = {}

    provider = (((cfg.get("models") or {}).get("providers") or {}).get("codex") or {}) if isinstance(cfg, dict) else {}
    base_url = str(provider.get("baseUrl") or env_base_url or DEFAULT_BASE_URL).strip().rstrip("/")
    api_key = str(provider.get("apiKey") or env_api_key or "").strip()
    model = env_model or DEFAULT_MODEL
    return base_url, api_key, model


def _call_responses_api(content: list[dict], effort: str = "none") -> str:
    base_url, api_key, model = _resolve_runtime_settings()
    if not api_key:
        raise RuntimeError("finance vision api key missing; set FINANCE_LLM_API_KEY or configure models.providers.codex.apiKey")
    payload = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": content,
            }
        ],
        "reasoning": {"effort": effort},
    }
    response = requests.post(
        f"{base_url}/responses",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
        json=payload,
        timeout=180,
    )
    response.raise_for_status()
    return _extract_output_text(response.json())


def vision_extract(path: Path, prompt: str) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode()
    return _call_responses_api([
        {"type": "input_text", "text": prompt},
        {"type": "input_image", "image_url": f"data:{guess_mime(path)};base64,{b64}"},
    ])


def text_extract(text: str, prompt: str) -> str:
    return _call_responses_api([
        {"type": "input_text", "text": f"{prompt}\n\n\u4ee5\u4e0b\u662f\u5f85\u5904\u7406\u5185\u5bb9\uff1a\n{text}"},
    ])


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract text from image using LLM vision")
    ap.add_argument("image")
    ap.add_argument("--prompt", default="\u8bf7\u63d0\u53d6\u8fd9\u5f20\u56fe\u7247\u91cc\u7684\u5168\u90e8\u6587\u5b57\uff0c\u53ea\u8f93\u51fa\u6574\u7406\u540e\u7684\u6587\u5b57\u672c\u8eab\uff0c\u4e0d\u8981\u52a0\u89e3\u91ca\u3002\u7eaf\u6587\u672c\u8f93\u51fa\uff0c\u4e0d\u8981 markdown\u3002")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    text = vision_extract(Path(args.image), args.prompt)
    if args.json:
        print(json.dumps({"ok": bool(text), "text": text}, ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
