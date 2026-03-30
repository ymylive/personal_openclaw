# QQ模块优化说明

## 概述

本次优化对QQ模块进行了全面的可用性补全和代码质量提升，主要包括：

1. **统一的日志系统** - `qq_logging.py`
2. **统一的配置管理** - `qq_config.py`
3. **完整的类型注解和文档字符串**
4. **改进的错误处理和日志记录**

## 新增模块

### 1. qq_logging.py - 统一日志系统

提供结构化日志记录功能，支持：

- 多种日志级别（DEBUG, INFO, WARNING, ERROR, CRITICAL）
- 文件和控制台双输出
- 结构化JSON格式日志
- 上下文信息记录
- API调用日志记录

**使用示例：**

```python
from qq_logging import qq_direct_logger as logger, log_api_call

# 基本日志
logger.info('Message sent successfully')
logger.error('Failed to send message', exc_info=True)

# API调用日志
log_api_call(
    logger,
    'send_group_msg',
    'websocket',
    params={'group_id': 123456},
    response={'status': 'ok'},
    duration_ms=150.5
)
```

**日志文件位置：**
- `/home/node/.openclaw/workspace/finance_system/logs/`

### 2. qq_config.py - 统一配置管理

提供统一的配置加载和访问接口，支持：

- 自动查找配置文件
- 配置验证
- 类型安全的访问方法
- 配置热重载

**使用示例：**

```python
from qq_config import get_config

# 获取配置实例
config = get_config()

# 获取WebSocket配置
ws_url, token = config.get_ws_config()

# 获取允许的群组
groups = config.get_allowed_groups()

# 检查代理是否存在
if config.has_agent('qqreply'):
    print('Agent exists')

# 重新加载配置
config.reload()
```

## 优化的模块

### 1. qq_direct_utils.py - QQ消息发送工具

**改进内容：**

- ✅ 添加完整的类型注解
- ✅ 添加详细的文档字符串
- ✅ 集成日志记录系统
- ✅ 改进错误处理
- ✅ 使用统一配置管理

**主要功能：**

```python
from qq_direct_utils import send_group_message

# 发送群消息（带重试和确认）
result = await send_group_message(
    ws_url='ws://localhost:8080',
    token='your_token',
    group_id=123456,
    message='Hello, world!',
    echo_prefix='test',
    attempts=2  # 最大尝试次数
)

if result.get('status') == 'ok':
    print('Message sent successfully')
```

**特性：**

- 自动重试机制
- 消息送达确认
- 历史消息查询
- 详细的日志记录

### 2. qq_attachment_extract.py - 附件内容提取

**改进内容：**

- ✅ 添加完整的类型注解
- ✅ 添加详细的文档字符串
- ✅ 集成日志记录系统
- ✅ 改进错误处理
- ✅ 更好的临时文件清理

**支持的格式：**

- 图片：jpg, jpeg, png, webp, gif
- 文本：txt, md, json, yaml, csv, 代码文件等
- Office文档：docx, pptx, xlsx

**使用示例：**

```python
from qq_attachment_extract import extract_any

# 从URL提取内容
result = extract_any(
    'https://example.com/image.jpg',
    query='这是什么？'
)

if result['ok']:
    print(result['text'])
else:
    print(result['error'])
```

**命令行使用：**

```bash
# 提取图片内容
python3 qq_attachment_extract.py https://example.com/image.jpg --query "这是什么？"

# JSON输出
python3 qq_attachment_extract.py file.docx --json
```

### 3. qq_at_auto_reply.py - @消息自动回复

**改进内容：**

- ✅ 添加类型注解
- ✅ 添加文档字符串
- ✅ 集成日志记录系统
- ✅ 使用统一配置管理
- ✅ 改进错误处理

**主要功能：**

- 监听QQ群@消息
- 自动提取图片和文件内容
- 智能上下文关联
- 支持多群组监听

**使用示例：**

```bash
# 单次运行（适合cron）
python3 qq_at_auto_reply.py --group-id 123456

# 持续监听模式
python3 qq_at_auto_reply.py --group-id 123456 --listen

# 多群组监听
python3 qq_at_auto_reply.py --group-id 123456 --group-id 789012 --listen

# 干运行（测试）
python3 qq_at_auto_reply.py --group-id 123456 --dry-run
```

## 代码质量改进

### 类型注解

所有函数都添加了完整的类型注解：

```python
async def send_group_message(
    ws_url: str,
    token: str,
    group_id: int,
    message: str,
    echo_prefix: str,
    attempts: int = DEFAULT_SEND_ATTEMPTS,
) -> dict:
    """发送群消息（带重试和确认）

    Args:
        ws_url: WebSocket URL
        token: 访问令牌
        group_id: 群组ID
        message: 消息内容
        echo_prefix: 回显前缀
        attempts: 最大尝试次数

    Returns:
        发送结果字典
    """
    ...
```

