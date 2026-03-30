from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

CONFIG_CANDIDATES = [
    Path("/root/.openclaw/openclaw.json"),
    Path("/home/node/.openclaw/openclaw.json"),
    Path.home() / ".openclaw" / "openclaw.json",
]
WORKSPACE_CANDIDATES = [
    Path("/root/.openclaw/workspace"),
    Path("/home/node/.openclaw/workspace"),
    Path.cwd(),
]
QR_IMAGE_CANDIDATES = [
    Path("/root/napcat_qrcode_live.png"),
    Path("/root/napcat_qrcode.png"),
]
NAPCAT_ONEBOT_CONFIG_CANDIDATES = [
    Path("/root/napcat/config/onebot11_1010679324.json"),
    Path("/root/napcat/config/onebot11.json"),
]


def build_bootstrap_payload(
    *,
    connection: dict,
    listener: dict,
    logs: list[str],
    account: dict | None = None,
    qr: dict | None = None,
    config: dict | None = None,
    automation: dict | None = None,
    messages: dict | None = None,
    alerts: list[str] | None = None,
) -> dict:
    return {
        "module": "qq",
        "connection": dict(connection),
        "listener": dict(listener),
        "logs": list(logs),
        "account": dict(account or {}),
        "qr": dict(qr or {}),
        "config": dict(config or {}),
        "automation": dict(automation or {}),
        "messages": dict(messages or {}),
        "alerts": list(alerts or []),
    }


def route_status() -> tuple[int, dict]:
    payload = build_bootstrap_payload(
        connection={"running": True},
        listener={"count": 0},
        logs=[],
        account={"loggedIn": False},
    )
    return HTTPStatus.OK, payload


def resolve_asset_dir(asset_dir: str | None = None) -> Path:
    if asset_dir:
        return Path(asset_dir).expanduser().resolve()
    return Path(__file__).resolve().parent / "dashboard_assets"


def resolve_config_path() -> Path:
    for candidate in CONFIG_CANDIDATES:
        if candidate.exists():
            return candidate
    return CONFIG_CANDIDATES[0]


def resolve_workspace_root() -> Path:
    for candidate in WORKSPACE_CANDIDATES:
        if candidate.exists():
            return candidate
    return WORKSPACE_CANDIDATES[0]


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_app_config(config_path: Path | None = None) -> dict:
    path = config_path or resolve_config_path()
    return read_json(path, {})


def save_app_config(payload: dict, config_path: Path | None = None) -> None:
    path = config_path or resolve_config_path()
    write_json(path, payload)


def qq_channel_config(config: dict) -> dict:
    return dict((((config.get("channels") or {}).get("qq")) or {}))


def locate_qr_image() -> Path | None:
    for candidate in QR_IMAGE_CANDIDATES:
        if candidate.exists():
            return candidate
    return None


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
    if suffix == ".png":
        return "image/png"
    return "application/octet-stream"


def _run_command(cmd: list[str]) -> tuple[bool, str]:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=30)
    except Exception as error:
        return False, str(error)
    output = (result.stdout or result.stderr or "").strip()
    return result.returncode == 0, output


def _docker_container_state(name: str) -> dict:
    ok, output = _run_command(
        ["docker", "inspect", name, "--format", "{{.State.Status}}|{{.State.Running}}|{{.Config.Image}}"]
    )
    if not ok or not output:
        return {"available": False, "running": False, "status": "missing", "image": ""}
    status, running, image = (output.split("|", 2) + ["", "", ""])[:3]
    return {
        "available": True,
        "running": running.strip().lower() == "true",
        "status": status.strip(),
        "image": image.strip(),
    }


