#!/usr/bin/env python3
import argparse
import copy
import json
import os
import sys
import tempfile
from contextlib import contextmanager
import uuid
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Iterator, List, Optional

import requests
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Shanghai")
BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "schedule_config.json"
STATE_FILE = BASE_DIR / "schedule_state.json"
MORNING_LOCK_FILE = BASE_DIR / "schedule_morning.lock"
DUE_LOCK_FILE = BASE_DIR / "schedule_due.lock"

DEFAULT_CONFIG = {
    "timezone": "Asia/Shanghai",
    "default_reminder_minutes": 30,
    "semester": {
        "name": "",
        "week1_monday": "",
    },
    "classes": [],
    "events": [],
}

DEFAULT_STATE = {
    "last_reminder_check": "",
    "last_morning_summary_date": "",
    "sent_reminders": {},
}


def now_cn() -> datetime:
    return datetime.now(TZ)


def deep_copy(value):
    return copy.deepcopy(value)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return deep_copy(default)


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    temp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temp_path = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temp_path.replace(path)
    finally:
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


def read_lock_pid(path: Path) -> int:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except Exception:
        return 0
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except Exception:
        try:
            return int(raw)
        except Exception:
            return 0
    try:
        return int(payload.get("pid") or 0)
    except Exception:
        return 0


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def try_acquire_lock(path: Path) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"pid": os.getpid(), "created_at": now_cn().isoformat()}, ensure_ascii=False)
    for _ in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            lock_pid = read_lock_pid(path)
            if lock_pid and process_is_alive(lock_pid):
                return False
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError:
                return False
            continue
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            return True
        except Exception:
            try:
                path.unlink()
            except OSError:
                pass
            raise
    return False


@contextmanager
def runtime_lock(path: Path) -> Iterator[bool]:
    locked = try_acquire_lock(path)
    try:
        yield locked
    finally:
        if not locked:
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def ensure_storage() -> None:
    if not CONFIG_FILE.exists():
        save_json(CONFIG_FILE, DEFAULT_CONFIG)
    if not STATE_FILE.exists():
        save_json(STATE_FILE, DEFAULT_STATE)


def load_config() -> dict:
    ensure_storage()
    config = load_json(CONFIG_FILE, DEFAULT_CONFIG)
    merged = deep_copy(DEFAULT_CONFIG)
    merged.update({k: v for k, v in config.items() if k not in {"semester", "classes", "events"}})
    merged["semester"].update(config.get("semester") or {})
    merged["classes"] = list(config.get("classes") or [])
    merged["events"] = list(config.get("events") or [])
    return merged


def load_state() -> dict:
    ensure_storage()
    state = load_json(STATE_FILE, DEFAULT_STATE)
    merged = deep_copy(DEFAULT_STATE)
    merged.update(state or {})
    merged["sent_reminders"] = dict((state or {}).get("sent_reminders") or {})
    return merged


def parse_iso_date(value: str) -> date:
    return date.fromisoformat(value)


def parse_hhmm(value: str) -> time:
    return datetime.strptime(value, "%H:%M").time()


def parse_iso_datetime(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        result = datetime.fromisoformat(value)
    except ValueError:
        return None
    if result.tzinfo is None:
        return result.replace(tzinfo=TZ)
    return result.astimezone(TZ)


def normalize_minutes(value, default_minutes: int) -> int:
    if value in (None, ""):
        return int(default_minutes)
    return max(0, int(value))


def parse_weeks(spec) -> List[int]:
    if spec is None:
        return []
    if isinstance(spec, list):
        return sorted({int(item) for item in spec})
    text = str(spec).strip()
    if not text:
        return []
    values = set()
    for chunk in text.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start_text, end_text = chunk.split("-", 1)
            start = int(start_text)
            end = int(end_text)
            if end < start:
                start, end = end, start
            values.update(range(start, end + 1))
        else:
            values.add(int(chunk))
    return sorted(values)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def build_occurrence(kind: str, item: dict, target_date: date, default_minutes: int) -> dict:
    start_value = parse_hhmm(item["start_time"])
    end_value = parse_hhmm(item["end_time"])
    start_dt = datetime.combine(target_date, start_value, TZ)
    end_dt = datetime.combine(target_date, end_value, TZ)
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)
    reminder_minutes = normalize_minutes(item.get("reminder_minutes"), default_minutes)
    return {
        "kind": kind,
        "source_id": item["id"],
        "occurrence_id": f"{kind}:{item['id']}:{target_date.isoformat()}:{item['start_time']}",
        "date": target_date.isoformat(),
        "title": item["title"],
        "start_time": item["start_time"],
        "end_time": item["end_time"],
        "location": item.get("location", ""),
        "teacher": item.get("teacher", ""),
        "notes": item.get("notes", ""),
        "reminder_minutes": reminder_minutes,
        "start_dt": start_dt,
        "end_dt": end_dt,
    }


