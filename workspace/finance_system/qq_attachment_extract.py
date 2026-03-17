#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlparse, unquote
from xml.etree import ElementTree as ET

import requests

from llm_vision_extract import text_extract, vision_extract

TEXT_EXTS = {
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv',
    '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.c', '.cc', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.sh', '.sql', '.xml', '.html', '.htm', '.css', '.log', '.ini', '.toml'
}
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
DOCX_EXTS = {'.docx'}
PPTX_EXTS = {'.pptx'}
XLSX_EXTS = {'.xlsx'}
MAX_TEXT_CHARS = 12000


def looks_like_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme in {'http', 'https'} and bool(parsed.netloc)
    except Exception:
        return False


def looks_like_file_url(value: str) -> bool:
    try:
        return urlparse(value).scheme == 'file'
    except Exception:
        return False


def looks_like_base64_blob(value: str) -> bool:
    return isinstance(value, str) and value.startswith('base64://')


def infer_suffix(url: str, content_type: str) -> str:
    suffix = Path(urlparse(url).path).suffix
    if suffix:
        return suffix
    guessed = mimetypes.guess_extension((content_type or '').split(';', 1)[0].strip()) or ''
    return guessed or '.bin'


def download_to_temp(url: str) -> Path:
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    suffix = infer_suffix(url, response.headers.get('content-type', ''))
    fd, tmp = tempfile.mkstemp(prefix='qqattach_', suffix=suffix)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(response.content)
    return Path(tmp)


def decode_base64_to_temp(src: str) -> Path:
    raw = src[len('base64://'):]
    fd, tmp = tempfile.mkstemp(prefix='qqattach_', suffix='.bin')
    with os.fdopen(fd, 'wb') as handle:
        handle.write(base64.b64decode(raw))
    return Path(tmp)


def file_url_to_path(src: str) -> Path:
    parsed = urlparse(src)
    return Path(unquote(parsed.path))


def read_text_bytes(data: bytes) -> str:
    for encoding in ('utf-8', 'utf-8-sig', 'gb18030', 'gbk', 'latin1'):
        try:
            return data.decode(encoding)
        except Exception:
            pass
    return data.decode('utf-8', errors='replace')


def extract_docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        xml = archive.read('word/document.xml')
    root = ET.fromstring(xml)
    parts = [(node.text or '').strip() for node in root.iter() if node.tag.endswith('}t') and (node.text or '').strip()]
    return '\n'.join(parts)


def extract_pptx_text(path: Path) -> str:
    parts = []
    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            if not name.startswith('ppt/slides/slide') or not name.endswith('.xml'):
                continue
            root = ET.fromstring(archive.read(name))
            slide_parts = [(node.text or '').strip() for node in root.iter() if node.tag.endswith('}t') and (node.text or '').strip()]
            if slide_parts:
                parts.append('\n'.join(slide_parts))
    return '\n\n'.join(parts)


def extract_xlsx_text(path: Path) -> str:
    parts = []
    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            if not name.startswith('xl/worksheets/') or not name.endswith('.xml'):
                continue
            root = ET.fromstring(archive.read(name))
            sheet_parts = [(node.text or '').strip() for node in root.iter() if node.tag.endswith('}t') and (node.text or '').strip()]
            if sheet_parts:
                parts.append('\n'.join(sheet_parts))
    return '\n\n'.join(parts)


def read_source_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in DOCX_EXTS:
        return extract_docx_text(path)
    if ext in PPTX_EXTS:
        return extract_pptx_text(path)
    if ext in XLSX_EXTS:
        return extract_xlsx_text(path)
    return read_text_bytes(path.read_bytes())


