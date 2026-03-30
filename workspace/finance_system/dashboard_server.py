#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import date as date_cls
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

script_dir = Path(__file__).resolve().parent
workspace_root = script_dir.parent
project_root = workspace_root.parent
for candidate in (workspace_root, project_root):
    candidate_path = str(candidate)
    if candidate_path not in sys.path:
        sys.path.insert(0, candidate_path)

from finance_system.dashboard_access import (
    build_session_cookie_header,
    current_cn_date,
    parse_session_cookie_from_header,
    valid_until_for_date,
    validate_daily_key,
)
from finance_system.dashboard_contracts import (
    build_day_payload,
    build_error_payload,
    build_history_index_payload,
    build_status_payload,
)
from finance_system.dashboard_storage import DEFAULT_DATA_ROOT, list_history_dates, load_day_bundle, load_latest_bundle
from workspace.modules.finance.dashboard import build_finance_bootstrap_payload

ENTRY_ROUTE = "/finance"
ACCESS_PREFIX = "/finance/access/"
API_BOOTSTRAP = "/finance/api/bootstrap"
API_STATUS = "/finance/api/status"
API_HISTORY_INDEX = "/finance/api/history-index"
API_ARCHIVE_PREFIX = "/finance/api/archive/"
ASSET_PREFIX = "/finance/assets/"

__all__ = ["build_finance_bootstrap_payload"]

@dataclass(frozen=True)
class DashboardServerConfig:
    secret: str
    data_dir: Path
    asset_dir: Path
    now_override: str | None = None


def create_handler(config: DashboardServerConfig):
    class DashboardHandler(BaseHTTPRequestHandler):
        server_version = "OpenClawFinanceDashboard/1.0"

        def do_GET(self):
            path = unquote(self.path.split("?", 1)[0])
            if path == ENTRY_ROUTE:
                self._handle_finance()
                return
            if path.startswith(ACCESS_PREFIX):
                self._handle_access(path)
                return
            if path == API_BOOTSTRAP:
                self._handle_bootstrap()
                return
            if path == API_STATUS:
                self._handle_status()
                return
            if path == API_HISTORY_INDEX:
                self._handle_history_index()
                return
            if path.startswith(API_ARCHIVE_PREFIX):
                self._handle_archive(path)
                return
            if path.startswith(ASSET_PREFIX):
                self._handle_asset(path)
                return
            self._write_text(HTTPStatus.NOT_FOUND, "Not Found", "text/plain; charset=utf-8")

        def log_message(self, format, *args):
            return

        def _handle_finance(self):
            session = self._session()
            if not session["authorized"]:
                self._write_html(HTTPStatus.OK, render_gated_page())
                return
            self._write_html(HTTPStatus.OK, load_finance_shell(config.asset_dir))

        def _handle_access(self, path: str):
            key = path[len(ACCESS_PREFIX) :].strip("/")
            current_date = current_cn_date(config.now_override)
            if not key or not validate_daily_key(key, config.secret, current_date):
                self._write_html(HTTPStatus.OK, render_expired_page())
                return
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", ENTRY_ROUTE)
            self.send_header(
                "Set-Cookie",
                build_session_cookie_header(config.secret, current_date, now_iso=config.now_override),
            )
            self.end_headers()

        def _handle_bootstrap(self):
            if not self._require_api_session():
                return
            latest_bundle = load_latest_bundle(config.data_dir)
            if not latest_bundle:
                self._write_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    build_error_payload("FINANCE_DATA_UNAVAILABLE", "Finance dashboard data is not available yet."),
                )
                return
            date = self._resolve_selected_date(latest_bundle)
            history_dates = list_history_dates(config.data_dir)
            payload = build_day_payload(
                mode="latest",
                date=date,
                valid_until=valid_until_for_date(current_cn_date(config.now_override)),
                content=latest_bundle,
                history_dates=history_dates,
                authorized=True,
            )
            bootstrap_payload = build_finance_bootstrap_payload(
                date=date,
                history_dates=history_dates,
                delivery=payload,
            )
            self._write_json(HTTPStatus.OK, bootstrap_payload)

        def _handle_archive(self, path: str):
            if not self._require_api_session():
                return
            date = path[len(API_ARCHIVE_PREFIX) :].strip("/")
            if not _is_iso_date(date):
                self._write_json(
                    HTTPStatus.NOT_FOUND,
                    build_error_payload("FINANCE_ARCHIVE_NOT_FOUND", f"Archive not found for {date}."),
                )
                return
            try:
                bundle = load_day_bundle(config.data_dir, date)
            except (FileNotFoundError, ValueError):
                self._write_json(
                    HTTPStatus.NOT_FOUND,
                    build_error_payload("FINANCE_ARCHIVE_NOT_FOUND", f"Archive not found for {date}."),
                )
                return
            history_dates = list_history_dates(config.data_dir)
            payload = build_day_payload(
                mode="archive",
                date=date,
                valid_until=valid_until_for_date(current_cn_date(config.now_override)),
                content=bundle,
                history_dates=history_dates,
                authorized=True,
            )
            bootstrap_payload = build_finance_bootstrap_payload(
                date=date,
                history_dates=history_dates,
                delivery=payload,
            )
            self._write_json(HTTPStatus.OK, bootstrap_payload)

        def _handle_status(self):
            if not self._require_api_session():
                return
            latest_bundle = load_latest_bundle(config.data_dir)
            if not latest_bundle:
                self._write_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    build_error_payload("FINANCE_DATA_UNAVAILABLE", "Finance dashboard data is not available yet."),
                )
                return
            payload = build_status_payload(
                date=self._resolve_selected_date(latest_bundle),
                valid_until=valid_until_for_date(current_cn_date(config.now_override)),
                content=latest_bundle,
                now=_resolve_now_iso(config.now_override),
                authorized=True,
            )
            self._write_json(HTTPStatus.OK, payload)

        def _handle_history_index(self):
            if not self._require_api_session():
                return
            dates = list_history_dates(config.data_dir)
            latest_bundle = load_latest_bundle(config.data_dir)
            latest_date = self._resolve_selected_date(latest_bundle) if latest_bundle else (dates[0] if dates else "")
            payload = build_history_index_payload(latest_date=latest_date, available_dates=dates, authorized=True)
            self._write_json(HTTPStatus.OK, payload)

        def _handle_asset(self, path: str):
            if not self._require_api_session():
                return
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

        def _require_api_session(self) -> bool:
            session = self._session()
            if session["authorized"]:
                return True
            self._write_json(
                HTTPStatus.UNAUTHORIZED,
                build_error_payload("FINANCE_SESSION_REQUIRED", "Please open today's Telegram finance link first."),
            )
            return False

        def _session(self):
            cookie_header = self.headers.get("Cookie", "")
            return parse_session_cookie_from_header(cookie_header, config.secret, now_iso=config.now_override)

        def _resolve_selected_date(self, bundle: dict) -> str:
            index_payload = dict(bundle.get("index") or {})
            return str(index_payload.get("date") or next(iter(bundle.values()), {}).get("date") or current_cn_date(config.now_override))

        def _write_json(self, status: HTTPStatus, payload: dict):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._write_bytes(status, body, "application/json; charset=utf-8")

        def _write_html(self, status: HTTPStatus, html: str):
            self._write_bytes(status, html.encode("utf-8"), "text/html; charset=utf-8")

        def _write_text(self, status: HTTPStatus, text: str, content_type: str):
            self._write_bytes(status, text.encode("utf-8"), content_type)

        def _write_bytes(self, status: HTTPStatus, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Vary", "Cookie")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    return DashboardHandler


def load_finance_shell(asset_dir: Path) -> str:
    html_path = asset_dir / "finance_dashboard.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8")
    return render_fallback_shell()


