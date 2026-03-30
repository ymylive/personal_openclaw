from __future__ import annotations

import json


def build_send_group_payload(group_id: int, message: str, echo: str) -> dict:
    return {
        "action": "send_group_msg",
        "params": {"group_id": group_id, "message": message},
        "echo": echo,
    }


def authorization_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


def encode_payload(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)
