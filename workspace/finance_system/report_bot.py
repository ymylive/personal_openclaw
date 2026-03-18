#!/usr/bin/env python3
import argparse
import contextlib
import io
import math
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd
import requests
from bs4 import BeautifulSoup
from dateutil import parser as date_parser
from zoneinfo import ZoneInfo

from finance_system.dashboard_access import build_daily_key, valid_until_for_date
from finance_system.dashboard_contracts import DEFAULT_TELEGRAM_ROUTE, build_access_delivery, build_index_payload
from finance_system.dashboard_storage import DEFAULT_DATA_ROOT, list_history_dates, load_latest_bundle, write_stage_payload

try:
    import yfinance as yf
except Exception:
    yf = None

TZ = ZoneInfo("Asia/Shanghai")
UTC = timezone.utc
BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "portfolio_config.json"
STATE_FILE = BASE_DIR / "portfolio_state.json"
MARKET_CACHE_FILE = BASE_DIR / "market_cache.json"
DASHBOARD_DATA_DIR = DEFAULT_DATA_ROOT
USER_AGENT = "Mozilla/5.0 (compatible; OpenClawFinanceBot/1.1)"
NEWS_LOOKBACK_HOURS = 24
MAX_MORNING_NEWS_ITEMS = 6
MAX_NOON_NEWS_ITEMS = 4
MAX_ALLOCATION_PICKS = 2
JIN10_FETCH_LIMIT = 80
WEB_NEWS_FETCH_LIMIT = 18
NEWS_SOURCE_CAP = 2
OPENCLAW_FINANCE_NEWS_AGENT = "finance-news"
OPENCLAW_FINANCE_NOON_AGENT = "finance-noon"
OPENCLAW_SUMMARY_TIMEOUT_SECONDS = 180
MARKET_CACHE_FRESH_HOURS = 24
MARKET_CACHE_STALE_HOURS = 72
EM_REQUEST_TIMEOUT = 20
EM_PAGE_WORKERS = 8
SINA_REQUEST_TIMEOUT = 20
SINA_PAGE_WORKERS = 4
SINA_HQ_BATCH_SIZE = 40
NASDAQ_PAGE_SIZE = 1000
MORNING_SHORTLIST_PER_MARKET = 12
MORNING_FINAL_PICKS_PER_MARKET = 2
MORNING_TOTAL_POSITION_LIMIT = 0.30
MORNING_SINGLE_MARKET_LIMIT = 0.12
MORNING_SINGLE_POSITION_LIMIT = 0.08
EM_UT = "bd1d9ddb04089700cf9c27f6f7426281"
EM_LIST_FIELDS = (
    "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,"
    "f20,f21,f22,f23,f24,f25"
)
EM_INDEX_FIELDS = (
    "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,"
    "f20,f21,f22,f23,f24,f25,f26,f33,f62,f115,f128,f136,f152"
)
EM_KLINE_FIELDS1 = "f1,f2,f3,f4,f5,f6,f7,f8"
EM_KLINE_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64"
EM_A_SPOT_URL = "https://82.push2.eastmoney.com/api/qt/clist/get"
EM_A_SPOT_FS = "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048"
EM_A_INDEX_URL = "https://48.push2.eastmoney.com/api/qt/clist/get"
EM_A_MAIN_INDEX_URL = "https://33.push2.eastmoney.com/api/qt/clist/get"
EM_A_MAIN_INDEX_FS = "b:MK0010"
EM_A_INDEX_FS = {
    "main": EM_A_MAIN_INDEX_FS,
    "sh": "m:1+t:1",
    "sz": "m:0 t:5",
    "component": "m:1+s:3,m:0+t:5",
    "csi": "m:2",
}
EM_HK_SPOT_URL = "https://72.push2.eastmoney.com/api/qt/clist/get"
EM_HK_SPOT_FS = "m:128 t:3,m:128 t:4,m:128 t:1,m:128 t:2"
EM_HK_MAIN_SPOT_URL = "https://81.push2.eastmoney.com/api/qt/clist/get"
EM_HK_MAIN_SPOT_FS = "m:128 t:3"
EM_HK_INDEX_URL = "https://15.push2.eastmoney.com/api/qt/clist/get"
EM_HK_INDEX_FS = "m:124,m:125,m:305"
EM_US_SPOT_URL = "https://72.push2.eastmoney.com/api/qt/clist/get"
EM_US_SPOT_FS = "m:105,m:106,m:107"
EM_ETF_SPOT_URL = "https://88.push2.eastmoney.com/api/qt/clist/get"
EM_ETF_SPOT_FS = "b:MK0021,b:MK0022,b:MK0023,b:MK0024,b:MK0827"
EM_A_HIST_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
EM_HK_HIST_URL = "https://33.push2his.eastmoney.com/api/qt/stock/kline/get"
EM_US_HIST_URL = "https://63.push2his.eastmoney.com/api/qt/stock/kline/get"
SINA_A_COUNT_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/openapi.php/Market_Center.getHQNodeStockCount"
SINA_A_SPOT_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/openapi.php/Market_Center.getHQNodeData"
SINA_HK_COUNT_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/openapi.php/Market_Center.getHKStockCount"
SINA_HK_SPOT_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/openapi.php/Market_Center.getHKStockData"
SINA_HQ_URL = "https://hq.sinajs.cn/list="
NASDAQ_STOCK_SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks"
A_SHARE_TURNOVER_MIN = 1e8
A_SHARE_ETF_TURNOVER_MIN = 8e7
HK_TURNOVER_MIN = 5e7
US_TURNOVER_MIN = 2e8
US_MARKET_CAP_MIN = 5e9
A_SHARE_MARKET_CAP_MIN = 5e9
HK_MARKET_CAP_MIN = 2e9
MORNING_A_SHARE_NAME_BLOCKLIST = ("ST", "*ST", "退")
MORNING_HK_NAME_BLOCKLIST = ("牛熊", "认购", "认沽", "界内证", "杠杆", "反向")
MORNING_US_NAME_BLOCKLIST = ("WARRANT", "RIGHT", "UNIT", "CVR")
NASDAQ_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/market-activity/stocks/screener",
    "Connection": "close",
}
SINA_HEADERS = {"User-Agent": USER_AGENT, "Referer": "https://finance.sina.com.cn/"}
A_ETF_WATCHLIST = ("sh510300", "sh510050", "sz159915", "sz159919", "sh513100", "sz159949", "sh513500", "sh518880")
US_ETF_WATCHLIST = ("SPY", "QQQ", "DIA", "IWM", "TLT", "GLD", "SLV", "KWEB", "FXI", "HYG")
HK_ETF_WATCHLIST = ("02800", "02828", "03033", "03088", "03067")
OPENWEBSEARCH_QUERIES = [
    "US stocks market news last 24 hours Reuters Bloomberg CNBC",
    "Bitcoin crypto market news last 24 hours Reuters Bloomberg",
    "Hong Kong stocks China A-shares gold silver market news last 24 hours",
    "Federal Reserve yield inflation tariff market news last 24 hours Reuters FT Bloomberg",
    "China stimulus yuan Hong Kong market news last 24 hours Reuters SCMP Bloomberg",
    "Oil gold silver OPEC Middle East market news last 24 hours Reuters CNBC",
]
GOOGLE_NEWS_RSS_QUERIES = [
    "US stocks OR S&P 500 OR Nasdaq when:1d",
    "Federal Reserve OR Treasury yields OR CPI OR inflation when:1d",
    "China stimulus OR yuan OR Hong Kong stocks OR A-shares when:1d",
    "Bitcoin OR Ethereum OR crypto ETF when:1d",
    "Gold OR silver OR oil OR OPEC when:1d",
]
DEFAULT_DASHBOARD_PUBLIC_BASE_URL = "https://cornna.qzz.io"
PUBLISH_TIME_PATTERNS = [
    re.compile(r"<meta[^>]+property=[\"']article:published_time[\"'][^>]+content=[\"']([^\"']+)", re.I),
    re.compile(r"<meta[^>]+name=[\"']pubdate[\"'][^>]+content=[\"']([^\"']+)", re.I),
    re.compile(r"<meta[^>]+name=[\"']publishdate[\"'][^>]+content=[\"']([^\"']+)", re.I),
    re.compile(r"<meta[^>]+itemprop=[\"']datePublished[\"'][^>]+content=[\"']([^\"']+)", re.I),
    re.compile(r"<meta[^>]+property=[\"']og:updated_time[\"'][^>]+content=[\"']([^\"']+)", re.I),
    re.compile(r'"datePublished"\s*:\s*"([^"]+)"', re.I),
    re.compile(r'"dateModified"\s*:\s*"([^"]+)"', re.I),
    re.compile(r"<time[^>]+datetime=[\"']([^\"']+)", re.I),
]
LOW_SIGNAL_NEWS_PATTERNS = [
    re.compile(r"(财经门户|金融信息服务商|全球金融行情资讯专家|提供专业的财经|各类财经资讯及数据)", re.I),
    re.compile(r"^(东方财富网|新浪财经|英为财情(?:Investing\.com)?|Investing\.com|sina)\b", re.I),
    re.compile(r"^Hong Kong stock market\s*-\s*South China Morning Post$", re.I),
]
MAJOR_NEWS_KEYWORDS = (
    "fed", "fomc", "rate", "yield", "inflation", "cpi", "ppi", "jobs", "payroll", "treasury",
    "tariff", "earnings", "guidance", "stimulus", "yuan", "hong kong", "a-share", "china",
    "bitcoin", "btc", "ethereum", "eth", "crypto", "etf", "gold", "silver", "oil", "opec",
    "safe haven", "美联储", "利率", "通胀", "非农", "就业", "收益率", "关税", "财报", "指引",
    "刺激", "人民币", "港股", "a股", "美股", "比特币", "以太坊", "黄金", "白银", "原油", "避险", "监管", "政策",
)
MAJOR_NEWS_SOURCES = ("reuters", "bloomberg", "cnbc", "wsj", "ft", "jin10", "scmp")
JIN10_LOW_SIGNAL_KEYWORDS = ("图示", "持仓报告", "行情播报", "报价更新", "技术分析")


def now_cn() -> datetime:
    return datetime.now(TZ)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text or "")
    text = text.replace("\u3000", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_json_from_text(raw: str):
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except Exception:
            return None
    return None


def unwrap_openapi_payload(payload):
    if isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, dict) and "data" in result:
            return result.get("data")
    return payload


def parse_datetime_candidate(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = date_parser.parse(value)
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(TZ)


def within_lookback(published_at: Optional[datetime], lookback_hours: int = NEWS_LOOKBACK_HOURS) -> bool:
    if published_at is None:
        return False
    delta = now_cn() - published_at
    return timedelta(0) <= delta <= timedelta(hours=lookback_hours)


def format_timestamp(value: Optional[str]) -> str:
    if not value:
        return "Unknown time"
    parsed = parse_datetime_candidate(value)
    if not parsed:
        return value
    return parsed.strftime("%m-%d %H:%M")


def fetch_article_publish_time(url: str) -> Optional[str]:
    try:
        response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
        response.raise_for_status()
        html = response.text
    except Exception:
        return None

    for pattern in PUBLISH_TIME_PATTERNS:
        match = pattern.search(html)
        if not match:
            continue
        value = clean_text(match.group(1))
        parsed = parse_datetime_candidate(value)
        if parsed:
            return parsed.isoformat()
    return None

def search_openweb(query: str, limit: int) -> List[dict]:
    cmd = [
        "mcporter",
        "call",
        "--output",
        "json",
        "--stdio",
        "open-websearch",
        "search",
        f"query={query}",
        f"limit:{limit}",
    ]
    env = os.environ.copy()
    env.setdefault("MODE", "stdio")
    env.setdefault("DEFAULT_SEARCH_ENGINE", "duckduckgo")
    env.setdefault("LANG", "C.UTF-8")
    env.setdefault("LC_ALL", "C.UTF-8")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            env=env,
        )
        data = parse_json_from_text(result.stdout)
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return data["results"]
    except Exception:
        pass
    return []


def fetch_openweb_news(limit: int = 6, lookback_hours: int = NEWS_LOOKBACK_HOURS) -> List[dict]:
    items: List[dict] = []
    seen_urls = set()
    for query in OPENWEBSEARCH_QUERIES:
        for item in search_openweb(query=query, limit=max(limit, 6)):
            url = item.get("url", "")
            if not url or url in seen_urls:
                continue
            published_at = item.get("publishedAt") or item.get("published_at") or item.get("date")
            if not published_at:
                published_at = fetch_article_publish_time(url)
            published_dt = parse_datetime_candidate(published_at) if published_at else None
            if not within_lookback(published_dt, lookback_hours):
                continue
            seen_urls.add(url)
            items.append(
                {
                    "title": clean_text(item.get("title", "")),
                    "url": url,
                    "source": item.get("source", ""),
                    "published_at": published_dt.isoformat(),
                }
            )
            if len(items) >= limit:
                return items
    return items


def fetch_google_news_rss(limit: int = 6, lookback_hours: int = NEWS_LOOKBACK_HOURS) -> List[dict]:
    headers = {"User-Agent": USER_AGENT}
    items: List[dict] = []
    seen_urls = set()

    for query in GOOGLE_NEWS_RSS_QUERIES:
        try:
            response = requests.get(
                "https://news.google.com/rss/search",
                params={"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"},
                headers=headers,
                timeout=20,
            )
            response.raise_for_status()
            root = ET.fromstring(response.content)
        except Exception:
            continue

        for rss_item in root.findall(".//item"):
            title = clean_text(rss_item.findtext("title", default=""))
            url = clean_text(rss_item.findtext("link", default=""))
            published_at = clean_text(rss_item.findtext("pubDate", default=""))
            source = clean_text(rss_item.findtext("source", default="Google News"))
            if not title or not url or url in seen_urls:
                continue
            published_dt = parse_datetime_candidate(published_at)
            if not within_lookback(published_dt, lookback_hours):
                continue
            seen_urls.add(url)
            items.append(
                {
                    "title": re.sub(r"\s+-\s+[^-]+$", "", title).strip(),
                    "url": url,
                    "source": source or "Google News",
                    "published_at": published_dt.isoformat(),
                }
            )
            if len(items) >= limit:
                return items
    return items


def fetch_jin10_news(limit: int = 6, lookback_hours: int = NEWS_LOOKBACK_HOURS) -> List[dict]:
    headers = {"User-Agent": USER_AGENT}
    items: List[dict] = []
    seen_ids = set()
    try:
        response = requests.get("https://www.jin10.com/live/", headers=headers, timeout=25)
        response.raise_for_status()
        html = response.content.decode("utf-8", errors="replace")
    except Exception:
        return []

    soup = BeautifulSoup(html, "html.parser")
    for flash_item in soup.select("div.jin-flash-item.flash"):
        detail_url = ""
        for link in flash_item.select("a[href]"):
            href = str(link.get("href", "")).strip()
            if "/detail/" in href:
                detail_url = href
                break
        match = re.search(r"/detail/(\d+)", detail_url)
        if not match:
            continue
        news_id = match.group(1)
        if news_id in seen_ids:
            continue
        seen_ids.add(news_id)
        if len(news_id) < 14:
            continue
        try:
            published_dt = datetime.strptime(news_id[:14], "%Y%m%d%H%M%S").replace(tzinfo=TZ)
        except ValueError:
            continue
        if not within_lookback(published_dt, lookback_hours):
            continue
        text_node = flash_item.select_one(".flash-text, .right-content, .collapse-content")
        title = clean_text(text_node.get_text(" ", strip=True) if text_node else "")
        title = re.sub(r"^金十数据\s*\d+月\d+日(?:讯|电)[，,:：]?", "", title).strip()
        title = re.sub(r"\s+", " ", title)
        if not title:
            continue
        items.append(
            {
                "title": title,
                "url": detail_url,
                "source": "Jin10",
                "published_at": published_dt.isoformat(),
            }
        )
        if len(items) >= limit:
            break
    return items


def fetch_web_news(limit: int = WEB_NEWS_FETCH_LIMIT, lookback_hours: int = NEWS_LOOKBACK_HOURS) -> List[dict]:
    items = []
    items.extend(fetch_google_news_rss(limit=limit, lookback_hours=lookback_hours))
    items.extend(fetch_openweb_news(limit=limit, lookback_hours=lookback_hours))
    return sort_and_dedupe_news(items, limit=limit)


def extract_openclaw_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if isinstance(payload, list):
        for item in payload:
            text = extract_openclaw_text(item)
            if text:
                return text
        return ""
    if not isinstance(payload, dict):
        return ""

    for key in ("output_text", "text", "message", "response", "content"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    for key in ("result", "data", "output", "assistant", "messages", "choices"):
        value = payload.get(key)
        text = extract_openclaw_text(value)
        if text:
            return text

    for value in payload.values():
        text = extract_openclaw_text(value)
        if text:
            return text
    return ""


def run_openclaw_finance_agent(
    agent_name: str,
    prompt: str,
    timeout_seconds: int = OPENCLAW_SUMMARY_TIMEOUT_SECONDS,
) -> dict:
    binary = shutil.which("openclaw")
    if not binary:
        return {}

    cmd = [
        binary,
        "agent",
        "--local",
        "--agent",
        agent_name,
        "--message",
        prompt,
        "--json",
        "--timeout",
        str(timeout_seconds),
    ]
    env = os.environ.copy()
    env.setdefault("LANG", "C.UTF-8")
    env.setdefault("LC_ALL", "C.UTF-8")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(timeout_seconds + 30, 60),
            env=env,
        )
    except Exception:
        return {}

    outer = parse_json_from_text(result.stdout) or parse_json_from_text(result.stderr or "")
    if isinstance(outer, dict):
        inner = parse_json_from_text(extract_openclaw_text(outer))
        if isinstance(inner, dict):
            return inner
        return outer

    inner = parse_json_from_text(result.stdout)
    return inner if isinstance(inner, dict) else {}


