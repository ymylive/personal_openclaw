#!/usr/bin/env bash
set -euo pipefail
docker exec openclaw_openclaw-gateway_1 sh -lc "pgrep -af 'qq_at_auto_reply.py --group-id 1016414937 --group-id 1061966199 --listen' >/dev/null || (nohup /home/node/.openclaw/venvs/finance/bin/python /home/node/.openclaw/workspace/finance_system/qq_at_auto_reply.py --group-id 1016414937 --group-id 1061966199 --listen >> /home/node/.openclaw/workspace/finance_system/qq_at_auto_reply_multi.log 2>&1 </dev/null & sleep 1)"