def get_schedule_for_date(config: dict, target_date: date) -> List[dict]:
    occurrences = []
    default_minutes = int(config.get("default_reminder_minutes", 30))
    semester = config.get("semester") or {}
    week1_monday = (semester.get("week1_monday") or "").strip()

    if week1_monday:
        base_date = parse_iso_date(week1_monday)
        diff_days = (target_date - base_date).days
        if diff_days >= 0:
            current_week = diff_days // 7 + 1
            weekday = target_date.isoweekday()
            for item in config.get("classes", []):
                if int(item.get("weekday", 0)) != weekday:
                    continue
                if target_date.isoformat() in set(item.get("skip_dates") or []):
                    continue
                weeks = parse_weeks(item.get("weeks"))
                if weeks and current_week not in weeks:
                    continue
                occurrences.append(build_occurrence("class", item, target_date, default_minutes))

    for item in config.get("events", []):
        if item.get("date") != target_date.isoformat():
            continue
        occurrences.append(build_occurrence("event", item, target_date, default_minutes))

    occurrences.sort(key=lambda row: row["start_dt"])
    return occurrences


def format_occurrence_line(item: dict) -> str:
    label = "\u8bfe\u7a0b" if item["kind"] == "class" else "\u65e5\u7a0b"
    extras = []
    if item.get("location"):
        extras.append(f"\u5730\u70b9\uff1a{item['location']}")
    if item.get("teacher") and item["kind"] == "class":
        extras.append(f"\u8001\u5e08\uff1a{item['teacher']}")
    extras.append(f"\u63d0\u524d {item['reminder_minutes']} \u5206\u949f\u63d0\u9192")
    if item.get("notes"):
        extras.append(f"\u5907\u6ce8\uff1a{item['notes']}")
    return f"- {item['start_time']}-{item['end_time']} [{label}] {item['title']} | {' | '.join(extras)}"


def build_morning_summary(config: dict, target_date: date) -> str:
    semester = config.get("semester") or {}
    weekday_map = {1: "\u5468\u4e00", 2: "\u5468\u4e8c", 3: "\u5468\u4e09", 4: "\u5468\u56db", 5: "\u5468\u4e94", 6: "\u5468\u516d", 7: "\u5468\u65e5"}
    lines = [f"\u3010\u9f99\u867e\u4eca\u65e5\u884c\u7a0b\u3011{target_date.strftime('%Y-%m-%d')} {weekday_map[target_date.isoweekday()]}"]
    if semester.get("name"):
        lines.append(f"\u5b66\u671f\uff1a{semester['name']}")
    lines.append("")

    items = get_schedule_for_date(config, target_date)
    if not items:
        lines.append("\u4eca\u5929\u6682\u65f6\u6ca1\u6709\u5df2\u767b\u8bb0\u7684\u8bfe\u7a0b\u6216\u989d\u5916\u65e5\u7a0b\u3002")
        return "\n".join(lines)

    for item in items:
        lines.append(format_occurrence_line(item))
    lines.append("")
    lines.append(f"\u5171 {len(items)} \u9879\u5b89\u6392\u3002")
    return "\n".join(lines)


