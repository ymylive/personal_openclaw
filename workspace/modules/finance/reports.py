from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import json
from pathlib import Path
import subprocess
from typing import Protocol
from urllib.request import urlopen
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo


TZ_CN = ZoneInfo("Asia/Shanghai")
PUBLIC_TAG = "公事"


class _SubprocessResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


class _SubprocessRunner(Protocol):
    def __call__(
        self,
        cmd: list[str],
        *,
        capture_output: bool,
        text: bool,
        check: bool,
        timeout: int | None = None,
    ) -> _SubprocessResult: ...


class _FetchText(Protocol):
    def __call__(self, url: str, *, timeout_seconds: int) -> str: ...


def build_morning_analysis(report_text: str) -> str:
    low = report_text.lower()
    lines = [
        "【简要分析】",
        "影响链路：宏观数据/地缘事件 → 利率预期与风险偏好 → 股债汇与大宗联动。",
    ]

    if any(k in low for k in ["cpi", "ppi", "通胀", "inflation"]):
        lines.append(
            "- 通胀数据是当前定价核心，若持续走高，利率下调预期可能后移，成长板块波动会放大。"
        )
    if any(k in low for k in ["oil", "原油", "中东", "opec"]):
        lines.append(
            "- 能源价格与地缘冲突抬升输入型通胀风险，关注航运、化工与高能耗行业成本压力。"
        )
    if any(k in low for k in ["fed", "美联储", "yield", "利率"]):
        lines.append(
            "- 美联储路径仍是全球资产锚，需关注美元与美债收益率对港美股估值压缩效应。"
        )

    lines.extend(
        [
            "",
            "【三情景（24h）】",
            "1) 偏多：风险事件缓和 + 利率预期稳定，权益资产修复。",
            "2) 中性：消息面分化，指数震荡，结构性机会为主。",
            "3) 偏空：地缘或通胀超预期，避险升温，波动加剧。",
            "",
            "【接下来关注】",
            "- 未来24小时：突发政策/地缘消息、主要市场开盘后的成交与波动率。",
            "- 未来7天：关键宏观数据与央行表态是否改变市场对利率路径的预期。",
            "",
            "【金融晨间分析】",
            "本次推送仅包含金融相关内容，不包含运营推广信息。",
        ]
    )
    return "\n".join(lines)


def build_morning_news_message(report_text: str) -> str:
    report = (report_text or "").strip()
    analysis = build_morning_analysis(report)
    if not report:
        return analysis
    return "\n".join([report, analysis])


def prepare_morning_news_message_from_report_bot(
    *,
    report_bot_path: Path,
    runner: _SubprocessRunner = subprocess.run,
    python_executable: str = "python3",
    timeout_seconds: int | None = None,
) -> str:
    report = load_morning_report_from_report_bot(
        report_bot_path=report_bot_path,
        runner=runner,
        python_executable=python_executable,
        timeout_seconds=timeout_seconds,
    )
    return build_morning_news_message(report)


def load_morning_report_from_report_bot(
    *,
    report_bot_path: Path,
    runner: _SubprocessRunner = subprocess.run,
    python_executable: str = "python3",
    timeout_seconds: int | None = None,
) -> str:
    cmd = [python_executable, str(report_bot_path), "--mode", "news", "--dry-run"]
    result = runner(cmd, capture_output=True, text=True, check=False, timeout=timeout_seconds)
    if result.returncode != 0:
        raise RuntimeError(f"新闻总结生成失败: {result.stderr or result.stdout}")
    report = (result.stdout or "").strip()
    if "\n---END-REPORT---\n" in report:
        report = report.split("\n---END-REPORT---\n", 1)[0].strip()
    elif "---END-REPORT---" in report:
        report = report.split("---END-REPORT---", 1)[0].strip()
    if not report:
        raise RuntimeError("新闻总结为空")
    return report


def _is_public_item(item: dict) -> bool:
    text = f"{item.get('title', '')} {item.get('notes', '')}"
    return PUBLIC_TAG in text


def build_daily_schedule_message(schedule: dict, date_text: str) -> str:
    items = list((schedule or {}).get("items") or [])
    classes = [i for i in items if (i or {}).get("kind") == "class"]
    events = [i for i in items if (i or {}).get("kind") == "event"]

    public_events = [e for e in events if _is_public_item(e)]
    private_events = [e for e in events if not _is_public_item(e)]

    lines = [f"【今日课表日程总结｜{date_text}】"]

    if not items:
        lines.append("今天没有课程或已登记日程。")
        return "\n".join(lines)

    idx = 1
    if classes:
        lines.append("")
        lines.append("📚 课程安排")
        for c in classes:
            lines.append(
                f"{idx}) {c.get('start_time','??')}-{c.get('end_time','??')} {c.get('title','未命名课程')}"
            )
            if c.get("location"):
                lines.append(f"   📍{c['location']}")
            idx += 1

    if public_events:
        lines.append("")
        lines.append("💼 公事日程（已并入推送）")
        for e in public_events:
            lines.append(
                f"{idx}) {e.get('start_time','??')}-{e.get('end_time','??')} {e.get('title','未命名日程')}（公事）"
            )
            if e.get("location"):
                lines.append(f"   📍{e['location']}")
            if e.get("notes"):
                lines.append(f"   📝{e['notes']}")
            idx += 1

    lines.append("")
    lines.append(
        f"✅ 本群推送共 {len(classes) + len(public_events)} 项（课程 {len(classes)} 项，公事 {len(public_events)} 项）。"
    )
    if private_events:
        lines.append('🔒 未标注“公事”的私人日程已自动排除，不会发送到班级群。')
    return "\n".join(lines)


