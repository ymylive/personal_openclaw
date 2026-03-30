#!/usr/bin/env python3
"""QQ模块统一配置管理

提供统一的配置加载、验证和访问接口。
"""
import json
from pathlib import Path
from typing import Any, Optional

from workspace.modules.qq.status import build_status_payload

from qq_logging import setup_logger

logger = setup_logger('qq_config', 'qq_config.log')

# 配置文件路径候选列表
CONFIG_CANDIDATES = [
    Path('/home/node/.openclaw/openclaw.json'),
    Path('/root/.openclaw/openclaw.json'),
    Path.home() / '.openclaw' / 'openclaw.json',
]


class QQConfig:
    """QQ配置管理类"""

    def __init__(self, config_path: Optional[Path] = None):
        """初始化配置管理器

        Args:
            config_path: 配置文件路径，如果为None则自动查找
        """
        self._config: Optional[dict] = None
        self._config_path: Optional[Path] = None

        if config_path:
            self._config_path = config_path
        else:
            self._config_path = self._find_config()

        if self._config_path:
            self._load_config()

    def _find_config(self) -> Optional[Path]:
        """查找配置文件

        Returns:
            配置文件路径，如果未找到则返回None
        """
        for candidate in CONFIG_CANDIDATES:
            if candidate.exists():
                logger.info(f'Found config at: {candidate}')
                return candidate

        logger.warning('No config file found')
        return None

    def _load_config(self) -> None:
        """加载配置文件"""
        if not self._config_path or not self._config_path.exists():
            raise FileNotFoundError(f'Config file not found: {self._config_path}')

        try:
            self._config = json.loads(self._config_path.read_text(encoding='utf-8'))
            logger.info(f'Config loaded from: {self._config_path}')
        except json.JSONDecodeError as e:
            logger.error(f'Failed to parse config: {e}')
            raise ValueError(f'Invalid JSON in config file: {e}')
        except Exception as e:
            logger.error(f'Failed to load config: {e}')
            raise

    def reload(self) -> None:
        """重新加载配置文件"""
        self._load_config()

    def save(self) -> None:
        """保存配置到文件"""
        if not self._config_path:
            raise RuntimeError('No config path set')

        try:
            self._config_path.write_text(
                json.dumps(self._config, ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8'
            )
            logger.info(f'Config saved to: {self._config_path}')
        except Exception as e:
            logger.error(f'Failed to save config: {e}')
            raise

    @property
    def raw(self) -> dict:
        """获取原始配置字典"""
        if self._config is None:
            raise RuntimeError('Config not loaded')
        return self._config

    def get_qq_config(self) -> dict:
        """获取QQ频道配置

        Returns:
            QQ频道配置字典
        """
        return ((self.raw.get('channels') or {}).get('qq') or {})

    def get_ws_url(self) -> str:
        """获取WebSocket URL

        Returns:
            WebSocket URL

        Raises:
            RuntimeError: 如果未配置WebSocket URL
        """
        qq_config = self.get_qq_config()
        ws_url = qq_config.get('wsUrl')

        if not ws_url:
            raise RuntimeError('QQ wsUrl not configured')

        return str(ws_url)

    def get_access_token(self) -> str:
        """获取访问令牌

        Returns:
            访问令牌（可能为空字符串）
        """
        qq_config = self.get_qq_config()
        return str(qq_config.get('accessToken') or '')

    def get_ws_config(self) -> tuple[str, str]:
        """获取WebSocket配置

        Returns:
            (ws_url, access_token) 元组
        """
        return self.get_ws_url(), self.get_access_token()

    def get_allowed_groups(self) -> list[int]:
        """获取允许的群组ID列表

        Returns:
            群组ID列表
        """
        qq_config = self.get_qq_config()
        groups = qq_config.get('allowedGroups') or qq_config.get('ambientChatGroups') or []

        if isinstance(groups, str):
            groups = [g.strip() for g in groups.split(',') if g.strip()]

        result = []
        for g in groups:
            try:
                result.append(int(g))
            except (ValueError, TypeError):
                logger.warning(f'Invalid group ID: {g}')

        return result

    def get_monitor_groups(self) -> list[dict]:
        """获取监控群组配置

        Returns:
            监控群组配置列表
        """
        qq_config = self.get_qq_config()
        return qq_config.get('monitorGroups') or []

    def get_monitor_settings(self) -> dict:
        """获取监控设置

        Returns:
            监控设置字典
        """
        qq_config = self.get_qq_config()
        return qq_config.get('monitorSettings') or {}

    def get_system_prompt(self) -> str:
        """获取系统提示词

        Returns:
            系统提示词
        """
        qq_config = self.get_qq_config()
        return str(qq_config.get('systemPrompt') or '')

    def set_system_prompt(self, prompt: str) -> None:
        """设置系统提示词

        Args:
            prompt: 新的系统提示词
        """
        if 'channels' not in self.raw:
            self.raw['channels'] = {}
        if 'qq' not in self.raw['channels']:
            self.raw['channels']['qq'] = {}

        self.raw['channels']['qq']['systemPrompt'] = prompt
        logger.info('System prompt updated')

    def get_agent_config(self, agent_id: str) -> Optional[dict]:
        """获取代理配置

        Args:
            agent_id: 代理ID

        Returns:
            代理配置字典，如果未找到则返回None
        """
        agents = self.raw.get('agents', {}).get('list', [])
        for agent in agents:
            if agent.get('id') == agent_id:
                return agent
        return None

    def has_agent(self, agent_id: str) -> bool:
        """检查是否存在指定的代理

        Args:
            agent_id: 代理ID

        Returns:
            如果存在返回True，否则返回False
        """
        return self.get_agent_config(agent_id) is not None

    def get_model_provider(self, provider_name: str) -> dict:
        """获取模型提供商配置

        Args:
            provider_name: 提供商名称

        Returns:
            提供商配置字典
        """
        providers = self.raw.get('models', {}).get('providers', {})
        return providers.get(provider_name) or {}


# 全局配置实例
_global_config: Optional[QQConfig] = None


def get_config(reload: bool = False) -> QQConfig:
    """获取全局配置实例

    Args:
        reload: 是否重新加载配置

    Returns:
        QQConfig实例
    """
    global _global_config

    if _global_config is None or reload:
        _global_config = QQConfig()

    return _global_config


def load_qq_ws_config() -> tuple[str, str]:
    """加载QQ WebSocket配置（兼容旧接口）

    Returns:
        (ws_url, access_token) 元组
    """
    config = get_config()
    return config.get_ws_config()


def build_qq_status_payload(*, running: bool, listener_count: int, last_error: str | None) -> dict:
    """Convenience wrapper exposing the QQ status payload helper."""
    return build_status_payload(running=running, listener_count=listener_count, last_error=last_error)


__all__ = ["QQConfig", "get_config", "load_qq_ws_config", "build_qq_status_payload"]
