# Finance Report System

This system now has two delivery layers:

- structured finance analysis artifacts under `finance_system/dashboard_data`
- Telegram URL-only notifications that point to the finance dashboard

Trading-day schedule:

- `08:00` finance news summary
- `10:00` full-market morning scan for A / HK / US
- `12:00` AI simulated portfolio analysis with market linkage

## Files

- `report_bot.py`: CLI entrypoint and artifact producer
- `dashboard_server.py`: read-only sidecar service for `/finance`
- `dashboard_contracts.py`: canonical API payload builders
- `dashboard_storage.py`: latest/archive JSON storage helpers
- `dashboard_access.py`: daily key and session cookie helpers
- `dashboard_data/latest/*.json`: latest dashboard artifacts
- `dashboard_data/archive/YYYY-MM-DD/*.json`: historical dashboard artifacts
- `openclaw_finance_dashboard.service.example`: example systemd unit
- `check_openclaw_runtime.py`: runtime validation, including dashboard prerequisites

## Environment

Required for production dashboard mode:

- `FINANCE_DASHBOARD_SECRET`
- `FINANCE_DASHBOARD_PUBLIC_BASE_URL`
- `FINANCE_DASHBOARD_PORT` default `18790`
- `OPENCLAW_HOME`

Optional:

- `FINANCE_DASHBOARD_MODE` default enabled
- `TELEGRAM_BOT_TOKEN` when not present in runtime config

## Core Commands

- `python3 report_bot.py --mode news --dry-run`
- `python3 report_bot.py --mode morning --dry-run`
- `python3 report_bot.py --mode noon --dry-run`
- `python3 dashboard_server.py --host 127.0.0.1 --port 18790 --secret <SECRET>`
- `python3 report_bot.py --mode news --chat-id <TEST_CHAT_ID>`

## Telegram Behavior

Telegram no longer sends the long report body in dashboard mode. It sends only the private access URL:

```text
今日金融分析工作台： https://<domain>/finance/access/<daily-key>
```

All report narratives stay in:

- `dashboard_data/latest/news.json`
- `dashboard_data/latest/morning.json`
- `dashboard_data/latest/noon.json`
- `dashboard_data/latest/health.json`
- `dashboard_data/latest/index.json`

The noon payload includes `market_linkage`, which connects the AI simulated portfolio to the morning full-market scan through:

- overlap picks
- market exposure by A / HK / US / Macro
- top holdings
- linkage notes

## Cron Recipe

```cron
CRON_TZ=Asia/Shanghai
0 8 * * * docker exec <OPENCLAW_CONTAINER> sh -lc 'export OPENCLAW_HOME=<OPENCLAW_HOME> FINANCE_DASHBOARD_SECRET=<SECRET> FINANCE_DASHBOARD_PUBLIC_BASE_URL=<PUBLIC_BASE_URL> FINANCE_DASHBOARD_PORT=18790 LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONIOENCODING=UTF-8 PYTHONUTF8=1; cd <WORKSPACE_DIR>/finance_system && python3 report_bot.py --mode news' >> <WORKSPACE_DIR>/finance_system/finance_cron.log 2>&1
0 10 * * * docker exec <OPENCLAW_CONTAINER> sh -lc 'export OPENCLAW_HOME=<OPENCLAW_HOME> FINANCE_DASHBOARD_SECRET=<SECRET> FINANCE_DASHBOARD_PUBLIC_BASE_URL=<PUBLIC_BASE_URL> FINANCE_DASHBOARD_PORT=18790 LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONIOENCODING=UTF-8 PYTHONUTF8=1; cd <WORKSPACE_DIR>/finance_system && python3 report_bot.py --mode morning' >> <WORKSPACE_DIR>/finance_system/finance_cron.log 2>&1
0 12 * * * docker exec <OPENCLAW_CONTAINER> sh -lc 'export OPENCLAW_HOME=<OPENCLAW_HOME> FINANCE_DASHBOARD_SECRET=<SECRET> FINANCE_DASHBOARD_PUBLIC_BASE_URL=<PUBLIC_BASE_URL> FINANCE_DASHBOARD_PORT=18790 LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONIOENCODING=UTF-8 PYTHONUTF8=1; cd <WORKSPACE_DIR>/finance_system && python3 report_bot.py --mode noon' >> <WORKSPACE_DIR>/finance_system/finance_cron.log 2>&1
```

## Sidecar Service

Example start command:

```bash
export FINANCE_DASHBOARD_SECRET=<SECRET>
export FINANCE_DASHBOARD_PUBLIC_BASE_URL=https://cornna.qzz.io
python3 finance_system/dashboard_server.py --host 127.0.0.1 --port 18790 --secret "$FINANCE_DASHBOARD_SECRET"
```

Example systemd flow:

```bash
cp finance_system/openclaw_finance_dashboard.service.example /etc/systemd/system/openclaw-finance-dashboard.service
systemctl daemon-reload
systemctl enable --now openclaw-finance-dashboard.service
systemctl status openclaw-finance-dashboard.service --no-pager
```

## Validation

- `python finance_system/check_openclaw_runtime.py --openclaw-home <OPENCLAW_HOME> --workspace-dir <WORKSPACE_DIR> --json`
- `python finance_system/report_bot.py --mode news --dry-run`
- `python finance_system/report_bot.py --mode morning --dry-run`
- `python finance_system/report_bot.py --mode noon --dry-run`
- `python finance_system/dashboard_server.py --host 127.0.0.1 --port 18790 --secret <SECRET>`
- `curl -i http://127.0.0.1:18790/finance`

Verify:

- `dashboard_data/latest/*.json` refreshes
- `telegram_delivery.mode` is `url_only`
- `/finance/access/<daily-key>` sets a cookie and redirects
- `/finance/api/bootstrap` and `/finance/api/history-index` require authorization

## Notes

- `report_bot.py` still prints the full report to stdout during `--dry-run` for operator inspection.
- `channels.telegram.streamMode` should remain `off`.
- `check_openclaw_runtime.py` now validates `beautifulsoup4` and dashboard env prerequisites.
