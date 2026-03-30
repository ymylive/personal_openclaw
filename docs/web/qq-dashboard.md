---
summary: "QQ-only dashboard routing and safety guidance"
read_when:
  - "Routing QQ-only traffic through a separate reverse proxy"
  - "Configuring QQ dashboard authentication"
title: "QQ Dashboard"
---

# QQ Dashboard

When you split the frontends, the QQ dashboard lives under `/qq/` and only surfaces QQ-related telemetry and controls. The UI shows listener health, recent attachments, and module logs so operators can keep the QQ agents healthy without exposing the finance workflows.

Access the dashboard via your reverse proxy (see `deployment/nginx/openclaw-separated-frontends.conf.example`) and keep its authentication secret in sync with the running service (`workspace/modules/qq/qq_dashboard_server.py`). The service example in `deployment/systemd/openclaw-qq-dashboard.service.example` runs the dashboard on `127.0.0.1:18891`, so the proxy only exposes `/qq/` while upstream keeps the QQ tokens private.

Do not surface this dashboard to public traffic or the finance workflows. It is strictly for QQ listener management, so avoid sharing `/qq/` URLs when you publish finance reports or collaborate on the finance dashboard.