def build_image_prompt(query: str) -> str:
    compact = (query or '').strip()
    if compact:
        return f"\u7528\u6237\u5f53\u524d\u5728\u95ee\uff1a{compact}\n\u8bf7\u5148\u5b8c\u6574\u770b\u56fe\uff0c\u53ea\u8f93\u51fa\u548c\u56de\u7b54\u5f53\u524d\u95ee\u9898\u76f4\u63a5\u76f8\u5173\u7684\u6587\u5b57\u4e0e\u5173\u952e\u4fe1\u606f\uff0c\u4e0d\u8981\u7f16\u9020\uff0c\u4e0d\u8981\u52a0\u5ba2\u5957\u3002\u7eaf\u6587\u672c\u8f93\u51fa\uff0c\u4e0d\u8981 markdown\uff0c\u4e0d\u8981\u9879\u76ee\u7b26\u53f7\u82b1\u6837\u3002"
    return "\u8bf7\u63d0\u53d6\u8fd9\u5f20\u56fe\u7247\u91cc\u7684\u4e3b\u8981\u6587\u5b57\u548c\u5173\u952e\u4fe1\u606f\uff0c\u53ea\u8f93\u51fa\u6574\u7406\u540e\u7684\u5185\u5bb9\u672c\u8eab\uff0c\u4e0d\u8981\u52a0\u89e3\u91ca\u3002\u7eaf\u6587\u672c\u8f93\u51fa\uff0c\u4e0d\u8981 markdown\u3002"


def build_text_prompt(query: str, source_name: str) -> str:
    compact = (query or '').strip()
    if compact:
        return f"\u7528\u6237\u5f53\u524d\u5728\u95ee\uff1a{compact}\n\u4e0b\u9762\u662f\u6587\u4ef6\u300a{source_name}\u300b\u7684\u5185\u5bb9\u3002\u8bf7\u53ea\u63d0\u53d6\u5bf9\u56de\u7b54\u5f53\u524d\u95ee\u9898\u6700\u6709\u7528\u7684\u5173\u952e\u4fe1\u606f\uff0c\u4f18\u5148\u4fdd\u7559\u539f\u6587\u4e2d\u7684\u6807\u9898\u3001\u7ed3\u8bba\u3001\u6570\u5b57\u3001\u65f6\u95f4\u3001\u8981\u6c42\uff0c\u4e0d\u8981\u7f16\u9020\uff0c\u63a7\u5236\u57281200\u5b57\u5185\u3002\u7eaf\u6587\u672c\u8f93\u51fa\uff0c\u4e0d\u8981 markdown\u3002"
    return f"\u4e0b\u9762\u662f\u6587\u4ef6\u300a{source_name}\u300b\u7684\u5185\u5bb9\u3002\u8bf7\u63d0\u53d6\u6700\u5173\u952e\u3001\u6700\u53ef\u76f4\u63a5\u7528\u4e8e\u56de\u7b54\u7684\u5185\u5bb9\uff0c\u4fdd\u7559\u6838\u5fc3\u6807\u9898\u3001\u6570\u636e\u548c\u7ed3\u8bba\uff0c\u4e0d\u8981\u7f16\u9020\uff0c\u63a7\u5236\u57281200\u5b57\u5185\u3002\u7eaf\u6587\u672c\u8f93\u51fa\uff0c\u4e0d\u8981 markdown\u3002"


def extract_any(src: str, query: str = '') -> dict:
    cleanup = None
    if looks_like_url(src):
        path = download_to_temp(src)
        cleanup = path
    elif looks_like_base64_blob(src):
        path = decode_base64_to_temp(src)
        cleanup = path
    elif looks_like_file_url(src):
        path = file_url_to_path(src)
    else:
        path = Path(src)

    ext = path.suffix.lower()
    try:
        if ext in IMAGE_EXTS:
            text = vision_extract(path, build_image_prompt(query))
            return {'ok': bool(text), 'kind': 'image', 'text': text}
        if ext in TEXT_EXTS or ext in DOCX_EXTS or ext in PPTX_EXTS or ext in XLSX_EXTS or ext == '':
            raw_text = (read_source_text(path) or '').strip()
            if not raw_text:
                return {'ok': False, 'kind': 'text', 'error': 'empty readable content'}
            compact = raw_text[:MAX_TEXT_CHARS]
            refined = text_extract(compact, build_text_prompt(query, path.name or '\u9644\u4ef6'))
            return {'ok': bool(refined or compact), 'kind': 'text', 'text': refined or compact[:2000]}
        return {'ok': False, 'kind': 'unsupported', 'error': f'unsupported file type: {ext or "unknown"}'}
    finally:
        if cleanup:
            try:
                cleanup.unlink(missing_ok=True)
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description='Extract readable content from QQ attachment input')
    parser.add_argument('source')
    parser.add_argument('--query', default='')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    result = extract_any(args.source, query=args.query)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        if result.get('ok'):
            print(result.get('text', ''))
        else:
            print(result.get('error', 'extract failed'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
