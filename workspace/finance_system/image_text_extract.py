#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import requests

API_URL = "https://api.ocr.space/parse/image"
API_KEY = "helloworld"


def extract_text_from_file(path: Path, language: str = "chs") -> str:
    with path.open("rb") as f:
        resp = requests.post(
            API_URL,
            data={
                "apikey": API_KEY,
                "language": language,
                "OCREngine": 2,
                "scale": True,
                "isTable": False,
            },
            files={"file": (path.name, f)},
            timeout=90,
        )
    resp.raise_for_status()
    data = resp.json()
    parsed = data.get("ParsedResults") or []
    texts = []
    for item in parsed:
        text = (item.get("ParsedText") or "").strip()
        if text:
            texts.append(text)
    return "\n".join(texts).strip()


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract text from an image via OCR.space")
    ap.add_argument("image")
    ap.add_argument("--language", default="chs")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    path = Path(args.image)
    text = extract_text_from_file(path, language=args.language)
    if args.json:
        print(json.dumps({"ok": bool(text), "text": text}, ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
