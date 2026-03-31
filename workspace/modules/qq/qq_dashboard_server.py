#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import cgi
import json
import os
import re
import socket
import subprocess
import sys
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Sequence
from urllib.parse import unquote


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for ancestor in current.parents:
        if (ancestor / "workspace").is_dir():
            return ancestor
    return current.parents[-1]


REPO_ROOT = _repo_root()
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from workspace.modules.qq.status import build_status_payload

ENTRY_ROUTE = "/qq"
API_BOOTSTRAP = "/qq/api/bootstrap"
API_STATUS = "/qq/api/status"
API_CONFIG = "/qq/api/config"
API_STICKERS = "/qq/api/stickers"
API_STICKER_FOLDERS = "/qq/api/stickers/folders"
API_STICKER_UPLOAD = "/qq/api/stickers/upload"
ASSET_PREFIX = "/qq/assets/"

DEFAULT_CONFIG_CANDIDATES = (
    Path("/home/node/.openclaw/openclaw.json"),
    Path("/root/.openclaw/openclaw.json"),
    Path.home() / ".openclaw" / "openclaw.json",
)
DEFAULT_STATE_DIR = Path("/home/node/.openclaw/workspace/finance_system/qq_at_reply_state")
DEFAULT_LEGACY_STATE_PATH = Path("/home/node/.openclaw/workspace/finance_system/qq_at_reply_state.json")
DEFAULT_LOG_DIR = Path("/home/node/.openclaw/workspace/finance_system/logs")
DEFAULT_ASSET_DIR = Path(__file__).resolve().parent / "dashboard_assets"
DEFAULT_ATTACH_EXTRACTOR = REPO_ROOT / "workspace" / "finance_system" / "qq_attachment_extract.py"
KNOWN_LOG_FILES = (
    "qq_reply.log",
    "qq_direct.log",
    "qq_monitor.log",
    "qq_attachment.log",
    "qq_style.log",
)
ATTACHMENT_HINTS = [
    "Images and screenshots",
    "Office documents and text files",
    "CQ image URL extraction",
    "Graceful empty-state handling",
]
QR_DECODE_URL_PATTERN = re.compile(r"二维码解码URL:\s*(https?://\S+)")
LOGIN_ERROR_MARKER = "[Login] Login Error"
ACTIVE_MESSAGE_MARKERS = ("接收 <-", "发送 ->")
DEFAULT_NAPCAT_QR_PATH = "/app/napcat/cache/qrcode.png"
GROUP_PRIORITY_MIN = -10
GROUP_PRIORITY_MAX = 10
STICKER_INTENSITY_MIN = 0
STICKER_INTENSITY_MAX = 100
MAX_COOLDOWN_SECONDS = 86400
DEFAULT_STICKER_INTENSITY = 50
DEFAULT_COOLDOWN_SECONDS = 0
IMAGE_FILE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}


@dataclass(frozen=True)
class QQDashboardConfig:
    asset_dir: Path
    config_candidates: tuple[Path, ...] = DEFAULT_CONFIG_CANDIDATES
    state_dir: Path = DEFAULT_STATE_DIR
    legacy_state_path: Path = DEFAULT_LEGACY_STATE_PATH
    log_dir: Path = DEFAULT_LOG_DIR
    attach_extractor: Path = DEFAULT_ATTACH_EXTRACTOR
    napcat_container_name: str = "napcat-qq"
    napcat_qr_path: str = DEFAULT_NAPCAT_QR_PATH
    docker_bin: str = "docker"


