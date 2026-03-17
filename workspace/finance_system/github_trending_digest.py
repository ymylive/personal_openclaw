#!/usr/bin/env python3
import argparse
import re
from collections import Counter
from datetime import datetime
from typing import List, Dict

import requests
from bs4 import BeautifulSoup
from zoneinfo import ZoneInfo

TRENDING_URL = "https://github.com/trending"
UA = "Mozilla/5.0 (OpenClaw github_trending_digest)"
TZ = ZoneInfo("Asia/Shanghai")


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def parse_count(text: str) -> int:
    text = clean(text).replace(",", "")
    m = re.search(r"(\d+)", text)
    return int(m.group(1)) if m else 0


def fetch_trending(limit: int = 10, since: str = "daily") -> List[Dict]:
    resp = requests.get(
        TRENDING_URL,
        params={"since": since},
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    repos = []
    for article in soup.select("article.Box-row")[:limit]:
        a = article.select_one("h2 a")
        if not a:
            continue
        href = clean(a.get("href", ""))
        repo = href.strip("/")
        desc = article.select_one("p")
        lang = article.select_one('[itemprop="programmingLanguage"]')
        star_links = article.select('a.Link--muted')
        total_stars = parse_count(star_links[0].get_text(" ", strip=True)) if len(star_links) >= 1 else 0
        forks = parse_count(star_links[1].get_text(" ", strip=True)) if len(star_links) >= 2 else 0
        today_text = ""
        for span in article.select("span.d-inline-block.float-sm-right"):
            t = clean(span.get_text(" ", strip=True))
            if "stars today" in t or "star today" in t:
                today_text = t
                break
        repos.append(
            {
                "repo": repo,
                "url": f"https://github.com/{repo}",
                "desc": clean(desc.get_text(" ", strip=True)) if desc else "",
                "language": clean(lang.get_text(" ", strip=True)) if lang else "未知",
                "stars": total_stars,
                "forks": forks,
                "stars_today": parse_count(today_text),
            }
        )
    return repos


def build_digest(repos: List[Dict], since: str = "daily") -> str:
    now = datetime.now(TZ).strftime("%Y-%m-%d %H:%M")
    if not repos:
        return f"【GitHub 热榜日报】{now}\n今天暂时没抓到 GitHub Trending 数据。"

    lang_counter = Counter(r["language"] for r in repos if r.get("language") and r.get("language") != "未知")
    top_lang = "、".join(f"{lang}({count})" for lang, count in lang_counter.most_common(3)) or "暂无明显集中语言"
    hottest = max(repos, key=lambda x: x.get("stars_today", 0))

    lines = [
        f"【GitHub 热榜日报】{now}",
        f"周期：{since}",
        f"一句话：今天前十里最热的是 {hottest['repo']}，单日新增 {hottest['stars_today']} 星；热门语言主要是 {top_lang}。",
        "",
    ]

    for i, repo in enumerate(repos, start=1):
        headline = f"{i}. {repo['repo']}"
        meta = f"语言：{repo['language']} | 总星标：{repo['stars']} | 今日新增：{repo['stars_today']}"
        lines.append(headline)
        if repo["desc"]:
            lines.append(f"   简介：{repo['desc']}")
        lines.append(f"   {meta}")
        lines.append(f"   {repo['url']}")

    lines.extend(
        [
            "",
            "简评：",
            "- 可以优先看前 3 名和自己技术栈相关的项目，效率最高。",
            "- 如果连续几天都反复上榜，通常说明不只是热闹，值得深入看源码或 README。",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a GitHub trending digest")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--since", choices=["daily", "weekly", "monthly"], default="daily")
    args = parser.parse_args()

    repos = fetch_trending(limit=args.limit, since=args.since)
    print(build_digest(repos, since=args.since))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