### 文档字符串

所有公共函数都添加了详细的文档字符串，包括：

- 功能描述
- 参数说明
- 返回值说明
- 异常说明
- 使用示例

### 日志记录

关键操作都添加了日志记录：

```python
logger.info(f'Sending message to group {group_id}')
logger.debug(f'Message delivery confirmed: {message_id}')
logger.error(f'Failed to send message: {error}', exc_info=True)
logger.warning(f'Retrying send operation (attempt {attempt})')
```

### 错误处理

改进了错误处理机制：

```python
try:
    result = await send_message(...)
except asyncio.TimeoutError:
    logger.error('Request timeout')
    # 尝试通过历史消息确认
    matched = await confirm_delivery(...)
except websockets.WebSocketException as e:
    logger.error(f'WebSocket error: {e}')
    raise
except Exception as e:
    logger.error(f'Unexpected error: {e}', exc_info=True)
    raise
```

## 配置示例

### openclaw.json 配置示例

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://localhost:8080",
      "accessToken": "your_token_here",
      "allowedGroups": [123456, 789012],
      "monitorGroups": [
        {
          "id": 123456,
          "name": "学习群",
          "focus": "study help and debugging"
        }
      ],
      "monitorSettings": {
        "windowMinutes": 180,
        "recentMsgLimit": 40,
        "botCooldownMinutes": 6
      },
      "systemPrompt": "You are a helpful assistant..."
    }
  }
}
```

## 迁移指南

### 从旧代码迁移

如果你的代码使用了旧的配置加载方式：

**旧代码：**
```python
cfg = json.loads(Path('/home/node/.openclaw/openclaw.json').read_text())
qq = cfg['channels']['qq']
ws_url = qq['wsUrl']
```

**新代码：**
```python
from qq_config import get_config

config = get_config()
ws_url = config.get_ws_url()
```

### 添加日志记录

**旧代码：**
```python
print(f'Sending message to group {group_id}')
```

**新代码：**
```python
from qq_logging import qq_direct_logger as logger

logger.info(f'Sending message to group {group_id}')
```

## 性能优化

1. **配置缓存** - 配置只加载一次，避免重复读取文件
2. **连接复用** - WebSocket连接可以复用
3. **批量操作** - 支持批量处理消息
4. **异步操作** - 所有IO操作都是异步的

## 测试建议

### 单元测试

```python
import pytest
from qq_config import QQConfig

def test_config_loading():
    config = QQConfig()
    assert config.get_ws_url()
    assert isinstance(config.get_allowed_groups(), list)

@pytest.mark.asyncio
async def test_send_message():
    from qq_direct_utils import send_group_message

    result = await send_group_message(
        ws_url='ws://localhost:8080',
        token='test_token',
        group_id=123456,
        message='Test message',
        echo_prefix='test'
    )

    assert result.get('status') == 'ok'
```

### 集成测试

```bash
# 测试配置加载
python3 -c "from qq_config import get_config; print(get_config().get_ws_url())"

# 测试附件提取
python3 qq_attachment_extract.py test_image.jpg --json

# 测试自动回复（干运行）
python3 qq_at_auto_reply.py --group-id 123456 --dry-run
```

## 故障排查

### 日志位置

所有日志文件位于：
```
/home/node/.openclaw/workspace/finance_system/logs/
├── qq_direct.log       # 消息发送日志
├── qq_monitor.log      # 群组监控日志
├── qq_reply.log        # 自动回复日志
├── qq_attachment.log   # 附件提取日志
└── qq_config.log       # 配置管理日志
```

### 常见问题

**Q: 配置文件找不到**
```
A: 检查配置文件是否存在于以下位置之一：
   - /home/node/.openclaw/openclaw.json
   - /root/.openclaw/openclaw.json
   - ~/.openclaw/openclaw.json
```

**Q: WebSocket连接失败**
```
A: 检查日志文件中的错误信息：
   tail -f /home/node/.openclaw/workspace/finance_system/logs/qq_direct.log
```

**Q: 消息发送失败**
```
A: 启用DEBUG日志级别查看详细信息：
   from qq_logging import setup_logger
   logger = setup_logger('qq_direct', 'qq_direct.log', level='DEBUG')
```

## 未来改进计划

- [ ] 添加消息队列支持
- [ ] 添加速率限制
- [ ] 添加消息模板系统
- [ ] 添加更多的媒体类型支持
- [ ] 添加性能监控
- [ ] 添加单元测试覆盖

## 贡献指南

如果你想为QQ模块贡献代码，请遵循以下规范：

1. 所有函数必须有类型注解
2. 所有公共函数必须有文档字符串
3. 关键操作必须添加日志记录
4. 错误处理必须完善
5. 代码必须通过类型检查（mypy）
6. 代码必须符合PEP 8规范

## 许可证

与主项目相同。