def create_handler(config: QQDashboardConfig):
    class QQDashboardHandler(BaseHTTPRequestHandler):
        server_version = "OpenClawQQDashboard/1.0"

        def do_GET(self):
            path = unquote(self.path.split("?", 1)[0])
            if path == ENTRY_ROUTE:
                self._write_html(HTTPStatus.OK, load_qq_shell(config.asset_dir))
                return
            if path == API_BOOTSTRAP:
                self._write_json(HTTPStatus.OK, build_bootstrap_payload(config=config))
                return
            if path == API_STATUS:
                self._write_json(HTTPStatus.OK, build_runtime_status_payload(config=config))
                return
            if path == API_CONFIG:
                self._write_json(HTTPStatus.OK, build_dashboard_config_payload(config=config))
                return
            if path == API_STICKERS:
                self._write_json(HTTPStatus.OK, build_sticker_inventory_payload(config=config))
                return
            if path.startswith(ASSET_PREFIX):
                self._handle_asset(path)
                return
            self._write_text(HTTPStatus.NOT_FOUND, "Not Found", "text/plain; charset=utf-8")

        def do_POST(self):
            path = unquote(self.path.split("?", 1)[0])
            if path == API_CONFIG:
                self._handle_save_config()
                return
            if path == API_STICKER_FOLDERS:
                self._handle_create_sticker_folder()
                return
            if path == API_STICKER_UPLOAD:
                self._handle_upload_stickers()
                return
            self._write_text(HTTPStatus.NOT_FOUND, "Not Found", "text/plain; charset=utf-8")

        def log_message(self, format, *args):
            return

        def _handle_save_config(self):
            try:
                payload = self._read_json_body()
            except ValueError as exc:
                self._write_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "error": "INVALID_JSON",
                        "message": str(exc),
                    },
                )
                return

            normalized, errors = _validate_and_normalize_dashboard_config(payload)
            if errors:
                self._write_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "error": "VALIDATION_FAILED",
                        "message": "Fix the invalid fields and submit again.",
                        "details": errors,
                    },
                )
                return

            persisted, error_message = save_dashboard_config(config=config, normalized=normalized)
            if error_message:
                self._write_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "CONFIG_WRITE_FAILED",
                        "message": error_message,
                    },
                )
                return

            self._write_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "config": persisted,
                },
            )

        def _handle_create_sticker_folder(self):
            try:
                payload = self._read_json_body()
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "INVALID_JSON", "message": str(exc)})
                return

            config_doc, _ = _load_primary_config_document(config.config_candidates)
            qq_config = dict(((config_doc.get("channels") or {}).get("qq") or {}))
            sticker_settings = _extract_sticker_settings(qq_config)
            root_path = str(sticker_settings.get("rootPath") or "").strip()
            folder_name = _sanitize_sticker_folder_name(payload.get("name"))
            if not root_path:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "STICKER_ROOT_MISSING", "message": "Configure stickers.rootPath before creating folders."})
                return
            if not folder_name:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "INVALID_FOLDER_NAME", "message": "Provide a folder name using letters, numbers, spaces, hyphens, or underscores."})
                return

            created_path = ensure_sticker_folder(root_path=root_path, folder_name=folder_name)
            if created_path is None:
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "FOLDER_CREATE_FAILED", "message": "Could not create the sticker emotion directory."})
                return

            self._write_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "folder": folder_name,
                    "path": str(created_path),
                    "inventory": build_sticker_inventory_payload(config=config),
                },
            )

        def _handle_upload_stickers(self):
            config_doc, _ = _load_primary_config_document(config.config_candidates)
            qq_config = dict(((config_doc.get("channels") or {}).get("qq") or {}))
            sticker_settings = _extract_sticker_settings(qq_config)
            root_path = str(sticker_settings.get("rootPath") or "").strip()
            if not root_path:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "STICKER_ROOT_MISSING", "message": "Configure stickers.rootPath before uploading stickers."})
                return

            try:
                form = self._read_multipart_form()
            except ValueError as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "INVALID_MULTIPART", "message": str(exc)})
                return

            folder_name = _sanitize_sticker_folder_name(_form_value(form, "emotion"))
            if not folder_name:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": "INVALID_FOLDER_NAME", "message": "Choose an existing emotion folder or create a new one first."})
                return

            folder_path = ensure_sticker_folder(root_path=root_path, folder_name=folder_name)
            if folder_path is None:
                self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "FOLDER_CREATE_FAILED", "message": "Could not prepare the target emotion directory."})
                return

            uploaded = save_uploaded_sticker_files(folder_path=folder_path, form=form)
            if not uploaded["saved"]:
                self._write_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "error": "NO_VALID_FILES",
                        "message": "Upload one or more image files (.png, .jpg, .jpeg, .gif, .webp, .bmp).",
                        "rejected": uploaded["rejected"],
                    },
                )
                return

            self._write_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "folder": folder_name,
                    "saved": uploaded["saved"],
                    "rejected": uploaded["rejected"],
                    "inventory": build_sticker_inventory_payload(config=config),
                },
            )

        def _read_json_body(self):
            raw_length = self.headers.get("Content-Length") or "0"
            try:
                content_length = int(raw_length)
            except ValueError as exc:
                raise ValueError("Request body length is invalid.") from exc
            if content_length <= 0:
                raise ValueError("Request body is empty. Send JSON payload with groups and stickers.")
            raw_body = self.rfile.read(content_length)
            try:
                parsed = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("Request body must be valid UTF-8 JSON.") from exc
            if not isinstance(parsed, dict):
                raise ValueError("Request JSON must be an object.")
            return parsed

        def _read_multipart_form(self):
            environ = {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
            }
            try:
                form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=environ)
            except Exception as exc:
                raise ValueError("Request body must be multipart/form-data.") from exc
            return form

        def _handle_asset(self, path: str):
            filename = path[len(ASSET_PREFIX) :].strip("/")
            asset_path = _resolve_asset_path(config.asset_dir, filename)
            if not asset_path.exists() or not asset_path.is_file():
                self._write_text(HTTPStatus.NOT_FOUND, "Not Found", "text/plain; charset=utf-8")
                return
            if filename.endswith(".css"):
                content_type = "text/css; charset=utf-8"
            elif filename.endswith(".js"):
                content_type = "application/javascript; charset=utf-8"
            else:
                content_type = "text/html; charset=utf-8"
            self._write_bytes(HTTPStatus.OK, asset_path.read_bytes(), content_type)

        def _write_json(self, status: HTTPStatus, payload: dict):
            self._write_bytes(
                status,
                json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8",
            )

        def _write_html(self, status: HTTPStatus, html: str):
            self._write_bytes(status, html.encode("utf-8"), "text/html; charset=utf-8")

        def _write_text(self, status: HTTPStatus, text: str, content_type: str):
            self._write_bytes(status, text.encode("utf-8"), content_type)

        def _write_bytes(self, status: HTTPStatus, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    return QQDashboardHandler


def build_bootstrap_payload(*, config: QQDashboardConfig, now: str | None = None) -> dict:
    runtime = _build_runtime_context(config=config, now=now, log_line_limit=4)
    return {
        "module": "qq",
        "generatedAt": runtime["generatedAt"],
        "connection": runtime["connection"],
        "login": runtime["login"],
        "listener": runtime["listener"],
        "attachments": runtime["attachments"],
        "logs": runtime["logs"],
        "health": runtime["health"],
    }


def build_runtime_status_payload(*, config: QQDashboardConfig, now: str | None = None) -> dict:
    runtime = _build_runtime_context(config=config, now=now, log_line_limit=1)
    status_payload = build_status_payload(
        running=bool(runtime["listener"]["running"]),
        listener_count=int(runtime["listener"]["listenerCount"]),
        last_error=str(runtime["health"]["lastError"] or ""),
        generated_at=str(runtime["generatedAt"] or ""),
        summary=str(runtime["health"]["summary"] or ""),
    )
    status_payload["health"] = dict(runtime["health"])
    status_payload["connection"] = {
        "configured": bool(runtime["connection"]["configured"]),
        "hasToken": bool(runtime["connection"]["hasToken"]),
    }
    status_payload["login"] = dict(runtime["login"])
    status_payload["listener"] = {
        "running": bool(runtime["listener"]["running"]),
        "lastMessageIds": dict(runtime["listener"]["lastMessageIds"]),
    }
    status_payload["attachments"] = {
        "extractorConfigured": bool(runtime["attachments"]["extractorConfigured"]),
    }
    status_payload["groups"] = {
        "allowedCount": len(runtime["listener"]["groups"]),
        "monitoredCount": len(runtime["listener"]["monitoredGroups"]),
    }
    return status_payload


def load_qq_shell(asset_dir: Path) -> str:
    html_path = asset_dir / "qq_dashboard.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8")
    return render_fallback_shell()


