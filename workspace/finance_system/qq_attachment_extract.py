#!/usr/bin/env python3
"""QQ附件内容提取工具

支持从URL、文件路径或base64数据中提取文本和图片内容。
支持的格式：
- 图片：jpg, jpeg, png, webp, gif
- 文本：txt, md, json, yaml, csv, 代码文件等
- Office文档：docx, pptx, xlsx
"""
import argparse
import json
import mimetypes
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, unquote
from xml.etree import ElementTree as ET

import requests

from llm_vision_extract import text_extract, vision_extract
from llm_vision_extract import text_extract, vision_extract


def _ensure_workspace_importable() -> None:
    repo_root = None
    current = Path(__file__).resolve()
    for ancestor in current.parents:
        if (ancestor / "workspace").is_dir():
            repo_root = ancestor
            break
    if repo_root is None:
        repo_root = current.parents[-1]
    repo_root_str = str(repo_root)
    if repo_root_str not in sys.path:
        sys.path.insert(0, repo_root_str)


_ensure_workspace_importable()

from qq_logging import qq_attachment_logger as logger
from workspace.modules.qq.attachments import (
    decode_base64_attachment,
    extract_shared_strings_from_archive,
    extract_text_from_worksheet,
    normalize_attachment,
)

# 支持的文件扩展名
TEXT_EXTS = {
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv',
    '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.c', '.cc', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.sh', '.sql', '.xml', '.html', '.htm', '.css', '.log', '.ini', '.toml'
}
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
DOCX_EXTS = {'.docx'}
PPTX_EXTS = {'.pptx'}
XLSX_EXTS = {'.xlsx'}

# 最大文本字符数
MAX_TEXT_CHARS = 12000


def _normalize_attachment_result(payload: dict) -> dict:
    """Hook to normalize attachment extraction payloads."""
    return normalize_attachment(payload)


def looks_like_url(value: str) -> bool:
    """判断字符串是否为HTTP(S) URL

    Args:
        value: 待判断的字符串

    Returns:
        如果是URL返回True，否则返回False
    """
    try:
        parsed = urlparse(value)
        return parsed.scheme in {'http', 'https'} and bool(parsed.netloc)
    except Exception:
        return False


def looks_like_file_url(value: str) -> bool:
    """判断字符串是否为file:// URL

    Args:
        value: 待判断的字符串

    Returns:
        如果是file URL返回True，否则返回False
    """
    try:
        return urlparse(value).scheme == 'file'
    except Exception:
        return False


def looks_like_base64_blob(value: str) -> bool:
    """判断字符串是否为base64数据

    Args:
        value: 待判断的字符串

    Returns:
        如果是base64数据返回True，否则返回False
    """
    return isinstance(value, str) and value.startswith('base64://')


def infer_suffix(url: str, content_type: str) -> str:
    """推断文件后缀名

    Args:
        url: 文件URL
        content_type: Content-Type头

    Returns:
        文件后缀名（包含点号）
    """
    suffix = Path(urlparse(url).path).suffix
    if suffix:
        return suffix
    guessed = mimetypes.guess_extension((content_type or '').split(';', 1)[0].strip()) or ''
    return guessed or '.bin'


def download_to_temp(url: str) -> Path:
    """下载URL内容到临时文件

    Args:
        url: 文件URL

    Returns:
        临时文件路径

    Raises:
        requests.RequestException: 下载失败
    """
    logger.info(f'Downloading from URL: {url[:100]}')
    response = requests.get(url, timeout=60)
    response.raise_for_status()

    suffix = infer_suffix(url, response.headers.get('content-type', ''))
    fd, tmp = tempfile.mkstemp(prefix='qqattach_', suffix=suffix)

    with os.fdopen(fd, 'wb') as handle:
        handle.write(response.content)

    logger.debug(f'Downloaded to temp file: {tmp}')
    return Path(tmp)


def decode_base64_to_temp(src: str) -> Path:
    """解码base64数据到临时文件

    Args:
        src: base64数据字符串（格式：base64://...）

    Returns:
        临时文件路径
    """
    logger.debug('Decoding base64 data to temp file')
    data, suffix = decode_base64_attachment(src)
    fd, tmp = tempfile.mkstemp(prefix='qqattach_', suffix=suffix)

    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)

    return Path(tmp)


