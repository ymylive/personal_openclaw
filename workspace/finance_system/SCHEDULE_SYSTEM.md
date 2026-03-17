# Schedule Reminder System

This system sends two kinds of Telegram messages:

- `07:00` daily schedule summary for the current day.
- Minute-level reminder checks for classes and one-off events.

Files
- `schedule_reminder.py`: CLI and cron entrypoint.
- `schedule_config.json`: user-managed schedule data.
- `schedule_state.json`: runtime state for reminder dedupe.

Core commands
- `python3 schedule_reminder.py set-semester --week1-monday 2026-02-24 --name "2026_spring"`
- `python3 schedule_reminder.py set-default --minutes 30`
- `python3 schedule_reminder.py add-class --title "advanced_math" --weekday 1 --start 08:00 --end 09:35 --weeks 1-16 --location "A101" --teacher "zhang" --remind 20`
- `python3 schedule_reminder.py add-event --title "dinner" --date 2026-03-08 --start 18:30 --end 20:30 --location "restaurant" --remind 60`
- `python3 schedule_reminder.py list --date 2026-03-08`
- `python3 schedule_reminder.py morning-summary --dry-run`
- `python3 schedule_reminder.py due-reminders --dry-run`

Cron recipe
```cron
CRON_TZ=Asia/Shanghai
0 7 * * * docker exec openclaw_openclaw-gateway_1 sh -lc 'python3 /home/node/.openclaw/workspace/finance_system/schedule_reminder.py morning-summary' >> /root/.openclaw/workspace/finance_system/schedule_cron.log 2>&1
* * * * * docker exec openclaw_openclaw-gateway_1 sh -lc 'python3 /home/node/.openclaw/workspace/finance_system/schedule_reminder.py due-reminders' >> /root/.openclaw/workspace/finance_system/schedule_cron.log 2>&1
```

Environment notes
- Optional `OPENCLAW_HOME` can override the default config discovery path.
- Telegram target defaults to the first ID in `telegram-allowFrom.json` unless `--chat-id` is passed.
- `morning-summary` has `--force` if you need to override the built-in one-send-per-day guard.

Bulk import format
```json
{
  "default_reminder_minutes": 30,
  "semester": {
    "name": "2026_spring",
    "week1_monday": "2026-02-24"
  },
  "classes": [
    {
      "title": "advanced_math",
      "weekday": 1,
      "start_time": "08:00",
      "end_time": "09:35",
      "weeks": "1-16",
      "location": "A101",
      "teacher": "zhang",
      "reminder_minutes": 20
    }
  ],
  "events": [
    {
      "title": "dinner",
      "date": "2026-03-08",
      "start_time": "18:30",
      "end_time": "20:30",
      "location": "restaurant",
      "reminder_minutes": 60,
      "notes": "with classmates"
    }
  ]
}
```