def render_fallback_shell() -> str:
    return """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QQ Operations Dashboard</title>
    <link rel="stylesheet" href="/qq/assets/qq_dashboard.css" />
  </head>
  <body data-bootstrap-url="/qq/api/bootstrap" data-status-url="/qq/api/status">
    <main>
      <h1>QQ Operations Dashboard</h1>
      <p>QQ runtime data is loading.</p>
    </main>
    <script src="/qq/assets/qq_dashboard.js" defer></script>
  </body>
</html>"""


def _load_qq_channel_config(config_candidates: tuple[Path, ...]) -> dict:
    fallback: dict = {}
    for candidate in config_candidates:
        if not candidate.exists():
            continue
        try:
            raw = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        qq_config = dict(((raw.get("channels") or {}).get("qq") or {}))
        if qq_config:
            return qq_config
        if not fallback:
            fallback = qq_config
    return fallback


def _load_primary_config_document(config_candidates: tuple[Path, ...]) -> tuple[dict, Path | None]:
    fallback_doc: dict | None = None
    fallback_path: Path | None = None

    for candidate in config_candidates:
        if not candidate.exists():
            continue
        try:
            raw = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(raw, dict):
            continue
        qq_config = (raw.get("channels") or {}).get("qq") or {}
        if isinstance(qq_config, dict) and qq_config:
            return raw, candidate
        if fallback_doc is None:
            fallback_doc = raw
            fallback_path = candidate

    if fallback_doc is not None:
        return fallback_doc, fallback_path
    write_target = config_candidates[0] if config_candidates else None
    return {}, write_target


def _extract_sticker_settings(qq_config: dict) -> dict:
    sticker_packs = dict(qq_config.get("stickerPacks") or {})
    return {
        "enabled": _to_bool(sticker_packs.get("enabled"), default=False),
        "rootPath": str(sticker_packs.get("rootPath") or "").strip(),
        "mode": _normalize_sticker_mode(sticker_packs.get("mode")),
        "defaultIntensity": _to_int_with_default(
            sticker_packs.get("defaultIntensity"),
            default=DEFAULT_STICKER_INTENSITY,
        ),
        "defaultCooldown": _to_int_with_default(
            sticker_packs.get("cooldownSeconds"),
            default=DEFAULT_COOLDOWN_SECONDS,
        ),
    }


def _normalize_group_records(qq_config: dict) -> list[dict]:
    sticker_packs = dict(qq_config.get("stickerPacks") or {})
    default_intensity = _to_int_with_default(
        sticker_packs.get("defaultIntensity"),
        default=DEFAULT_STICKER_INTENSITY,
    )
    default_cooldown = _to_int_with_default(
        sticker_packs.get("cooldownSeconds"),
        default=DEFAULT_COOLDOWN_SECONDS,
    )
    allowed_groups = _parse_int_list(qq_config.get("allowedGroups") or qq_config.get("ambientChatGroups") or [])
    monitor_groups = qq_config.get("monitorGroups") or []

    records: dict[int, dict] = {}

    for group_id in allowed_groups:
        records[group_id] = {
            "groupId": group_id,
            "name": f"Group {group_id}",
            "focus": "",
            "enabled": True,
            "priority": 0,
            "replyEnabled": True,
            "stickerEnabled": True,
            "stickerIntensity": default_intensity,
            "cooldownSeconds": default_cooldown,
        }

    if isinstance(monitor_groups, list):
        for item in monitor_groups:
            if isinstance(item, dict):
                group_id = _to_int(item.get("groupId") or item.get("group_id") or item.get("id"))
            else:
                group_id = _to_int(item)
            if group_id is None:
                continue
            record = records.get(group_id)
            if record is None:
                record = {
                    "groupId": group_id,
                    "name": f"Group {group_id}",
                    "focus": "",
                    "enabled": group_id in allowed_groups,
                    "priority": 0,
                    "replyEnabled": group_id in allowed_groups,
                    "stickerEnabled": True,
                    "stickerIntensity": default_intensity,
                    "cooldownSeconds": default_cooldown,
                }
                records[group_id] = record
            if isinstance(item, dict):
                label = str(item.get("name") or item.get("label") or "").strip()
                if label:
                    record["name"] = label
                record["focus"] = str(item.get("focus") or "").strip()
                record["enabled"] = _to_bool(item.get("enabled"), default=record["enabled"])
                record["priority"] = _to_int_with_default(item.get("priority"), default=record["priority"])
                record["replyEnabled"] = _to_bool(item.get("replyEnabled"), default=record["enabled"])
                record["stickerEnabled"] = _to_bool(item.get("stickerEnabled"), default=record["stickerEnabled"])
                record["stickerIntensity"] = _to_int_with_default(
                    item.get("stickerIntensity"),
                    default=record["stickerIntensity"],
                )
                record["cooldownSeconds"] = _to_int_with_default(
                    item.get("cooldownSeconds"),
                    default=record["cooldownSeconds"],
                )

    normalized = sorted(records.values(), key=lambda item: int(item["groupId"]))
    return [_clamp_group_record(item) for item in normalized]