def prepare_daily_schedule_message_from_schedule_cli(
    *,
    schedule_cli_path: Path,
    date_text: str,
    runner: _SubprocessRunner = subprocess.run,
    python_executable: str = "python3",
    timeout_seconds: int | None = None,
) -> str:
    schedule = load_schedule_from_schedule_cli(
        schedule_cli_path=schedule_cli_path,
        date_text=date_text,
        runner=runner,
        python_executable=python_executable,
        timeout_seconds=timeout_seconds,
    )
    return build_daily_schedule_message(schedule, date_text)


def load_schedule_from_schedule_cli(
    *,
    schedule_cli_path: Path,
    date_text: str,
    runner: _SubprocessRunner = subprocess.run,
    python_executable: str = "python3",
    timeout_seconds: int | None = None,
) -> dict:
    cmd = [python_executable, str(schedule_cli_path), "list", "--date", date_text]
    result = runner(cmd, capture_output=True, text=True, check=False, timeout=timeout_seconds)
    if result.returncode != 0:
        raise RuntimeError(f"读取课表失败: {result.stderr or result.stdout}")
    try:
        return json.loads(result.stdout)
    except Exception as exc:
        raise RuntimeError(f"课表输出不是有效 JSON: {exc}")


def classify_class_news_topics(news: list[dict]) -> dict[str, int]:
    buckets: dict[str, int] = {"政策治理": 0, "科技教育": 0, "社会民生": 0, "国际局势": 0}
    for n in news:
        title = str(n.get("title") or "")
        if any(k in title for k in ["国务院", "政策", "会议", "改革", "法治", "治理"]):
            buckets["政策治理"] += 1
        elif any(k in title for k in ["AI", "人工智能", "芯片", "高校", "教育", "科研", "科技"]):
            buckets["科技教育"] += 1
        elif any(k in title for k in ["就业", "医疗", "住房", "交通", "校园", "安全", "民生"]):
            buckets["社会民生"] += 1
        else:
            buckets["国际局势"] += 1
    return buckets


def build_class_news_digest_message(news: list[dict], *, now_dt: datetime | None = None) -> str:
    now = now_dt.astimezone(TZ_CN) if now_dt else datetime.now(TZ_CN)
    date_text = now.strftime("%Y-%m-%d %H:%M")
    lines = [
        f"【24小时新闻与重大事件简报｜{date_text}】",
        "（班级群通用版：偏综合时事，不含个人金融分析）",
        "",
    ]

    if not news:
        lines.append("过去24小时未抓取到足够的新资讯，建议稍后重试。")
        return "\n".join(lines)

    lines.append("📰 过去24小时重点新闻")
    for idx, item in enumerate(news, 1):
        published = item.get("published") or ""
        title = item.get("title") or ""
        lines.append(f"{idx}) [{published}] {title}")

    topic_count = classify_class_news_topics(news)
    top_topics = sorted(topic_count.items(), key=lambda x: x[1], reverse=True)
    top1 = top_topics[0][0] if top_topics else "公共事务"
    top2 = top_topics[1][0] if len(top_topics) > 1 else top1

    lines.extend(
        [
            "",
            "🔎 简要分析（班级讨论版）",
            f"- 信息重心：{top1}、{top2}话题出现较多，说明舆论关注点偏向公共事务与现实影响。",
            "- 对同学们的启发：关注“政策变化—行业趋势—就业/升学机会”的传导链，形成长期信息敏感度。",
            "- 讨论建议：可围绕“这类事件对大学生学习/就业有什么实际影响”展开，避免只停留在标题层面。",
            "",
            "📌 今日建议关注",
            "- 是否有与高校、就业、科技创新、社会治理直接相关的后续政策/通报；",
            "- 同一事件在不同媒体叙事中的差异，训练信息辨别能力。",
        ]
    )
    return "\n".join(lines)


def _fetch_text_via_urllib(url: str, *, timeout_seconds: int) -> str:
    with urlopen(url, timeout=timeout_seconds) as resp:
        data = resp.read()
    return data.decode("utf-8", errors="replace")