def file_url_to_path(src: str) -> Path:
    """将file:// URL转换为文件路径

    Args:
        src: file URL

    Returns:
        文件路径
    """
    parsed = urlparse(src)
    return Path(unquote(parsed.path))


def read_text_bytes(data: bytes) -> str:
    """尝试多种编码读取字节数据

    Args:
        data: 字节数据

    Returns:
        解码后的文本
    """
    for encoding in ('utf-8', 'utf-8-sig', 'gb18030', 'gbk', 'latin1'):
        try:
            return data.decode(encoding)
        except Exception:
            pass
    return data.decode('utf-8', errors='replace')


def extract_docx_text(path: Path) -> str:
    """从DOCX文件中提取文本

    Args:
        path: DOCX文件路径

    Returns:
        提取的文本内容
    """
    logger.debug(f'Extracting text from DOCX: {path.name}')
    with zipfile.ZipFile(path) as archive:
        xml = archive.read('word/document.xml')

    root = ET.fromstring(xml)
    parts = [
        (node.text or '').strip()
        for node in root.iter()
        if node.tag.endswith('}t') and (node.text or '').strip()
    ]

    return '\n'.join(parts)


def extract_pptx_text(path: Path) -> str:
    """从PPTX文件中提取文本

    Args:
        path: PPTX文件路径

    Returns:
        提取的文本内容
    """
    logger.debug(f'Extracting text from PPTX: {path.name}')
    parts = []

    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            if not name.startswith('ppt/slides/slide') or not name.endswith('.xml'):
                continue

            root = ET.fromstring(archive.read(name))
            slide_parts = [
                (node.text or '').strip()
                for node in root.iter()
                if node.tag.endswith('}t') and (node.text or '').strip()
            ]

            if slide_parts:
                parts.append('\n'.join(slide_parts))

    return '\n\n'.join(parts)


def extract_xlsx_text(path: Path) -> str:
    """从XLSX文件中提取文本

    Args:
        path: XLSX文件路径

    Returns:
        提取的文本内容
    """
    logger.debug(f'Extracting text from XLSX: {path.name}')
    parts = []

    with zipfile.ZipFile(path) as archive:
        shared_strings = extract_shared_strings_from_archive(archive)
        for name in sorted(archive.namelist()):
            if not name.startswith('xl/worksheets/') or not name.endswith('.xml'):
                continue

            root = ET.fromstring(archive.read(name))
            sheet_parts = extract_text_from_worksheet(root, shared_strings)

            if sheet_parts:
                parts.append('\n'.join(sheet_parts))

    return '\n\n'.join(parts)


def read_source_text(path: Path) -> str:
    """读取源文件文本内容

    根据文件扩展名选择合适的提取方法。

    Args:
        path: 文件路径

    Returns:
        提取的文本内容
    """
    ext = path.suffix.lower()

    if ext in DOCX_EXTS:
        return extract_docx_text(path)
    if ext in PPTX_EXTS:
        return extract_pptx_text(path)
    if ext in XLSX_EXTS:
        return extract_xlsx_text(path)

    return read_text_bytes(path.read_bytes())


def build_image_prompt(query: str) -> str:
    """构建图片提取提示词

    Args:
        query: 用户查询

    Returns:
        提示词文本
    """
    compact = (query or '').strip()
    if compact:
        return (
            f"用户当前在问：{compact}\n"
            "请先完整看图，只输出和回答当前问题直接相关的文字与关键信息，"
            "不要编造，不要加客套。纯文本输出，不要 markdown，不要项目符号花样。"
        )
    return (
        "请提取这张图片里的主要文字和关键信息，只输出整理后的内容本身，"
        "不要加解释。纯文本输出，不要 markdown。"
    )