def _clamp_group_record(record: dict) -> dict:
    clamped = dict(record)
    clamped["name"] = str(clamped.get("name") or f"Group {clamped.get('groupId')}").strip()
    clamped["focus"] = str(clamped.get("focus") or "").strip()
    clamped["priority"] = max(GROUP_PRIORITY_MIN, min(GROUP_PRIORITY_MAX, _to_int_with_default(clamped.get("priority"), 0)))
    clamped["stickerIntensity"] = max(
        STICKER_INTENSITY_MIN,
        min(STICKER_INTENSITY_MAX, _to_int_with_default(clamped.get("stickerIntensity"), DEFAULT_STICKER_INTENSITY)),
    )
    clamped["cooldownSeconds"] = max(
        0,
        min(MAX_COOLDOWN_SECONDS, _to_int_with_default(clamped.get("cooldownSeconds"), DEFAULT_COOLDOWN_SECONDS)),
    )
    clamped["enabled"] = _to_bool(clamped.get("enabled"), default=False)
    clamped["replyEnabled"] = _to_bool(clamped.get("replyEnabled"), default=clamped["enabled"])
    clamped["stickerEnabled"] = _to_bool(clamped.get("stickerEnabled"), default=True)
    return clamped


def build_dashboard_config_payload(*, config: QQDashboardConfig, now: str | None = None) -> dict:
    config_doc, _ = _load_primary_config_document(config.config_candidates)
    qq_config = dict(((config_doc.get("channels") or {}).get("qq") or {}))
    normalized_groups = _normalize_group_records(qq_config)
    sticker_settings = _extract_sticker_settings(qq_config)
    return {
        "module": "qq",
        "generatedAt": _now_iso(now),
        "groups": normalized_groups,
        "stickers": sticker_settings,
    }


