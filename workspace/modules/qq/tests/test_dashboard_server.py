from __future__ import annotations

import json
import tempfile
import threading
import urllib.error
import urllib.request
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from workspace.modules.qq.qq_dashboard_server import (
    QQDashboardConfig,
    build_bootstrap_payload,
    build_runtime_status_payload,
    create_handler,
    load_qq_shell,
)


class QQDashboardServerTest(unittest.TestCase):
    def test_static_assets_expose_i18n_controls(self) -> None:
        repo_root = Path(__file__).resolve().parents[4]
        html = (
            repo_root / "workspace" / "modules" / "qq" / "dashboard_assets" / "qq_dashboard.html"
        ).read_text(encoding="utf-8")
        js = (
            repo_root / "workspace" / "modules" / "qq" / "dashboard_assets" / "qq_dashboard.js"
        ).read_text(encoding="utf-8")

        self.assertIn("data-language-toggle", html)
        self.assertIn("data-language-label", html)
        self.assertIn("data-login-panel", html)
        self.assertIn("data-login-qr", html)
        self.assertIn("data-group-rows", html)
        self.assertIn("data-group-add", html)
        self.assertIn("data-config-save", html)
        self.assertIn("data-sticker-root", html)
        self.assertIn("data-sticker-packs", html)
        self.assertIn("data-sticker-folder-select", html)
        self.assertIn("data-sticker-folder-create", html)
        self.assertIn("data-sticker-upload-files", html)
        self.assertIn("data-sticker-upload", html)
        self.assertIn("var TRANSLATIONS =", js)
        self.assertIn('"zh-CN"', js)
        self.assertIn('"en"', js)
        self.assertIn("renderLoginPanel", js)
        self.assertIn("renderConfigEditors", js)
        self.assertIn("handleConfigSave", js)
        self.assertIn("loadStickerInventory", js)
        self.assertIn("handleStickerUpload", js)
        self.assertIn("handleStickerFolderCreate", js)

    def test_bootstrap_payload_stays_qq_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            state_dir = root / "state"
            asset_dir = root / "assets"
            log_dir = root / "logs"
            state_dir.mkdir()
            asset_dir.mkdir()
            log_dir.mkdir()

            config_path.write_text(
                json.dumps(
                    {
                        "channels": {
                            "qq": {
                                "wsUrl": "ws://localhost:8080",
                                "accessToken": "token-1",
                                "allowedGroups": [101, 202],
                                "monitorGroups": [{"groupId": 303, "name": "Ops"}],
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            (state_dir / "group_101.json").write_text(
                json.dumps({"last_message_id": 88, "replied_message_ids": [77, 88]}),
                encoding="utf-8",
            )
            (log_dir / "qq_reply.log").write_text(
                "2026-03-30 08:00:00 - qq_reply - INFO - listener ready\n",
                encoding="utf-8",
            )

            payload = build_bootstrap_payload(
                config=QQDashboardConfig(
                    asset_dir=asset_dir,
                    config_candidates=(config_path,),
                    state_dir=state_dir,
                    legacy_state_path=root / "legacy.json",
                    log_dir=log_dir,
                ),
                now="2026-03-30T08:00:00+08:00",
            )

        self.assertEqual(payload["module"], "qq")
        self.assertEqual(payload["connection"]["wsUrl"], "ws://localhost:8080")
        self.assertTrue(payload["connection"]["hasToken"])
        self.assertEqual(payload["listener"]["listenerCount"], 1)
        self.assertEqual(payload["listener"]["groups"], [101, 202])
        self.assertEqual(payload["listener"]["monitoredGroups"][0]["groupId"], 303)
        self.assertEqual(payload["listener"]["lastMessageIds"]["101"], 88)
        self.assertTrue(payload["logs"][0]["exists"])
        self.assertIn("login", payload)
        self.assertNotIn("finance", payload)

    def test_bootstrap_payload_includes_login_qr_when_scan_pending(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://napcat-qq:3001", "accessToken": "token-1"}}}),
                encoding="utf-8",
            )

            with patch(
                "workspace.modules.qq.qq_dashboard_server._build_login_payload",
                return_value={
                    "requiresScan": True,
                    "qrDataUrl": "data:image/png;base64,qr-image",
                    "qrDecodeUrl": "https://txz.qq.com/p?k=test",
                    "status": "scan-required",
                    "summary": "Scan required",
                    "webUiUrl": "http://127.0.0.1:6099",
                },
            ):
                payload = build_bootstrap_payload(
                    config=QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    ),
                    now="2026-03-31T21:20:00+08:00",
                )

        self.assertEqual(payload["login"]["status"], "scan-required")
        self.assertTrue(payload["login"]["requiresScan"])
        self.assertEqual(payload["login"]["qrDataUrl"], "data:image/png;base64,qr-image")
        self.assertEqual(payload["login"]["qrDecodeUrl"], "https://txz.qq.com/p?k=test")

    def test_bootstrap_payload_prefers_online_status_over_stale_qr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://napcat-qq:3001", "accessToken": "token-1"}}}),
                encoding="utf-8",
            )

            with patch(
                "workspace.modules.qq.qq_dashboard_server._docker_logs",
                return_value="03-31 21:43:30 [info] Corn | 接收 <- 群聊 [test] [user] hello\n",
            ), patch(
                "workspace.modules.qq.qq_dashboard_server._load_napcat_qr_data_url",
                return_value="data:image/png;base64,stale-qr",
            ), patch(
                "workspace.modules.qq.qq_dashboard_server._napcat_onebot_is_ready",
                return_value=True,
            ):
                payload = build_bootstrap_payload(
                    config=QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    ),
                    now="2026-03-31T21:20:00+08:00",
                )

        self.assertEqual(payload["login"]["status"], "ready")
        self.assertFalse(payload["login"]["requiresScan"])
        self.assertEqual(payload["login"]["qrDataUrl"], "")

    def test_bootstrap_payload_treats_recent_message_logs_as_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://napcat-qq:3001", "accessToken": "token-1"}}}),
                encoding="utf-8",
            )

            with patch(
                "workspace.modules.qq.qq_dashboard_server._docker_logs",
                return_value="03-31 21:43:30 [info] Corn | 接收 <- 群聊 [test] [user] hello\n",
            ), patch(
                "workspace.modules.qq.qq_dashboard_server._load_napcat_qr_data_url",
                return_value="data:image/png;base64,stale-qr",
            ), patch(
                "workspace.modules.qq.qq_dashboard_server._napcat_onebot_is_ready",
                return_value=False,
            ):
                payload = build_bootstrap_payload(
                    config=QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    ),
                    now="2026-03-31T21:20:00+08:00",
                )

        self.assertEqual(payload["login"]["status"], "ready")
        self.assertFalse(payload["login"]["requiresScan"])
        self.assertEqual(payload["login"]["qrDataUrl"], "")

    def test_bootstrap_payload_handles_missing_runtime_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset_dir = root / "assets"
            asset_dir.mkdir()

            payload = build_bootstrap_payload(
                config=QQDashboardConfig(
                    asset_dir=asset_dir,
                    config_candidates=(root / "missing.json",),
                    state_dir=root / "missing-state",
                    legacy_state_path=root / "missing-legacy.json",
                    log_dir=root / "missing-logs",
                ),
                now="2026-03-30T08:05:00+08:00",
            )

        self.assertFalse(payload["connection"]["configured"])
        self.assertEqual(payload["listener"]["listenerCount"], 0)
        self.assertEqual(payload["listener"]["groups"], [])
        self.assertEqual(payload["health"]["level"], "warn")
        self.assertEqual(payload["health"]["lastError"], "")
        self.assertTrue(payload["logs"])
        self.assertTrue(all(not entry["exists"] for entry in payload["logs"]))

    def test_load_qq_shell_falls_back_when_asset_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            asset_dir = Path(tmp)
            shell = load_qq_shell(asset_dir)

        self.assertIn("QQ Operations Dashboard", shell)
        self.assertIn("data-bootstrap-url", shell)
        self.assertIn("/qq/assets/qq_dashboard.css", shell)
        self.assertIn("/qq/assets/qq_dashboard.js", shell)

    def test_config_discovery_uses_later_candidate_with_qq_section(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset_dir = root / "assets"
            asset_dir.mkdir()
            first = root / "first.json"
            second = root / "second.json"
            first.write_text(json.dumps({"channels": {"telegram": {"token": "x"}}}), encoding="utf-8")
            second.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://localhost:8080", "allowedGroups": [11]}}}),
                encoding="utf-8",
            )

            payload = build_bootstrap_payload(
                config=QQDashboardConfig(
                    asset_dir=asset_dir,
                    config_candidates=(first, second),
                    state_dir=root / "state",
                    legacy_state_path=root / "legacy.json",
                    log_dir=root / "logs",
                ),
                now="2026-03-30T08:05:00+08:00",
            )

        self.assertTrue(payload["connection"]["configured"])
        self.assertEqual(payload["listener"]["groups"], [11])

    def test_runtime_status_payload_is_lighter_than_bootstrap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            state_dir = root / "state"
            asset_dir = root / "assets"
            log_dir = root / "logs"
            state_dir.mkdir()
            asset_dir.mkdir()
            log_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://localhost:8080", "allowedGroups": [7]}}}),
                encoding="utf-8",
            )
            (state_dir / "group_7.json").write_text(json.dumps({"last_message_id": 99}), encoding="utf-8")
            (log_dir / "qq_reply.log").write_text("2026-03-30 ERROR broken\n", encoding="utf-8")

            payload = build_runtime_status_payload(
                config=QQDashboardConfig(
                    asset_dir=asset_dir,
                    config_candidates=(config_path,),
                    state_dir=state_dir,
                    legacy_state_path=root / "legacy.json",
                    log_dir=log_dir,
                ),
                now="2026-03-30T08:00:00+08:00",
            )

        self.assertEqual(payload["module"], "qq")
        self.assertEqual(payload["groups"]["allowedCount"], 1)
        self.assertTrue(payload["listener"]["running"])
        self.assertIn("login", payload)
        self.assertNotIn("logs", payload)

    def test_runtime_status_does_not_report_good_when_config_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset_dir = root / "assets"
            log_dir = root / "logs"
            asset_dir.mkdir()
            log_dir.mkdir()
            (log_dir / "qq_reply.log").write_text("2026-03-30 INFO stale line\n", encoding="utf-8")

            payload = build_runtime_status_payload(
                config=QQDashboardConfig(
                    asset_dir=asset_dir,
                    config_candidates=(root / "missing.json",),
                    state_dir=root / "state",
                    legacy_state_path=root / "legacy.json",
                    log_dir=log_dir,
                ),
                now="2026-03-30T08:00:00+08:00",
            )

        self.assertFalse(payload["connection"]["configured"])
        self.assertFalse(payload["running"])
        self.assertEqual(payload["health"]["level"], "warn")

    def test_config_api_returns_normalized_group_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps(
                    {
                        "channels": {
                            "qq": {
                                "wsUrl": "ws://localhost:8080",
                                "allowedGroups": [1001, 1002],
                                "monitorGroups": [
                                    {"groupId": 1001, "name": "Alpha", "priority": 2, "focus": "alerts"},
                                    {"groupId": 1003, "name": "Gamma", "enabled": False},
                                ],
                                "stickerPacks": {"enabled": True, "rootPath": "/tmp/stickers"},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                create_handler(
                    QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    )
                ),
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            try:
                payload = json.loads(
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/qq/api/config").read().decode("utf-8")
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

        self.assertEqual(payload["module"], "qq")
        self.assertEqual(payload["stickers"]["rootPath"], "/tmp/stickers")
        self.assertEqual(payload["stickers"]["mode"], "balanced")
        self.assertEqual(payload["stickers"]["defaultIntensity"], 50)
        self.assertEqual(payload["stickers"]["defaultCooldown"], 0)
        self.assertEqual({item["groupId"] for item in payload["groups"]}, {1001, 1002, 1003})
        by_id = {item["groupId"]: item for item in payload["groups"]}
        self.assertTrue(by_id[1001]["enabled"])
        self.assertEqual(by_id[1001]["name"], "Alpha")
        self.assertEqual(by_id[1001]["focus"], "alerts")
        self.assertFalse(by_id[1003]["enabled"])

    def test_config_api_post_persists_qq_group_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://localhost:8080", "accessToken": "token"}}}),
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                create_handler(
                    QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    )
                ),
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            payload = {
                "groups": [
                    {
                        "groupId": 2001,
                        "name": "Trading",
                        "focus": "risk",
                        "enabled": True,
                        "priority": 3,
                        "replyEnabled": True,
                        "stickerEnabled": True,
                        "stickerIntensity": 60,
                        "cooldownSeconds": 45,
                    },
                    {
                        "groupId": 2002,
                        "name": "Muted",
                        "focus": "",
                        "enabled": False,
                        "priority": -1,
                        "replyEnabled": False,
                        "stickerEnabled": False,
                        "stickerIntensity": 0,
                        "cooldownSeconds": 0,
                    },
                ],
                "stickers": {
                    "enabled": True,
                    "rootPath": str(root / "stickers"),
                    "mode": "balanced",
                    "defaultIntensity": 70,
                    "defaultCooldown": 90,
                },
            }
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/qq/api/config",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                response_payload = json.loads(urllib.request.urlopen(request).read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            raw = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertTrue(response_payload["ok"])
        qq_config = raw["channels"]["qq"]
        self.assertEqual(qq_config["allowedGroups"], [2001])
        self.assertEqual(len(qq_config["monitorGroups"]), 2)
        self.assertEqual(qq_config["monitorGroups"][0]["groupId"], 2001)
        self.assertEqual(qq_config["monitorGroups"][0]["focus"], "risk")
        self.assertEqual(qq_config["monitorGroups"][1]["groupId"], 2002)
        self.assertTrue(qq_config["stickerPacks"]["enabled"])
        self.assertEqual(qq_config["stickerPacks"]["mode"], "balanced")
        self.assertEqual(qq_config["stickerPacks"]["defaultIntensity"], 70)
        self.assertEqual(qq_config["stickerPacks"]["cooldownSeconds"], 90)

    def test_config_api_post_rejects_invalid_payload_with_actionable_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://localhost:8080"}}}),
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                create_handler(
                    QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    )
                ),
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            payload = {
                "groups": [
                    {
                        "groupId": "abc",
                        "name": "Invalid",
                        "focus": "",
                        "enabled": True,
                        "priority": 999,
                        "replyEnabled": True,
                        "stickerEnabled": True,
                        "stickerIntensity": 500,
                        "cooldownSeconds": -1,
                    }
                ],
                "stickers": {
                    "enabled": True,
                    "rootPath": "",
                    "mode": "balanced",
                    "defaultIntensity": 200,
                    "defaultCooldown": -1,
                },
            }
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/qq/api/config",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as context:
                    urllib.request.urlopen(request)
                self.assertEqual(context.exception.code, 400)
                error_payload = json.loads(context.exception.read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

        self.assertEqual(error_payload["error"], "VALIDATION_FAILED")
        fields = {item["field"] for item in error_payload["details"]}
        self.assertIn("groups[0].groupId", fields)
        self.assertIn("groups[0].priority", fields)
        self.assertIn("groups[0].stickerIntensity", fields)
        self.assertIn("groups[0].cooldownSeconds", fields)
        self.assertIn("stickers.rootPath", fields)
        self.assertIn("stickers.defaultIntensity", fields)
        self.assertIn("stickers.defaultCooldown", fields)

    def test_stickers_api_scans_immediate_emotion_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            sticker_root = root / "stickers"
            happy_dir = sticker_root / "happy"
            calm_dir = sticker_root / "calm"
            nested_dir = happy_dir / "nested"
            nested_dir.mkdir(parents=True)
            calm_dir.mkdir(parents=True)
            asset_dir.mkdir()
            (happy_dir / "a.png").write_text("x", encoding="utf-8")
            (happy_dir / "b.jpg").write_text("x", encoding="utf-8")
            (happy_dir / "readme.txt").write_text("x", encoding="utf-8")
            (nested_dir / "deep.png").write_text("x", encoding="utf-8")
            (calm_dir / "c.webp").write_text("x", encoding="utf-8")
            config_path.write_text(
                json.dumps(
                    {
                        "channels": {
                            "qq": {
                                "stickerPacks": {"enabled": True, "rootPath": str(sticker_root)},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                create_handler(
                    QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    )
                ),
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            try:
                payload = json.loads(
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/qq/api/stickers").read().decode("utf-8")
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

        self.assertEqual(payload["rootPath"], str(sticker_root))
        self.assertEqual(payload["emotionCount"], 2)
        self.assertEqual(payload["totalImages"], 3)
        emotions = {item["emotion"]: item["imageCount"] for item in payload["emotions"]}
        self.assertEqual(emotions["happy"], 2)
        self.assertEqual(emotions["calm"], 1)
        self.assertEqual(payload["problems"], [])

    def test_sticker_folder_api_creates_new_emotion_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            sticker_root = root / "stickers"
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"stickerPacks": {"enabled": True, "rootPath": str(sticker_root)}}}}),
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                create_handler(
                    QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    )
                ),
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/qq/api/stickers/folders",
                    data=json.dumps({"name": "happy"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                payload = json.loads(urllib.request.urlopen(request).read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["folder"], "happy")
            self.assertTrue(Path(payload["path"]).is_dir())

    def test_sticker_upload_api_saves_multiple_images_and_dedupes_names(self) -> None:
        boundary = "----OpenClawFormBoundary"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="emotion"\r\n\r\n'
            "happy\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="files"; filename="wave.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
            "png-one\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="files"; filename="wave.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
            "png-two\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="files"; filename="notes.txt"\r\n'
            "Content-Type: text/plain\r\n\r\n"
            "not-image\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            asset_dir = root / "assets"
            sticker_root = root / "stickers"
            (sticker_root / "happy").mkdir(parents=True)
            asset_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"stickerPacks": {"enabled": True, "rootPath": str(sticker_root)}}}}),
                encoding="utf-8",
            )

            server = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                create_handler(
                    QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=root / "state",
                        legacy_state_path=root / "legacy.json",
                        log_dir=root / "logs",
                    )
                ),
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/qq/api/stickers/upload",
                    data=body,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                    method="POST",
                )
                payload = json.loads(urllib.request.urlopen(request).read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            self.assertTrue(payload["ok"])
            self.assertEqual(sorted(payload["saved"]), ["wave-2.png", "wave.png"])
            self.assertEqual(payload["rejected"], ["notes.txt"])
            saved_names = sorted(path.name for path in (Path(payload["inventory"]["rootPath"]) / "happy").iterdir())
            self.assertEqual(saved_names, ["wave-2.png", "wave.png"])

    def test_server_routes_serve_shell_status_and_assets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "openclaw.json"
            state_dir = root / "state"
            asset_dir = root / "assets"
            log_dir = root / "logs"
            state_dir.mkdir()
            asset_dir.mkdir()
            log_dir.mkdir()
            config_path.write_text(
                json.dumps({"channels": {"qq": {"wsUrl": "ws://localhost:8080", "allowedGroups": [5]}}}),
                encoding="utf-8",
            )
            (state_dir / "group_5.json").write_text(json.dumps({"last_message_id": 12}), encoding="utf-8")
            (asset_dir / "qq_dashboard.html").write_text(
                "<!doctype html><html><body data-bootstrap-url='/qq/api/bootstrap'>qq</body></html>",
                encoding="utf-8",
            )
            (asset_dir / "qq_dashboard.css").write_text("body{}", encoding="utf-8")

            server = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                create_handler(
                    QQDashboardConfig(
                        asset_dir=asset_dir,
                        config_candidates=(config_path,),
                        state_dir=state_dir,
                        legacy_state_path=root / "legacy.json",
                        log_dir=log_dir,
                    )
                ),
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            try:
                html = urllib.request.urlopen(f"http://127.0.0.1:{port}/qq").read().decode("utf-8")
                status = json.loads(
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/qq/api/status").read().decode("utf-8")
                )
                css = urllib.request.urlopen(f"http://127.0.0.1:{port}/qq/assets/qq_dashboard.css").read().decode("utf-8")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

        self.assertIn("data-bootstrap-url", html)
        self.assertEqual(status["module"], "qq")
        self.assertIn("listenerCount", status)
        self.assertEqual(css, "body{}")


if __name__ == "__main__":
    unittest.main()