def build_due_message(item: dict) -> str:
    label = "\u8bfe\u7a0b\u63d0\u9192" if item["kind"] == "class" else "\u65e5\u7a0b\u63d0\u9192"
    lines = [f"\u3010\u9f99\u867e{label}\u3011"]
    lines.append(f"\u8fd8\u6709 {item['reminder_minutes']} \u5206\u949f\uff1a{item['title']}")
    lines.append(f"\u65f6\u95f4\uff1a{item['date']} {item['start_time']}-{item['end_time']}")
    if item.get("location"):
        lines.append(f"\u5730\u70b9\uff1a{item['location']}")
    if item.get("teacher") and item["kind"] == "class":
        lines.append(f"\u8001\u5e08\uff1a{item['teacher']}")
    if item.get("notes"):
        lines.append(f"\u5907\u6ce8\uff1a{item['notes']}")
    return "\n".join(lines)
def get_runtime_paths() -> List[Path]:
    custom_home = os.getenv("OPENCLAW_HOME", "").strip()
    paths = []
    if custom_home:
        paths.append(Path(custom_home) / "openclaw.json")
    paths.extend([
        Path("/home/node/.openclaw/openclaw.json"),
        Path("/root/.openclaw/openclaw.json"),
    ])
    return paths


def get_allow_paths() -> List[Path]:
    custom_home = os.getenv("OPENCLAW_HOME", "").strip()
    paths = []
    if custom_home:
        paths.append(Path(custom_home) / "credentials" / "telegram-allowFrom.json")
    paths.extend([
        Path("/home/node/.openclaw/credentials/telegram-allowFrom.json"),
        Path("/root/.openclaw/credentials/telegram-allowFrom.json"),
    ])
    return paths


def get_telegram_target(override_chat_id: str = ""):
    token = ""
    for candidate in get_runtime_paths():
        runtime_cfg = load_json(candidate, {})
        telegram_cfg = ((runtime_cfg.get("channels") or {}).get("telegram") or {})
        token = telegram_cfg.get("botToken") or telegram_cfg.get("token") or ""
        if token:
            break
    token = token or os.getenv("TELEGRAM_BOT_TOKEN", "")

    if override_chat_id:
        return token, override_chat_id

    for candidate in get_allow_paths():
        allow_cfg = load_json(candidate, {})
        allow_from = allow_cfg.get("allowFrom") or []
        if allow_from:
            return token, str(allow_from[0])
    return token, ""