def build_news_summary_prompt(items: List[dict]) -> str:
    rows = []
    for index, item in enumerate(items, start=1):
        rows.append(
            f"{index}. [{normalize_news_source(item)}] {clean_text(str(item.get('title', '')))} | "
            f"{format_timestamp(item.get('published_at'))} | {str(item.get('url', '')).strip()}"
        )
    schema = (
        '{"headline":"",'
        '"bullets":[""],'
        '"risk_note":"",'
        '"items":[{"index":1,"ai_summary":""}]}'
    )
    return (
        "You are a professional cross-market financial analyst. "
        "Use only the news items below from the last 24 hours. "
        "Return strict JSON only, no markdown, no explanation, no code fences. "
        f"Schema: {schema}. "
        "Rules: Simplified Chinese, concise and neutral, headline <= 32 Chinese characters, "
        "bullets max 3, risk_note optional, each item ai_summary <= 40 Chinese characters."
        "\nNews:\n"
        + "\n".join(rows)
    )


def summarize_news_with_openclaw(items: List[dict], limit: int = MAX_MORNING_NEWS_ITEMS) -> Tuple[List[dict], dict]:
    selected = sort_and_dedupe_news(items, limit=limit)
    if not selected:
        return [], {}

    payload = run_openclaw_finance_agent(
        OPENCLAW_FINANCE_NEWS_AGENT,
        build_news_summary_prompt(selected),
    )
    if not isinstance(payload, dict):
        return selected, {}

    item_summary_by_index: Dict[int, str] = {}
    item_summary_by_title: Dict[str, str] = {}
    for row in payload.get("items") or []:
        if not isinstance(row, dict):
            continue
        summary = clean_text(str(row.get("ai_summary") or row.get("summary") or ""))
        if not summary:
            continue
        index_value = safe_float(row.get("index"))
        if index_value is not None:
            item_summary_by_index[int(index_value)] = summary[:120]
        title_key = clean_text(str(row.get("title") or "")).lower()
        if title_key:
            item_summary_by_title[title_key] = summary[:120]

    annotated: List[dict] = []
    for index, item in enumerate(selected, start=1):
        title_key = clean_text(str(item.get("title", ""))).lower()
        summary = item_summary_by_index.get(index) or item_summary_by_title.get(title_key)
        annotated.append({**item, "ai_summary": summary} if summary else dict(item))

    summary_payload = {
        "mode": "openclaw",
        "headline": clean_text(str(payload.get("headline") or payload.get("summary") or ""))[:120],
        "bullets": [
            clean_text(str(entry))
            for entry in (payload.get("bullets") or payload.get("watch_points") or [])
            if clean_text(str(entry))
        ][:3],
        "risk_note": clean_text(str(payload.get("risk_note") or payload.get("risk") or ""))[:160],
    }
    if not summary_payload["headline"] and not summary_payload["bullets"] and not summary_payload["risk_note"]:
        summary_payload = {}
    return annotated, summary_payload


def build_noon_ai_summary(
    config: dict,
    analysis: dict,
    allocations: dict,
    market_status: Optional[dict],
    recent_news: List[dict],
) -> dict:
    top_positions = []
    for category in config.get("categories", []):
        detail = allocations.get(category["key"], {})
        for item in detail.get("picks", []):
            top_positions.append(
                f"{resolve_symbol_name(item.get('symbol', ''), item.get('name', ''))}"
                f"({item.get('symbol', '')}) {format_pct(safe_float(item.get('portfolio_pct'), 0.0))}"
            )
    top_positions = top_positions[:5]
    category_pnl = [
        f"{resolve_category_name(key, config.get('categories'))} {format_signed_usd(amount)}"
        for key, amount in sorted(
            (analysis.get("category_pnl") or {}).items(),
            key=lambda row: abs(row[1]),
            reverse=True,
        )[:4]
    ]
    news_rows = [
        f"[{normalize_news_source(item)}] {clean_text(str(item.get('title', '')))}"
        for item in recent_news[:4]
    ]
    market_rows = build_market_status_rows(market_status)[:6]
    schema = (
        '{"headline":"",'
        '"bullets":[""],'
        '"risk_note":"",'
        '"advice":[""]}'
    )
    prompt = (
        "You are a professional portfolio analyst for a cross-market simulated book. "
        "Use only the context below. Return strict JSON only, no markdown, no extra commentary. "
        f"Schema: {schema}. "
        "Rules: Simplified Chinese, concise and neutral, bullets max 3, advice max 3. "
        f"Portfolio value: {format_usd(analysis.get('portfolio_value', 0.0))}. "
        f"Daily pnl: {format_signed_pct(analysis.get('daily_pnl_pct', 0.0))}. "
        f"Turnover: {format_pct(analysis.get('turnover_pct', 0.0))}. "
        "\nTop positions:\n"
        + ("\n".join(f"- {row}" for row in top_positions) or "- none")
        + "\nCategory pnl:\n"
        + ("\n".join(f"- {row}" for row in category_pnl) or "- none")
        + "\nMarket status:\n"
        + ("\n".join(f"- {row}" for row in market_rows) or "- none")
        + "\nRecent news:\n"
        + ("\n".join(f"- {row}" for row in news_rows) or "- none")
    )
    payload = run_openclaw_finance_agent(OPENCLAW_FINANCE_NOON_AGENT, prompt)
    if not isinstance(payload, dict):
        return {}
    summary = {
        "mode": "openclaw",
        "headline": clean_text(str(payload.get("headline") or payload.get("summary") or ""))[:120],
        "bullets": [
            clean_text(str(entry))
            for entry in (payload.get("bullets") or [])
            if clean_text(str(entry))
        ][:3],
        "risk_note": clean_text(str(payload.get("risk_note") or payload.get("risk") or ""))[:160],
        "advice": [
            clean_text(str(entry))
            for entry in (payload.get("advice") or [])
            if clean_text(str(entry))
        ][:3],
    }
    if not summary["headline"] and not summary["bullets"] and not summary["risk_note"] and not summary["advice"]:
        return {}
    return summary


def fetch_symbol_metrics(symbol: str) -> dict:
    if yf is None:
        raise RuntimeError("yfinance not installed")
    ticker = yf.Ticker(symbol)
    hist = ticker.history(period="6mo", interval="1d", auto_adjust=False)
    if hist is None or hist.empty or len(hist) < 2 or "Close" not in hist:
        raise RuntimeError(f"no history for {symbol}")
    return compute_metrics_from_close(symbol, hist["Close"].dropna())


def format_market_bar_at(value) -> str:
    try:
        ts = pd.Timestamp(value)
    except Exception:
        return ""
    if ts.tzinfo is None:
        ts = ts.tz_localize(UTC)
    else:
        ts = ts.tz_convert(UTC)
    return ts.to_pydatetime().astimezone(TZ).isoformat()


def compute_metrics_from_close(symbol: str, close: pd.Series) -> dict:
    if len(close) < 2:
        raise RuntimeError(f"insufficient close for {symbol}")

    last = float(close.iloc[-1])
    prev = float(close.iloc[-2])
    ret_1d = (last / prev - 1.0) if prev else 0.0

    ret_5d = 0.0
    if len(close) >= 6:
        base5 = float(close.iloc[-6])
        ret_5d = (last / base5 - 1.0) if base5 else 0.0

    ret_20d = 0.0
    if len(close) >= 21:
        base20 = float(close.iloc[-21])
        ret_20d = (last / base20 - 1.0) if base20 else 0.0

    ret_60d = 0.0
    if len(close) >= 61:
        base60 = float(close.iloc[-61])
        ret_60d = (last / base60 - 1.0) if base60 else 0.0

    daily = close.pct_change().dropna()
    vol_20d = float(daily.tail(20).std() * (252 ** 0.5)) if len(daily) >= 5 else 0.0
    score = 0.45 * ret_60d + 0.35 * ret_20d + 0.15 * ret_5d + 0.05 * ret_1d - 0.10 * vol_20d

    return {
        "symbol": symbol,
        "price": last,
        "ret_1d": ret_1d,
        "ret_5d": ret_5d,
        "ret_20d": ret_20d,
        "ret_60d": ret_60d,
        "vol_20d": vol_20d,
        "score": score,
        "bar_at": format_market_bar_at(close.index[-1]),
    }


def safe_float(value, default: float = 0.0) -> float:
    if value in (None, "", "-", "--", "None", "null"):
        return default
    try:
        cleaned = (
            str(value)
            .replace(",", "")
            .replace("HK$", "")
            .replace("$", "")
            .replace("%", "")
            .replace("¥", "")
            .strip()
        )
        return float(cleaned)
    except Exception:
        return default


def safe_int(value, default: int = 0) -> int:
    try:
        return int(safe_float(value, float(default)))
    except Exception:
        return default


def normalize_market_cap_value(value) -> float:
    market_cap = safe_float(value, 0.0)
    if market_cap <= 0:
        return 0.0
    if market_cap < 1e8:
        return market_cap * 10000.0
    return market_cap


def format_compact_amount(value: float, currency: str = "") -> str:
    value = safe_float(value, 0.0)
    abs_value = abs(value)
    prefix = currency or ""
    if abs_value >= 1e8:
        return f"{prefix}{value / 1e8:.1f}亿"
    if abs_value >= 1e4:
        return f"{prefix}{value / 1e4:.1f}万"
    if abs_value >= 1000:
        return f"{prefix}{value:,.0f}"
    return f"{prefix}{value:.0f}"


def format_price_compact(value: float) -> str:
    value = safe_float(value, 0.0)
    abs_value = abs(value)
    if abs_value >= 100:
        return f"{value:.2f}"
    if abs_value >= 10:
        return f"{value:.2f}"
    if abs_value >= 1:
        return f"{value:.3f}"
    return f"{value:.4f}"


def format_pct_points(value: float) -> str:
    return f"{safe_float(value, 0.0):+.2f}%"


def normalize_em_diff_rows(raw_diff) -> List[dict]:
    if isinstance(raw_diff, list):
        return [item for item in raw_diff if isinstance(item, dict)]
    if isinstance(raw_diff, dict):
        items = []
        for _, value in sorted(raw_diff.items(), key=lambda pair: safe_int(pair[0], 0)):
            if isinstance(value, dict):
                items.append(value)
        return items
    return []


def build_em_query_params(fs: str, fields: str, fid: str = "f3") -> dict:
    return {
        "pn": "1",
        "pz": "100",
        "po": "1",
        "np": "1",
        "ut": EM_UT,
        "fltt": "2",
        "invt": "2",
        "dect": "1",
        "wbp2u": "|0|0|0|web",
        "fid": fid,
        "fs": fs,
        "fields": fields,
    }


def request_json_with_retry(
    url: str,
    params: Optional[dict] = None,
    headers: Optional[dict] = None,
    timeout: int = EM_REQUEST_TIMEOUT,
    attempts: int = 2,
):
    last_error = None
    for _ in range(max(1, attempts)):
        try:
            response = requests.get(url, params=params, headers=headers or {"User-Agent": USER_AGENT}, timeout=timeout)
            response.raise_for_status()
            try:
                payload = response.json()
            except Exception:
                payload = parse_json_from_text(response.text)
            payload = unwrap_openapi_payload(payload)
            if payload is None:
                raise RuntimeError("invalid json payload")
            return payload
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"{urlparse(url).netloc} request failed: {last_error}")


def request_text_with_retry(
    url: str,
    params: Optional[dict] = None,
    headers: Optional[dict] = None,
    timeout: int = EM_REQUEST_TIMEOUT,
    attempts: int = 2,
) -> str:
    last_error = None
    for _ in range(max(1, attempts)):
        try:
            response = requests.get(url, params=params, headers=headers or {"User-Agent": USER_AGENT}, timeout=timeout)
            response.raise_for_status()
            return response.text
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"{urlparse(url).netloc} request failed: {last_error}")


def merge_rows_by_symbol(*row_groups: List[dict]) -> List[dict]:
    merged: Dict[str, dict] = {}
    order: List[str] = []
    for rows in row_groups:
        for row in rows:
            symbol = str(row.get("symbol", ""))
            if not symbol:
                continue
            if symbol not in merged:
                merged[symbol] = dict(row)
                order.append(symbol)
                continue
            current = merged[symbol]
            for key, value in row.items():
                if key in {"symbol", "display_symbol", "code", "market", "market_label", "asset_type", "history_market"}:
                    continue
                if current.get(key) in (None, "", 0, 0.0, False) and value not in (None, "", 0, 0.0, False):
                    current[key] = value
    return [merged[symbol] for symbol in order]


def em_request_json(url: str, params: dict) -> dict:
    payload = request_json_with_retry(
        url,
        params=params,
        headers={"User-Agent": USER_AGENT, "Referer": "https://quote.eastmoney.com/"},
        timeout=EM_REQUEST_TIMEOUT,
        attempts=2,
    )
    if not isinstance(payload, dict):
        raise RuntimeError("non-dict response")
    return payload


def em_fetch_rows(url: str, params: dict, max_pages: Optional[int] = None) -> List[dict]:
    first_payload = em_request_json(url, params)
    data = (first_payload.get("data") or {}) if isinstance(first_payload, dict) else {}
    rows = normalize_em_diff_rows(data.get("diff"))
    total = safe_int(data.get("total"), len(rows))
    page_size = max(1, safe_int(params.get("pz"), 100))
    page_count = max(1, math.ceil(total / page_size)) if total else 1
    if max_pages is not None:
        page_count = min(page_count, max_pages)
    if page_count <= 1:
        return rows

    paged_rows = {1: rows}

    def fetch_page(page_no: int) -> Tuple[int, List[dict]]:
        page_params = dict(params)
        page_params["pn"] = str(page_no)
        payload = em_request_json(url, page_params)
        page_data = (payload.get("data") or {}) if isinstance(payload, dict) else {}
        return page_no, normalize_em_diff_rows(page_data.get("diff"))

    with ThreadPoolExecutor(max_workers=min(EM_PAGE_WORKERS, page_count - 1)) as executor:
        futures = [executor.submit(fetch_page, page_no) for page_no in range(2, page_count + 1)]
        for future in as_completed(futures):
            page_no, page_rows = future.result()
            paged_rows[page_no] = page_rows

    combined: List[dict] = []
    for page_no in sorted(paged_rows):
        combined.extend(paged_rows[page_no])
    return combined


def normalize_a_symbol(code: str, market_id: int) -> str:
    if market_id == 1:
        return f"{code}.SH"
    if code.startswith(("4", "8", "9")):
        return f"{code}.BJ"
    return f"{code}.SZ"


def normalize_em_spot_row(row: dict, market: str, asset_type: str) -> Optional[dict]:
    code = clean_text(str(row.get("f12", "")))
    name = clean_text(str(row.get("f14", "")))
    if not code or not name:
        return None

    price = safe_float(row.get("f2"), 0.0)
    pct_chg = safe_float(row.get("f3"), 0.0)
    market_id = safe_int(row.get("f13"), 0)

    if market == "A":
        code = code.zfill(6)
        if market_id not in {0, 1}:
            market_id = 1 if code.startswith(("5", "6", "9")) else 0
        secid = f"{market_id}.{code}"
        symbol = normalize_a_symbol(code, market_id)
        display_symbol = code
        market_label = "A股"
        history_market = "ETF" if asset_type == "etf" else "A"
    elif market == "HK":
        code = code.zfill(5)
        secid = f"116.{code}"
        symbol = f"{code}.HK"
        display_symbol = symbol
        market_label = "港股"
        history_market = "HK"
    else:
        symbol = code.upper()
        secid = f"{market_id}.{symbol}" if market_id else symbol
        display_symbol = symbol
        market_label = "美股"
        history_market = "US"

    return {
        "market": market,
        "market_label": market_label,
        "asset_type": asset_type,
        "symbol": symbol,
        "display_symbol": display_symbol,
        "code": code,
        "name": name,
        "secid": secid,
        "history_market": history_market,
        "price": price,
        "pct_chg": pct_chg,
        "change": safe_float(row.get("f4"), 0.0),
        "volume": safe_float(row.get("f5"), 0.0),
        "amount": safe_float(row.get("f6"), 0.0),
        "amplitude_pct": safe_float(row.get("f7"), 0.0),
        "turnover_rate_pct": safe_float(row.get("f8"), 0.0),
        "pe_ttm": safe_float(row.get("f9"), 0.0),
        "volume_ratio": safe_float(row.get("f10"), 0.0),
        "high": safe_float(row.get("f15"), 0.0),
        "low": safe_float(row.get("f16"), 0.0),
        "open": safe_float(row.get("f17"), 0.0),
        "prev_close": safe_float(row.get("f18"), 0.0),
        "market_cap": safe_float(row.get("f20"), 0.0),
        "float_market_cap": safe_float(row.get("f21"), 0.0),
        "speed_pct": safe_float(row.get("f22"), 0.0),
        "pb": safe_float(row.get("f23"), 0.0),
        "pct_60d": safe_float(row.get("f24"), 0.0),
        "pct_ytd": safe_float(row.get("f25"), 0.0),
    }


def compute_amplitude_pct(high: float, low: float, prev_close: float) -> float:
    if prev_close <= 0:
        return 0.0
    return max((high - low) / prev_close * 100.0, 0.0)


def fetch_sina_hq_quote_map(codes: List[str]) -> Dict[str, List[str]]:
    quote_map: Dict[str, List[str]] = {}
    for start in range(0, len(codes), SINA_HQ_BATCH_SIZE):
        chunk = codes[start : start + SINA_HQ_BATCH_SIZE]
        raw = request_text_with_retry(
            SINA_HQ_URL + ",".join(chunk),
            headers=SINA_HEADERS,
            timeout=SINA_REQUEST_TIMEOUT,
            attempts=2,
        )
        for line in raw.splitlines():
            match = re.match(r'var hq_str_(?P<code>[^=]+)="(?P<body>.*)";?$', line.strip())
            if not match:
                continue
            body = match.group("body")
            quote_map[match.group("code")] = body.split(",") if body else []
    return quote_map