def save_dashboard_config(*, config: QQDashboardConfig, normalized: dict) -> tuple[dict, str]:
    config_doc, config_path = _load_primary_config_document(config.config_candidates)
    if config_path is None:
        return normalized, "No config file path is available for writing."

    channels_raw = config_doc.get("channels")
    if not isinstance(channels_raw, dict):
        channels_raw = {}
        config_doc["channels"] = channels_raw
    qq_raw = channels_raw.get("qq")
    if not isinstance(qq_raw, dict):
        qq_raw = {}
        channels_raw["qq"] = qq_raw

    groups = list(normalized.get("groups") or [])
    sticker_settings = dict(normalized.get("stickers") or {})
    allowed_group_ids = [int(item["groupId"]) for item in groups if bool(item.get("enabled"))]
    qq_raw["allowedGroups"] = allowed_group_ids
    if "ambientChatGroups" in qq_raw:
        qq_raw["ambientChatGroups"] = list(allowed_group_ids)

    qq_raw["monitorGroups"] = [
        {
            "groupId": int(item["groupId"]),
            "name": str(item.get("name") or f"Group {item['groupId']}"),
            "focus": str(item.get("focus") or ""),
            "enabled": bool(item.get("enabled")),
            "priority": int(item.get("priority") or 0),
            "replyEnabled": bool(item.get("replyEnabled")),
            "stickerEnabled": bool(item.get("stickerEnabled")),
            "stickerIntensity": int(item.get("stickerIntensity") or 0),
            "cooldownSeconds": int(item.get("cooldownSeconds") or 0),
        }
        for item in groups
    ]

    sticker_packs = dict(qq_raw.get("stickerPacks") or {})
    sticker_packs["enabled"] = bool(sticker_settings.get("enabled"))
    sticker_packs["rootPath"] = str(sticker_settings.get("rootPath") or "")
    sticker_packs["mode"] = _normalize_sticker_mode(sticker_settings.get("mode"))
    sticker_packs["defaultIntensity"] = max(
        STICKER_INTENSITY_MIN,
        min(
            STICKER_INTENSITY_MAX,
            _to_int_with_default(sticker_settings.get("defaultIntensity"), DEFAULT_STICKER_INTENSITY),
        ),
    )
    sticker_packs["cooldownSeconds"] = max(
        0,
        min(
            MAX_COOLDOWN_SECONDS,
            _to_int_with_default(sticker_settings.get("defaultCooldown"), DEFAULT_COOLDOWN_SECONDS),
        ),
    )
    qq_raw["stickerPacks"] = sticker_packs

    try:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps(config_doc, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        return normalized, f"Could not persist QQ config to {config_path}: {exc}"
    return normalized, ""


def _validate_and_normalize_dashboard_config(payload: dict) -> tuple[dict, list[dict]]:
    errors: list[dict] = []
    groups_raw = payload.get("groups")
    stickers_raw = payload.get("stickers")

    if groups_raw is None:
        groups_raw = []
    if not isinstance(groups_raw, list):
        errors.append(
            {
                "field": "groups",
                "message": "Use a JSON array for groups. Example: [{\"groupId\": 123456}].",
            }
        )
        groups_raw = []

    if stickers_raw is None:
        stickers_raw = {}
    if not isinstance(stickers_raw, dict):
        errors.append(
            {
                "field": "stickers",
                "message": "Use a JSON object for stickers. Example: {\"enabled\": true, \"rootPath\": \"/path\"}.",
            }
        )
        stickers_raw = {}

    normalized_groups: list[dict] = []
    seen_group_ids: set[int] = set()
    for index, item in enumerate(groups_raw):
        field_base = f"groups[{index}]"
        if not isinstance(item, dict):
            errors.append(
                {
                    "field": field_base,
                    "message": "Each group must be an object with groupId and policy fields.",
                }
            )
            continue

        item_has_error = False
        group_id = _to_int(item.get("groupId"))
        if group_id is None:
            item_has_error = True
            errors.append(
                {
                    "field": f"{field_base}.groupId",
                    "message": "Group ID must be numeric. Example: 1061966199.",
                }
            )
        elif group_id in seen_group_ids:
            item_has_error = True
            errors.append(
                {
                    "field": f"{field_base}.groupId",
                    "message": f"Group {group_id} appears more than once. Keep one record per group.",
                }
            )
        else:
            seen_group_ids.add(group_id)

        priority = _to_int(item.get("priority"))
        if priority is None or priority < GROUP_PRIORITY_MIN or priority > GROUP_PRIORITY_MAX:
            item_has_error = True
            errors.append(
                {
                    "field": f"{field_base}.priority",
                    "message": f"Priority must be an integer between {GROUP_PRIORITY_MIN} and {GROUP_PRIORITY_MAX}.",
                }
            )

        sticker_intensity = _to_int(item.get("stickerIntensity"))
        if (
            sticker_intensity is None
            or sticker_intensity < STICKER_INTENSITY_MIN
            or sticker_intensity > STICKER_INTENSITY_MAX
        ):
            item_has_error = True
            errors.append(
                {
                    "field": f"{field_base}.stickerIntensity",
                    "message": f"Sticker intensity must be an integer between {STICKER_INTENSITY_MIN} and {STICKER_INTENSITY_MAX}.",
                }
            )

        cooldown_seconds = _to_int(item.get("cooldownSeconds"))
        if cooldown_seconds is None or cooldown_seconds < 0 or cooldown_seconds > MAX_COOLDOWN_SECONDS:
            item_has_error = True
            errors.append(
                {
                    "field": f"{field_base}.cooldownSeconds",
                    "message": f"Cooldown must be an integer between 0 and {MAX_COOLDOWN_SECONDS} seconds.",
                }
            )

        if item_has_error or group_id is None or priority is None or sticker_intensity is None or cooldown_seconds is None:
            continue

        normalized_groups.append(
            {
                "groupId": group_id,
                "name": str(item.get("name") or f"Group {group_id}").strip(),
                "focus": str(item.get("focus") or "").strip(),
                "enabled": _to_bool(item.get("enabled"), default=True),
                "priority": priority,
                "replyEnabled": _to_bool(item.get("replyEnabled"), default=True),
                "stickerEnabled": _to_bool(item.get("stickerEnabled"), default=True),
                "stickerIntensity": sticker_intensity,
                "cooldownSeconds": cooldown_seconds,
            }
        )

    stickers_enabled = _to_bool(stickers_raw.get("enabled"), default=False)
    root_path = str(stickers_raw.get("rootPath") or "").strip()
    sticker_mode = _normalize_sticker_mode(stickers_raw.get("mode"))
    default_intensity = _to_int(stickers_raw.get("defaultIntensity"))
    default_cooldown = _to_int(stickers_raw.get("defaultCooldown"))
    if stickers_enabled and not root_path:
        errors.append(
            {
                "field": "stickers.rootPath",
                "message": "Set stickers.rootPath to a local folder when stickers are enabled.",
            }
        )
    if default_intensity is None or default_intensity < STICKER_INTENSITY_MIN or default_intensity > STICKER_INTENSITY_MAX:
        errors.append(
            {
                "field": "stickers.defaultIntensity",
                "message": f"Default sticker intensity must be an integer between {STICKER_INTENSITY_MIN} and {STICKER_INTENSITY_MAX}.",
            }
        )
    if default_cooldown is None or default_cooldown < 0 or default_cooldown > MAX_COOLDOWN_SECONDS:
        errors.append(
            {
                "field": "stickers.defaultCooldown",
                "message": f"Default cooldown must be an integer between 0 and {MAX_COOLDOWN_SECONDS} seconds.",
            }
        )

    normalized_stickers = {
        "enabled": stickers_enabled,
        "rootPath": root_path,
        "mode": sticker_mode,
        "defaultIntensity": default_intensity if default_intensity is not None else DEFAULT_STICKER_INTENSITY,
        "defaultCooldown": default_cooldown if default_cooldown is not None else DEFAULT_COOLDOWN_SECONDS,
    }
    normalized = {
        "groups": sorted(normalized_groups, key=lambda item: int(item["groupId"])),
        "stickers": normalized_stickers,
    }
    return normalized, errors


def build_sticker_inventory_payload(*, config: QQDashboardConfig, now: str | None = None) -> dict:
    config_doc, _ = _load_primary_config_document(config.config_candidates)
    qq_config = dict(((config_doc.get("channels") or {}).get("qq") or {}))
    sticker_settings = _extract_sticker_settings(qq_config)
    inventory = _scan_sticker_inventory(root_path=sticker_settings["rootPath"], enabled=sticker_settings["enabled"])
    return {
        "module": "qq",
        "generatedAt": _now_iso(now),
        "enabled": sticker_settings["enabled"],
        "rootPath": sticker_settings["rootPath"],
        "emotions": inventory["emotions"],
        "emotionCount": inventory["emotionCount"],
        "totalImages": inventory["totalImages"],
        "problems": inventory["problems"],
    }


def _scan_sticker_inventory(*, root_path: str, enabled: bool) -> dict:
    clean_root = root_path.strip()
    if not clean_root:
        problems = [] if not enabled else ["Sticker root path is empty while stickers are enabled."]
        return {"emotions": [], "emotionCount": 0, "totalImages": 0, "problems": problems}

    root = Path(clean_root)
    if not root.exists():
        return {
            "emotions": [],
            "emotionCount": 0,
            "totalImages": 0,
            "problems": [f"Sticker root path does not exist: {clean_root}"],
        }
    if not root.is_dir():
        return {
            "emotions": [],
            "emotionCount": 0,
            "totalImages": 0,
            "problems": [f"Sticker root path is not a directory: {clean_root}"],
        }

    emotions: list[dict] = []
    total_images = 0
    for child in sorted(root.iterdir(), key=lambda path: path.name.lower()):
        if not child.is_dir():
            continue
        count = 0
        for item in child.iterdir():
            if item.is_file() and item.suffix.lower() in IMAGE_FILE_EXTENSIONS:
                count += 1
        emotions.append({"emotion": child.name, "imageCount": count})
        total_images += count

    return {
        "emotions": emotions,
        "emotionCount": len(emotions),
        "totalImages": total_images,
        "problems": [],
    }


def ensure_sticker_folder(*, root_path: str, folder_name: str) -> Path | None:
    clean_name = _sanitize_sticker_folder_name(folder_name)
    clean_root = str(root_path or "").strip()
    if not clean_name or not clean_root:
        return None
    root = Path(clean_root)
    try:
        root.mkdir(parents=True, exist_ok=True)
        folder = _resolve_child_path(root, clean_name)
        folder.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return folder


def save_uploaded_sticker_files(*, folder_path: Path, form) -> dict:
    saved: list[str] = []
    rejected: list[str] = []
    fields = form["files"] if "files" in form else []
    if not isinstance(fields, list):
        fields = [fields]

    for field in fields:
        filename = os.path.basename(str(getattr(field, "filename", "") or ""))
        if not filename:
            continue
        suffix = Path(filename).suffix.lower()
        if suffix not in IMAGE_FILE_EXTENSIONS:
            rejected.append(filename)
            continue
        body = field.file.read() if getattr(field, "file", None) else b""
        if not body:
            rejected.append(filename)
            continue
        target = _dedupe_filename(folder_path, filename)
        try:
            target.write_bytes(body)
        except OSError:
            rejected.append(filename)
            continue
        saved.append(target.name)

    return {"saved": saved, "rejected": rejected}


def _dedupe_filename(folder_path: Path, filename: str) -> Path:
    candidate = _resolve_child_path(folder_path, filename)
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    index = 2
    while True:
        next_candidate = _resolve_child_path(folder_path, f"{stem}-{index}{suffix}")
        if not next_candidate.exists():
            return next_candidate
        index += 1


def _sanitize_sticker_folder_name(value) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    cleaned = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff ]+", "", raw).strip().replace(" ", "-")
    return cleaned[:64]