def send_telegram(token: str, chat_id: str, text: str) -> dict:
    if not token or not chat_id:
        return {"ok": False, "error": "missing bot token or chat_id"}
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    chunks = []
    body = (text or "").strip()
    while body:
        chunks.append(body[:3900])
        body = body[3900:]
    if not chunks:
        chunks = [""]

    message_ids = []
    for chunk in chunks:
        payload = {"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True}
        try:
            response = requests.post(url, json=payload, timeout=20)
            data = response.json()
        except Exception as exc:
            return {"ok": False, "error": str(exc), "message_ids": message_ids}
        if not isinstance(data, dict) or not data.get("ok"):
            if isinstance(data, dict):
                data.setdefault("message_ids", message_ids)
                return data
            return {"ok": False, "error": "bad response", "message_ids": message_ids}
        message_id = ((data.get("result") or {}).get("message_id"))
        if isinstance(message_id, int):
            message_ids.append(message_id)
    return {"ok": True, "message_ids": message_ids, "result": {"message_id": message_ids[-1] if message_ids else None}}


def normalize_class_row(row: dict, default_minutes: int) -> dict:
    return {
        "id": row.get("id") or new_id("class"),
        "title": str(row["title"]).strip(),
        "weekday": int(row["weekday"]),
        "start_time": row["start_time"],
        "end_time": row["end_time"],
        "weeks": parse_weeks(row.get("weeks")),
        "location": str(row.get("location", "")).strip(),
        "teacher": str(row.get("teacher", "")).strip(),
        "notes": str(row.get("notes", "")).strip(),
        "reminder_minutes": normalize_minutes(row.get("reminder_minutes"), default_minutes),
        "skip_dates": list(row.get("skip_dates") or []),
    }


def normalize_event_row(row: dict, default_minutes: int) -> dict:
    return {
        "id": row.get("id") or new_id("event"),
        "title": str(row["title"]).strip(),
        "date": row["date"],
        "start_time": row["start_time"],
        "end_time": row["end_time"],
        "location": str(row.get("location", "")).strip(),
        "notes": str(row.get("notes", "")).strip(),
        "reminder_minutes": normalize_minutes(row.get("reminder_minutes"), default_minutes),
    }


def command_set_default(args) -> int:
    config = load_config()
    config["default_reminder_minutes"] = max(0, int(args.minutes))
    save_json(CONFIG_FILE, config)
    print(json.dumps({"ok": True, "default_reminder_minutes": config["default_reminder_minutes"]}, ensure_ascii=False))
    return 0


def command_set_semester(args) -> int:
    config = load_config()
    config["semester"]["week1_monday"] = args.week1_monday
    if args.name is not None:
        config["semester"]["name"] = args.name
    save_json(CONFIG_FILE, config)
    print(json.dumps({"ok": True, "semester": config["semester"]}, ensure_ascii=False))
    return 0


def command_add_class(args) -> int:
    config = load_config()
    item = normalize_class_row(
        {
            "id": args.id,
            "title": args.title,
            "weekday": args.weekday,
            "start_time": args.start,
            "end_time": args.end,
            "weeks": args.weeks,
            "location": args.location,
            "teacher": args.teacher,
            "notes": args.notes,
            "reminder_minutes": args.remind,
        },
        int(config.get("default_reminder_minutes", 30)),
    )
    config["classes"].append(item)
    save_json(CONFIG_FILE, config)
    print(json.dumps({"ok": True, "class": item}, ensure_ascii=False))
    return 0


def command_add_event(args) -> int:
    config = load_config()
    item = normalize_event_row(
        {
            "id": args.id,
            "title": args.title,
            "date": args.date,
            "start_time": args.start,
            "end_time": args.end,
            "location": args.location,
            "notes": args.notes,
            "reminder_minutes": args.remind,
        },
        int(config.get("default_reminder_minutes", 30)),
    )
    config["events"].append(item)
    save_json(CONFIG_FILE, config)
    print(json.dumps({"ok": True, "event": item}, ensure_ascii=False))
    return 0


def command_import_json(args) -> int:
    config = load_config()
    payload = load_json(Path(args.file), {})
    if not isinstance(payload, dict):
        print(json.dumps({"ok": False, "error": "payload must be an object"}, ensure_ascii=False))
        return 2

    if args.replace_classes:
        config["classes"] = []
    if args.replace_events:
        config["events"] = []

    if "timezone" in payload:
        config["timezone"] = payload["timezone"]
    if "default_reminder_minutes" in payload:
        config["default_reminder_minutes"] = max(0, int(payload["default_reminder_minutes"]))
    if "semester" in payload and isinstance(payload["semester"], dict):
        config["semester"].update(payload["semester"])

    default_minutes = int(config.get("default_reminder_minutes", 30))
    if "classes" in payload:
        config["classes"].extend([normalize_class_row(item, default_minutes) for item in payload.get("classes") or []])
    if "events" in payload:
        config["events"].extend([normalize_event_row(item, default_minutes) for item in payload.get("events") or []])

    save_json(CONFIG_FILE, config)
    print(json.dumps({
        "ok": True,
        "semester": config.get("semester", {}),
        "default_reminder_minutes": config.get("default_reminder_minutes", 30),
        "classes": len(config.get("classes", [])),
        "events": len(config.get("events", [])),
    }, ensure_ascii=False))
    return 0


def command_delete(args) -> int:
    config = load_config()
    removed = 0
    if args.kind in ("class", "all"):
        before = len(config["classes"])
        config["classes"] = [item for item in config["classes"] if item.get("id") != args.id]
        removed += before - len(config["classes"])
    if args.kind in ("event", "all"):
        before = len(config["events"])
        config["events"] = [item for item in config["events"] if item.get("id") != args.id]
        removed += before - len(config["events"])
    save_json(CONFIG_FILE, config)
    print(json.dumps({"ok": removed > 0, "removed": removed, "id": args.id}, ensure_ascii=False))
    return 0 if removed else 1


def command_list(args) -> int:
    config = load_config()
    target_date = parse_iso_date(args.date) if args.date else now_cn().date()
    items = get_schedule_for_date(config, target_date)
    payload = {
        "date": target_date.isoformat(),
        "count": len(items),
        "items": [
            {
                "kind": item["kind"],
                "id": item["source_id"],
                "title": item["title"],
                "start_time": item["start_time"],
                "end_time": item["end_time"],
                "location": item.get("location", ""),
                "teacher": item.get("teacher", ""),
                "notes": item.get("notes", ""),
                "reminder_minutes": item["reminder_minutes"],
            }
            for item in items
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def command_show_config(args) -> int:
    print(json.dumps(load_config(), ensure_ascii=False, indent=2))
    return 0


def command_morning_summary(args) -> int:
    config = load_config()
    target_date = parse_iso_date(args.date) if args.date else now_cn().date()
    message = build_morning_summary(config, target_date)
    if args.dry_run:
        print(message)
        return 0
    with runtime_lock(MORNING_LOCK_FILE) as locked:
        if not locked:
            print(json.dumps({"ok": True, "skipped": "locked", "date": target_date.isoformat()}, ensure_ascii=False))
            return 0
        state = load_state()
        if not args.force and state.get("last_morning_summary_date") == target_date.isoformat():
            print(json.dumps({"ok": True, "skipped": True, "date": target_date.isoformat()}, ensure_ascii=False))
            return 0
        token, chat_id = get_telegram_target(args.chat_id)
        result = send_telegram(token, chat_id, message)
        if not result.get("ok"):
            print(json.dumps(result, ensure_ascii=False))
            return 1
        state["last_morning_summary_date"] = target_date.isoformat()
        save_json(STATE_FILE, state)
        print(json.dumps({"ok": True, "date": target_date.isoformat(), "message_id": result.get("result", {}).get("message_id")}, ensure_ascii=False))
        return 0


def reminder_key(item: dict) -> str:
    return f"{item['occurrence_id']}:{item['reminder_minutes']}"


def prune_sent_reminders(state: dict, now_dt: datetime) -> None:
    keep = {}
    for key, sent_at in (state.get("sent_reminders") or {}).items():
        sent_dt = parse_iso_datetime(sent_at)
        if not sent_dt:
            continue
        if now_dt - sent_dt <= timedelta(days=21):
            keep[key] = sent_at
    state["sent_reminders"] = keep


def command_due_reminders(args) -> int:
    config = load_config()
    now_dt = now_cn()
    with runtime_lock(DUE_LOCK_FILE) as locked:
        if not locked:
            print(json.dumps({"ok": True, "skipped": "locked"}, ensure_ascii=False))
            return 0
        state = load_state()
        last_check = parse_iso_datetime(state.get("last_reminder_check", ""))
        if last_check is None or last_check > now_dt:
            last_check = now_dt - timedelta(seconds=70)

        due_items = []
        seen = set()
        for offset in (0, 1):
            target_date = (now_dt + timedelta(days=offset)).date()
            for item in get_schedule_for_date(config, target_date):
                key = reminder_key(item)
                if key in seen:
                    continue
                seen.add(key)
                reminder_at = item["start_dt"] - timedelta(minutes=item["reminder_minutes"])
                if reminder_at <= last_check or reminder_at > now_dt + timedelta(seconds=10):
                    continue
                if key in state.get("sent_reminders", {}):
                    continue
                due_items.append((item, reminder_at))

        due_items.sort(key=lambda row: row[1])
        if args.dry_run:
            if not due_items:
                print("\u5f53\u524d\u6ca1\u6709\u5230\u70b9\u63d0\u9192\u3002")
                return 0
            for item, _ in due_items:
                print(build_due_message(item))
                print("---")
            return 0

        if not due_items:
            state["last_reminder_check"] = now_dt.isoformat()
            prune_sent_reminders(state, now_dt)
            save_json(STATE_FILE, state)
            print(json.dumps({"ok": True, "sent": 0, "failed": 0}, ensure_ascii=False))
            return 0

        token, chat_id = get_telegram_target(args.chat_id)
        sent = 0
        failed_reminder_at = []
        sent_at = now_dt.isoformat()
        for item, reminder_at in due_items:
            result = send_telegram(token, chat_id, build_due_message(item))
            if not result.get("ok"):
                failed_reminder_at.append(reminder_at)
                print(json.dumps({"ok": False, "item": item["occurrence_id"], "error": result.get("error") or result}, ensure_ascii=False))
                continue
            state.setdefault("sent_reminders", {})[reminder_key(item)] = sent_at
            prune_sent_reminders(state, now_dt)
            save_json(STATE_FILE, state)
            sent += 1

        next_check = min(failed_reminder_at) - timedelta(seconds=1) if failed_reminder_at else now_dt
        state["last_reminder_check"] = next_check.isoformat()
        prune_sent_reminders(state, now_dt)
        save_json(STATE_FILE, state)
        print(json.dumps({"ok": len(failed_reminder_at) == 0, "sent": sent, "failed": len(failed_reminder_at)}, ensure_ascii=False))
        return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenClaw schedule reminder manager")
    subparsers = parser.add_subparsers(dest="command", required=True)

    show_config = subparsers.add_parser("show-config")
    show_config.set_defaults(func=command_show_config)

    set_default = subparsers.add_parser("set-default")
    set_default.add_argument("--minutes", required=True, type=int)
    set_default.set_defaults(func=command_set_default)

    set_semester = subparsers.add_parser("set-semester")
    set_semester.add_argument("--week1-monday", required=True)
    set_semester.add_argument("--name")
    set_semester.set_defaults(func=command_set_semester)

    add_class = subparsers.add_parser("add-class")
    add_class.add_argument("--id")
    add_class.add_argument("--title", required=True)
    add_class.add_argument("--weekday", required=True, type=int)
    add_class.add_argument("--start", required=True)
    add_class.add_argument("--end", required=True)
    add_class.add_argument("--weeks", required=True)
    add_class.add_argument("--location", default="")
    add_class.add_argument("--teacher", default="")
    add_class.add_argument("--notes", default="")
    add_class.add_argument("--remind", type=int)
    add_class.set_defaults(func=command_add_class)

    add_event = subparsers.add_parser("add-event")
    add_event.add_argument("--id")
    add_event.add_argument("--title", required=True)
    add_event.add_argument("--date", required=True)
    add_event.add_argument("--start", required=True)
    add_event.add_argument("--end", required=True)
    add_event.add_argument("--location", default="")
    add_event.add_argument("--notes", default="")
    add_event.add_argument("--remind", type=int)
    add_event.set_defaults(func=command_add_event)

    import_json = subparsers.add_parser("import-json")
    import_json.add_argument("--file", required=True)
    import_json.add_argument("--replace-classes", action="store_true")
    import_json.add_argument("--replace-events", action="store_true")
    import_json.set_defaults(func=command_import_json)

    delete_cmd = subparsers.add_parser("delete")
    delete_cmd.add_argument("--kind", choices=["class", "event", "all"], required=True)
    delete_cmd.add_argument("--id", required=True)
    delete_cmd.set_defaults(func=command_delete)

    list_cmd = subparsers.add_parser("list")
    list_cmd.add_argument("--date")
    list_cmd.set_defaults(func=command_list)

    morning = subparsers.add_parser("morning-summary")
    morning.add_argument("--date")
    morning.add_argument("--dry-run", action="store_true")
    morning.add_argument("--chat-id", default="")
    morning.add_argument("--force", action="store_true")
    morning.set_defaults(func=command_morning_summary)

    due = subparsers.add_parser("due-reminders")
    due.add_argument("--dry-run", action="store_true")
    due.add_argument("--chat-id", default="")
    due.set_defaults(func=command_due_reminders)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
