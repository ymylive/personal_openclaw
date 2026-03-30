from __future__ import annotations

from http import HTTPStatus


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