def _resolve_child_path(root: Path, child: str) -> Path:
    root_resolved = root.resolve()
    candidate = (root_resolved / child).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        return root_resolved / "__invalid__"
    return candidate


def _form_value(form, key: str) -> str:
    if key not in form:
        return ""
    field = form[key]
    if isinstance(field, list):
        field = field[0]
    return str(getattr(field, "value", "") or "")


def _build_runtime_context(*, config: QQDashboardConfig, now: str | None, log_line_limit: int) -> dict:
    generated_at = _now_iso(now)
    qq_config = _load_qq_channel_config(config.config_candidates)
    login = _build_login_payload(config=config, qq_config=qq_config)
    groups = _parse_int_list(qq_config.get("allowedGroups") or qq_config.get("ambientChatGroups") or [])
    monitored_groups = _parse_monitor_groups(qq_config.get("monitorGroups") or [])
    last_message_ids = _load_last_message_ids(
        groups=groups,
        monitored_groups=monitored_groups,
        state_dir=config.state_dir,
        legacy_state_path=config.legacy_state_path,
    )
    logs = _collect_log_sections(config.log_dir, line_limit=log_line_limit)
    listener_count = len(last_message_ids)
    configured = bool(str(qq_config.get("wsUrl") or "").strip())
    running = configured and (listener_count > 0 or any(section["lines"] for section in logs))
    last_error = _find_last_error(logs)
    summary = _build_summary(
        configured=configured,
        running=running,
        last_error=last_error,
        listener_count=listener_count,
    )
    return {
        "generatedAt": generated_at,
        "connection": {
            "configured": configured,
            "wsUrl": str(qq_config.get("wsUrl") or ""),
            "hasToken": bool(str(qq_config.get("accessToken") or "").strip()),
        },
        "login": login,
        "listener": {
            "running": running,
            "listenerCount": listener_count,
            "groups": groups,
            "monitoredGroups": monitored_groups,
            "lastMessageIds": last_message_ids,
        },
        "attachments": {
            "extractorConfigured": config.attach_extractor.exists(),
            "supportedHints": list(ATTACHMENT_HINTS),
        },
        "logs": logs,
        "health": {
            "level": _health_level(configured=configured, running=running, last_error=last_error),
            "summary": summary,
            "lastError": last_error,
        },
    }