def _docker_container_ip(name: str) -> str:
    ok, output = _run_command(
        ["docker", "inspect", "-f", "{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name]
    )
    return output.strip() if ok and output else ""


def _read_napcat_onebot_server() -> dict:
    for candidate in NAPCAT_ONEBOT_CONFIG_CANDIDATES:
        if not candidate.exists():
            continue
        payload = read_json(candidate, {})
        servers = ((((payload.get("network") or {}).get("websocketServers")) or []))
        if not servers:
            continue
        server = servers[0] or {}
        return {
            "host": str(server.get("host") or ""),
            "port": int(server.get("port") or 0),
            "token": str(server.get("token") or ""),
            "name": str(server.get("name") or ""),
        }
    return {"host": "", "port": 0, "token": "", "name": ""}


def resolve_runtime_onebot(qq_config: dict) -> dict:
    configured_ws = str(qq_config.get("wsUrl") or "")
    configured_token = str(qq_config.get("accessToken") or "")
    napcat_server = _read_napcat_onebot_server()
    container_ip = _docker_container_ip("napcat-qq")
    if napcat_server.get("port") and container_ip:
        return {
            "wsUrl": f"ws://{container_ip}:{napcat_server['port']}",
            "accessToken": str(napcat_server.get("token") or configured_token),
            "source": "napcat-config",
        }
    return {
        "wsUrl": configured_ws,
        "accessToken": configured_token,
        "source": "openclaw-config",
    }


async def _onebot_call(ws_url: str, token: str, action: str, params: dict, echo: str) -> dict:
    import websockets

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with websockets.connect(ws_url, additional_headers=headers, open_timeout=5, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps({"action": action, "params": params, "echo": echo}, ensure_ascii=False))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            payload = json.loads(raw)
            if payload.get("echo") == echo:
                return payload


def call_onebot(ws_url: str, token: str, action: str, params: dict | None = None) -> dict | None:
    if not ws_url:
        return None
    try:
        return asyncio.run(_onebot_call(ws_url, token, action, params or {}, f"qq-admin-{action}"))
    except Exception:
        return None


def get_login_info(qq_config: dict) -> dict:
    runtime = resolve_runtime_onebot(qq_config)
    payload = call_onebot(str(runtime.get("wsUrl") or ""), str(runtime.get("accessToken") or ""), "get_login_info")
    data = (payload or {}).get("data") or {}
    user_id = int(data.get("user_id") or 0)
    nickname = str(data.get("nickname") or "")
    return {
        "loggedIn": bool(user_id),
        "uin": user_id,
        "nickname": nickname,
    }


def get_recent_messages(qq_config: dict, group_id: int | None, limit: int = 20) -> list[dict]:
    if not group_id:
        return []
    runtime = resolve_runtime_onebot(qq_config)
    payload = call_onebot(
        str(runtime.get("wsUrl") or ""),
        str(runtime.get("accessToken") or ""),
        "get_group_msg_history",
        {"group_id": int(group_id)},
    )
    messages = list((((payload or {}).get("data") or {}).get("messages") or []))
    normalized: list[dict] = []
    for item in messages[: max(1, min(limit, 50))]:
        sender = item.get("sender") or {}
        normalized.append(
            {
                "messageId": item.get("message_id"),
                "userId": item.get("user_id") or sender.get("user_id"),
                "senderName": sender.get("nickname") or sender.get("card") or "",
                "time": item.get("time"),
                "rawMessage": item.get("raw_message") or "",
            }
        )
    return normalized


def _tail_lines(path: Path, limit: int = 20) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return []
    return lines[-limit:]


def _log_paths(workspace_root: Path) -> list[Path]:
    return [
        workspace_root / "qq_group_monitor.log",
        workspace_root / "finance_system" / "qq_at_auto_reply.log",
        workspace_root / "finance_system" / "qq_at_auto_reply_watch.log",
    ]


def _pick_default_group_id(qq_config: dict) -> int:
    allowed = qq_config.get("allowedGroups") or qq_config.get("ambientChatGroups") or []
    if isinstance(allowed, str):
        allowed = [part.strip() for part in allowed.split(",") if part.strip()]
    for item in allowed:
        try:
            return int(item)
        except Exception:
            continue
    groups = qq_config.get("monitorGroups") or []
    if isinstance(groups, list):
        for item in groups:
            try:
                return int((item or {}).get("groupId") or (item or {}).get("group_id") or 0)
            except Exception:
                continue
    return 0


def read_dashboard_snapshot(config_path: Path | None = None, workspace_root: Path | None = None) -> dict:
    config = load_app_config(config_path)
    qq_config = qq_channel_config(config)
    root = workspace_root or resolve_workspace_root()
    napcat = _docker_container_state("napcat-qq")
    runtime = resolve_runtime_onebot(qq_config)
    account = get_login_info(qq_config)
    default_group_id = _pick_default_group_id(qq_config)
    recent_messages = get_recent_messages(qq_config, default_group_id)
    qr_image = locate_qr_image()
    alerts: list[str] = []
    if not napcat["running"]:
        alerts.append("NapCat container is not running.")
    if not qq_config.get("wsUrl"):
        alerts.append("QQ wsUrl is not configured.")
    if not account.get("loggedIn"):
        alerts.append("QQ account is not logged in.")

    return build_bootstrap_payload(
        connection={
            "running": napcat["running"],
            "status": napcat["status"],
            "image": napcat["image"],
            "onebotConfigured": bool(qq_config.get("wsUrl")),
            "wsUrl": str(qq_config.get("wsUrl") or ""),
            "runtimeWsUrl": str(runtime.get("wsUrl") or ""),
            "runtimeSource": str(runtime.get("source") or ""),
            "napcatHttpUrl": "http://127.0.0.1:6099",
        },
        listener={
            "count": 1 if (root / "qq_group_monitor.mjs").exists() else 0,
            "defaultGroupId": default_group_id,
        },
        logs=[line for path in _log_paths(root) for line in _tail_lines(path, limit=6)][-20:],
        account=account,
        qr={
            "available": bool(qr_image),
            "imageUrl": "/qq/api/qr-image" if qr_image else "",
            "path": str(qr_image or ""),
        },
        config={
            "systemPrompt": str(qq_config.get("systemPrompt") or ""),
            "monitorAgentId": str(qq_config.get("monitorAgentId") or ""),
            "replyAgentId": str(qq_config.get("replyAgentId") or ""),
            "allowedGroups": qq_config.get("allowedGroups") or [],
            "monitorGroups": qq_config.get("monitorGroups") or [],
            "monitorSettings": qq_config.get("monitorSettings") or {},
            "stickerSettings": qq_config.get("stickerSettings") or {},
        },
        automation={
            "monitorScriptPresent": (root / "qq_group_monitor.mjs").exists(),
            "autoReplyScriptPresent": (root / "finance_system" / "qq_at_auto_reply.py").exists(),
            "monitorLogPath": str(root / "qq_group_monitor.log"),
            "autoReplyLogPath": str(root / "finance_system" / "qq_at_auto_reply.log"),
            "enabled": bool((qq_config.get("monitorSettings") or {}).get("enabled", True)),
        },
        messages={
            "defaultGroupId": default_group_id,
            "recent": recent_messages,
        },
        alerts=alerts,
    )


def update_qq_config(payload: dict, config_path: Path | None = None) -> dict:
    config = load_app_config(config_path)
    channels = config.setdefault("channels", {})
    qq = channels.setdefault("qq", {})
    for key in ("systemPrompt", "monitorAgentId", "replyAgentId"):
        if key in payload:
            qq[key] = payload[key]
    if "monitorSettings" in payload and isinstance(payload["monitorSettings"], dict):
        qq["monitorSettings"] = payload["monitorSettings"]
    if "stickerSettings" in payload and isinstance(payload["stickerSettings"], dict):
        qq["stickerSettings"] = payload["stickerSettings"]
    if "allowedGroups" in payload:
        qq["allowedGroups"] = payload["allowedGroups"]
    save_app_config(config, config_path)
    return qq


def execute_action(action: str, payload: dict, config_path: Path | None = None) -> dict:
    if action == "restart-napcat":
        ok, output = _run_command(["docker", "restart", "napcat-qq"])
        return {"ok": ok, "output": output}
    if action == "restart-automation":
        workspace_root = resolve_workspace_root()
        candidates = [
            workspace_root / "finance_system" / "ensure_qq_at_listeners.sh",
            workspace_root / "finance_system" / "ensure_qq_at_multi_listener.sh",
        ]
        script = next((path for path in candidates if path.exists()), None)
        if not script:
            return {"ok": False, "error": "No automation restart script found."}
        ok, output = _run_command(["bash", str(script)])
        return {"ok": ok, "output": output}
    if action == "send-message":
        config = load_app_config(config_path)
        qq = qq_channel_config(config)
        target = int(payload.get("groupId") or _pick_default_group_id(qq) or 0)
        message = str(payload.get("message") or "")
        result = call_onebot(
            str(qq.get("wsUrl") or ""),
            str(qq.get("accessToken") or ""),
            "send_group_msg",
            {"group_id": target, "message": message},
        )
        return {"ok": bool(result and result.get("status") == "ok"), "result": result}
    if action == "send-sticker":
        config = load_app_config(config_path)
        qq = qq_channel_config(config)
        target = int(payload.get("groupId") or _pick_default_group_id(qq) or 0)
        image_ref = str(payload.get("imageRef") or "")
        message = f"[CQ:image,file={image_ref}]"
        result = call_onebot(
            str(qq.get("wsUrl") or ""),
            str(qq.get("accessToken") or ""),
            "send_group_msg",
            {"group_id": target, "message": message},
        )
        return {"ok": bool(result and result.get("status") == "ok"), "result": result}
    return {"ok": False, "error": f"Unknown action: {action}"}


def create_handler(asset_dir: Path, config_path: Path):
    class QQDashboardHandler(BaseHTTPRequestHandler):
        server_version = "OpenClawQQDashboard/2.0"

        def do_GET(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            if path in {"/qq", "/qq/"}:
                return self._serve_file(asset_dir / "qq_dashboard.html")
            if path == "/qq/api/bootstrap":
                return self._write_json(HTTPStatus.OK, read_dashboard_snapshot(config_path=config_path))
            if path == "/qq/api/config":
                return self._write_json(HTTPStatus.OK, read_dashboard_snapshot(config_path=config_path).get("config", {}))
            if path == "/qq/api/messages":
                config = load_app_config(config_path)
                qq = qq_channel_config(config)
                group_id = int((query.get("groupId") or [0])[0] or 0) or _pick_default_group_id(qq)
                limit = int((query.get("limit") or [20])[0] or 20)
                return self._write_json(HTTPStatus.OK, {"groupId": group_id, "messages": get_recent_messages(qq, group_id, limit)})
            if path == "/qq/api/qr-image":
                qr_image = locate_qr_image()
                if not qr_image:
                    return self._write_text(HTTPStatus.NOT_FOUND, "QR image unavailable")
                return self._serve_file(qr_image)
            if path.startswith("/qq/assets/"):
                rel = path[len("/qq/assets/") :].strip("/")
                if not rel or ".." in Path(rel).parts:
                    return self._write_text(HTTPStatus.NOT_FOUND, "Not Found")
                return self._serve_file(asset_dir / rel)
            return self._write_text(HTTPStatus.NOT_FOUND, "Not Found")

        def do_POST(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            payload = self._read_json()
            if path == "/qq/api/config":
                return self._write_json(HTTPStatus.OK, {"ok": True, "config": update_qq_config(payload, config_path)})
            if path.startswith("/qq/api/actions/"):
                action = path[len("/qq/api/actions/") :].strip("/")
                return self._write_json(HTTPStatus.OK, execute_action(action, payload, config_path))
            return self._write_text(HTTPStatus.NOT_FOUND, "Not Found")

        def log_message(self, format, *args):
            return

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception:
                return {}

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
    parser.add_argument("--config-path", default="")
    args = parser.parse_args()

    asset_dir = resolve_asset_dir(args.asset_dir or None)
    config_path = Path(args.config_path).expanduser().resolve() if args.config_path else resolve_config_path()
    server = ThreadingHTTPServer((args.bind, args.port), create_handler(asset_dir, config_path))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
