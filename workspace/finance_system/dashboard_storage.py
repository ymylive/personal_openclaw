from __future__ import annotations

import json
import tempfile
from datetime import date as date_cls
from pathlib import Path
from typing import Any, Dict, Iterable

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_ROOT = BASE_DIR / "dashboard_data"
LATEST_DIRNAME = "latest"
ARCHIVE_DIRNAME = "archive"
STAGES = ("news", "morning", "noon", "health", "index")


def ensure_storage(root: Path | str | None = None) -> Path:
    resolved = resolve_root(root)
    (resolved / LATEST_DIRNAME).mkdir(parents=True, exist_ok=True)
    (resolved / ARCHIVE_DIRNAME).mkdir(parents=True, exist_ok=True)
    return resolved


def resolve_root(root: Path | str | None = None) -> Path:
    return Path(root) if root is not None else DEFAULT_DATA_ROOT


def write_stage_payload(root: Path | str | None, date: str, stage: str, payload: Dict[str, Any]) -> None:
    if stage not in STAGES:
        raise ValueError(f"unsupported stage: {stage}")
    normalized_date = normalize_history_date(date)
    resolved = ensure_storage(root)
    latest_path = resolved / LATEST_DIRNAME / f"{stage}.json"
    archive_path = resolved / ARCHIVE_DIRNAME / normalized_date / f"{stage}.json"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    body = _to_json(payload)
    _atomic_write_text(latest_path, body)
    _atomic_write_text(archive_path, body)


def load_latest_bundle(root: Path | str | None = None) -> Dict[str, dict]:
    resolved = ensure_storage(root)
    bundle: Dict[str, dict] = {}
    for stage in STAGES:
        payload = _read_json_if_exists(resolved / LATEST_DIRNAME / f"{stage}.json")
        if payload is not None:
            bundle[stage] = payload
    return bundle


def load_day_bundle(root: Path | str | None, date: str) -> Dict[str, dict]:
    resolved = resolve_root(root)
    day_dir = resolved / ARCHIVE_DIRNAME / normalize_history_date(date)
    if not day_dir.exists():
        raise FileNotFoundError(day_dir)
    bundle: Dict[str, dict] = {}
    for stage in STAGES:
        payload = _read_json_if_exists(day_dir / f"{stage}.json")
        if payload is not None:
            bundle[stage] = payload
    return bundle


def list_history_dates(root: Path | str | None = None) -> list[str]:
    resolved = resolve_root(root)
    archive_root = resolved / ARCHIVE_DIRNAME
    if not archive_root.exists():
        return []
    return sorted(
        [
            item.name
            for item in archive_root.iterdir()
            if item.is_dir() and _is_history_date(item.name)
        ],
        reverse=True,
    )


def _read_json_if_exists(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _to_json(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def normalize_history_date(date_str: str) -> str:
    candidate = str(date_str or "").strip()
    if not _is_history_date(candidate):
        raise ValueError(f"invalid history date: {date_str}")
    return candidate


def _is_history_date(value: str) -> bool:
    try:
        return date_cls.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _atomic_write_text(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(body)
        temp_path = Path(handle.name)
    temp_path.replace(path)