def normalize_sina_a_spot_row(row: dict) -> Optional[dict]:
    code = clean_text(str(row.get("code") or row.get("symbol") or ""))
    name = clean_text(str(row.get("name") or ""))
    if not code or not name:
        return None
    symbol_code = clean_text(str(row.get("symbol") or "")).lower()
    market_id = 1 if symbol_code.startswith("sh") else 0
    high = safe_float(row.get("high"), 0.0)
    low = safe_float(row.get("low"), 0.0)
    prev_close = safe_float(row.get("settlement"), 0.0)
    return {
        "market": "A",
        "market_label": "A股",
        "asset_type": "stock",
        "symbol": normalize_a_symbol(code.zfill(6), market_id),
        "display_symbol": code.zfill(6),
        "code": code.zfill(6),
        "name": name,
        "secid": f"{market_id}.{code.zfill(6)}",
        "history_market": "A",
        "price": safe_float(row.get("trade"), 0.0),
        "pct_chg": safe_float(row.get("changepercent"), 0.0),
        "change": safe_float(row.get("pricechange"), 0.0),
        "volume": safe_float(row.get("volume"), 0.0),
        "amount": safe_float(row.get("amount"), 0.0),
        "amplitude_pct": compute_amplitude_pct(high, low, prev_close),
        "turnover_rate_pct": safe_float(row.get("turnoverratio"), 0.0),
        "pe_ttm": safe_float(row.get("per"), 0.0),
        "volume_ratio": 0.0,
        "high": high,
        "low": low,
        "open": safe_float(row.get("open"), 0.0),
        "prev_close": prev_close,
        "market_cap": normalize_market_cap_value(row.get("mktcap")),
        "float_market_cap": normalize_market_cap_value(row.get("nmc")),
        "speed_pct": 0.0,
        "pb": safe_float(row.get("pb"), 0.0),
        "pct_60d": 0.0,
        "pct_ytd": 0.0,
    }


def fetch_sina_a_share_spot_rows() -> List[dict]:
    count = safe_int(
        request_json_with_retry(
            SINA_A_COUNT_URL,
            params={"node": "hs_a"},
            headers=SINA_HEADERS,
            timeout=SINA_REQUEST_TIMEOUT,
            attempts=2,
        ),
        0,
    )
    page_size = 100
    page_count = max(1, math.ceil(count / page_size)) if count else 1
    rows: List[dict] = []
    for page_no in range(1, page_count + 1):
        payload = request_json_with_retry(
            SINA_A_SPOT_URL,
            params={
                "page": str(page_no),
                "num": str(page_size),
                "sort": "symbol",
                "asc": "1",
                "node": "hs_a",
                "symbol": "",
                "_s_r_a": "page",
            },
            headers=SINA_HEADERS,
            timeout=SINA_REQUEST_TIMEOUT,
            attempts=2,
        )
        page_rows = payload if isinstance(payload, list) else []
        if not page_rows:
            break
        for raw_row in page_rows:
            if not isinstance(raw_row, dict):
                continue
            item = normalize_sina_a_spot_row(raw_row)
            if item is not None:
                rows.append(item)
        if len(page_rows) < page_size:
            break
    return rows


def normalize_sina_a_etf_quote_row(prefixed_code: str, fields: List[str]) -> Optional[dict]:
    if len(fields) < 10:
        return None
    code = prefixed_code[-6:]
    price = safe_float(fields[3], 0.0)
    name = clean_text(fields[0])
    if price <= 0 or not name:
        return None
    high = safe_float(fields[4], 0.0)
    low = safe_float(fields[5], 0.0)
    prev_close = safe_float(fields[2], 0.0)
    market_id = 1 if prefixed_code.startswith("sh") else 0
    return {
        "market": "A",
        "market_label": "A股",
        "asset_type": "etf",
        "symbol": normalize_a_symbol(code, market_id),
        "display_symbol": code,
        "code": code,
        "name": name,
        "secid": f"{market_id}.{code}",
        "history_market": "ETF",
        "price": price,
        "pct_chg": ((price - prev_close) / prev_close * 100.0) if prev_close > 0 else 0.0,
        "change": price - prev_close if prev_close > 0 else 0.0,
        "volume": safe_float(fields[8], 0.0),
        "amount": safe_float(fields[9], 0.0),
        "amplitude_pct": compute_amplitude_pct(high, low, prev_close),
        "turnover_rate_pct": 0.0,
        "pe_ttm": 0.0,
        "volume_ratio": 0.0,
        "high": high,
        "low": low,
        "open": safe_float(fields[1], 0.0),
        "prev_close": prev_close,
        "market_cap": 0.0,
        "float_market_cap": 0.0,
        "speed_pct": 0.0,
        "pb": 0.0,
        "pct_60d": 0.0,
        "pct_ytd": 0.0,
    }


def fetch_a_etf_watchlist_rows() -> List[dict]:
    quote_map = fetch_sina_hq_quote_map(list(A_ETF_WATCHLIST))
    rows: List[dict] = []
    for prefixed_code in A_ETF_WATCHLIST:
        fields = quote_map.get(prefixed_code) or []
        item = normalize_sina_a_etf_quote_row(prefixed_code, fields)
        if item is not None:
            rows.append(item)
    return rows


def normalize_sina_hk_spot_row(row: dict) -> Optional[dict]:
    code = clean_text(str(row.get("symbol") or "")).zfill(5)
    name = clean_text(str(row.get("name") or ""))
    if not code or not name:
        return None
    high = safe_float(row.get("high"), 0.0)
    low = safe_float(row.get("low"), 0.0)
    prev_close = safe_float(row.get("prevclose"), 0.0)
    return {
        "market": "HK",
        "market_label": "港股",
        "asset_type": "stock",
        "symbol": f"{code}.HK",
        "display_symbol": f"{code}.HK",
        "code": code,
        "name": name,
        "secid": f"116.{code}",
        "history_market": "HK",
        "price": safe_float(row.get("lasttrade"), 0.0),
        "pct_chg": safe_float(row.get("changepercent"), 0.0),
        "change": safe_float(row.get("pricechange"), 0.0),
        "volume": safe_float(row.get("volume"), 0.0),
        "amount": safe_float(row.get("amount"), 0.0),
        "amplitude_pct": compute_amplitude_pct(high, low, prev_close),
        "turnover_rate_pct": 0.0,
        "pe_ttm": safe_float(row.get("pe_ratio"), 0.0),
        "volume_ratio": 0.0,
        "high": high,
        "low": low,
        "open": safe_float(row.get("open"), 0.0),
        "prev_close": prev_close,
        "market_cap": normalize_market_cap_value(row.get("market_value")),
        "float_market_cap": normalize_market_cap_value(row.get("market_value")),
        "speed_pct": 0.0,
        "pb": 0.0,
        "pct_60d": 0.0,
        "pct_ytd": 0.0,
    }


def fetch_sina_hk_spot_rows() -> List[dict]:
    page_size = 60
    rows: List[dict] = []
    page_no = 1
    while True:
        payload = request_json_with_retry(
            SINA_HK_SPOT_URL,
            params={
                "page": str(page_no),
                "num": str(page_size),
                "sort": "symbol",
                "asc": "1",
                "node": "qbgg_hk",
                "_s_r_a": "page",
            },
            headers=SINA_HEADERS,
            timeout=SINA_REQUEST_TIMEOUT,
            attempts=2,
        )
        page_rows = payload if isinstance(payload, list) else []
        if not page_rows:
            break
        for raw_row in page_rows:
            if not isinstance(raw_row, dict):
                continue
            item = normalize_sina_hk_spot_row(raw_row)
            if item is not None:
                rows.append(item)
        if len(page_rows) < page_size:
            break
        page_no += 1
    return rows


def normalize_nasdaq_us_row(row: dict) -> Optional[dict]:
    symbol = clean_text(str(row.get("symbol") or "")).upper()
    name = clean_text(str(row.get("name") or ""))
    if not symbol or not name:
        return None
    price = safe_float(row.get("lastsale"), 0.0)
    change = safe_float(row.get("netchange"), 0.0)
    volume = safe_float(row.get("volume"), 0.0)
    return {
        "market": "US",
        "market_label": "美股",
        "asset_type": "stock",
        "symbol": symbol,
        "display_symbol": symbol,
        "code": symbol,
        "name": name,
        "secid": symbol,
        "history_market": "US",
        "price": price,
        "pct_chg": safe_float(row.get("pctchange"), 0.0),
        "change": change,
        "volume": volume,
        "amount": volume * price,
        "amplitude_pct": 0.0,
        "turnover_rate_pct": 0.0,
        "pe_ttm": 0.0,
        "volume_ratio": 0.0,
        "high": 0.0,
        "low": 0.0,
        "open": 0.0,
        "prev_close": price - change if price > 0 else 0.0,
        "market_cap": normalize_market_cap_value(row.get("marketCap")),
        "float_market_cap": 0.0,
        "speed_pct": 0.0,
        "pb": 0.0,
        "pct_60d": 0.0,
        "pct_ytd": 0.0,
    }


def fetch_nasdaq_us_stock_rows() -> List[dict]:
    payload = request_json_with_retry(
        NASDAQ_STOCK_SCREENER_URL,
        params={"tableonly": "true", "download": "true"},
        headers=NASDAQ_HEADERS,
        timeout=EM_REQUEST_TIMEOUT,
        attempts=2,
    )
    data = payload.get("data") if isinstance(payload, dict) else {}
    raw_rows = data.get("rows") if isinstance(data, dict) else []
    rows: List[dict] = []
    for raw_row in raw_rows or []:
        if not isinstance(raw_row, dict):
            continue
        item = normalize_nasdaq_us_row(raw_row)
        if item is not None:
            rows.append(item)
    return rows


def normalize_sina_hk_quote_row(code: str, fields: List[str]) -> Optional[dict]:
    if len(fields) < 13:
        return None
    price = safe_float(fields[6], 0.0)
    name = clean_text(fields[1] or fields[0])
    if price <= 0 or not name:
        return None
    high = safe_float(fields[4], 0.0)
    low = safe_float(fields[5], 0.0)
    prev_close = safe_float(fields[3], 0.0)
    symbol = f"{code}.HK"
    return {
        "market": "HK",
        "market_label": "港股",
        "asset_type": "etf",
        "symbol": symbol,
        "display_symbol": symbol,
        "code": code,
        "name": name,
        "secid": f"116.{code}",
        "history_market": "HK",
        "price": price,
        "pct_chg": safe_float(fields[8], 0.0),
        "change": safe_float(fields[7], 0.0),
        "volume": safe_float(fields[12], 0.0),
        "amount": safe_float(fields[11], 0.0),
        "amplitude_pct": compute_amplitude_pct(high, low, prev_close),
        "turnover_rate_pct": 0.0,
        "pe_ttm": 0.0,
        "volume_ratio": 0.0,
        "high": high,
        "low": low,
        "open": safe_float(fields[2], 0.0),
        "prev_close": prev_close,
        "market_cap": 0.0,
        "float_market_cap": 0.0,
        "speed_pct": 0.0,
        "pb": 0.0,
        "pct_60d": 0.0,
        "pct_ytd": 0.0,
    }


def fetch_hk_etf_watchlist_rows() -> List[dict]:
    codes = [f"rt_hk{code}" for code in HK_ETF_WATCHLIST]
    quote_map = fetch_sina_hq_quote_map(codes)
    rows: List[dict] = []
    for prefixed_code in codes:
        fields = quote_map.get(prefixed_code) or []
        item = normalize_sina_hk_quote_row(prefixed_code.removeprefix("rt_hk"), fields)
        if item is not None:
            rows.append(item)
    return rows


def normalize_sina_us_etf_quote_row(symbol: str, fields: List[str]) -> Optional[dict]:
    if len(fields) < 11:
        return None
    price = safe_float(fields[1], 0.0)
    name = clean_text(fields[0])
    if price <= 0 or not name:
        return None
    high = safe_float(fields[6], 0.0)
    low = safe_float(fields[7], 0.0)
    prev_close = safe_float(fields[26], price - safe_float(fields[4], 0.0)) if len(fields) > 26 else price - safe_float(fields[4], 0.0)
    amount = safe_float(fields[33], 0.0) if len(fields) > 33 else 0.0
    volume = safe_float(fields[10], 0.0)
    return {
        "market": "US",
        "market_label": "美股",
        "asset_type": "etf",
        "symbol": symbol,
        "display_symbol": symbol,
        "code": symbol,
        "name": name,
        "secid": symbol,
        "history_market": "US",
        "price": price,
        "pct_chg": safe_float(fields[2], 0.0),
        "change": safe_float(fields[4], 0.0),
        "volume": volume,
        "amount": amount if amount > 0 else volume * price,
        "amplitude_pct": compute_amplitude_pct(high, low, prev_close),
        "turnover_rate_pct": 0.0,
        "pe_ttm": 0.0,
        "volume_ratio": 0.0,
        "high": high,
        "low": low,
        "open": safe_float(fields[5], 0.0),
        "prev_close": prev_close,
        "market_cap": normalize_market_cap_value(fields[30] if len(fields) > 30 else 0.0),
        "float_market_cap": 0.0,
        "speed_pct": 0.0,
        "pb": 0.0,
        "pct_60d": 0.0,
        "pct_ytd": 0.0,
    }


def fetch_us_etf_watchlist_rows() -> List[dict]:
    codes = [f"gb_{symbol.lower()}" for symbol in US_ETF_WATCHLIST]
    quote_map = fetch_sina_hq_quote_map(codes)
    rows: List[dict] = []
    for prefixed_code in codes:
        fields = quote_map.get(prefixed_code) or []
        item = normalize_sina_us_etf_quote_row(prefixed_code.removeprefix("gb_").upper(), fields)
        if item is not None:
            rows.append(item)
    return rows


def fetch_sina_a_index_rows() -> List[dict]:
    code_map = {
        "s_sh000001": ("000001", "上证指数"),
        "s_sz399001": ("399001", "深证成指"),
        "s_sz399006": ("399006", "创业板指"),
    }
    quote_map = fetch_sina_hq_quote_map(list(code_map))
    rows: List[dict] = []
    for prefixed_code, (code, default_name) in code_map.items():
        fields = quote_map.get(prefixed_code) or []
        if len(fields) < 4:
            continue
        rows.append(
            {
                "code": code,
                "name": clean_text(fields[0] or default_name),
                "price": safe_float(fields[1], 0.0),
                "pct_chg": safe_float(fields[3], 0.0),
                "change": safe_float(fields[2], 0.0),
                "amount": 0.0,
                "high": 0.0,
                "low": 0.0,
                "open": 0.0,
                "prev_close": 0.0,
                "market_id": 0,
            }
        )
    return rows


def fetch_sina_hk_index_rows() -> List[dict]:
    code_map = {
        "rt_hkHSI": ("HSI", "恒生指数"),
        "rt_hkHSTECH": ("HSTECH", "恒生科技指数"),
    }
    quote_map = fetch_sina_hq_quote_map(list(code_map))
    rows: List[dict] = []
    for prefixed_code, (code, default_name) in code_map.items():
        fields = quote_map.get(prefixed_code) or []
        if len(fields) < 9:
            continue
        rows.append(
            {
                "code": code,
                "name": clean_text(fields[1] or default_name),
                "price": safe_float(fields[6], 0.0),
                "pct_chg": safe_float(fields[8], 0.0),
                "change": safe_float(fields[7], 0.0),
                "amount": safe_float(fields[12], 0.0) if len(fields) > 12 else 0.0,
                "high": safe_float(fields[4], 0.0),
                "low": safe_float(fields[5], 0.0),
                "open": safe_float(fields[2], 0.0),
                "prev_close": safe_float(fields[3], 0.0),
                "market_id": 0,
            }
        )
    return rows


def fetch_em_spot_rows(url: str, fs: str, market: str, asset_type: str) -> List[dict]:
    params = build_em_query_params(fs=fs, fields=EM_LIST_FIELDS, fid="f3")
    rows: List[dict] = []
    for raw_row in em_fetch_rows(url, params):
        item = normalize_em_spot_row(raw_row, market=market, asset_type=asset_type)
        if item is not None:
            rows.append(item)
    return rows


def fetch_a_share_spot_rows() -> List[dict]:
    try:
        rows = fetch_em_spot_rows(EM_A_SPOT_URL, EM_A_SPOT_FS, market="A", asset_type="stock")
        if rows:
            return rows
    except Exception as exc:
        primary_error = exc
    else:
        primary_error = None
    fallback_rows = fetch_sina_a_share_spot_rows()
    if fallback_rows:
        return fallback_rows
    if primary_error is not None:
        raise RuntimeError(f"eastmoney failed and sina fallback empty: {primary_error}")
    return fallback_rows


def fetch_a_etf_spot_rows() -> List[dict]:
    try:
        rows = fetch_em_spot_rows(EM_ETF_SPOT_URL, EM_ETF_SPOT_FS, market="A", asset_type="etf")
        if rows:
            return merge_rows_by_symbol(rows, fetch_a_etf_watchlist_rows())
    except Exception as exc:
        primary_error = exc
    else:
        primary_error = None
    fallback_rows = fetch_a_etf_watchlist_rows()
    if fallback_rows:
        return fallback_rows
    if primary_error is not None:
        raise RuntimeError(f"eastmoney failed and sina watchlist empty: {primary_error}")
    return fallback_rows


def fetch_hk_spot_rows() -> List[dict]:
    try:
        rows = fetch_em_spot_rows(EM_HK_SPOT_URL, EM_HK_SPOT_FS, market="HK", asset_type="stock")
        if rows:
            return merge_rows_by_symbol(rows, fetch_hk_etf_watchlist_rows())
    except Exception as exc:
        primary_error = exc
    else:
        primary_error = None
    fallback_rows = fetch_sina_hk_spot_rows()
    merged_rows = merge_rows_by_symbol(fallback_rows, fetch_hk_etf_watchlist_rows())
    if merged_rows:
        return merged_rows
    if primary_error is not None:
        raise RuntimeError(f"eastmoney failed and sina fallback empty: {primary_error}")
    return merged_rows


def fetch_us_spot_rows() -> List[dict]:
    try:
        rows = fetch_em_spot_rows(EM_US_SPOT_URL, EM_US_SPOT_FS, market="US", asset_type="stock")
        if rows:
            return merge_rows_by_symbol(rows, fetch_us_etf_watchlist_rows())
    except Exception as exc:
        primary_error = exc
    else:
        primary_error = None
    fallback_rows = fetch_nasdaq_us_stock_rows()
    merged_rows = merge_rows_by_symbol(fallback_rows, fetch_us_etf_watchlist_rows())
    if merged_rows:
        return merged_rows
    if primary_error is not None:
        raise RuntimeError(f"eastmoney failed and nasdaq fallback empty: {primary_error}")
    return merged_rows


