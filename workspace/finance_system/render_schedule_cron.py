#!/usr/bin/env python3
import argparse
from pathlib import Path


def build_cron(
    container: str,
    openclaw_home: str,
    workspace_dir: str,
    python_bin: str,
    schedule_log_file: str,
    finance_log_file: str,
    news_hour: int,
    morning_hour: int,
    noon_hour: int,
) -> str:
    finance_dir = f"{workspace_dir.rstrip('/')}/finance_system"
    runtime_exports = (
        f"export OPENCLAW_HOME={openclaw_home} LANG=C.UTF-8 LC_ALL=C.UTF-8 "
        "PYTHONIOENCODING=UTF-8 PYTHONUTF8=1;"
    )
    cron_lines = [
        "CRON_TZ=Asia/Shanghai",
        f"0 7 * * * docker exec {container} sh -lc '{runtime_exports} cd {finance_dir} && {python_bin} schedule_reminder.py morning-summary' >> {schedule_log_file} 2>&1",
        f"* * * * * docker exec {container} sh -lc '{runtime_exports} cd {finance_dir} && {python_bin} schedule_reminder.py due-reminders' >> {schedule_log_file} 2>&1",
        f"0 {news_hour} * * * docker exec {container} sh -lc '{runtime_exports} cd {finance_dir} && {python_bin} report_bot.py --mode news' >> {finance_log_file} 2>&1",
        f"0 {morning_hour} * * * docker exec {container} sh -lc '{runtime_exports} cd {finance_dir} && {python_bin} report_bot.py --mode morning' >> {finance_log_file} 2>&1",
        f"0 {noon_hour} * * * docker exec {container} sh -lc '{runtime_exports} cd {finance_dir} && {python_bin} report_bot.py --mode noon' >> {finance_log_file} 2>&1",
    ]
    return "\n".join(cron_lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Render OpenClaw cron entries for reminders and finance reports")
    parser.add_argument("--container", required=True, help="OpenClaw container name")
    parser.add_argument("--openclaw-home", default="/home/node/.openclaw", help="Runtime OPENCLAW_HOME path")
    parser.add_argument("--workspace-dir", default="/home/node/.openclaw/workspace", help="Workspace root directory")
    parser.add_argument("--python-bin", default="python3", help="Python binary inside the container")
    parser.add_argument("--schedule-log-file", default="", help="Schedule cron log file path")
    parser.add_argument("--finance-log-file", default="", help="Finance cron log file path")
    parser.add_argument("--news-hour", default=8, type=int, help="Hour for finance news summary")
    parser.add_argument("--morning-hour", default=10, type=int, help="Hour for finance morning report")
    parser.add_argument("--noon-hour", default=12, type=int, help="Hour for finance noon analysis")
    parser.add_argument("--output", default="", help="Optional output file path")
    args = parser.parse_args()

    workspace_dir = args.workspace_dir.rstrip("/")
    schedule_log_file = args.schedule_log_file or f"{workspace_dir}/finance_system/schedule_cron.log"
    finance_log_file = args.finance_log_file or f"{workspace_dir}/finance_system/finance_cron.log"
    content = build_cron(
        container=args.container,
        openclaw_home=args.openclaw_home,
        workspace_dir=workspace_dir,
        python_bin=args.python_bin,
        schedule_log_file=schedule_log_file,
        finance_log_file=finance_log_file,
        news_hour=args.news_hour,
        morning_hour=args.morning_hour,
        noon_hour=args.noon_hour,
    )

    if args.output:
        output_path = Path(args.output)
        output_path.write_text(content, encoding="utf-8")
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