def _parse_recent_news_from_rss(
    xml_text: str,
    *,
    now_utc: datetime,
    lookback_hours: int,
    max_items: int,
) -> list[dict]:
    cutoff = now_utc - timedelta(hours=int(lookback_hours))
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return []

    items: list[dict] = []
    for node in root.findall("./channel/item"):
        title = (node.findtext("title") or "").strip()
        link = (node.findtext("link") or "").strip()
        pub = (node.findtext("pubDate") or "").strip()
        if not title or not link or not pub:
            continue
        try:
            published_utc = parsedate_to_datetime(pub).astimezone(timezone.utc)
        except Exception:
            continue
        if published_utc < cutoff:
            continue
        items.append(
            {
                "title": title,
                "link": link,
                "published": published_utc.astimezone(TZ_CN).strftime("%m-%d %H:%M"),
            }
        )
        if len(items) >= int(max_items):
            break
    return items


def prepare_class_news_digest_message_from_rss(
    *,
    rss_url: str,
    now_dt: datetime | None = None,
    lookback_hours: int = 24,
    max_items: int = 8,
    fetch_text: _FetchText | None = None,
    timeout_seconds: int = 20,
) -> str:
    fetch = fetch_text or _fetch_text_via_urllib
    resolved_now = now_dt
    if resolved_now is None:
        resolved_now = datetime.now(timezone.utc)
    elif resolved_now.tzinfo is None:
        resolved_now = resolved_now.replace(tzinfo=timezone.utc)

    news = fetch_class_news_from_rss(
        rss_url=rss_url,
        now_dt=resolved_now,
        lookback_hours=lookback_hours,
        max_items=max_items,
        fetch_text=fetch,
        timeout_seconds=timeout_seconds,
    )
    return build_class_news_digest_message(news, now_dt=resolved_now)


def fetch_class_news_from_rss(
    *,
    rss_url: str,
    now_dt: datetime | None = None,
    lookback_hours: int = 24,
    max_items: int = 8,
    fetch_text: _FetchText | None = None,
    timeout_seconds: int = 20,
) -> list[dict]:
    fetch = fetch_text or _fetch_text_via_urllib
    resolved_now = now_dt
    if resolved_now is None:
        resolved_now = datetime.now(timezone.utc)
    elif resolved_now.tzinfo is None:
        resolved_now = resolved_now.replace(tzinfo=timezone.utc)

    xml_text = fetch(rss_url, timeout_seconds=int(timeout_seconds))
    return _parse_recent_news_from_rss(
        xml_text,
        now_utc=resolved_now.astimezone(timezone.utc),
        lookback_hours=lookback_hours,
        max_items=max_items,
    )


def _qq_due_key(item: dict, reminder_minutes: int) -> str:
    occurrence_id = str(item.get("occurrence_id") or "")
    return f"qq:{occurrence_id}:{int(reminder_minutes)}"


def collect_public_due_items(
    *,
    now_dt: datetime,
    last_check: datetime | None,
    sent_reminders: dict,
    reminder_minutes: int,
    get_items_for_date: Callable[[date], Iterable[dict]],
) -> tuple[datetime, list[tuple[dict, datetime]]]:
    now = now_dt
    last = last_check
    if last is None or last > now:
        last = now - timedelta(seconds=70)

    due_items: list[tuple[dict, datetime]] = []
    seen: set[str] = set()

    for offset in (0, 1):
        target_date = (now + timedelta(days=offset)).date()
        for item in get_items_for_date(target_date):
            kind = (item or {}).get("kind")
            if kind == "event" and not _is_public_item(item):
                continue

            if not item.get("occurrence_id") or item.get("start_dt") is None:
                continue

            key = _qq_due_key(item, reminder_minutes)
            if key in seen:
                continue
            seen.add(key)

            reminder_at = item["start_dt"] - timedelta(minutes=int(reminder_minutes))
            if reminder_at <= last or reminder_at > now + timedelta(seconds=10):
                continue
            if key in (sent_reminders or {}):
                continue
            due_items.append((item, reminder_at))

    due_items.sort(key=lambda row: row[1])
    return now, due_items


def build_public_due_reminder_message(item: dict, *, reminder_minutes: int) -> str:
    kind = (item or {}).get("kind") or "event"
    label = "课程提醒" if kind == "class" else "日程提醒"

    title = str((item or {}).get("title") or "").strip() or "未命名"
    date_text = str((item or {}).get("date") or "").strip() or "????-??-??"
    start_time = str((item or {}).get("start_time") or "").strip() or "??:??"
    end_time = str((item or {}).get("end_time") or "").strip() or "??:??"

    lines = [f"【龙虾{label}】"]
    lines.append(f"还有 {int(reminder_minutes)} 分钟：{title}")
    lines.append(f"时间：{date_text} {start_time}-{end_time}")

    location = str((item or {}).get("location") or "").strip()
    if location:
        lines.append(f"地点：{location}")

    teacher = str((item or {}).get("teacher") or "").strip()
    if kind == "class" and teacher:
        lines.append(f"老师：{teacher}")

    notes = str((item or {}).get("notes") or "").strip()
    if notes:
        lines.append(f"备注：{notes}")

    return "\n".join(lines)