def _parse_int_list(value) -> list[int]:
    items = value
    if isinstance(items, str):
        items = [part.strip() for part in items.split(",")]
    if not isinstance(items, list):
        return []

    result: list[int] = []
    for item in items:
        number = _to_int(item)
        if number is not None and number not in result:
            result.append(number)
    return result


def _parse_monitor_groups(value) -> list[dict]:
    if not isinstance(value, list):
        return []

    result: list[dict] = []
    for item in value:
        if isinstance(item, dict):
            group_id = _to_int(item.get("groupId") or item.get("group_id") or item.get("id"))
            name = str(item.get("name") or item.get("label") or "").strip()
        else:
            group_id = _to_int(item)
            name = ""
        if group_id is None:
            continue
        result.append({"groupId": group_id, "name": name or f"Group {group_id}"})
    return result


def _load_last_message_ids(
    *,
    groups: list[int],
    monitored_groups: list[dict],
    state_dir: Path,
    legacy_state_path: Path,
) -> dict[str, int]:
    result: dict[str, int] = {}
    candidate_ids = list(groups)
    for item in monitored_groups:
        group_id = _to_int(item.get("groupId"))
        if group_id is not None and group_id not in candidate_ids:
            candidate_ids.append(group_id)

    for group_id in candidate_ids:
        state = _load_state_file(state_dir / f"group_{group_id}.json")
        if state is None and group_id == 1061966199:
            state = _load_state_file(legacy_state_path)
        if state is None:
            continue
        result[str(group_id)] = int(state.get("last_message_id") or 0)
    return result


def _load_state_file(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(state, dict):
        return None
    return state


def _collect_log_sections(log_dir: Path, *, line_limit: int) -> list[dict]:
    sections: list[dict] = []
    for filename in KNOWN_LOG_FILES:
        path = log_dir / filename
        lines = _tail_lines(path, limit=line_limit)
        sections.append(
            {
                "name": filename.removesuffix(".log"),
                "path": str(path),
                "exists": path.exists(),
                "lines": lines,
            }
        )
    return sections


def _tail_lines(path: Path, *, limit: int) -> list[str]:
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-limit:]


def _find_last_error(log_sections: list[dict]) -> str:
    markers = ("ERROR", "CRITICAL", "Traceback", "failed")
    for section in reversed(log_sections):
        for line in reversed(section.get("lines") or []):
            if any(marker in line for marker in markers):
                return line
    return ""


def _build_summary(*, configured: bool, running: bool, last_error: str, listener_count: int) -> str:
    if last_error:
        return "QQ dashboard detected an error in recent runtime activity."
    if not configured:
        return "QQ channel is not configured yet. Add wsUrl and token to bring the module online."
    if running:
        return f"QQ listeners are active across {listener_count} tracked group slots."
    return "QQ is configured, but no listener state has been observed yet."


def _health_level(*, configured: bool, running: bool, last_error: str) -> str:
    if last_error:
        return "critical"
    if configured and running:
        return "good"
    return "warn"


def _build_login_payload(*, config: QQDashboardConfig, qq_config: dict) -> dict:
    logs_text = _docker_logs(config=config)
    qr_decode_url = _extract_qr_decode_url(logs_text)
    qr_data_url = _load_napcat_qr_data_url(config=config)
    last_error = _extract_login_error(logs_text)
    ws_url = str(qq_config.get("wsUrl") or "").strip()
    onebot_ready = _napcat_onebot_is_ready(config=config, ws_url=ws_url)
    recent_activity = _has_recent_message_activity(logs_text)

    if onebot_ready or recent_activity:
        status = "ready"
        summary = "NapCat OneBot is online. QQ login is active."
        qr_data_url = ""
        qr_decode_url = ""
    elif qr_data_url or qr_decode_url:
        status = "scan-required"
        summary = "NapCat is waiting for a QR scan. Use the code below to log QQ back in."
    elif last_error:
        status = "login-error"
        summary = "NapCat login is failing. Refresh the page after the next QR code appears."
    elif ws_url:
        status = "unknown"
        summary = "NapCat login status is unavailable. Open the QR flow again if QQ stays offline."
    else:
        status = "not-configured"
        summary = "QQ login is unavailable until the qq wsUrl is configured."

    return {
        "status": status,
        "requiresScan": bool(qr_data_url or qr_decode_url),
        "qrDataUrl": qr_data_url,
        "qrDecodeUrl": qr_decode_url,
        "lastError": last_error,
        "summary": summary,
    }