def render_gated_page() -> str:
    return """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>需要当日私有链接 / Finance Access Required</title>
    <style>
      body { margin: 0; font-family: Georgia, 'Times New Roman', serif; background: #f6f3ed; color: #192534; }
      main { max-width: 720px; margin: 10vh auto; padding: 32px; background: #fffaf2; border: 1px solid #d7cab3; border-radius: 24px; }
      h1 { margin: 0 0 12px; font-size: 32px; }
      p { line-height: 1.7; }
    </style>
  </head>
  <body>
    <main>
      <h1>需要今日私有链接 / Finance Access Required</h1>
      <p>请从今日 Telegram 链接进入，系统会自动完成当日授权。</p>
      <p>Open the current-day Telegram link to create the finance session automatically.</p>
    </main>
  </body>
</html>"""


def render_expired_page() -> str:
    return """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>私有链接已失效 / Finance Link Expired</title>
    <style>
      body { margin: 0; font-family: Georgia, 'Times New Roman', serif; background: #fcf6ef; color: #2b2f3a; }
      main { max-width: 720px; margin: 10vh auto; padding: 32px; background: #ffffff; border: 1px solid #d9d0bf; border-radius: 24px; }
      a { color: #203a5b; }
    </style>
  </head>
  <body>
    <main>
      <h1>私有链接已失效 / Link Expired</h1>
      <p>该私有链接已失效，请从今日 Telegram 链接重新进入。</p>
      <p><a href="/finance">返回金融工作台入口 / Back to Finance entry</a></p>
    </main>
  </body>
</html>"""


def render_fallback_shell() -> str:
    return """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw Finance Dashboard</title>
  </head>
  <body>
    <div id="finance-dashboard-root">
      <header id="top-status-strip"></header>
      <main id="primary-market-canvas"></main>
      <aside id="ai-portfolio-panel"></aside>
      <section id="push-timeline"></section>
      <section id="history-workbench"></section>
      <aside id="live-rail"></aside>
    </div>
  </body>
</html>"""


def _resolve_now_iso(now_override: str | None) -> str:
    if now_override:
        return now_override
    return datetime_now_iso()


def _is_iso_date(value: str) -> bool:
    try:
        return date_cls.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


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


def datetime_now_iso() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenClaw finance dashboard sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18790)
    parser.add_argument("--secret", default="")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_ROOT))
    parser.add_argument("--asset-dir", default=str(Path(__file__).resolve().parent / "dashboard_assets"))
    parser.add_argument("--now-override", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.secret:
        raise SystemExit("missing --secret")
    config = DashboardServerConfig(
        secret=args.secret,
        data_dir=Path(args.data_dir),
        asset_dir=Path(args.asset_dir),
        now_override=args.now_override or None,
    )
    server = ThreadingHTTPServer((args.host, args.port), create_handler(config))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
