#!/usr/bin/env python3
import argparse
import json
import os
import shutil
from pathlib import Path

CHECK_FILES = [
    "finance_system/schedule_reminder.py",
    "finance_system/report_bot.py",
    "finance_system/dashboard_server.py",
    "finance_system/schedule_config.json",
    "finance_system/schedule_state.json",
    "finance_system/portfolio_config.json",
    "finance_system/openclaw_finance_dashboard.service.example",
]

PY_MODULES = [
    ("requests", "requests"),
    ("pandas", "pandas"),
    ("bs4", "beautifulsoup4"),
    ("yfinance", "yfinance"),
    ("dateutil.parser", "python-dateutil"),
    ("zoneinfo", "zoneinfo"),
]


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def check_path(path: Path, kind: str):
    exists = path.exists()
    return {
        "path": str(path),
        "kind": kind,
        "exists": exists,
        "readable": exists and path.is_file(),
    }


def import_module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Check OpenClaw runtime readiness for finance_system migration")
    parser.add_argument("--openclaw-home", default=os.getenv("OPENCLAW_HOME", "/home/node/.openclaw"))
    parser.add_argument("--workspace-dir", default="/home/node/.openclaw/workspace")
    parser.add_argument("--dashboard-enabled", default=os.getenv("FINANCE_DASHBOARD_MODE", "1"))
    parser.add_argument("--dashboard-port", default=os.getenv("FINANCE_DASHBOARD_PORT", "18790"))
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    openclaw_home = Path(args.openclaw_home)
    workspace_dir = Path(args.workspace_dir)
    finance_dir = workspace_dir / "finance_system"

    runtime_file = openclaw_home / "openclaw.json"
    allow_file = openclaw_home / "credentials" / "telegram-allowFrom.json"

    runtime_cfg = load_json(runtime_file) or {}
    allow_cfg = load_json(allow_file) or {}
    telegram_cfg = ((runtime_cfg.get("channels") or {}).get("telegram") or {}) if isinstance(runtime_cfg, dict) else {}
    allow_from = allow_cfg.get("allowFrom") or [] if isinstance(allow_cfg, dict) else []
    stream_mode = str(telegram_cfg.get("streamMode", "")).strip().lower() or "(default: off)"
    dashboard_enabled = str(args.dashboard_enabled).strip().lower() not in {"0", "false", "no", "off"}
    dashboard_secret = os.getenv("FINANCE_DASHBOARD_SECRET", "").strip()
    dashboard_public_base_url = os.getenv("FINANCE_DASHBOARD_PUBLIC_BASE_URL", "").strip()

    file_checks = [check_path(runtime_file, "runtime_config"), check_path(allow_file, "allow_list")]
    for rel in CHECK_FILES:
        file_checks.append(check_path(workspace_dir / rel, "workspace_file"))

    module_checks = []
    for import_name, package_name in PY_MODULES:
        module_checks.append(
            {
                "import": import_name,
                "package": package_name,
                "ok": import_module(import_name),
            }
        )

    binary_checks = [
        {"name": "mcporter", "found": shutil.which("mcporter") is not None},
        {"name": "python3", "found": shutil.which("python3") is not None or shutil.which("python") is not None},
        {"name": "openclaw", "found": shutil.which("openclaw") is not None},
    ]

    result = {
        "openclaw_home": str(openclaw_home),
        "workspace_dir": str(workspace_dir),
        "finance_dir_exists": finance_dir.exists(),
        "telegram_token_found": bool(telegram_cfg.get("botToken") or telegram_cfg.get("token") or os.getenv("TELEGRAM_BOT_TOKEN", "")),
        "telegram_stream_mode": stream_mode,
        "allow_from_count": len(allow_from),
        "dashboard_enabled": dashboard_enabled,
        "dashboard_secret_found": bool(dashboard_secret),
        "dashboard_public_base_url": dashboard_public_base_url,
        "dashboard_port": str(args.dashboard_port),
        "files": file_checks,
        "python_modules": module_checks,
        "binaries": binary_checks,
    }

    failures = []
    if not result["finance_dir_exists"]:
        failures.append("finance_system directory missing")
    if not result["telegram_token_found"]:
        failures.append("telegram token missing")
    if result["allow_from_count"] <= 0:
        failures.append("telegram allowFrom missing")
    if stream_mode in {"partial", "block"}:
        failures.append(f"channels.telegram.streamMode should be off, current={stream_mode}")
    if dashboard_enabled and not dashboard_secret:
        failures.append("FINANCE_DASHBOARD_SECRET missing while dashboard mode is enabled")
    if dashboard_enabled and not str(args.dashboard_port).strip():
        failures.append("dashboard port missing")
    for item in file_checks:
        if not item["exists"]:
            failures.append(f"missing file: {item['path']}")
    for item in module_checks:
        if not item["ok"]:
            failures.append(f"missing python package: {item['package']}")
    for item in binary_checks:
        if item["name"] == "mcporter" and not item["found"]:
            failures.append("mcporter not found")

    result["ok"] = len(failures) == 0
    result["failures"] = failures

    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"ok={result['ok']}")
        print(f"openclaw_home={result['openclaw_home']}")
        print(f"workspace_dir={result['workspace_dir']}")
        print(f"finance_dir_exists={result['finance_dir_exists']}")
        print(f"telegram_token_found={result['telegram_token_found']}")
        print(f"telegram_stream_mode={result['telegram_stream_mode']}")
        print(f"allow_from_count={result['allow_from_count']}")
        print(f"dashboard_enabled={result['dashboard_enabled']}")
        print(f"dashboard_secret_found={result['dashboard_secret_found']}")
        print(f"dashboard_public_base_url={result['dashboard_public_base_url']}")
        print(f"dashboard_port={result['dashboard_port']}")
        for item in failures:
            print(f"FAIL: {item}")

    if args.strict and failures:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
