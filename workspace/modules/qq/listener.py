from __future__ import annotations

import re

AT_RE = re.compile(r"\[CQ:at,qq=(\d+)(?:,[^\]]*)?\]")


def should_handle_at_message(event: dict, blacklist: set[int], self_ids: set[int]) -> bool:
    group_id_value = event.get("group_id")
    try:
        group_id = int(group_id_value or 0)
    except (TypeError, ValueError):
        return False
    if group_id in blacklist:
        return False
    raw = str(event.get("raw_message") or "")
    matches = {int(match) for match in AT_RE.findall(raw)}
    return bool(matches & self_ids)
