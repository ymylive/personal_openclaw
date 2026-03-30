from __future__ import annotations

import base64
import imghdr
import zipfile
import xml.etree.ElementTree as ET
from typing import Any, Iterable
from urllib.parse import urlparse

BASE64_PREFIX = "base64://"


def normalize_attachment(payload: dict) -> dict:
    """Return the provided payload unchanged; placeholder for future parsing."""
    return payload.copy()


def extract_image_urls_from_segments(message: Any) -> list[str]:
    """Extract image URLs from CQ message segments."""
    segments = message if isinstance(message, list) else []
    urls: list[str] = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        if seg.get("type") != "image":
            continue
        data = seg.get("data") or {}
        for key in ("url", "file"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                normalized = value.strip()
                if key == "file" and not _looks_like_url(normalized):
                    continue
                urls.append(normalized)
                break
    return urls


def infer_suffix_from_bytes(data: bytes) -> str:
    """Infer a file suffix based on raw bytes."""
    if not data:
        return ".bin"

    image_type = imghdr.what(None, data)
    if image_type:
        if image_type == "jpeg":
            return ".jpg"
        return f".{image_type}"

    if _looks_like_webp(data):
        return ".webp"
    if _looks_like_pdf(data):
        return ".pdf"
    if _looks_like_text(data):
        return ".txt"

    return ".bin"


def decode_base64_attachment(blob: str) -> tuple[bytes, str]:
    """Decode a base64 blob and return the bytes with a guessed suffix."""
    payload = blob[len(BASE64_PREFIX) :].strip()
    if payload.startswith("data:"):
        payload = payload.split("data:", 1)[1]

    if ";base64," in payload:
        payload = payload.split(";base64,", 1)[1]
    elif "," in payload:
        payload = payload.split(",", 1)[1]
    elif ";" in payload:
        payload = payload.split(";", 1)[1]

    decoded = base64.b64decode(payload, validate=False)
    return decoded, infer_suffix_from_bytes(decoded)


def _looks_like_text(data: bytes) -> bool:
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "gbk"):
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        stripped = text.strip()
        if not stripped:
            continue
        total = len(stripped)
        printable = sum(1 for ch in stripped if ch.isprintable() and ch not in "\t\r\n")
        if printable and printable / total >= 0.7 and any(
            ch.isalpha() or ch.isdigit() for ch in stripped
        ):
            return True
    return False


def _looks_like_webp(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def _looks_like_pdf(data: bytes) -> bool:
    return data.startswith(b"%PDF")


def _looks_like_url(value: str) -> bool:
    parsed = urlparse(value)
    return bool(parsed.scheme and parsed.netloc)


def extract_shared_strings_from_archive(archive: zipfile.ZipFile) -> list[str]:
    """Parse sharedStrings.xml from an XLSX archive."""
    try:
        raw = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []

    root = ET.fromstring(raw)
    strings: list[str] = []
    for si in root.iter():
        if not si.tag.endswith("}si"):
            continue
        parts = []
        for text_node in si.iter():
            if text_node.tag.endswith("}t") and text_node.text:
                parts.append(text_node.text)
        strings.append("".join(parts))
    return strings


def extract_text_from_worksheet(root: ET.Element, shared_strings: Iterable[str]) -> list[str]:
    """Extract text values from a worksheet element."""
    shared_list = list(shared_strings)
    values: list[str] = []

    for row in root.iter():
        if not row.tag.endswith("}row"):
            continue
        for cell in row:
            if not cell.tag.endswith("}c"):
                continue
            text_value = _cell_text_from_element(cell, shared_list)
            if text_value:
                values.append(text_value)

    return values


def _cell_text_from_element(cell: ET.Element, shared_strings: list[str]) -> str:
    """Extract the text content from a single `<c>` element."""
    cell_type = cell.get("t")
    if cell_type == "s":
        for child in cell.iter():
            if child.tag.endswith("}v") and child.text and child.text.isdigit():
                index = int(child.text)
                if 0 <= index < len(shared_strings):
                    return shared_strings[index]
                return ""

    parts: list[str] = []
    for child in cell.iter():
        if child.tag.endswith("}t") and child.text:
            parts.append(child.text)

    value = "".join(parts).strip()
    if value:
        return value

    for child in cell.iter():
        if child.tag.endswith("}v") and child.text:
            return child.text.strip()

    return ""