def _docker_logs(*, config: QQDashboardConfig) -> str:
    result = _run_command(
        [config.docker_bin, "logs", "--tail", "200", config.napcat_container_name],
        timeout=5,
    )
    if result is None:
        return ""
    return result.decode("utf-8", errors="replace")


def _load_napcat_qr_data_url(*, config: QQDashboardConfig) -> str:
    result = _run_command(
        [
            config.docker_bin,
            "exec",
            config.napcat_container_name,
            "sh",
            "-lc",
            f"cat {config.napcat_qr_path}",
        ],
        timeout=5,
    )
    if not result or not result.startswith(b"\x89PNG\r\n\x1a\n"):
        return ""
    return f"data:image/png;base64,{base64.b64encode(result).decode('ascii')}"


def _run_command(command: Sequence[str], *, timeout: int) -> bytes | None:
    try:
        completed = subprocess.run(
            list(command),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout


def _extract_qr_decode_url(logs_text: str) -> str:
    matches = QR_DECODE_URL_PATTERN.findall(logs_text)
    return matches[-1] if matches else ""


def _extract_login_error(logs_text: str) -> str:
    for line in reversed(logs_text.splitlines()):
        if LOGIN_ERROR_MARKER in line:
            return line.strip()
    return ""


def _has_recent_message_activity(logs_text: str) -> bool:
    for line in reversed(logs_text.splitlines()):
        if any(marker in line for marker in ACTIVE_MESSAGE_MARKERS):
            return True
    return False


def _napcat_onebot_is_ready(*, config: QQDashboardConfig, ws_url: str) -> bool:
    host = _resolve_napcat_host(config=config, ws_url=ws_url)
    port = _resolve_napcat_port(ws_url)
    if not host or port is None:
        return False
    try:
        with socket.create_connection((host, port), timeout=3):
            return True
    except OSError:
        return False


def _resolve_napcat_host(*, config: QQDashboardConfig, ws_url: str) -> str:
    container_ip = _docker_inspect_container_ip(config=config)
    if container_ip:
        return container_ip
    return _parse_ws_url(ws_url).get("host", "")


def _resolve_napcat_port(ws_url: str) -> int | None:
    parsed = _parse_ws_url(ws_url)
    if parsed.get("port") is not None:
        return int(parsed["port"])
    scheme = parsed.get("scheme", "ws")
    return 443 if scheme == "wss" else 80


def _docker_inspect_container_ip(*, config: QQDashboardConfig) -> str:
    result = _run_command(
        [
            config.docker_bin,
            "inspect",
            config.napcat_container_name,
            "--format",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        ],
        timeout=5,
    )
    if not result:
        return ""
    return result.decode("utf-8", errors="replace").strip()


def _parse_ws_url(ws_url: str) -> dict[str, str | int | None]:
    raw = ws_url.strip()
    if not raw:
        return {"scheme": "", "host": "", "port": None}
    match = re.match(r"^(?P<scheme>wss?)://(?P<host>[^/:]+)(?::(?P<port>\d+))?", raw)
    if not match:
        return {"scheme": "", "host": "", "port": None}
    port_raw = match.group("port")
    return {
        "scheme": match.group("scheme") or "",
        "host": match.group("host") or "",
        "port": int(port_raw) if port_raw else None,
    }


def _to_int(value) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def _normalize_sticker_mode(value) -> str:
    mode = str(value or "").strip()
    if mode in {"balanced", "text-only", "sticker-first"}:
        return mode
    return "balanced"


def _to_int_with_default(value, default: int) -> int:
    parsed = _to_int(value)
    if parsed is None:
        return default
    return parsed


def _to_bool(value, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _resolve_asset_path(asset_dir: Path, filename: str) -> Path:
    if not filename:
        return asset_dir / "__missing__"
    asset_root = asset_dir.resolve()
    candidate = (asset_root / filename).resolve()
    try:
        candidate.relative_to(asset_root)
    except ValueError:
        return asset_root / "__missing__"
    return candidate


def _now_iso(now: str | None) -> str:
    if now:
        return now
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenClaw QQ dashboard sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18891)
    parser.add_argument("--asset-dir", default=str(DEFAULT_ASSET_DIR))
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR))
    parser.add_argument("--legacy-state-path", default=str(DEFAULT_LEGACY_STATE_PATH))
    parser.add_argument("--log-dir", default=str(DEFAULT_LOG_DIR))
    parser.add_argument("--config", action="append", default=[])
    parser.add_argument("--now-override", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config_candidates = tuple(Path(item) for item in args.config) or DEFAULT_CONFIG_CANDIDATES
    config = QQDashboardConfig(
        asset_dir=Path(args.asset_dir),
        config_candidates=config_candidates,
        state_dir=Path(args.state_dir),
        legacy_state_path=Path(args.legacy_state_path),
        log_dir=Path(args.log_dir),
    )
    handler_cls = create_handler(config)
    server = ThreadingHTTPServer((args.host, args.port), handler_cls)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
