from __future__ import annotations

import argparse
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


def build_bootstrap_payload(*, connection: dict, listener: dict, logs: list[str]) -> dict:
    return {
        "module": "qq",
        "connection": dict(connection),
        "listener": dict(listener),
        "logs": list(logs),
    }


def route_status() -> tuple[int, dict]:
    payload = build_bootstrap_payload(
        connection={"running": True},
        listener={"count": 0},
        logs=[],
    )
    return HTTPStatus.OK, payload


def resolve_asset_dir(asset_dir: str | None = None) -> Path:
    if asset_dir:
        return Path(asset_dir).expanduser().resolve()
    return Path(__file__).resolve().parent / "dashboard_assets"


def _content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".html":
        return "text/html; charset=utf-8"
    if suffix == ".css":
        return "text/css; charset=utf-8"
    if suffix == ".js":
        return "application/javascript; charset=utf-8"
    if suffix == ".json":
        return "application/json; charset=utf-8"
    return "application/octet-stream"


def create_handler(asset_dir: Path):
    class QQDashboardHandler(BaseHTTPRequestHandler):
        server_version = "OpenClawQQDashboard/1.0"

        def do_GET(self):
            path = unquote(self.path.split("?", 1)[0])
            if path in {"/qq", "/qq/"}:
                return self._serve_file(asset_dir / "qq_dashboard.html")
            if path == "/qq/api/bootstrap":
                status, payload = route_status()
                return self._write_json(status, payload)
            if path.startswith("/qq/assets/"):
                rel = path[len("/qq/assets/") :].strip("/")
                if not rel or ".." in Path(rel).parts:
                    return self._write_text(HTTPStatus.NOT_FOUND, "Not Found")
                return self._serve_file(asset_dir / rel)
            return self._write_text(HTTPStatus.NOT_FOUND, "Not Found")

        def log_message(self, format, *args):
            return

        def _serve_file(self, file_path: Path):
            if not file_path.exists() or not file_path.is_file():
                return self._write_text(HTTPStatus.NOT_FOUND, "Not Found")
            payload = file_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", _content_type(file_path))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(payload)

        def _write_json(self, status: int, payload: dict):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

        def _write_text(self, status: int, payload: str):
            data = payload.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(data)

    return QQDashboardHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenClaw QQ dashboard sidecar")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18891)
    parser.add_argument("--asset-dir", default="")
    args = parser.parse_args()

    asset_dir = resolve_asset_dir(args.asset_dir or None)
    server = ThreadingHTTPServer((args.bind, args.port), create_handler(asset_dir))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