def fetch_em_index_rows(url: str, fs: str, max_pages: Optional[int] = 1) -> List[dict]:
    params = build_em_query_params(fs=fs, fields=EM_INDEX_FIELDS, fid="f3")
    rows = []
    for raw_row in em_fetch_rows(url, params, max_pages=max_pages):
        code = clean_text(str(raw_row.get("f12", "")))
        name = clean_text(str(raw_row.get("f14", "")))
        if not code or not name:
            continue
        rows.append(
            {
                "code": code,
                "name": name,
                "price": safe_float(raw_row.get("f2"), 0.0),
                "pct_chg": safe_float(raw_row.get("f3"), 0.0),
                "change": safe_float(raw_row.get("f4"), 0.0),
                "amount": safe_float(raw_row.get("f6"), 0.0),
                "high": safe_float(raw_row.get("f15"), 0.0),
                "low": safe_float(raw_row.get("f16"), 0.0),
                "open": safe_float(raw_row.get("f17"), 0.0),
                "prev_close": safe_float(raw_row.get("f18"), 0.0),
                "market_id": safe_int(raw_row.get("f13"), 0),
            }
        )
    return rows


def fetch_a_index_rows() -> List[dict]:
    try:
        rows = fetch_em_index_rows(EM_A_MAIN_INDEX_URL, EM_A_INDEX_FS["main"], max_pages=1)
        codes = {item["code"] for item in rows}
        for key in ("sh", "sz", "component", "csi"):
            for item in fetch_em_index_rows(EM_A_INDEX_URL, EM_A_INDEX_FS[key], max_pages=2):
                if item["code"] in codes:
                    continue
                rows.append(item)
                codes.add(item["code"])
        if rows:
            return rows
    except Exception:
        pass
    return fetch_sina_a_index_rows()


def fetch_hk_index_rows() -> List[dict]:
    try:
        rows = fetch_em_index_rows(EM_HK_INDEX_URL, EM_HK_INDEX_FS, max_pages=2)
        if rows:
            return rows
    except Exception:
        pass
    return fetch_sina_hk_index_rows()


def fetch_em_close_series(secid: str, market: str, limit: int = 120) -> pd.Series:
    url = EM_A_HIST_URL
    if market == "HK":
        url = EM_HK_HIST_URL
    elif market == "US":
        url = EM_US_HIST_URL

    candidate_secids = [secid]
    if market == "ETF" and "." in secid:
        suffix = secid.split(".", 1)[1]
        for prefix in ("1", "0"):
            alt_secid = f"{prefix}.{suffix}"
            if alt_secid not in candidate_secids:
                candidate_secids.append(alt_secid)

    last_error = None
    for candidate_secid in candidate_secids:
        params = {
            "secid": candidate_secid,
            "ut": EM_UT,
            "klt": "101",
            "fqt": "0",
            "lmt": str(limit),
            "end": "20500101",
            "fields1": EM_KLINE_FIELDS1,
            "fields2": EM_KLINE_FIELDS2,
        }
        try:
            payload = em_request_json(url, params)
            data = (payload.get("data") or {}) if isinstance(payload, dict) else {}
            klines = data.get("klines") or []
            if not klines:
                raise RuntimeError("empty klines")
            pairs = []
            for item in klines:
                parts = str(item).split(",")
                if len(parts) < 3:
                    continue
                bar_at = pd.to_datetime(parts[0], errors="coerce")
                close = safe_float(parts[2], float("nan"))
                if pd.isna(bar_at) or math.isnan(close):
                    continue
                pairs.append((bar_at, close))
            if len(pairs) < 2:
                raise RuntimeError("insufficient klines")
            index = pd.DatetimeIndex([bar_at for bar_at, _ in pairs])
            close = pd.Series([close for _, close in pairs], index=index)
            return close
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"history failed for {secid}: {last_error}")


def normalize_yf_symbol(symbol: str) -> str:
    if symbol.endswith(".SH"):
        return symbol[:-3] + ".SS"
    return symbol


