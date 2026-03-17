#!/usr/bin/env bash
set -euo pipefail
container="openclaw_openclaw-gateway_1"
if ! docker exec "$container" sh -lc "pgrep -af 'qq_at_auto_reply.py --group-id 1016414937 --listen' >/dev/null" >/dev/null 2>&1; then
  docker exec "$container" sh -lc "nohup /home/node/.openclaw/venvs/finance/bin/python /home/node/.openclaw/workspace/finance_system/qq_at_auto_reply.py --group-id 1016414937 --listen >> /home/node/.openclaw/workspace/finance_system/qq_at_auto_reply_1016414937.log 2>&1 </dev/null & sleep 1"
fi
if ! docker exec "$container" sh -lc "pgrep -af 'qq_at_auto_reply.py --group-id 1061966199 --listen' >/dev/null" >/dev/null 2>&1; then
  docker exec "$container" sh -lc "nohup /home/node/.openclaw/venvs/finance/bin/python /home/node/.openclaw/workspace/finance_system/qq_at_auto_reply.py --group-id 1061966199 --listen >> /home/node/.openclaw/workspace/finance_system/qq_at_auto_reply_1061966199.log 2>&1 </dev/null & sleep 1"
fi