def build_text_prompt(query: str, source_name: str) -> str:
    """构建文本提取提示词

    Args:
        query: 用户查询
        source_name: 源文件名

    Returns:
        提示词文本
    """
    compact = (query or '').strip()
    if compact:
        return (
            f"用户当前在问：{compact}\n"
            f"下面是文件《{source_name}》的内容。"
            "请只提取对回答当前问题最有用的关键信息，"
            "优先保留原文中的标题、结论、数字、时间、要求，"
            "不要编造，控制在1200字内。纯文本输出，不要 markdown。"
        )
    return (
        f"下面是文件《{source_name}》的内容。"
        "请提取最关键、最可直接用于回答的内容，"
        "保留核心标题、数据和结论，不要编造，控制在1200字内。"
        "纯文本输出，不要 markdown。"
    )


def extract_any(src: str, query: str = '') -> dict:
    """提取任意来源的内容

    支持URL、文件路径、base64数据等多种输入格式。

    Args:
        src: 数据源（URL、文件路径或base64数据）
        query: 用户查询（可选）

    Returns:
        提取结果字典，包含以下字段：
        - ok: 是否成功
        - kind: 内容类型（image/text/unsupported）
        - text: 提取的文本内容
        - error: 错误信息（如果失败）

    Example:
        >>> result = extract_any('https://example.com/image.jpg', '这是什么？')
        >>> if result['ok']:
        ...     print(result['text'])
    """
    cleanup: Optional[Path] = None

    try:
        # 确定文件路径
        if looks_like_url(src):
            logger.info(f'Processing URL: {src[:100]}')
            path = download_to_temp(src)
            cleanup = path
        elif looks_like_base64_blob(src):
            logger.info('Processing base64 data')
            path = decode_base64_to_temp(src)
            cleanup = path
        elif looks_like_file_url(src):
            logger.info(f'Processing file URL: {src}')
            path = file_url_to_path(src)
        else:
            logger.info(f'Processing local file: {src}')
            path = Path(src)

        ext = path.suffix.lower()
        logger.debug(f'File extension: {ext}')

        # 根据文件类型提取内容
        if ext in IMAGE_EXTS:
            logger.info('Extracting image content')
            text = vision_extract(path, build_image_prompt(query))
            return _normalize_attachment_result({'ok': bool(text), 'kind': 'image', 'text': text})

        if ext in TEXT_EXTS or ext in DOCX_EXTS or ext in PPTX_EXTS or ext in XLSX_EXTS or ext == '':
            logger.info('Extracting text content')
            raw_text = (read_source_text(path) or '').strip()

            if not raw_text:
                logger.warning('No readable content found')
                return _normalize_attachment_result({'ok': False, 'kind': 'text', 'error': 'empty readable content'})

            compact = raw_text[:MAX_TEXT_CHARS]
            refined = text_extract(compact, build_text_prompt(query, path.name or '附件'))

            return _normalize_attachment_result({
                'ok': bool(refined or compact),
                'kind': 'text',
                'text': refined or compact[:2000]
            })

        logger.warning(f'Unsupported file type: {ext}')
        return _normalize_attachment_result({
            'ok': False,
            'kind': 'unsupported',
            'error': f'unsupported file type: {ext or "unknown"}'
        })

    except Exception as e:
        logger.error(f'Extraction failed: {e}', exc_info=True)
        return _normalize_attachment_result({
            'ok': False,
            'kind': 'error',
            'error': str(e)
        })

    finally:
        if cleanup:
            try:
                cleanup.unlink(missing_ok=True)
                logger.debug(f'Cleaned up temp file: {cleanup}')
            except Exception as e:
                logger.warning(f'Failed to clean up temp file: {e}')


def main() -> int:
    """命令行入口函数

    Returns:
        退出码（0表示成功）
    """
    parser = argparse.ArgumentParser(
        description='Extract readable content from QQ attachment input'
    )
    parser.add_argument('source', help='Source URL, file path, or base64 data')
    parser.add_argument('--query', default='', help='User query for context-aware extraction')
    parser.add_argument('--json', action='store_true', help='Output result as JSON')

    args = parser.parse_args()

    logger.info(f'Starting extraction: source={args.source[:100]}, query={args.query[:50]}')

    result = extract_any(args.source, query=args.query)

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        if result.get('ok'):
            print(result.get('text', ''))
        else:
            print(result.get('error', 'extract failed'))

    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