def fetch_yf_history_frame(symbol: str, limit: int = 120) -> pd.DataFrame:
    if yf is None:
        raise RuntimeError("yfinance unavailable")
    with contextlib.redirect_stderr(io.StringIO()):
        history = yf.Ticker(normalize_yf_symbol(symbol)).history(period="1y", interval="1d", auto_adjust=False)
    if history is None or history.empty:
        raise RuntimeError(f"yfinance history empty for {symbol}")
    frame = history[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
    if len(frame) < 2:
        raise RuntimeError(f"yfinance history insufficient for {symbol}")
    try:
        frame.index = frame.index.tz_localize(None)
    except Exception:
        try:
            frame.index = frame.index.tz_convert(None)
        except Exception:
            pass
    return frame.tail(limit)


def is_a_share_name_blocked(name: str) -> bool:
    clean_name = clean_text(name)
    upper_name = clean_name.upper()
    if any(keyword in upper_name for keyword in MORNING_A_SHARE_NAME_BLOCKLIST):
        return True
    if clean_name.startswith(("N", "C")) and len(clean_name) <= 6:
        return True
    return False


def is_hk_name_blocked(name: str) -> bool:
    clean_name = clean_text(name)
    return any(keyword in clean_name for keyword in MORNING_HK_NAME_BLOCKLIST)


def is_us_name_blocked(symbol: str, name: str) -> bool:
    target = f"{symbol} {name}".upper()
    return any(keyword in target for keyword in MORNING_US_NAME_BLOCKLIST)


def filter_morning_rows(rows: List[dict], market: str, liquidity_only: bool = True) -> List[dict]:
    filtered: List[dict] = []
    for row in rows:
        if row.get("price", 0.0) <= 0 or not row.get("name"):
            continue

        cap = max(safe_float(row.get("market_cap"), 0.0), safe_float(row.get("float_market_cap"), 0.0))
        amount = safe_float(row.get("amount"), 0.0)
        if market == "A":
            if row.get("asset_type") == "stock":
                if is_a_share_name_blocked(str(row.get("name", ""))):
                    continue
                if liquidity_only and (amount < A_SHARE_TURNOVER_MIN or cap < A_SHARE_MARKET_CAP_MIN):
                    continue
            else:
                if liquidity_only and amount < A_SHARE_ETF_TURNOVER_MIN:
                    continue
        elif market == "HK":
            if is_hk_name_blocked(str(row.get("name", ""))):
                continue
            if liquidity_only and amount < HK_TURNOVER_MIN:
                continue
            if liquidity_only and cap > 0 and cap < HK_MARKET_CAP_MIN:
                continue
        elif market == "US":
            if is_us_name_blocked(str(row.get("symbol", "")), str(row.get("name", ""))):
                continue
            if liquidity_only and amount < US_TURNOVER_MIN:
                continue
            if liquidity_only and cap > 0 and cap < US_MARKET_CAP_MIN:
                continue
        filtered.append(dict(row))
    return filtered


def compute_market_breadth(rows: List[dict]) -> dict:
    total = len(rows)
    up = sum(1 for row in rows if row.get("pct_chg", 0.0) > 0)
    down = sum(1 for row in rows if row.get("pct_chg", 0.0) < 0)
    flat = max(0, total - up - down)
    return {"total": total, "up": up, "down": down, "flat": flat}


def score_morning_universe(rows: List[dict]) -> List[dict]:
    if not rows:
        return []

    frame = pd.DataFrame(rows)
    amount_rank = frame["amount"].rank(method="average", pct=True)
    pct_rank = frame["pct_chg"].rank(method="average", pct=True)
    turnover_rank = (
        frame["turnover_rate_pct"].rank(method="average", pct=True)
        if frame["turnover_rate_pct"].notna().any()
        else pd.Series([0.5] * len(frame))
    )
    cap_series = frame[["market_cap", "float_market_cap"]].max(axis=1)
    cap_rank = cap_series.rank(method="average", pct=True)
    score = pct_rank * 42 + amount_rank * 30 + turnover_rank * 18 + cap_rank * 10
    if "speed_pct" in frame:
        score += frame["speed_pct"].rank(method="average", pct=True) * 8

    scored_rows: List[dict] = []
    for index, row in frame.iterrows():
        item = dict(row.to_dict())
        item["base_score"] = float(score.iloc[index])
        scored_rows.append(item)
    return sorted(scored_rows, key=lambda item: item.get("base_score", -999.0), reverse=True)


def shortlist_market_rows(rows: List[dict]) -> List[dict]:
    return score_morning_universe(rows)[:MORNING_SHORTLIST_PER_MARKET]


def score_final_morning_pick(row: dict) -> float:
    history_score = safe_float(row.get("score"), 0.0) * 100.0
    trend_bonus = max(safe_float(row.get("ret_20d"), 0.0), 0.0) * 80.0 + max(safe_float(row.get("ret_60d"), 0.0), 0.0) * 60.0
    live_bonus = safe_float(row.get("pct_chg"), 0.0) * 1.6 + math.log10(max(safe_float(row.get("amount"), 1.0), 1.0)) * 4.0
    live_bonus += max(safe_float(row.get("turnover_rate_pct"), 0.0), 0.0) * 0.35
    if row.get("asset_type") == "etf":
        live_bonus += 1.5
    risk_penalty = safe_float(row.get("vol_20d"), 0.0) * 10.0 + max(safe_float(row.get("amplitude_pct"), 0.0) - 10.0, 0.0) * 0.25
    return history_score + trend_bonus + live_bonus - risk_penalty


def enrich_rows_with_history(rows: List[dict]) -> List[dict]:
    if not rows:
        return []

    enriched: List[dict] = []

    def load_history(item: dict) -> Tuple[dict, dict]:
        history_frame: Optional[pd.DataFrame] = None
        try:
            close = fetch_em_close_series(item["secid"], item["history_market"])
            history_source = "eastmoney"
        except Exception:
            history_frame = fetch_yf_history_frame(item["symbol"])
            close = history_frame["Close"]
            history_source = "yfinance"
        metric = compute_metrics_from_close(item["symbol"], close)
        updated_item = dict(item)
        updated_item["history_source"] = history_source
        if history_frame is not None:
            latest = history_frame.iloc[-1]
            previous = history_frame.iloc[-2]
            updated_item["volume"] = max(safe_float(updated_item.get("volume"), 0.0), safe_float(latest.get("Volume"), 0.0))
            updated_item["amount"] = max(
                safe_float(updated_item.get("amount"), 0.0),
                safe_float(latest.get("Volume"), 0.0) * safe_float(latest.get("Close"), 0.0),
            )
            if safe_float(updated_item.get("open"), 0.0) <= 0:
                updated_item["open"] = safe_float(latest.get("Open"), 0.0)
            if safe_float(updated_item.get("high"), 0.0) <= 0:
                updated_item["high"] = safe_float(latest.get("High"), 0.0)
            if safe_float(updated_item.get("low"), 0.0) <= 0:
                updated_item["low"] = safe_float(latest.get("Low"), 0.0)
            if safe_float(updated_item.get("prev_close"), 0.0) <= 0:
                updated_item["prev_close"] = safe_float(previous.get("Close"), 0.0)
            if safe_float(updated_item.get("price"), 0.0) <= 0:
                updated_item["price"] = safe_float(latest.get("Close"), 0.0)
            if safe_float(updated_item.get("amplitude_pct"), 0.0) <= 0:
                updated_item["amplitude_pct"] = compute_amplitude_pct(
                    safe_float(updated_item.get("high"), 0.0),
                    safe_float(updated_item.get("low"), 0.0),
                    safe_float(updated_item.get("prev_close"), 0.0),
                )
        return updated_item, metric

    with ThreadPoolExecutor(max_workers=min(EM_PAGE_WORKERS, len(rows))) as executor:
        future_map = {executor.submit(load_history, item): item for item in rows}
        for future in as_completed(future_map):
            item = dict(future_map[future])
            try:
                item, metric = future.result()
                item.update(metric)
                item["history_ok"] = True
            except Exception as exc:
                item["history_ok"] = False
                item["history_error"] = str(exc)[:180]
                item.setdefault("ret_1d", 0.0)
                item.setdefault("ret_5d", 0.0)
                item.setdefault("ret_20d", 0.0)
                item.setdefault("ret_60d", 0.0)
                item.setdefault("vol_20d", 0.0)
                item.setdefault("score", 0.0)
            item["final_score"] = score_final_morning_pick(item)
            enriched.append(item)

    return sorted(enriched, key=lambda item: item.get("final_score", -999.0), reverse=True)


def choose_market_picks(rows: List[dict]) -> List[dict]:
    return enrich_rows_with_history(shortlist_market_rows(rows))[:MORNING_FINAL_PICKS_PER_MARKET]


def find_index_row(rows: List[dict], names: Tuple[str, ...] = (), codes: Tuple[str, ...] = ()) -> Optional[dict]:
    for code in codes:
        for row in rows:
            if str(row.get("code", "")) == code:
                return row
    for name in names:
        for row in rows:
            row_name = str(row.get("name", ""))
            if row_name == name or name in row_name:
                return row
    return None


def classify_market_temperature(index_moves: List[float], breadth: dict) -> str:
    avg_index_move = sum(index_moves) / len(index_moves) if index_moves else 0.0
    total = max(1, safe_int(breadth.get("total"), 0))
    breadth_bias = (safe_int(breadth.get("up"), 0) - safe_int(breadth.get("down"), 0)) / total
    score = avg_index_move + breadth_bias * 5.0
    if score >= 1.6:
        return "偏强"
    if score >= 0.4:
        return "中性偏强"
    if score > -0.4:
        return "中性"
    if score > -1.6:
        return "偏弱"
    return "谨慎"


def should_force_market_refresh() -> bool:
    return os.getenv("OPENCLAW_FORCE_MARKET_REFRESH", "").strip().lower() in {"1", "true", "yes", "on"}


def load_cached_metric(market_cache: dict, symbol: str, allow_stale: bool = False) -> Optional[dict]:
    cached_metric = market_cache.get(symbol)
    if not isinstance(cached_metric, dict):
        return None

    required_keys = {"price", "ret_1d", "ret_5d", "ret_20d", "ret_60d", "vol_20d", "score"}
    if not required_keys.issubset(cached_metric.keys()):
        return None

    updated_at = parse_datetime_candidate(str(cached_metric.get("updated_at", "")))
    if updated_at is None:
        return None

    age = now_cn() - updated_at
    if age < timedelta(0):
        return None

    max_age = timedelta(hours=MARKET_CACHE_STALE_HOURS if allow_stale else MARKET_CACHE_FRESH_HOURS)
    if age > max_age:
        return None

    return dict(cached_metric)


def extract_metric_from_batch(batch_data, symbol: str) -> Optional[dict]:
    if batch_data is None or batch_data.empty:
        return None
    try:
        if isinstance(batch_data.columns, pd.MultiIndex):
            if symbol not in batch_data.columns.get_level_values(0):
                return None
            close = batch_data[symbol]["Close"].dropna()
        else:
            close = batch_data["Close"].dropna()
        if len(close) < 2:
            return None
        return compute_metrics_from_close(symbol, close)
    except Exception:
        return None


def build_market_status_entry(symbol: str, metric: Optional[dict], source: str, error: str = "") -> dict:
    metric = metric or {}
    updated_at = str(metric.get("updated_at", "") or "")
    updated_dt = parse_datetime_candidate(updated_at)
    age_minutes = None
    if updated_dt is not None:
        age_minutes = max(0, int((now_cn() - updated_dt).total_seconds() // 60))
    return {
        "symbol": symbol,
        "source": source,
        "is_stale": source == "cache_stale",
        "updated_at": updated_at,
        "bar_at": str(metric.get("bar_at", "") or ""),
        "age_minutes": age_minutes,
        "error": error.strip()[:200],
    }


def build_market_status_rows(market_status: Optional[dict]) -> List[str]:
    if not market_status:
        return ["- 行情状态：本轮未记录。"]

    rows = [
        f"- 标的总数：{int(market_status.get('symbols_total', 0))}",
        f"- 实时抓取：{int(market_status.get('live_count', 0))}",
        f"- 缓存回退：{int(market_status.get('cache_count', 0))}",
        f"- 过期缓存：{int(market_status.get('stale_count', 0))}",
    ]
    generated_at = str(market_status.get("generated_at", "") or "")
    if generated_at:
        rows.append(f"- 生成时间：{format_timestamp(generated_at)}")

    stale_symbols = [
        item["symbol"]
        for item in market_status.get("symbols", [])
        if isinstance(item, dict) and item.get("source") == "cache_stale"
    ]
    if stale_symbols:
        rows.append(f"- 注意：{', '.join(stale_symbols[:6])} 使用过期缓存回退。")

    failed_symbols = [
        item["symbol"]
        for item in market_status.get("symbols", [])
        if isinstance(item, dict) and item.get("error")
    ]
    if failed_symbols:
        rows.append(f"- 实时抓取失败后已回退：{', '.join(failed_symbols[:6])}")
    return rows


def fetch_market_snapshot(config: dict, prefer_live: bool = False) -> Tuple[Dict[str, List[dict]], Dict[str, dict], dict]:
    category_metrics: Dict[str, List[dict]] = {}
    symbol_metrics: Dict[str, dict] = {}
    market_cache = load_json(MARKET_CACHE_FILE, {})
    cache_changed = False
    all_symbols: List[str] = []
    for category in config.get("categories", []):
        for item in category.get("symbols", []):
            all_symbols.append(item["symbol"])

    unique_symbols = list(dict.fromkeys(all_symbols))
    stale_cache = {symbol: load_cached_metric(market_cache, symbol, allow_stale=True) for symbol in unique_symbols}
    fresh_cache = {symbol: load_cached_metric(market_cache, symbol, allow_stale=False) for symbol in unique_symbols}
    force_live = prefer_live or should_force_market_refresh()
    market_status = {
        "generated_at": now_cn().isoformat(),
        "prefer_live": force_live,
        "symbols_total": len(unique_symbols),
        "live_count": 0,
        "cache_count": 0,
        "stale_count": 0,
        "symbols": [],
    }

    for category in config.get("categories", []):
        key = category["key"]
        metrics = []
        for item in category.get("symbols", []):
            symbol = item["symbol"]
            metric = None
            source = ""
            fetch_error = ""

            should_try_live = force_live or fresh_cache.get(symbol) is None
            if should_try_live:
                try:
                    metric = fetch_symbol_metrics(symbol)
                    metric["updated_at"] = now_cn().isoformat()
                    metric["data_source"] = "live_single"
                    market_cache[symbol] = dict(metric)
                    cache_changed = True
                    source = "live_single"
                    market_status["live_count"] += 1
                except Exception as exc:
                    fetch_error = str(exc)

            if metric is None and fresh_cache.get(symbol) is not None:
                metric = dict(fresh_cache[symbol])
                metric.setdefault("data_source", "cache_fresh")
                source = "cache_fresh"
                market_status["cache_count"] += 1

            if metric is None and stale_cache.get(symbol) is not None:
                metric = dict(stale_cache[symbol])
                metric.setdefault("data_source", "cache_stale")
                source = "cache_stale"
                market_status["cache_count"] += 1
                market_status["stale_count"] += 1

            if metric is None:
                market_status["symbols"].append(build_market_status_entry(symbol, None, "missing", fetch_error))
                continue

            metric["name"] = item.get("name", symbol)
            metric["category"] = key
            metrics.append(metric)
            symbol_metrics[symbol] = metric
            market_status["symbols"].append(
                build_market_status_entry(symbol, metric, source or str(metric.get("data_source", "") or "unknown"), fetch_error)
            )

        category_metrics[key] = metrics

    if cache_changed:
        save_json(MARKET_CACHE_FILE, market_cache)
    return category_metrics, symbol_metrics, market_status


def calc_target_weights(category_metrics: Dict[str, List[dict]], config: dict) -> dict:
    desired = {}
    for category in config.get("categories", []):
        key = category["key"]
        picks = sorted(category_metrics.get(key, []), key=lambda row: row.get("score", -999), reverse=True)
        picks = picks[: max(1, min(3, len(picks)))]
        if not picks:
            desired[key] = []
            continue

        positive_scores = [max(item["score"], 0.0) for item in picks]
        if sum(positive_scores) <= 0:
            fallback = [0.50, 0.30, 0.20][: len(picks)]
            total = sum(fallback)
            weights = [value / total for value in fallback]
        else:
            total = sum(positive_scores)
            weights = [value / total for value in positive_scores]

        desired[key] = [
            {
                "symbol": item["symbol"],
                "name": item.get("name", item["symbol"]),
                "category_weight": weight,
                "score": item["score"],
            }
            for item, weight in zip(picks, weights)
        ]
    return desired


def normalize_weight_map(weight_map: Dict[str, float]) -> Dict[str, float]:
    cleaned = {symbol: max(0.0, float(weight)) for symbol, weight in weight_map.items() if float(weight) > 0}
    total = sum(cleaned.values())
    if total <= 0:
        return {}
    return {symbol: weight / total for symbol, weight in cleaned.items()}


def mark_to_market(previous_positions: dict, symbol_metrics: Dict[str, dict], initial_capital: float) -> dict:
    if not previous_positions:
        return {
            "previous_value": initial_capital,
            "portfolio_value": initial_capital,
            "positions": {},
            "category_pnl": {},
            "contributors": [],
        }

    current_value = 0.0
    category_pnl: Dict[str, float] = {}
    contributors = []
    positions = {}

    for symbol, position in previous_positions.items():
        old_amount = float(position.get("amount_usd", 0.0))
        ret_1d = float(symbol_metrics.get(symbol, {}).get("ret_1d", 0.0))
        current_amount = old_amount * (1.0 + ret_1d)
        pnl_amount = current_amount - old_amount
        current_value += current_amount
        category = position.get("category", "unknown")
        category_pnl[category] = category_pnl.get(category, 0.0) + pnl_amount
        positions[symbol] = {
            **position,
            "current_amount": current_amount,
            "pnl_amount": pnl_amount,
            "ret_1d": ret_1d,
        }
        contributors.append(
            {
                "symbol": symbol,
                "name": symbol_metrics.get(symbol, {}).get("name", symbol),
                "category": category,
                "pnl_amount": pnl_amount,
                "ret_1d": ret_1d,
            }
        )

    portfolio_value = current_value if current_value > 0 else initial_capital
    return {
        "previous_value": float(sum(float(position.get("amount_usd", 0.0)) for position in previous_positions.values())),
        "portfolio_value": portfolio_value,
        "positions": positions,
        "category_pnl": category_pnl,
        "contributors": contributors,
    }


def smooth_category_amounts(config: dict, portfolio_value: float, previous_positions: dict) -> Dict[str, float]:
    strategic = {}
    current = {}
    for category in config.get("categories", []):
        key = category["key"]
        strategic[key] = portfolio_value * float(category.get("allocation_pct", 0.0)) / 100.0
        current[key] = 0.0
    for position in previous_positions.values():
        category = position.get("category")
        if category in current:
            current[category] += float(position.get("current_amount", position.get("amount_usd", 0.0)))

    if not previous_positions:
        return strategic

    alpha = float(config.get("category_rebalance_alpha", 0.12))
    smoothed = {}
    for key, target_amount in strategic.items():
        current_amount = current.get(key, target_amount)
        smoothed[key] = current_amount + alpha * (target_amount - current_amount)

    total = sum(smoothed.values())
    if total <= 0:
        return strategic
    scale = portfolio_value / total
    return {key: value * scale for key, value in smoothed.items()}


def smooth_symbol_weights(
    current_weights: Dict[str, float],
    desired_weights: Dict[str, float],
    symbol_metrics: Dict[str, dict],
    alpha: float,
    max_step: float,
    drop_threshold: float,
) -> Dict[str, float]:
    if not current_weights:
        return normalize_weight_map(desired_weights)

    symbols = sorted(set(current_weights) | set(desired_weights))
    smoothed = {}
    for symbol in symbols:
        current = float(current_weights.get(symbol, 0.0))
        desired = float(desired_weights.get(symbol, 0.0))
        if symbol not in symbol_metrics and symbol in current_weights and desired == 0:
            desired = current
        target = current + alpha * (desired - current)
        delta = target - current
        if delta > max_step:
            target = current + max_step
        elif delta < -max_step:
            target = current - max_step
        if desired == 0 and target < drop_threshold:
            continue
        if target > 0:
            smoothed[symbol] = target

    if not smoothed:
        smoothed = current_weights or desired_weights
    return normalize_weight_map(smoothed)


def update_portfolio_state(config: dict, symbol_metrics: Dict[str, dict], target_weights: dict) -> dict:
    state = load_json(STATE_FILE, {})
    initial_capital = float(config.get("initial_capital", 1_000_000))
    previous_positions = state.get("positions", {})
    marked = mark_to_market(previous_positions, symbol_metrics, initial_capital)
    portfolio_value = marked["portfolio_value"]
    previous_value = float(state.get("portfolio_value", initial_capital))
    if previous_value <= 0:
        previous_value = initial_capital

    category_amounts = smooth_category_amounts(config, portfolio_value, marked["positions"])
    symbol_alpha = float(config.get("rebalance_alpha", 0.18))
    max_step = float(config.get("max_daily_weight_shift_pct", 0.08))
    drop_threshold = float(config.get("drop_threshold_pct", 0.04))

    new_positions = {}
    allocations = {}

    for category in config.get("categories", []):
        key = category["key"]
        cat_amount = float(category_amounts.get(key, 0.0))
        desired_map = {
            item["symbol"]: float(item["category_weight"])
            for item in target_weights.get(key, [])
        }
        desired_map = normalize_weight_map(desired_map)

        current_amounts = {}
        for symbol, position in marked["positions"].items():
            if position.get("category") == key:
                current_amounts[symbol] = float(position.get("current_amount", 0.0))
        current_weight_total = sum(current_amounts.values())
        current_weights = {}
        if current_weight_total > 0:
            current_weights = {
                symbol: amount / current_weight_total
                for symbol, amount in current_amounts.items()
                if amount > 0
            }

        final_weights = smooth_symbol_weights(
            current_weights=current_weights,
            desired_weights=desired_map,
            symbol_metrics=symbol_metrics,
            alpha=symbol_alpha,
            max_step=max_step,
            drop_threshold=drop_threshold,
        )

        allocations[key] = {
            "category_pct": cat_amount / portfolio_value if portfolio_value else 0.0,
            "category_amount": cat_amount,
            "picks": [],
        }

        for symbol, weight in final_weights.items():
            amount = cat_amount * weight
            portfolio_pct = amount / portfolio_value if portfolio_value else 0.0
            metric_name = symbol_metrics.get(symbol, {}).get("name", symbol)
            new_positions[symbol] = {
                "category": key,
                "amount_usd": amount,
                "category_pct": weight,
                "portfolio_pct": portfolio_pct,
                "updated_at": now_cn().isoformat(),
            }
            allocations[key]["picks"].append(
                {
                    "symbol": symbol,
                    "name": metric_name,
                    "amount_usd": amount,
                    "category_pct": weight,
                    "portfolio_pct": portfolio_pct,
                }
            )

    current_amount_lookup = {
        symbol: float(position.get("current_amount", 0.0))
        for symbol, position in marked["positions"].items()
    }
    target_amount_lookup = {
        symbol: float(position.get("amount_usd", 0.0))
        for symbol, position in new_positions.items()
    }
    union_symbols = set(current_amount_lookup) | set(target_amount_lookup)
    turnover_amount = 0.5 * sum(
        abs(target_amount_lookup.get(symbol, 0.0) - current_amount_lookup.get(symbol, 0.0))
        for symbol in union_symbols
    )
    turnover_pct = turnover_amount / portfolio_value if portfolio_value else 0.0

    daily_pnl_amount = portfolio_value - previous_value
    daily_pnl_pct = daily_pnl_amount / previous_value if previous_value else 0.0
    contributors = sorted(marked["contributors"], key=lambda row: row["pnl_amount"], reverse=True)

    analysis = {
        "previous_portfolio_value": previous_value,
        "portfolio_value": portfolio_value,
        "daily_pnl_amount": daily_pnl_amount,
        "daily_pnl_pct": daily_pnl_pct,
        "turnover_amount": turnover_amount,
        "turnover_pct": turnover_pct,
        "category_pnl": marked["category_pnl"],
        "top_contributors": contributors[:3],
        "top_detractors": sorted(marked["contributors"], key=lambda row: row["pnl_amount"])[:3],
    }

    state = {
        "updated_at": now_cn().isoformat(),
        "portfolio_value": portfolio_value,
        "positions": new_positions,
        "analysis": analysis,
    }
    save_json(STATE_FILE, state)
    return {"state": state, "allocations": allocations, "analysis": analysis}


def format_pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def format_signed_pct(value: float) -> str:
    return f"{value * 100:+.2f}%"


def format_usd(value: float) -> str:
    return f"${value:,.2f}"


def format_signed_usd(value: float) -> str:
    if value >= 0:
        return f"+${value:,.2f}"
    return f"-${abs(value):,.2f}"


TELEGRAM_TEXT_LIMIT = 3500
NEWS_SECTION_LIMIT = 4
NOON_NEWS_WATCH_LIMIT = 3
MORNING_HEALTH_MIN_CANDIDATES = {
    "A": 500,
    "HK": 120,
    "US": 150,
}
MORNING_HEALTH_CRITICAL_MIN_CANDIDATES = {
    "A": 50,
    "HK": 20,
    "US": 20,
}
MORNING_HEALTH_CRITICAL_MIN_BREADTH = {
    "A": 200,
    "HK": 80,
    "US": 80,
}
MORNING_HEALTH_CRITICAL_SOURCE_KEYS = {"a_stocks", "hk_spot", "us_spot"}
CATEGORY_NAME_FALLBACKS = {
    "us_equities": "US Equities",
    "btc_market": "Crypto",
    "hk_equities": "HK Equities",
    "a_equities": "A-Shares",
    "precious_metals": "Precious Metals",
}
SYMBOL_NAME_FALLBACKS = {
    "QQQ": "Nasdaq 100 ETF",
    "NVDA": "NVIDIA",
    "AAPL": "Apple",
    "MSFT": "Microsoft",
    "BTC-USD": "Bitcoin",
    "ETH-USD": "Ethereum",
    "SOL-USD": "Solana",
    "0700.HK": "Tencent",
    "9988.HK": "Alibaba",
    "3690.HK": "Meituan",
    "2800.HK": "Hang Seng ETF",
    "600519.SS": "Kweichow Moutai",
    "000001.SZ": "Ping An Bank",
    "300750.SZ": "CATL",
    "510300.SS": "CSI 300 ETF",
    "GC=F": "COMEX Gold",
    "SI=F": "COMEX Silver",
    "GLD": "Gold ETF",
    "SLV": "Silver ETF",
}


def has_meaningful_label(value: str) -> bool:
    text = clean_text(value or "")
    stripped = text.replace("?", "").strip(" -_/|")
    return bool(stripped)


def resolve_category_name(category_or_key, categories: Optional[List[dict]] = None) -> str:
    if isinstance(category_or_key, dict):
        key = str(category_or_key.get("key", "")).strip()
        raw_name = str(category_or_key.get("name", "")).strip()
    else:
        key = str(category_or_key).strip()
        raw_name = ""
        for category in categories or []:
            if category.get("key") == key:
                raw_name = str(category.get("name", "")).strip()
                break
    if has_meaningful_label(raw_name):
        return raw_name
    return CATEGORY_NAME_FALLBACKS.get(key, key or "Unknown category")


def resolve_symbol_name(symbol: str, raw_name: str = "") -> str:
    raw = str(raw_name or "").strip()
    if has_meaningful_label(raw):
        return raw
    return SYMBOL_NAME_FALLBACKS.get(symbol, symbol)


def normalize_news_source(item: dict) -> str:
    source = clean_text(str(item.get("source", "")))
    if has_meaningful_label(source):
        return source
    url = str(item.get("url", "")).strip()
    if "jin10" in url.lower():
        return "Jin10"
    host = urlparse(url).netloc.lower().replace("www.", "")
    return host or "Unknown source"


def is_low_signal_news_title(title: str) -> bool:
    title = clean_text(title)
    if not title:
        return True
    if any(pattern.search(title) for pattern in LOW_SIGNAL_NEWS_PATTERNS):
        return True
    return title.endswith(("首页", "频道", "Home"))


def score_major_news_item(item: dict) -> int:
    title = clean_text(str(item.get("title", "")))
    if is_low_signal_news_title(title):
        return -10

    title_lower = title.lower()
    source = normalize_news_source(item).lower()
    url = str(item.get("url", "")).lower()
    score = 0

    if any(keyword in title_lower for keyword in MAJOR_NEWS_KEYWORDS):
        score += 3
    if any(name in source or name in url for name in MAJOR_NEWS_SOURCES):
        score += 1
    if source == "jin10":
        score += 2
        if any(keyword in title for keyword in JIN10_LOW_SIGNAL_KEYWORDS):
            score -= 2
    if title.startswith("【"):
        score += 1
    if len(title) >= 18:
        score += 1
    return score


def select_major_news(items: List[dict], limit: Optional[int] = None) -> List[dict]:
    normalized = sort_and_dedupe_news(items)
    epoch = datetime(1970, 1, 1, tzinfo=TZ)
    ranked = []
    fallback = []

    for item in normalized:
        published_dt = parse_datetime_candidate(str(item.get("published_at", "")))
        if not within_lookback(published_dt, NEWS_LOOKBACK_HOURS):
            continue
        if not is_low_signal_news_title(str(item.get("title", ""))):
            fallback.append(item)
        score = score_major_news_item(item)
        if score < 2:
            continue
        ranked.append((score, published_dt or epoch, item))

    ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
    selected = [item for _, _, item in ranked]
    if not selected:
        selected = fallback
    if limit:
        selected = selected[:limit]
    return selected


def select_major_news_with_primary(
    primary_items: List[dict],
    secondary_items: List[dict],
    limit: Optional[int] = None,
) -> List[dict]:
    primary_selected = select_major_news(primary_items, limit=limit)
    secondary_selected = select_major_news(secondary_items)
    combined: List[dict] = []
    seen = set()

    for item in primary_selected + secondary_selected:
        title = clean_text(str(item.get("title", "")))
        url = str(item.get("url", "")).strip()
        if not title or not url:
            continue
        dedupe_key = (title.lower(), url)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        combined.append(item)

    if not combined:
        combined = select_major_news(primary_items + secondary_items, limit=limit)

    if not limit or NEWS_SOURCE_CAP <= 0:
        return combined[:limit] if limit else combined

    diversified: List[dict] = []
    overflow: List[dict] = []
    source_counts: Dict[str, int] = {}
    for item in combined:
        source = normalize_news_source(item)
        count = source_counts.get(source, 0)
        if count < NEWS_SOURCE_CAP:
            diversified.append(item)
            source_counts[source] = count + 1
        else:
            overflow.append(item)
        if len(diversified) >= limit:
            return diversified[:limit]

    for item in overflow:
        diversified.append(item)
        if len(diversified) >= limit:
            break
    return diversified[:limit]


def sort_and_dedupe_news(items: List[dict], limit: Optional[int] = None) -> List[dict]:
    epoch = datetime(1970, 1, 1, tzinfo=TZ)
    sorted_items = sorted(
        items,
        key=lambda item: parse_datetime_candidate(str(item.get("published_at", ""))) or epoch,
        reverse=True,
    )
    normalized: List[dict] = []
    seen = set()
    for item in sorted_items:
        title = clean_text(str(item.get("title", "")))
        url = str(item.get("url", "")).strip()
        if not title or not url:
            continue
        dedupe_key = (title.lower(), url)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        normalized.append(
            {
                **item,
                "title": title,
                "url": url,
                "source": normalize_news_source(item),
            }
        )
        if limit and len(normalized) >= limit:
            break
    return normalized


def split_telegram_text(text: str, limit: int = TELEGRAM_TEXT_LIMIT) -> List[str]:
    text = text.strip()
    if not text:
        return []
    chunks: List[str] = []
    current = ""
    for paragraph in text.split("\n\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        candidate = paragraph if not current else f"{current}\n\n{paragraph}"
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ""
        if len(paragraph) <= limit:
            current = paragraph
            continue
        line_buffer = ""
        for line in paragraph.split("\n"):
            line = line.rstrip()
            candidate = line if not line_buffer else f"{line_buffer}\n{line}"
            if len(candidate) <= limit:
                line_buffer = candidate
                continue
            if line_buffer:
                chunks.append(line_buffer)
                line_buffer = ""
            while len(line) > limit:
                chunks.append(line[:limit])
                line = line[limit:]
            line_buffer = line
        if line_buffer:
            current = line_buffer
    if current:
        chunks.append(current)
    return chunks


def build_market_watch_points(news_items: List[dict]) -> List[str]:
    combined = " ".join(clean_text(str(item.get("title", ""))).lower() for item in news_items)
    watch_points: List[str] = []
    if any(keyword in combined for keyword in ("fed", "rate", "yield", "inflation", "cpi", "jobs", "payroll")):
        watch_points.append("关注美联储/通胀/利率线索，留意美股与美元利率联动。")
    if any(keyword in combined for keyword in ("bitcoin", "btc", "crypto", "ethereum", "eth", "sol")):
        watch_points.append("加密资产消息密集，控制高波动仓位与 Beta 暴露。")
    if any(keyword in combined for keyword in ("gold", "silver", "oil", "crude", "commodity", "safe haven")):
        watch_points.append("黄金白银/原油受避险与通胀预期驱动，注意商品链轮动。")
    if any(keyword in combined for keyword in ("china", "hong kong", "a-share", "yuan", "property", "stimulus")):
        watch_points.append("中国、港股与 A 股政策线索增多，留意人民币和风险偏好变化。")
    if not watch_points:
        watch_points.append("暂无单一主线，优先观察成交量、波动率和仓位集中度。")
    return watch_points[:3]


def build_section(title: str, rows: List[str]) -> List[str]:
    return [title, *rows, ""]


def build_news_message(jin10_news: List[dict], web_news: List[dict]) -> str:
    dt = now_cn().strftime("%Y-%m-%d %H:%M")
    major_items = select_major_news_with_primary(
        jin10_news,
        web_news,
        limit=MAX_MORNING_NEWS_ITEMS,
    )
    watch_points = build_market_watch_points(major_items)

    lines = [
        f"【龙虾 08:00 新闻总结】{dt}",
        f"范围：仅统计最近 {NEWS_LOOKBACK_HOURS} 小时内的重大财经/市场事件",
        "",
    ]

    news_rows: List[str] = []
    if major_items:
        for index, item in enumerate(major_items, start=1):
            news_rows.append(f"{index}. [{format_timestamp(item.get('published_at'))}] {item['title']}")
            news_rows.append(f"   来源：{item['source']} | {item['url']}")
    else:
        news_rows.append(f"- 最近 {NEWS_LOOKBACK_HOURS} 小时暂未筛出高置信度重大事件。")
    lines.extend(build_section("最近24小时大事", news_rows))

    focus_rows = [f"- {item}" for item in watch_points]
    focus_rows.append("- 若盘中出现放量异动，优先复核单一高波动仓位。")
    lines.extend(build_section("市场关注", focus_rows))
    return "\n".join(lines)


def should_ignore_trade_day() -> bool:
    return os.getenv("OPENCLAW_IGNORE_TRADE_DAY", "").strip().lower() in {"1", "true", "yes", "on"}


def build_morning_news_drivers(jin10_news: List[dict], web_news: List[dict]) -> List[dict]:
    return select_major_news_with_primary(
        sort_and_dedupe_news(jin10_news),
        sort_and_dedupe_news(web_news),
        limit=2,
    )


def build_morning_market_summary(
    label: str,
    clean_rows: List[dict],
    candidate_rows: List[dict],
    picks: List[dict],
    index_rows: List[dict],
) -> dict:
    index_moves = [safe_float(item.get("pct_chg"), 0.0) for item in index_rows if item]
    leaders = sorted(clean_rows, key=lambda item: item.get("pct_chg", -999.0), reverse=True)[:3]
    return {
        "label": label,
        "breadth": compute_market_breadth(clean_rows),
        "candidate_count": len(candidate_rows),
        "picks": picks,
        "indices": index_rows,
        "leaders": leaders,
        "temperature": classify_market_temperature(index_moves, compute_market_breadth(clean_rows)),
    }


def fetch_morning_market_snapshot() -> dict:
    tasks = {
        "a_stocks": fetch_a_share_spot_rows,
        "a_etfs": fetch_a_etf_spot_rows,
        "hk_spot": fetch_hk_spot_rows,
        "us_spot": fetch_us_spot_rows,
        "a_index": fetch_a_index_rows,
        "hk_index": fetch_hk_index_rows,
    }
    results = {key: [] for key in tasks}
    errors: Dict[str, str] = {}

    with ThreadPoolExecutor(max_workers=len(tasks)) as executor:
        future_map = {executor.submit(loader): key for key, loader in tasks.items()}
        for future in as_completed(future_map):
            key = future_map[future]
            try:
                results[key] = future.result()
            except Exception as exc:
                errors[key] = str(exc)[:200]
                results[key] = []

    for key in ("a_stocks", "hk_spot"):
        if not results.get(key) and key not in errors:
            errors[key] = "empty payload"

    a_stock_clean = filter_morning_rows(results["a_stocks"], market="A", liquidity_only=False)
    a_stock_candidates = filter_morning_rows(results["a_stocks"], market="A", liquidity_only=True)
    a_etf_candidates = filter_morning_rows(results["a_etfs"], market="A", liquidity_only=True)
    a_candidates = a_stock_candidates + a_etf_candidates

    hk_clean = filter_morning_rows(results["hk_spot"], market="HK", liquidity_only=False)
    hk_candidates = filter_morning_rows(results["hk_spot"], market="HK", liquidity_only=True)

    us_clean = filter_morning_rows(results["us_spot"], market="US", liquidity_only=False)
    us_candidates = filter_morning_rows(results["us_spot"], market="US", liquidity_only=True)

    a_index_rows = results["a_index"]
    hk_index_rows = results["hk_index"]

    a_summary = build_morning_market_summary(
        label="A股",
        clean_rows=a_stock_clean,
        candidate_rows=a_candidates,
        picks=choose_market_picks(a_candidates),
        index_rows=[
            item
            for item in (
                find_index_row(a_index_rows, names=("上证指数",), codes=("000001",)),
                find_index_row(a_index_rows, names=("深证成指",), codes=("399001",)),
                find_index_row(a_index_rows, names=("创业板指",), codes=("399006",)),
            )
            if item is not None
        ],
    )
    hk_summary = build_morning_market_summary(
        label="港股",
        clean_rows=hk_clean,
        candidate_rows=hk_candidates,
        picks=choose_market_picks(hk_candidates),
        index_rows=[
            item
            for item in (
                find_index_row(hk_index_rows, names=("恒生指数",), codes=("HSI",)),
                find_index_row(hk_index_rows, names=("恒生科技指数",), codes=("HSTECH", "HSTECF2L")),
            )
            if item is not None
        ],
    )
    us_summary = build_morning_market_summary(
        label="美股",
        clean_rows=us_clean,
        candidate_rows=us_candidates,
        picks=choose_market_picks(us_candidates),
        index_rows=[
            item
            for item in (
                next((row for row in us_clean if row.get("symbol") == "SPY"), None),
                next((row for row in us_clean if row.get("symbol") == "QQQ"), None),
            )
            if item is not None
        ],
    )

    return {
        "generated_at": now_cn().isoformat(),
        "markets": {"A": a_summary, "HK": hk_summary, "US": us_summary},
        "errors": errors,
        "raw_counts": {
            "a_stocks": len(results["a_stocks"]),
            "a_etfs": len(results["a_etfs"]),
            "hk_spot": len(results["hk_spot"]),
            "us_spot": len(results["us_spot"]),
        },
    }


def get_morning_skip_reason(snapshot: Optional[dict] = None) -> str:
    if should_ignore_trade_day():
        return ""
    if now_cn().weekday() >= 5:
        return "周末，A股和港股休市，早报不推送。"
    if snapshot is None:
        return ""
    snapshot = snapshot or {}
    markets = snapshot.get("markets") or {}
    a_total = safe_int(((markets.get("A") or {}).get("breadth") or {}).get("total"), 0)
    hk_total = safe_int(((markets.get("HK") or {}).get("breadth") or {}).get("total"), 0)
    errors = snapshot.get("errors") or {}
    if a_total <= 0 and hk_total <= 0 and not errors:
        return "A股和港股均未取到有效盘中数据，判定为非交易日，早报不推送。"
    return ""


def assess_morning_health(snapshot: Optional[dict]) -> dict:
    snapshot = snapshot or {}
    critical_issues: List[str] = []
    warning_issues: List[str] = []

    errors = snapshot.get("errors") or {}
    for key, value in sorted(errors.items()):
        issue = f"source {key}: {clean_text(str(value))}"
        if key in MORNING_HEALTH_CRITICAL_SOURCE_KEYS:
            critical_issues.append(issue)
        else:
            warning_issues.append(issue)

    markets = snapshot.get("markets") or {}
    for market, threshold in MORNING_HEALTH_MIN_CANDIDATES.items():
        summary = markets.get(market) or {}
        candidate_count = safe_int(summary.get("candidate_count"), 0)
        breadth_total = safe_int((summary.get("breadth") or {}).get("total"), 0)
        critical_candidate_floor = safe_int(MORNING_HEALTH_CRITICAL_MIN_CANDIDATES.get(market), 0)
        critical_breadth_floor = safe_int(MORNING_HEALTH_CRITICAL_MIN_BREADTH.get(market), 0)

        if candidate_count < threshold:
            issue = f"{market} coverage low: candidates {candidate_count} < {threshold}, breadth {breadth_total}"
            if candidate_count <= critical_candidate_floor or breadth_total <= critical_breadth_floor:
                critical_issues.append(issue)
            else:
                warning_issues.append(issue)

    severity = ""
    if critical_issues:
        severity = "critical"
    elif warning_issues:
        severity = "warning"

    return {
        "severity": severity,
        "critical_issues": critical_issues,
        "warning_issues": warning_issues,
        "issues": critical_issues + warning_issues,
    }


def build_morning_health_alert(snapshot: Optional[dict]) -> str:
    snapshot = snapshot or {}
    health = assess_morning_health(snapshot)
    issues = health["issues"]
    if not issues:
        return ""

    markets = snapshot.get("markets") or {}
    raw_counts = snapshot.get("raw_counts") or {}
    severity = str(health.get("severity", "")).upper() or "WARNING"
    lines = [
        f"【龙虾 10:00 数据源告警 | {severity}】{now_cn().strftime('%Y-%m-%d %H:%M')}",
        "晨报已生成，但本次全市场扫描触发了健康告警：",
        "",
        "告警级别",
        f"- {severity}",
        "",
        "异常摘要",
        *[f"- {item}" for item in issues[:8]],
        "",
        "覆盖快照",
        (
            f"- A: breadth {safe_int(((markets.get('A') or {}).get('breadth') or {}).get('total'), 0)}"
            f" | candidates {safe_int((markets.get('A') or {}).get('candidate_count'), 0)}"
            f" | raw stocks {safe_int(raw_counts.get('a_stocks'), 0)}"
            f" | raw etfs {safe_int(raw_counts.get('a_etfs'), 0)}"
        ),
        (
            f"- HK: breadth {safe_int(((markets.get('HK') or {}).get('breadth') or {}).get('total'), 0)}"
            f" | candidates {safe_int((markets.get('HK') or {}).get('candidate_count'), 0)}"
            f" | raw spot {safe_int(raw_counts.get('hk_spot'), 0)}"
        ),
        (
            f"- US: breadth {safe_int(((markets.get('US') or {}).get('breadth') or {}).get('total'), 0)}"
            f" | candidates {safe_int((markets.get('US') or {}).get('candidate_count'), 0)}"
            f" | raw spot {safe_int(raw_counts.get('us_spot'), 0)}"
        ),
        "",
        "处理建议",
        "- 优先检查对应上游接口是否限流、超时或返回空载荷。",
        "- 若连续多日告警，再调整阈值或补充新的 fallback 源。",
    ]
    return "\n".join(lines)


def market_currency_prefix(market: str) -> str:
    return {"A": "¥", "HK": "HK$", "US": "$"}.get(market, "")


def build_pick_reason(item: dict) -> str:
    reasons = []
    if item.get("asset_type") == "etf":
        reasons.append("高流动性 ETF，适合做指数/板块表达")
    if safe_float(item.get("pct_chg"), 0.0) != 0:
        reasons.append(f"日内 {format_pct_points(item.get('pct_chg', 0.0))}")
    if safe_float(item.get("ret_20d"), 0.0) > 0:
        reasons.append(f"20日 {item['ret_20d'] * 100:+.1f}%")
    elif safe_float(item.get("ret_60d"), 0.0) > 0:
        reasons.append(f"60日 {item['ret_60d'] * 100:+.1f}%")
    if safe_float(item.get("amount"), 0.0) > 0:
        reasons.append(
            f"成交额 {format_compact_amount(item.get('amount', 0.0), market_currency_prefix(str(item.get('market', ''))))}"
        )
    return "，".join(reasons[:3]) or "流动性和趋势评分靠前"


def build_entry_plan(item: dict) -> str:
    price = safe_float(item.get("price"), 0.0)
    pct_chg = safe_float(item.get("pct_chg"), 0.0)
    market = str(item.get("market", ""))
    if price <= 0:
        return "等待下一根有效价格确认后再执行"
    if market == "US":
        if pct_chg >= 2.0:
            return f"今晚高开不追，回踩 {format_price_compact(price * 0.99)} 附近再看"
        return f"今晚开盘后 15 分钟再看，{format_price_compact(price * 0.995)}-{format_price_compact(price * 1.005)} 试单"
    if pct_chg >= 3.0:
        return f"不追高，回踩 {format_price_compact(price * 0.985)}-{format_price_compact(price * 0.995)} 再考虑"
    if pct_chg >= 0:
        return f"现价附近轻仓试单，参考 {format_price_compact(price * 0.995)}-{format_price_compact(price * 1.005)}"
    reference = max(price, safe_float(item.get("open"), price))
    return f"先等重回 {format_price_compact(reference)} 上方再考虑"


def build_stop_target_text(item: dict) -> str:
    price = safe_float(item.get("price"), 0.0)
    if price <= 0:
        return "止损/止盈位待价格恢复后更新"
    stop_price = price * 0.97
    target_low = price * 1.05
    target_high = price * 1.08
    return (
        f"止损 {format_price_compact(stop_price)} | "
        f"目标 {format_price_compact(target_low)}-{format_price_compact(target_high)}"
    )


def build_morning_market_line(summary: dict) -> str:
    breadth = summary.get("breadth") or {}
    index_bits = [
        f"{item['name']} {format_pct_points(item.get('pct_chg', 0.0))}"
        for item in summary.get("indices", [])
        if item
    ]
    index_text = "；".join(index_bits[:3]) if index_bits else "暂无核心指数快照"
    return (
        f"- {summary.get('label', '')}：{summary.get('temperature', '中性')}；"
        f"{index_text}；上涨 {safe_int(breadth.get('up'), 0)} / 下跌 {safe_int(breadth.get('down'), 0)}；"
        f"入池 {safe_int(summary.get('candidate_count'), 0)}"
    )


def build_market_execution_text(summary: dict, market: str) -> str:
    temperature = str(summary.get("temperature", "中性"))
    if market == "US":
        if temperature in {"偏强", "中性偏强"}:
            return "今晚以前两名各 4%-6% 观察，开盘 15 分钟后再决定，不追高开。"
        if temperature == "中性":
            return "今晚只留 1 个观察标的，仓位压到 3%-4%。"
        return "今晚以观察为主，除非开盘后与 SPY/QQQ 共振转强。"
    if temperature == "偏强":
        return "可按前两名分配 4%-6% 观察仓，单市场上限 12%。"
    if temperature == "中性偏强":
        return "优先首选标的 4%-5% 试单，次选控制在 3%-4%。"
    if temperature == "中性":
        return "只做首选 3%-4% 轻仓，不追涨。"
    return "先观察，除非重新站稳开盘价并放量。"


def normalize_reference_symbol(symbol: str) -> str:
    normalized = str(symbol or "").strip().upper()
    return normalized.replace(".SS", ".SH")


def build_ai_reference_rows(reference_state: Optional[dict], snapshot: dict) -> List[str]:
    reference_state = reference_state or {}
    raw_positions = (reference_state.get("positions") if isinstance(reference_state, dict) else {}) or {}
    positions = raw_positions if isinstance(raw_positions, dict) else {}
    if not positions:
        return [
            "- AI模拟持仓参考：当前模拟账户为空仓，晨报只输出观察清单，不直接触发模拟调仓。",
            "- 使用原则：晨报负责盘前筛选和盘中复核，AI模拟持仓仍沿用原有调仓与风控逻辑。",
        ]

    ranked_positions = sorted(
        positions.items(),
        key=lambda item: safe_float((item[1] or {}).get("portfolio_pct"), 0.0) if isinstance(item[1], dict) else 0.0,
        reverse=True,
    )
    top_position_bits = []
    reference_symbols = {}
    for symbol, detail in ranked_positions:
        detail = detail if isinstance(detail, dict) else {}
        normalized_symbol = normalize_reference_symbol(symbol)
        reference_symbols[normalized_symbol] = detail
        if len(top_position_bits) < 3:
            top_position_bits.append(
                f"{resolve_symbol_name(symbol)}({symbol}) {format_pct(safe_float(detail.get('portfolio_pct'), 0.0))}"
            )

    overlap_bits = []
    for market in ("A", "HK", "US"):
        for item in snapshot["markets"][market].get("picks", []):
            normalized_symbol = normalize_reference_symbol(item.get("symbol", ""))
            if normalized_symbol in reference_symbols:
                overlap_bits.append(f"{item['name']}({item['display_symbol']})")

    rows = [f"- AI模拟持仓参考：当前前3仓 = {'；'.join(top_position_bits)}。"]
    if overlap_bits:
        rows.append(f"- 晨报与模拟仓重叠：{'；'.join(overlap_bits[:3])}，可优先作为盘中复核对象。")
    else:
        rows.append("- 晨报候选与模拟仓当前重叠较少，默认只做参考，不直接改写 AI 模拟持仓。")
    rows.append("- 使用原则：晨报信号是参考层，AI模拟持仓仍以既有调仓与风控逻辑为主。")
    return rows


def build_morning_report(
    snapshot: dict,
    jin10_news: List[dict],
    web_news: List[dict],
    reference_state: Optional[dict] = None,
) -> str:
    dt = now_cn().strftime("%Y-%m-%d %H:%M")
    drivers = build_morning_news_drivers(jin10_news, web_news)
    reference_state = reference_state if isinstance(reference_state, dict) else {}
    raw_positions = reference_state.get("positions") or {}
    position_map = raw_positions if isinstance(raw_positions, dict) else {}
    reference_symbols = {
        normalize_reference_symbol(symbol)
        for symbol in position_map
    }
    lines = [
        f"【龙虾 10:00 全市场晨报】{dt}",
        "范围：A股 + 港股 + 美股隔夜，全市场扫描（个股 + 高流动性 ETF），仅交易日推送。",
        "定位：晨报信号只作为 AI 模拟持仓系统的盘前参考，不直接改写模拟仓。",
        "",
    ]

    market_rows = [
        build_morning_market_line(snapshot["markets"]["A"]),
        build_morning_market_line(snapshot["markets"]["HK"]),
        build_morning_market_line(snapshot["markets"]["US"]),
    ]
    if drivers:
        for index, item in enumerate(drivers, start=1):
            market_rows.append(f"- 驱动 {index}：[{format_timestamp(item.get('published_at'))}] {item['title']}（{item['source']}）")
    else:
        market_rows.append("- 驱动：最近 24 小时未筛出高置信度宏观主线，优先观察量价而非追消息。")
    lines.extend(build_section("A. 市场温度", market_rows))

    pick_rows: List[str] = []
    for market in ("A", "HK", "US"):
        summary = snapshot["markets"][market]
        if not summary.get("picks"):
            pick_rows.append(f"- {summary['label']}：暂无同时满足流动性与趋势条件的标的。")
            continue
        pick_rows.append(f"- {summary['label']}优先标的：")
        for index, item in enumerate(summary["picks"], start=1):
            reference_tag = " | AI模拟仓重叠" if normalize_reference_symbol(item.get("symbol", "")) in reference_symbols else ""
            pick_rows.append(
                f"  {index}. {item['name']} ({item['display_symbol']}) | 现价 {format_price_compact(item['price'])} | "
                f"{format_pct_points(item.get('pct_chg', 0.0))} | {build_pick_reason(item)}{reference_tag}"
            )
            pick_rows.append(f"     执行：{build_entry_plan(item)}；{build_stop_target_text(item)}")
    lines.extend(build_section("B. 今日优先标的", pick_rows))

    plan_rows = [
        (
            f"- 总仓位控制：轻仓试错，总仓不超过 {int(MORNING_TOTAL_POSITION_LIMIT * 100)}%，"
            f"单市场不超过 {int(MORNING_SINGLE_MARKET_LIMIT * 100)}%，"
            f"单标的不超过 {int(MORNING_SINGLE_POSITION_LIMIT * 100)}%。"
        ),
        f"- A股：{build_market_execution_text(snapshot['markets']['A'], 'A')}",
        f"- 港股：{build_market_execution_text(snapshot['markets']['HK'], 'HK')}",
        f"- 美股：{build_market_execution_text(snapshot['markets']['US'], 'US')}",
        *build_ai_reference_rows(reference_state, snapshot),
        "- 盘中加仓信号：指数/ETF 同向放量，且标的站稳开盘价与 VWAP。",
        "- 盘中减仓信号：30 分钟内跌破开盘价并放量，或单日冲高 >5% 后明显回落。",
    ]
    key_stop_parts = []
    for market in ("A", "HK", "US"):
        for item in snapshot["markets"][market].get("picks", [])[:1]:
            stop_price = safe_float(item.get("price"), 0.0) * 0.97
            key_stop_parts.append(f"{item['display_symbol']} {format_price_compact(stop_price)}")
    if key_stop_parts:
        plan_rows.append(f"- 关键止损位：{'；'.join(key_stop_parts)}。")
    lines.extend(build_section("C. 仓位与执行计划", plan_rows))

    risk_rows = [
        "- 若 A股/港股核心指数 30 分钟内由红翻绿且放量，主动降低白天仓位。",
        "- 若今晚美股高开超过 2% 后快速回落，不追涨，等待二次确认。",
    ]
    if now_cn().weekday() == 4:
        risk_rows.append("- 今天是周五，若白天仓位已有利润，优先考虑减半过周末。")
    if snapshot.get("errors"):
        error_text = "；".join(f"{key}: {value}" for key, value in sorted(snapshot["errors"].items())[:3])
        risk_rows.append(f"- 数据源提示：{error_text}")
    risk_rows.append("- 风险提示：本分析仅供模拟盘/流程参考，不构成任何投资建议。")
    lines.extend(build_section("D. 风险提示", risk_rows))
    return "\n".join(lines)


def build_investment_advice(config: dict, category_metrics: Dict[str, List[dict]], allocations: dict, analysis: dict) -> List[str]:
    advice = []
    category_views = []
    for category in config.get("categories", []):
        key = category["key"]
        metrics = sorted(category_metrics.get(key, []), key=lambda row: row.get("score", -999), reverse=True)
        if not metrics:
            continue
        sample = metrics[: min(3, len(metrics))]
        avg_20d = sum(item.get("ret_20d", 0.0) for item in sample) / len(sample)
        avg_60d = sum(item.get("ret_60d", 0.0) for item in sample) / len(sample)
        category_views.append((avg_60d, avg_20d, resolve_category_name(category), metrics[0]))

    if category_views:
        strongest = max(category_views, key=lambda row: row[0])
        weakest = min(category_views, key=lambda row: row[0])
        if strongest[0] > 0:
            advice.append(
                f"强势方向：{strongest[2]} 当前由 {resolve_symbol_name(strongest[3]['symbol'], strongest[3].get('name', ''))}({strongest[3]['symbol']}) 领跑，可继续跟踪趋势延续。"
            )
        if weakest[0] < 0:
            advice.append(
                f"弱势方向：{weakest[2]} 在 20 日和 60 日维度仍偏弱，避免盲目追高与逆势加仓。"
            )

    largest_position = None
    for detail in allocations.values():
        for item in detail.get("picks", []):
            if largest_position is None or item.get("portfolio_pct", 0.0) > largest_position.get("portfolio_pct", 0.0):
                largest_position = item
    if largest_position and largest_position.get("portfolio_pct", 0.0) > 0.18:
        advice.append(
            f"集中度提醒：{resolve_symbol_name(largest_position['symbol'], largest_position.get('name', ''))}({largest_position['symbol']}) 当前占组合 {format_pct(largest_position['portfolio_pct'])}，若继续放大需考虑分散风险。"
        )
    else:
        advice.append("仓位分散度尚可，继续控制单一资产与单一主题暴露。")

    if analysis.get("turnover_pct", 0.0) > 0.10:
        advice.append("调仓动作偏多，注意成交成本与滑点，避免情绪化来回切换。")
    else:
        advice.append("当前换手可控，维持小步调整节奏即可。")
    return advice[:3]


def build_noon_report(
    config: dict,
    category_metrics: Dict[str, List[dict]],
    allocations: dict,
    jin10_news: List[dict],
    web_news: List[dict],
    state: dict,
    analysis: dict,
    market_status: Optional[dict] = None,
) -> str:
    dt = now_cn().strftime("%Y-%m-%d %H:%M")
    jin10_items = sort_and_dedupe_news(jin10_news)
    web_items = sort_and_dedupe_news(web_news)
    merged_news = select_major_news_with_primary(
        jin10_items,
        web_items,
        limit=MAX_NOON_NEWS_ITEMS,
    )
    lines = [f"【龙虾 12:00 金融分析】{dt}", ""]

    overview_rows = [
        f"- 组合市值：{format_usd(analysis.get('portfolio_value', 0.0))}",
        f"- 当日盈亏：{format_signed_pct(analysis.get('daily_pnl_pct', 0.0))}（{format_signed_usd(analysis.get('daily_pnl_amount', 0.0))}）",
        f"- 预计换手：{format_pct(analysis.get('turnover_pct', 0.0))}（{format_usd(analysis.get('turnover_amount', 0.0))}）",
    ]
    category_pnl = sorted((analysis.get("category_pnl") or {}).items(), key=lambda row: abs(row[1]), reverse=True)
    for key, pnl_amount in category_pnl[:3]:
        overview_rows.append(f"- 波动较大：{resolve_category_name(key, config.get('categories'))} {format_signed_usd(pnl_amount)}")
    if analysis.get("top_contributors"):
        top = analysis["top_contributors"][0]
        overview_rows.append(
            f"- 贡献最多：{resolve_symbol_name(top['symbol'], top.get('name', ''))}({top['symbol']}) {format_signed_pct(top['ret_1d'])}，贡献 {format_signed_usd(top['pnl_amount'])}"
        )
    if analysis.get("top_detractors"):
        weak = analysis["top_detractors"][0]
        overview_rows.append(
            f"- 拖累最多：{resolve_symbol_name(weak['symbol'], weak.get('name', ''))}({weak['symbol']}) {format_signed_pct(weak['ret_1d'])}，拖累 {format_signed_usd(weak['pnl_amount'])}"
        )
    lines.extend(build_section("组合概览", overview_rows))
    lines.extend(build_section("行情数据", build_market_status_rows(market_status)))

    momentum_rows: List[str] = []
    for category in config.get("categories", []):
        key = category["key"]
        metrics = sorted(category_metrics.get(key, []), key=lambda row: row.get("score", -999), reverse=True)
        category_name = resolve_category_name(category)
        if not metrics:
            momentum_rows.append(f"- {category_name}：暂无可用行情数据")
            continue
        leader = metrics[0]
        tail = metrics[-1]
        momentum_rows.append(
            f"- {category_name}领跑：{resolve_symbol_name(leader['symbol'], leader.get('name', ''))}({leader['symbol']}) 1D {format_pct(leader['ret_1d'])} / 20D {format_pct(leader['ret_20d'])} / 60D {format_pct(leader['ret_60d'])}"
        )
        if tail['symbol'] != leader['symbol']:
            momentum_rows.append(
                f"  拖后：{resolve_symbol_name(tail['symbol'], tail.get('name', ''))}({tail['symbol']}) 1D {format_pct(tail['ret_1d'])} / 20D {format_pct(tail['ret_20d'])} / 60D {format_pct(tail['ret_60d'])}"
            )
    lines.extend(build_section("板块动量", momentum_rows))

    allocation_rows: List[str] = [f"- 当前组合总资产：{format_usd(state.get('portfolio_value', 0.0))}"]
    for category in config.get("categories", []):
        key = category['key']
        detail = allocations.get(key, {})
        allocation_rows.append(f"- {resolve_category_name(category)}子类仓位：{format_pct(float(detail.get('category_pct', 0.0)))}")
        picks = detail.get('picks', [])
        if not picks:
            allocation_rows.append("  - 暂无持仓")
            continue
        for item in picks[:MAX_ALLOCATION_PICKS]:
            allocation_rows.append(
                f"  - {resolve_symbol_name(item['symbol'], item.get('name', ''))}({item['symbol']})：子类内 {format_pct(float(item['category_pct']))}，组合内 {format_pct(float(item['portfolio_pct']))}"
            )
    lines.extend(build_section("AI模拟持仓", allocation_rows))

    news_rows: List[str] = []
    if merged_news:
        for index, item in enumerate(merged_news, start=1):
            news_rows.append(
                f"- 事件 {index} [{format_timestamp(item.get('published_at'))}] {item['title']}（{item['source']}）"
            )
    else:
        news_rows.append(f"- 最近 {NEWS_LOOKBACK_HOURS} 小时暂无高置信度重大事件。")
    lines.extend(build_section("最近24小时大事", news_rows))

    advice_rows = [f"- {item}" for item in build_investment_advice(config, category_metrics, allocations, analysis)]
    lines.extend(build_section("投资提醒", advice_rows))
    lines.extend(build_section("风险提示", ["- 本分析基于公开行情与模拟持仓推演，不构成任何投资建议。"]))
    return "\n".join(lines)


def dashboard_mode_enabled() -> bool:
    return os.getenv("FINANCE_DASHBOARD_MODE", "1").strip().lower() not in {"0", "false", "no", "off"}


def get_dashboard_public_base_url() -> str:
    for env_name in ("FINANCE_DASHBOARD_PUBLIC_BASE_URL", "OPENCLAW_PUBLIC_BASE_URL"):
        value = os.getenv(env_name, "").strip()
        if value:
            return value.rstrip("/")
    return DEFAULT_DASHBOARD_PUBLIC_BASE_URL.rstrip("/")


def discover_dashboard_secret_from_service() -> str:
    candidates = [
        Path("/etc/systemd/system/openclaw-finance-dashboard.service"),
        Path("/lib/systemd/system/openclaw-finance-dashboard.service"),
    ]
    pattern = re.compile(r"FINANCE_DASHBOARD_SECRET=([A-Za-z0-9._:-]+)")
    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        match = pattern.search(text)
        if match:
            return match.group(1).strip()
    return ""


def resolve_dashboard_secret() -> str:
    explicit = os.getenv("FINANCE_DASHBOARD_SECRET", "").strip()
    if explicit:
        return explicit
    service_secret = discover_dashboard_secret_from_service()
    if service_secret:
        return service_secret
    return ""


def build_dashboard_access_route(secret: str, date_str: str = "") -> str:
    resolved_date = date_str or now_cn().date().isoformat()
    return f"/finance/access/{build_daily_key(secret, resolved_date)}"


def resolve_dashboard_target_route(secret: str, date_str: str = "") -> str:
    if not secret:
        return DEFAULT_TELEGRAM_ROUTE
    return build_dashboard_access_route(secret, date_str)


def build_dashboard_access_url(secret: str, date_str: str = "", public_base_url: str = "") -> str:
    base_url = (public_base_url or get_dashboard_public_base_url()).rstrip("/")
    return f"{base_url}{build_dashboard_access_route(secret, date_str)}"


def build_dashboard_telegram_message(
    access_url: str,
    notice: str = "今日金融分析工作台 / Today's Finance Dashboard",
) -> str:
    return f"{notice}\n{access_url}".strip()


def infer_market_from_symbol(symbol: str) -> str:
    normalized = normalize_reference_symbol(symbol)
    if normalized.endswith(".HK"):
        return "HK"
    if normalized.endswith(".SH") or normalized.endswith(".SZ"):
        return "A"
    if normalized.endswith("-USD") or normalized in {"GC=F", "SI=F", "GLD", "SLV"}:
        return "Macro"
    return "US"


def build_morning_ai_reference(reference_state: Optional[dict], snapshot: dict) -> dict:
    reference_state = reference_state or {}
    raw_positions = (reference_state.get("positions") if isinstance(reference_state, dict) else {}) or {}
    positions = raw_positions if isinstance(raw_positions, dict) else {}
    ranked_positions = sorted(
        positions.items(),
        key=lambda item: safe_float((item[1] or {}).get("portfolio_pct"), 0.0) if isinstance(item[1], dict) else 0.0,
        reverse=True,
    )
    top_positions = []
    reference_symbols = {}
    for symbol, detail in ranked_positions:
        detail = detail if isinstance(detail, dict) else {}
        normalized_symbol = normalize_reference_symbol(symbol)
        reference_symbols[normalized_symbol] = detail
        if len(top_positions) < 5:
            top_positions.append(
                {
                    "symbol": symbol,
                    "name": resolve_symbol_name(symbol, detail.get("name", "")),
                    "portfolio_pct": safe_float(detail.get("portfolio_pct"), 0.0),
                }
            )
    overlap_picks = []
    for market in ("A", "HK", "US"):
        for item in ((snapshot.get("markets") or {}).get(market) or {}).get("picks", []):
            normalized_symbol = normalize_reference_symbol(item.get("symbol", ""))
            if normalized_symbol not in reference_symbols:
                continue
            overlap_picks.append(
                {
                    "market": market,
                    "symbol": item.get("symbol", ""),
                    "display_symbol": item.get("display_symbol") or item.get("symbol", ""),
                    "name": item.get("name", ""),
                }
            )
    if not positions:
        note = "当前模拟账户为空仓，晨报只输出观察清单，不直接触发模拟调仓。"
    elif overlap_picks:
        note = "晨报候选与 AI 模拟仓出现重叠，优先作为盘中复核和风控跟踪对象。"
    else:
        note = "晨报候选与当前模拟仓重叠较少，默认作为下一轮候选池参考。"
    return {
        "has_positions": bool(positions),
        "top_positions": top_positions,
        "overlap_picks": overlap_picks,
        "note": note,
    }


def build_portfolio_market_linkage(positions: dict, morning_payload: Optional[dict]) -> dict:
    positions = positions if isinstance(positions, dict) else {}
    morning_payload = morning_payload if isinstance(morning_payload, dict) else {}
    position_lookup = {}
    market_exposure = {"A": 0.0, "HK": 0.0, "US": 0.0, "Macro": 0.0}
    ranked_positions = []
    for symbol, detail in positions.items():
        detail = detail if isinstance(detail, dict) else {}
        normalized_symbol = normalize_reference_symbol(symbol)
        market = infer_market_from_symbol(symbol)
        portfolio_pct = safe_float(detail.get("portfolio_pct"), 0.0)
        market_exposure[market] = market_exposure.get(market, 0.0) + portfolio_pct
        resolved = {
            "symbol": symbol,
            "name": resolve_symbol_name(symbol, detail.get("name", "")),
            "portfolio_pct": portfolio_pct,
            "amount_usd": safe_float(detail.get("amount_usd"), 0.0),
            "market": market,
        }
        position_lookup[normalized_symbol] = resolved
        ranked_positions.append(resolved)
    ranked_positions.sort(key=lambda item: item["portfolio_pct"], reverse=True)

    overlap_picks = []
    watchlist_candidates = []
    market_temperatures = {}
    for market in ("A", "HK", "US"):
        market_summary = ((morning_payload.get("markets") or {}).get(market) or {})
        market_temperatures[market] = market_summary.get("temperature", "")
        for item in market_summary.get("picks", []):
            normalized_symbol = normalize_reference_symbol(item.get("symbol", ""))
            linked = {
                "market": market,
                "symbol": item.get("symbol", ""),
                "display_symbol": item.get("display_symbol") or item.get("symbol", ""),
                "name": item.get("name", ""),
            }
            if normalized_symbol in position_lookup:
                overlap_picks.append(
                    {
                        **linked,
                        "portfolio_pct": position_lookup[normalized_symbol]["portfolio_pct"],
                        "amount_usd": position_lookup[normalized_symbol]["amount_usd"],
                    }
                )
            else:
                watchlist_candidates.append(linked)

    notes = []
    if overlap_picks:
        notes.append(f"晨报优先标的与模拟仓重叠 {len(overlap_picks)} 个，可直接复核强弱延续。")
    else:
        notes.append("晨报优先标的与当前模拟仓暂无重叠，优先作为候选池和减仓对照。")
    if ranked_positions and ranked_positions[0]["portfolio_pct"] > 0.18:
        notes.append(
            f"集中度偏高：{ranked_positions[0]['name']} 当前占组合 {format_pct(ranked_positions[0]['portfolio_pct'])}。"
        )
    weak_markets = [
        market
        for market in ("A", "HK", "US")
        if market_exposure.get(market, 0.0) > 0.0 and market_temperatures.get(market) in {"偏弱", "谨慎"}
    ]
    if weak_markets:
        notes.append(f"当前组合在弱势市场仍有暴露：{' / '.join(weak_markets)}。")
    return {
        "overlap_count": len(overlap_picks),
        "overlap_picks": overlap_picks[:6],
        "watchlist_candidates": watchlist_candidates[:6],
        "market_exposure": market_exposure,
        "top_holdings": ranked_positions[:5],
        "notes": notes[:4],
    }


def build_news_stage_payload(
    jin10_news: List[dict],
    web_news: List[dict],
    message_text: str,
    telegram_delivery: dict,
) -> dict:
    major_items = select_major_news_with_primary(jin10_news, web_news, limit=MAX_MORNING_NEWS_ITEMS)
    major_items, news_summary = summarize_news_with_openclaw(major_items, limit=MAX_MORNING_NEWS_ITEMS)
    return {
        "date": now_cn().date().isoformat(),
        "generated_at": now_cn().isoformat(),
        "push_type": "news",
        "status": "ready",
        "message_text": message_text,
        "selected_news": major_items,
        "news_summary": news_summary,
        "watch_points": build_market_watch_points(major_items),
        "telegram_delivery": telegram_delivery,
    }


def build_morning_stage_payload(
    snapshot: dict,
    jin10_news: List[dict],
    web_news: List[dict],
    reference_state: Optional[dict],
    message_text: str,
    telegram_delivery: dict,
) -> dict:
    drivers, _ = summarize_news_with_openclaw(
        build_morning_news_drivers(jin10_news, web_news),
        limit=2,
    )
    return {
        "date": now_cn().date().isoformat(),
        "generated_at": snapshot.get("generated_at") or now_cn().isoformat(),
        "push_type": "morning",
        "status": "ready",
        "message_text": message_text,
        "markets": snapshot.get("markets") or {},
        "drivers": drivers,
        "ai_reference": build_morning_ai_reference(reference_state, snapshot),
        "errors": snapshot.get("errors") or {},
        "raw_counts": snapshot.get("raw_counts") or {},
        "telegram_delivery": telegram_delivery,
    }


def build_health_stage_payload(snapshot: Optional[dict], severity: str, telegram_delivery: dict) -> dict:
    health = assess_morning_health(snapshot or {})
    issues = list(health.get("issues") or [])
    return {
        "date": now_cn().date().isoformat(),
        "generated_at": now_cn().isoformat(),
        "push_type": "health",
        "status": "ready" if issues else "not_triggered",
        "severity": (severity or health.get("severity") or "none").lower(),
        "issues": issues,
        "critical_issues": list(health.get("critical_issues") or []),
        "warning_issues": list(health.get("warning_issues") or []),
        "raw_counts": (snapshot or {}).get("raw_counts") or {},
        "telegram_delivery": telegram_delivery,
    }


def build_noon_stage_payload(
    config: dict,
    category_metrics: Dict[str, List[dict]],
    allocations: dict,
    state: dict,
    analysis: dict,
    market_status: Optional[dict],
    message_text: str,
    telegram_delivery: dict,
    recent_news: Optional[List[dict]] = None,
    morning_payload: Optional[dict] = None,
) -> dict:
    category_pnl_rows = [
        {
            "key": key,
            "name": resolve_category_name(key, config.get("categories")),
            "pnl_amount": safe_float(amount, 0.0),
        }
        for key, amount in (analysis.get("category_pnl") or {}).items()
    ]
    positions_map = (state.get("positions") or {}) if isinstance(state, dict) else {}
    positions = []
    for symbol, detail in positions_map.items():
        detail = detail if isinstance(detail, dict) else {}
        positions.append(
            {
                "symbol": symbol,
                "name": resolve_symbol_name(symbol, detail.get("name", "")),
                "category": detail.get("category", ""),
                "amount_usd": safe_float(detail.get("amount_usd"), 0.0),
                "category_pct": safe_float(detail.get("category_pct"), 0.0),
                "portfolio_pct": safe_float(detail.get("portfolio_pct"), 0.0),
                "updated_at": detail.get("updated_at") or now_cn().isoformat(),
            }
        )
    positions.sort(key=lambda item: item["portfolio_pct"], reverse=True)

    allocation_rows = []
    for category in config.get("categories", []):
        key = category["key"]
        detail = allocations.get(key, {})
        picks = []
        for item in detail.get("picks", []):
            picks.append(
                {
                    "symbol": item.get("symbol", ""),
                    "name": resolve_symbol_name(item.get("symbol", ""), item.get("name", "")),
                    "amount_usd": safe_float(item.get("amount_usd"), 0.0),
                    "category_pct": safe_float(item.get("category_pct"), 0.0),
                    "portfolio_pct": safe_float(item.get("portfolio_pct"), 0.0),
                    "updated_at": now_cn().isoformat(),
                }
            )
        allocation_rows.append(
            {
                "key": key,
                "name": resolve_category_name(category),
                "category_pct": safe_float(detail.get("category_pct"), 0.0),
                "category_amount": safe_float(detail.get("category_amount"), 0.0),
                "picks": picks,
            }
        )

    category_momentum = []
    for category in config.get("categories", []):
        key = category["key"]
        metrics = sorted(category_metrics.get(key, []), key=lambda row: row.get("score", -999), reverse=True)
        if not metrics:
            continue
        leader = dict(metrics[0])
        laggard = dict(metrics[-1]) if metrics[-1]["symbol"] != leader["symbol"] else None
        leader["name"] = resolve_symbol_name(leader["symbol"], leader.get("name", ""))
        if laggard:
            laggard["name"] = resolve_symbol_name(laggard["symbol"], laggard.get("name", ""))
        category_momentum.append(
            {
                "key": key,
                "name": resolve_category_name(category),
                "leader": leader,
                "laggard": laggard,
            }
        )

    ai_summary = build_noon_ai_summary(
        config=config,
        analysis=analysis,
        allocations=allocations,
        market_status=market_status,
        recent_news=recent_news or [],
    )
    return {
        "date": now_cn().date().isoformat(),
        "generated_at": now_cn().isoformat(),
        "push_type": "noon",
        "status": "ready",
        "message_text": message_text,
        "portfolio_summary": {
            "previous_portfolio_value": safe_float(analysis.get("previous_portfolio_value"), 0.0),
            "portfolio_value": safe_float(analysis.get("portfolio_value"), 0.0),
            "daily_pnl_amount": safe_float(analysis.get("daily_pnl_amount"), 0.0),
            "daily_pnl_pct": safe_float(analysis.get("daily_pnl_pct"), 0.0),
            "turnover_amount": safe_float(analysis.get("turnover_amount"), 0.0),
            "turnover_pct": safe_float(analysis.get("turnover_pct"), 0.0),
            "category_pnl": category_pnl_rows,
            "top_contributors": list(analysis.get("top_contributors") or []),
            "top_detractors": list(analysis.get("top_detractors") or []),
        },
        "allocations": allocation_rows,
        "positions": positions,
        "category_momentum": category_momentum,
        "advice": list(ai_summary.get("advice") or build_investment_advice(config, category_metrics, allocations, analysis)),
        "ai_summary": ai_summary,
        "market_status": market_status or {},
        "market_linkage": build_portfolio_market_linkage(positions_map, morning_payload),
        "telegram_delivery": telegram_delivery,
    }


def persist_dashboard_stage(stage: str, payload: dict, secret: str) -> None:
    date_str = str(payload.get("date") or now_cn().date().isoformat())
    write_stage_payload(DASHBOARD_DATA_DIR, date_str, stage, payload)
    latest = load_latest_bundle(DASHBOARD_DATA_DIR)
    history_dates = list_history_dates(DASHBOARD_DATA_DIR)
    generated_at = max(
        [
            str((item or {}).get("generated_at") or "")
            for item in latest.values()
        ]
        or [now_cn().isoformat()]
    )
    index_payload = build_index_payload(
        date=date_str,
        generated_at=generated_at,
        content=latest,
        history_dates=history_dates,
        telegram_access_route=resolve_dashboard_target_route(secret, date_str),
        valid_until=valid_until_for_date(date_str),
    )
    write_stage_payload(DASHBOARD_DATA_DIR, date_str, "index", index_payload)


def load_latest_morning_payload() -> dict:
    latest = load_latest_bundle(DASHBOARD_DATA_DIR)
    payload = latest.get("morning") or {}
    return payload if isinstance(payload, dict) else {}


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


def get_telegram_target(config: dict, override_chat_id: str = "") -> Tuple[str, str]:
    token = ""
    for runtime_path in get_runtime_paths():
        runtime_cfg = load_json(runtime_path, {})
        telegram_cfg = ((runtime_cfg.get("channels") or {}).get("telegram") or {})
        token = telegram_cfg.get("botToken") or telegram_cfg.get("token") or ""
        if token:
            break
    if not token:
        token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    if override_chat_id:
        return token, override_chat_id

    for allow_file in get_allow_paths():
        allow = load_json(allow_file, {})
        arr = allow.get("allowFrom") or []
        if arr:
            return token, str(arr[0])
    return token, ""


def send_telegram(token: str, chat_id: str, text: str) -> dict:
    if not token or not chat_id:
        return {"ok": False, "error": "missing bot token or chat_id"}

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    message_ids: List[int] = []
    for chunk in split_telegram_text(text):
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


def build_delivery_state_from_result(send_result: dict, target_route: str) -> dict:
    ok = bool((send_result or {}).get("ok"))
    error_text = (
        str((send_result or {}).get("error") or (send_result or {}).get("description") or "").strip()[:200] or None
    )
    return build_access_delivery(
        status="sent" if ok else "failed",
        target_route=target_route,
        sent_at=now_cn().isoformat() if ok else None,
        message_ids=[str(item) for item in ((send_result or {}).get("message_ids") or [])],
        error=error_text,
    )


def ensure_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")

def main():
    ensure_utf8_stdio()
    parser = argparse.ArgumentParser(description="OpenClaw finance daily reporter")
    parser.add_argument("--mode", choices=["news", "morning", "noon"], required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--chat-id", default="")
    args = parser.parse_args()

    config = load_json(CONFIG_FILE, {})
    if not config:
        print("missing config", file=sys.stderr)
        sys.exit(2)

    token, chat_id = get_telegram_target(config, override_chat_id=args.chat_id)
    dashboard_secret = resolve_dashboard_secret()
    dashboard_requested = dashboard_mode_enabled()
    dashboard_enabled = dashboard_requested and bool(dashboard_secret)
    if dashboard_requested and not dashboard_secret:
        print("finance dashboard disabled: missing FINANCE_DASHBOARD_SECRET", file=sys.stderr)

    skip_send = False
    health_alert_message = ""
    health_alert_level = ""
    main_stage_name = args.mode
    main_stage_payload = None
    health_stage_payload = None
    if args.mode == "news":
        jin10_news = fetch_jin10_news(limit=JIN10_FETCH_LIMIT, lookback_hours=NEWS_LOOKBACK_HOURS)
        web_news = fetch_web_news(limit=WEB_NEWS_FETCH_LIMIT, lookback_hours=NEWS_LOOKBACK_HOURS)
        message = build_news_message(jin10_news, web_news)
        main_stage_payload = build_news_stage_payload(
            jin10_news,
            web_news,
            message,
            build_access_delivery(
                status="skipped" if args.dry_run else "pending",
                target_route=resolve_dashboard_target_route(dashboard_secret),
            ),
        )
    elif args.mode == "morning":
        skip_reason = get_morning_skip_reason()
        if skip_reason:
            skip_send = True
            message = skip_reason
        else:
            jin10_news = fetch_jin10_news(limit=JIN10_FETCH_LIMIT, lookback_hours=NEWS_LOOKBACK_HOURS)
            web_news = fetch_web_news(limit=WEB_NEWS_FETCH_LIMIT, lookback_hours=NEWS_LOOKBACK_HOURS)
            snapshot = fetch_morning_market_snapshot()
            skip_reason = get_morning_skip_reason(snapshot)
            if skip_reason:
                skip_send = True
                message = skip_reason
            else:
                health_alert_level = str(assess_morning_health(snapshot).get("severity", ""))
                health_alert_message = build_morning_health_alert(snapshot)
                reference_state = load_json(STATE_FILE, {})
                message = build_morning_report(
                    snapshot,
                    jin10_news,
                    web_news,
                    reference_state=reference_state,
                )
                target_route = resolve_dashboard_target_route(dashboard_secret)
                main_stage_payload = build_morning_stage_payload(
                    snapshot,
                    jin10_news,
                    web_news,
                    reference_state,
                    message,
                    build_access_delivery(
                        status="skipped" if args.dry_run else "pending",
                        target_route=target_route,
                    ),
                )
                health_should_notify = bool((assess_morning_health(snapshot).get("issues") or []))
                health_stage_payload = build_health_stage_payload(
                    snapshot,
                    health_alert_level,
                    build_access_delivery(
                        status=("skipped" if args.dry_run else "pending") if health_should_notify else "not_triggered",
                        target_route=target_route,
                    ),
                )
    else:
        jin10_news = fetch_jin10_news(limit=JIN10_FETCH_LIMIT, lookback_hours=NEWS_LOOKBACK_HOURS)
        web_news = fetch_web_news(limit=WEB_NEWS_FETCH_LIMIT, lookback_hours=NEWS_LOOKBACK_HOURS)
        recent_news = select_major_news_with_primary(jin10_news, web_news, limit=MAX_NOON_NEWS_ITEMS)
        category_metrics, symbol_metrics, market_status = fetch_market_snapshot(config, prefer_live=True)
        target = calc_target_weights(category_metrics, config)
        result = update_portfolio_state(config, symbol_metrics, target)
        result["state"]["market_data"] = market_status
        save_json(STATE_FILE, result["state"])
        message = build_noon_report(
            config=config,
            category_metrics=category_metrics,
            allocations=result["allocations"],
            jin10_news=jin10_news,
            web_news=web_news,
            state=result["state"],
            analysis=result["analysis"],
            market_status=market_status,
        )
        main_stage_payload = build_noon_stage_payload(
            config=config,
            category_metrics=category_metrics,
            allocations=result["allocations"],
            state=result["state"],
            analysis=result["analysis"],
            market_status=market_status,
            recent_news=recent_news,
            message_text=message,
            telegram_delivery=build_access_delivery(
                status="skipped" if args.dry_run else "pending",
                target_route=resolve_dashboard_target_route(dashboard_secret),
            ),
            morning_payload=load_latest_morning_payload(),
        )

    print(message)
    print("\n---END-REPORT---\n")

    if args.dry_run:
        return
    if main_stage_payload:
        persist_dashboard_stage(main_stage_name, main_stage_payload, dashboard_secret)
    if health_stage_payload:
        persist_dashboard_stage("health", health_stage_payload, dashboard_secret)
    if skip_send:
        print(json.dumps({"ok": True, "skipped": True, "reason": message}, ensure_ascii=False))
        return

    main_target_route = resolve_dashboard_target_route(dashboard_secret)
    access_url = build_dashboard_access_url(dashboard_secret) if dashboard_enabled else ""
    outbound_text = build_dashboard_telegram_message(access_url) if dashboard_enabled else message
    send_result = send_telegram(token, chat_id, outbound_text)
    if main_stage_payload:
        main_stage_payload["telegram_delivery"] = build_delivery_state_from_result(send_result, main_target_route)
        persist_dashboard_stage(main_stage_name, main_stage_payload, dashboard_secret)
    if args.mode == "morning" and health_alert_message:
        health_target_route = resolve_dashboard_target_route(dashboard_secret)
        if send_result.get("ok") and health_stage_payload and health_stage_payload.get("status") == "ready":
            health_text = (
                build_dashboard_telegram_message(access_url, notice="晨间数据预警，请查看金融分析工作台")
                if dashboard_enabled
                else health_alert_message
            )
            send_result["health_alert"] = send_telegram(token, chat_id, health_text)
            send_result["health_alert"]["severity"] = health_alert_level
            health_stage_payload["telegram_delivery"] = build_delivery_state_from_result(
                send_result["health_alert"],
                health_target_route,
            )
        else:
            send_result["health_alert"] = {
                "ok": False,
                "skipped": True,
                "reason": "main morning report send failed",
                "severity": health_alert_level,
            }
            if health_stage_payload and health_stage_payload.get("status") == "ready":
                health_stage_payload["telegram_delivery"] = build_access_delivery(
                    status="skipped",
                    target_route=health_target_route,
                    error="main morning report send failed",
                )
        if health_stage_payload:
            persist_dashboard_stage("health", health_stage_payload, dashboard_secret)
    print(json.dumps(send_result, ensure_ascii=False))


if __name__ == "__main__":
    main()
