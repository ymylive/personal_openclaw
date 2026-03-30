#!/usr/bin/env python3
"""QQ模块统一日志系统

提供统一的日志配置和工具函数，支持结构化日志记录。
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from workspace.modules.qq.status import build_status_payload

# 日志目录
DEFAULT_LOG_DIR = Path('/home/node/.openclaw/workspace/finance_system/logs')
try:
    LOG_DIR = DEFAULT_LOG_DIR
    LOG_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    fallback = Path.cwd() / 'logs'
    try:
        fallback.mkdir(parents=True, exist_ok=True)
        LOG_DIR = fallback
    except Exception:
        LOG_DIR = Path.cwd()

# 日志级别映射
LOG_LEVELS = {
    'DEBUG': logging.DEBUG,
    'INFO': logging.INFO,
    'WARNING': logging.WARNING,
    'ERROR': logging.ERROR,
    'CRITICAL': logging.CRITICAL,
}


class StructuredFormatter(logging.Formatter):
    """结构化日志格式化器，输出JSON格式的日志"""

    def format(self, record: logging.LogRecord) -> str:
        log_data = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
        }

        # 添加额外的字段
        if hasattr(record, 'extra_data'):
            log_data.update(record.extra_data)

        # 添加异常信息
        if record.exc_info:
            log_data['exception'] = self.formatException(record.exc_info)

        return json.dumps(log_data, ensure_ascii=False)


def setup_logger(
    name: str,
    log_file: Optional[str] = None,
    level: str = 'INFO',
    console: bool = True,
    structured: bool = False,
) -> logging.Logger:
    """设置日志记录器

    Args:
        name: 日志记录器名称
        log_file: 日志文件名（不含路径），如果为None则不写入文件
        level: 日志级别 (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        console: 是否输出到控制台
        structured: 是否使用结构化日志格式（JSON）

    Returns:
        配置好的日志记录器
    """
    logger = logging.getLogger(name)
    logger.setLevel(LOG_LEVELS.get(level.upper(), logging.INFO))

    # 清除已有的处理器
    logger.handlers.clear()

    # 选择格式化器
    if structured:
        formatter = StructuredFormatter()
    else:
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )

    # 添加文件处理器
    if log_file:
        file_path = LOG_DIR / log_file
        file_handler = logging.FileHandler(file_path, encoding='utf-8')
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    # 添加控制台处理器
    if console:
        console_handler = logging.StreamHandler(sys.stderr)
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)

    return logger


def log_with_context(
    logger: logging.Logger,
    level: str,
    message: str,
    **context: Any
) -> None:
    """记录带上下文信息的日志

    Args:
        logger: 日志记录器
        level: 日志级别
        message: 日志消息
        **context: 额外的上下文信息
    """
    log_func = getattr(logger, level.lower(), logger.info)
    extra = {'extra_data': context} if context else {}
    log_func(message, extra=extra)


def log_function_call(
    logger: logging.Logger,
    func_name: str,
    args: Optional[dict] = None,
    result: Optional[Any] = None,
    error: Optional[Exception] = None,
) -> None:
    """记录函数调用日志

    Args:
        logger: 日志记录器
        func_name: 函数名称
        args: 函数参数
        result: 函数返回值
        error: 异常信息
    """
    context = {'function': func_name}

    if args:
        context['args'] = args

    if error:
        context['error'] = str(error)
        context['error_type'] = type(error).__name__
        log_with_context(logger, 'ERROR', f'{func_name} failed', **context)
    elif result is not None:
        context['result_type'] = type(result).__name__
        log_with_context(logger, 'DEBUG', f'{func_name} completed', **context)
    else:
        log_with_context(logger, 'DEBUG', f'{func_name} called', **context)


def log_api_call(
    logger: logging.Logger,
    api_name: str,
    method: str,
    params: Optional[dict] = None,
    response: Optional[dict] = None,
    error: Optional[Exception] = None,
    duration_ms: Optional[float] = None,
) -> None:
    """记录API调用日志

    Args:
        logger: 日志记录器
        api_name: API名称
        method: 请求方法
        params: 请求参数
        response: 响应数据
        error: 异常信息
        duration_ms: 请求耗时（毫秒）
    """
    context = {
        'api': api_name,
        'method': method,
    }

    if params:
        context['params'] = params

    if duration_ms is not None:
        context['duration_ms'] = duration_ms

    if error:
        context['error'] = str(error)
        context['error_type'] = type(error).__name__
        log_with_context(logger, 'ERROR', f'API call failed: {api_name}', **context)
    elif response:
        context['status'] = response.get('status', 'unknown')
        log_with_context(logger, 'INFO', f'API call succeeded: {api_name}', **context)
    else:
        log_with_context(logger, 'DEBUG', f'API call started: {api_name}', **context)


def log_status_update(
    logger: logging.Logger,
    *,
    running: bool,
    listener_count: int,
    last_error: str | None,
) -> None:
    """记录 QQ 模块状态更新日志。

    Args:
        logger: 日志记录器
        running: 是否运行中
        listener_count: 当前监听器数量
        last_error: 最近的错误信息
    """
    payload = build_status_payload(
        running=running,
        listener_count=listener_count,
        last_error=last_error,
    )
    log_with_context(logger, 'INFO', 'QQ module status update', **payload)


__all__ = [
    "setup_logger",
    "log_with_context",
    "log_function_call",
    "log_api_call",
    "log_status_update",
]


# 预配置的日志记录器
qq_direct_logger = setup_logger('qq_direct', 'qq_direct.log')
qq_monitor_logger = setup_logger('qq_monitor', 'qq_monitor.log')
qq_reply_logger = setup_logger('qq_reply', 'qq_reply.log')
qq_attachment_logger = setup_logger('qq_attachment', 'qq_attachment.log')
qq_style_logger = setup_logger('qq_style', 'qq_style.log')
