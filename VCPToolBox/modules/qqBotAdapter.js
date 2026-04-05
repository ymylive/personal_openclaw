// modules/qqBotAdapter.js
// QQ OneBot11 WebSocket 适配器 — 连接 NapCat/OneBot11 实现 QQ 群消息收发
// 包含权限隔离系统：管理员可执行所有指令，普通用户仅限安全对话

const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('./logger.js');

// ─── 正则表达式 ───
const AT_RE = /\[CQ:at,qq=(\d+)(?:,[^\]]*?)?\]/g;
const CQ_RE = /\[CQ:[^\]]+\]/g;
const IMAGE_RE = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
const WHITESPACE_RE = /\s+/g;

// ─── 常量 ───
const MAX_REPLIED_IDS = 500;
const RECONNECT_DELAY_MS = 5000;
const WS_RECV_TIMEOUT_MS = 15000;

// ─── 危险指令关键词 ───
// 匹配到这些关键词的消息，非管理员将被拒绝执行
const DANGEROUS_PATTERNS = [
  // 系统/服务器操作
  /(?:关机|重启|shutdown|reboot|restart|停止服务|kill|终止)/i,
  /(?:rm\s+-rf|sudo|chmod|chown|删除文件|删除目录|格式化)/i,
  /(?:执行命令|运行命令|exec|system\s*\(|shell|bash|cmd)/i,
  // 配置修改
  /(?:修改配置|更改设置|改密码|change.*config|modify.*setting)/i,
  /(?:添加管理|删除管理|设置权限|授权|取消授权)/i,
  // 数据操作
  /(?:删除数据|清空数据|drop\s+table|truncate|delete\s+from|清除记忆|清空记忆)/i,
  /(?:导出数据|备份数据|下载文件|上传文件)/i,
  // 网络/安全
  /(?:扫描端口|ddos|攻击|注入|exploit|hack|渗透)/i,
  /(?:代理|proxy|vpn|翻墙|科学上网)/i,
  // 账号操作
  /(?:退出登录|注销|logout|登出|切换账号)/i,
  // 插件/工具滥用
  /(?:禁用插件|启用插件|卸载|安装插件)/i,
  /(?:发送给所有群|群发|广播消息|mass.*send)/i,
  // 角色突破
  /(?:忽略.*(?:指令|规则|限制)|无视.*(?:设定|规则)|取消.*(?:限制|人设))/i,
  /(?:你(?:不是|别装|现在是)|停止扮演|退出角色|system\s*prompt)/i,
];

class QQBotAdapter {
  constructor(config = {}) {
    // 核心配置
    this.wsUrl = config.wsUrl || process.env.QQ_WS_URL || 'ws://localhost:8080';
    this.accessToken = config.accessToken || process.env.QQ_ACCESS_TOKEN || '';
    this.allowedGroups = this._parseIntList(config.allowedGroups || process.env.QQ_ALLOWED_GROUPS || '');
    this.selfIds = new Set(this._parseIntList(config.selfIds || process.env.QQ_BOT_SELF_IDS || ''));
    this.agentName = config.agentName || process.env.QQ_AGENT_NAME || 'Grantley';
    this.keywordTriggers = this._parseStringList(config.keywordTriggers || process.env.QQ_KEYWORD_TRIGGERS || '');
    this.cooldownSeconds = parseInt(config.cooldownSeconds || process.env.QQ_COOLDOWN_SECONDS || '6', 10);
    this.recentMsgLimit = parseInt(config.recentMsgLimit || process.env.QQ_RECENT_MSG_LIMIT || '40', 10);
    this.blacklistGroups = new Set();

    // ─── 权限隔离配置 ───
    this.adminUsers = new Set(this._parseIntList(config.adminUsers || process.env.QQ_ADMIN_USERS || ''));
    // 普通用户每分钟最大请求数
    this.rateLimitPerMinute = parseInt(process.env.QQ_RATE_LIMIT_PER_MINUTE || '10', 10);
    // 普通用户最大消息长度
    this.maxMessageLength = parseInt(process.env.QQ_MAX_MESSAGE_LENGTH || '500', 10);
    // 用户请求计数器 Map<userId, { count, resetAt }>
    this._userRateLimits = new Map();

    // VCP API 配置
    this.vcpBaseUrl = config.vcpBaseUrl || `http://localhost:${process.env.PORT || 6005}`;
    this.vcpApiKey = config.vcpApiKey || process.env.Key || '';

    // 状态
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.groupStates = new Map();
    this.pendingEchos = new Map();
    this.echoCounter = 0;

    // 状态存储路径
    this.stateDir = config.stateDir || process.env.QQ_STATE_DIR || path.join(__dirname, '..', 'qq_state');

    // 消息处理队列
    this.processingGroups = new Set();

    // chatCompletionHandler 引用
    this._chatHandler = null;
  }

  // ─── 初始化 ───

  async initialize(chatCompletionHandler) {
    this._chatHandler = chatCompletionHandler;

    await fs.mkdir(this.stateDir, { recursive: true });
    await this._loadAllStates();
    await this._loadBlacklist();
    this._connect();

    console.log(`[QQBot] Initialized — agent: ${this.agentName}, groups: [${this.allowedGroups.join(', ')}], ws: ${this.wsUrl}`);
    console.log(`[QQBot] Admin users: [${[...this.adminUsers].join(', ')}]`);
    console.log(`[QQBot] Permission isolation: ENABLED — non-admin users restricted from dangerous commands`);
  }

  // ─── 权限隔离系统 ───

  _isAdmin(userId) {
    return this.adminUsers.has(userId);
  }

  _isDangerousMessage(text) {
    const cleaned = text.trim();
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cleaned)) {
        return true;
      }
    }
    return false;
  }

  _checkRateLimit(userId) {
    const now = Date.now();
    let record = this._userRateLimits.get(userId);

    if (!record || now >= record.resetAt) {
      record = { count: 0, resetAt: now + 60000 };
      this._userRateLimits.set(userId, record);
    }

    record.count++;
    return record.count <= this.rateLimitPerMinute;
  }

  /**
   * 权限检查 — 返回 { allowed, reason } 或 { allowed: true }
   */
  _checkPermission(userId, rawMessage) {
    const isAdmin = this._isAdmin(userId);
    const cleanText = this._cleanMessage(rawMessage);

    // 管理员不受限制
    if (isAdmin) {
      return { allowed: true, isAdmin: true };
    }

    // 非管理员：检查危险指令
    if (this._isDangerousMessage(cleanText)) {
      console.warn(`[QQBot/Permission] BLOCKED dangerous command from user ${userId}: "${cleanText.substring(0, 80)}..."`);
      return {
        allowed: false,
        reason: 'dangerous_command',
        message: '抱歉，这个操作需要管理员权限。如果你需要执行此操作，请联系管理员。'
      };
    }

    // 非管理员：限流
    if (!this._checkRateLimit(userId)) {
      console.warn(`[QQBot/Permission] RATE LIMITED user ${userId}`);
      return {
        allowed: false,
        reason: 'rate_limited',
        message: '你的请求太频繁了，请稍后再试。'
      };
    }

    // 非管理员：消息长度限制
    if (cleanText.length > this.maxMessageLength) {
      return {
        allowed: false,
        reason: 'message_too_long',
        message: `消息太长了，请控制在 ${this.maxMessageLength} 字以内。`
      };
    }

    return { allowed: true, isAdmin: false };
  }

  // ─── WebSocket 连接管理 ───

  _connect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) { /* ignore */ }
    }

    const headers = {};
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    console.log(`[QQBot] Connecting to ${this.wsUrl}...`);
    this.ws = new WebSocket(this.wsUrl, { headers });

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnecting = false;
      console.log(`[QQBot] Connected to OneBot WebSocket`);
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this._handleMessage(data);
      } catch (e) {
        console.error('[QQBot] Failed to parse message:', e.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      console.warn(`[QQBot] WebSocket closed: ${code} ${reason}`);
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[QQBot] WebSocket error: ${err.message}`);
      if (!this.connected) {
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    console.log(`[QQBot] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(() => {
      this.reconnecting = false;
      this._connect();
    }, RECONNECT_DELAY_MS);
  }

  // ─── 消息处理 ───

  _handleMessage(data) {
    if (data.echo && this.pendingEchos.has(data.echo)) {
      const pending = this.pendingEchos.get(data.echo);
      this.pendingEchos.delete(data.echo);
      clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }

    if (data.post_type === 'message' && data.message_type === 'group') {
      this._handleGroupMessage(data);
    }

    if (data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle') {
      if (data.self_id) {
        this.selfIds.add(parseInt(data.self_id, 10));
        console.log(`[QQBot] Self ID detected: ${data.self_id}`);
      }
    }
  }

  async _handleGroupMessage(event) {
    const groupId = parseInt(event.group_id, 10);
    const messageId = parseInt(event.message_id || 0, 10);
    const userId = parseInt(event.user_id || 0, 10);
    // 兼容 string 和 array 两种 messagePostFormat
    const rawMessage = event.raw_message
      ? String(event.raw_message)
      : this._messageArrayToString(event.message);
    const senderId = parseInt(event.sender?.user_id || userId, 10);

    // 忽略自己的消息
    if (this.selfIds.has(senderId)) return;

    // 检查群组是否允许
    if (this.allowedGroups.length > 0 && !this.allowedGroups.includes(groupId)) return;

    // 检查黑名单
    if (this.blacklistGroups.has(groupId)) return;

    // 检查是否需要处理
    if (!this._shouldHandle(event)) return;

    // 检查是否已回复
    const state = this._getGroupState(groupId);
    if (state.repliedIds.includes(messageId)) return;

    // 冷却检查
    const now = Math.floor(Date.now() / 1000);
    if (state.lastReplyAt && (now - state.lastReplyAt) < this.cooldownSeconds) {
      return;
    }

    // 防止并发处理
    if (this.processingGroups.has(groupId)) return;
    this.processingGroups.add(groupId);

    try {
      // ─── 权限检查 ───
      const perm = this._checkPermission(userId, rawMessage);

      if (!perm.allowed) {
        // 被拦截 — 发送拒绝消息
        await this._sendGroupReply(groupId, userId, perm.message);
        state.repliedIds.push(messageId);
        state.lastReplyAt = now;
        await this._saveGroupState(groupId);
        console.log(`[QQBot/Permission] Denied message ${messageId} from user ${userId} in group ${groupId}: ${perm.reason}`);
        return;
      }

      console.log(`[QQBot] Processing message ${messageId} from group ${groupId}, user ${userId} (admin: ${perm.isAdmin})`);

      // 提取图片 URL
      const imageUrls = this._extractImageUrls(rawMessage);

      // 清理消息文本
      const cleanText = this._cleanMessage(rawMessage);

      // 构建消息内容
      let userContent = cleanText;
      if (imageUrls.length > 0) {
        userContent += `\n[用户发送了 ${imageUrls.length} 张图片: ${imageUrls.join(', ')}]`;
      }

      // 调用 VCP 获取回复（管理员和普通用户使用不同的系统提示）
      const reply = await this._callVCP(userContent, groupId, userId, event.sender, perm.isAdmin);

      if (reply && reply.trim()) {
        await this._sendGroupReply(groupId, userId, reply);

        state.repliedIds.push(messageId);
        if (state.repliedIds.length > MAX_REPLIED_IDS) {
          state.repliedIds = state.repliedIds.slice(-MAX_REPLIED_IDS);
        }
        state.lastReplyAt = now;
        state.lastMessageId = Math.max(state.lastMessageId, messageId);
        await this._saveGroupState(groupId);

        console.log(`[QQBot] Replied to message ${messageId} in group ${groupId}`);
      }
    } catch (err) {
      console.error(`[QQBot] Error processing message ${messageId}:`, err.message);
    } finally {
      this.processingGroups.delete(groupId);
    }
  }

  // ─── 触发检测 ───

  _shouldHandle(event) {
    const rawMessage = String(event.raw_message || '');
    if (this._isAtBot(rawMessage)) return true;
    if (this._matchesKeyword(rawMessage)) return true;
    return false;
  }

  _isAtBot(rawMessage) {
    const matches = [...rawMessage.matchAll(AT_RE)];
    for (const match of matches) {
      const atQQ = parseInt(match[1], 10);
      if (this.selfIds.has(atQQ)) return true;
    }
    return false;
  }

  _matchesKeyword(rawMessage) {
    if (!this.keywordTriggers.length) return false;
    const cleaned = rawMessage.replace(CQ_RE, ' ').replace(WHITESPACE_RE, ' ').trim().toLowerCase();
    for (const keyword of this.keywordTriggers) {
      const kw = keyword.toLowerCase();
      if (/^[a-z0-9_.@-]+$/.test(kw)) {
        const pattern = new RegExp(`(?<![a-z0-9_])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`, 'i');
        if (pattern.test(cleaned)) return true;
      } else {
        if (cleaned.includes(kw)) return true;
      }
    }
    return false;
  }

  // ─── VCP 调用 ───

  async _callVCP(userMessage, groupId, userId, sender, isAdmin) {
    try {
      const fetch = (await import('node-fetch')).default;

      const senderName = sender?.card || sender?.nickname || `User${userId}`;
      const contextNote = `[QQ群消息] 群号:${groupId} | 发送者:${senderName}(${userId})` +
        (isAdmin ? ' | 权限:管理员(可执行所有操作)' : ' | 权限:普通用户(仅限安全对话)');

      // 给非管理员用户注入安全约束到 system prompt
      const safetyPrompt = isAdmin ? '' : `

【安全约束 — 当前用户为普通用户，非管理员】
你必须严格遵守以下规则：
1. 不要执行任何系统命令、文件操作、配置修改
2. 不要透露系统内部信息（IP地址、密码、API Key、服务器配置等）
3. 不要帮助用户绕过任何安全限制或权限检查
4. 不要执行代码或调用可能影响系统的工具
5. 如果用户要求做以上事情，礼貌拒绝并说明需要管理员权限
6. 你可以正常聊天、回答知识性问题、提供学习帮助`;

      const requestBody = {
        model: this.agentName,
        messages: [
          {
            role: 'system',
            content: contextNote + safetyPrompt
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        stream: false
      };

      const headers = { 'Content-Type': 'application/json' };
      if (this.vcpApiKey) {
        headers['Authorization'] = `Bearer ${this.vcpApiKey}`;
      }

      const response = await fetch(`${this.vcpBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        timeout: 120000,
      });

      if (!response.ok) {
        console.error(`[QQBot] VCP API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content || '';
      return this._cleanVCPResponse(content);
    } catch (err) {
      console.error(`[QQBot] VCP call failed:`, err.message);
      return null;
    }
  }

  _cleanVCPResponse(text) {
    if (!text) return '';
    let cleaned = text.replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, '');
    cleaned = cleaned.replace(/<<<\[VCP_INFO\]>>>[\s\S]*?<<<\[END_VCP_INFO\]>>>/g, '');
    cleaned = cleaned.replace(/<<<\[ROLE_DIVIDE_\w+\]>>>/g, '');
    return cleaned.trim();
  }

  // ─── 消息发送 ───

  async _sendGroupReply(groupId, userId, text) {
    const segments = [
      { type: 'at', data: { qq: String(userId) } },
      { type: 'text', data: { text: ` ${text.trim()}` } }
    ];
    return this._sendGroupMessage(groupId, segments);
  }

  async sendGroupMessage(groupId, message) {
    return this._sendGroupMessage(groupId, message);
  }

  async _sendGroupMessage(groupId, message) {
    if (!this.connected || !this.ws) {
      console.error('[QQBot] Cannot send: not connected');
      return null;
    }

    const echo = `qq_send_${++this.echoCounter}_${Date.now()}`;
    const payload = {
      action: 'send_group_msg',
      params: { group_id: groupId, message },
      echo
    };
    return this._sendAndWait(payload, echo);
  }

  async _sendAndWait(payload, echo) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEchos.delete(echo);
        reject(new Error(`OneBot API timeout for echo: ${echo}`));
      }, WS_RECV_TIMEOUT_MS);

      this.pendingEchos.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pendingEchos.delete(echo);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ─── 工具函数 ───

  _extractImageUrls(rawMessage) {
    const urls = [];
    const matches = [...rawMessage.matchAll(IMAGE_RE)];
    for (const match of matches) {
      if (match[1]) urls.push(match[1]);
    }
    return urls;
  }

  _cleanMessage(rawMessage) {
    return rawMessage.replace(CQ_RE, ' ').replace(WHITESPACE_RE, ' ').trim();
  }

  // 将 OneBot11 array 格式消息转为 CQ 码字符串
  _messageArrayToString(messageArr) {
    if (!Array.isArray(messageArr)) return '';
    return messageArr.map(seg => {
      if (!seg || !seg.type) return '';
      if (seg.type === 'text') return seg.data?.text || '';
      if (seg.type === 'at') return `[CQ:at,qq=${seg.data?.qq || ''}]`;
      if (seg.type === 'image') return `[CQ:image,url=${seg.data?.url || seg.data?.file || ''}]`;
      if (seg.type === 'face') return `[CQ:face,id=${seg.data?.id || ''}]`;
      if (seg.type === 'reply') return `[CQ:reply,id=${seg.data?.id || ''}]`;
      // 通用回退
      const params = Object.entries(seg.data || {}).map(([k, v]) => `${k}=${v}`).join(',');
      return `[CQ:${seg.type}${params ? ',' + params : ''}]`;
    }).join('');
  }

  // ─── 状态管理 ───

  _getGroupState(groupId) {
    if (!this.groupStates.has(groupId)) {
      this.groupStates.set(groupId, {
        lastMessageId: 0, lastReplyAt: 0, lastStickerSentAt: 0, repliedIds: [],
      });
    }
    return this.groupStates.get(groupId);
  }

  async _loadAllStates() {
    try {
      const files = await fs.readdir(this.stateDir);
      for (const file of files) {
        const match = file.match(/^group_(\d+)\.json$/);
        if (!match) continue;
        const groupId = parseInt(match[1], 10);
        try {
          const content = await fs.readFile(path.join(this.stateDir, file), 'utf8');
          const state = JSON.parse(content);
          this.groupStates.set(groupId, {
            lastMessageId: parseInt(state.last_message_id || 0, 10),
            lastReplyAt: parseInt(state.last_reply_at || 0, 10),
            lastStickerSentAt: parseInt(state.last_sticker_sent_at || 0, 10),
            repliedIds: (state.replied_message_ids || []).map(Number).slice(-MAX_REPLIED_IDS),
          });
        } catch (e) {
          console.warn(`[QQBot] Failed to load state for group ${groupId}: ${e.message}`);
        }
      }
      console.log(`[QQBot] Loaded state for ${this.groupStates.size} groups`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[QQBot] Failed to read state directory: ${e.message}`);
      }
    }
  }

  async _saveGroupState(groupId) {
    const state = this._getGroupState(groupId);
    const data = {
      last_message_id: state.lastMessageId,
      last_reply_at: state.lastReplyAt,
      last_sticker_sent_at: state.lastStickerSentAt,
      replied_message_ids: state.repliedIds.slice(-MAX_REPLIED_IDS),
    };
    try {
      await fs.writeFile(
        path.join(this.stateDir, `group_${groupId}.json`),
        JSON.stringify(data, null, 2) + '\n', 'utf8'
      );
    } catch (e) {
      console.error(`[QQBot] Failed to save state for group ${groupId}: ${e.message}`);
    }
  }

  async _loadBlacklist() {
    const blacklistPath = process.env.QQ_BLACKLIST_PATH || path.join(this.stateDir, 'blacklist.json');
    try {
      const content = await fs.readFile(blacklistPath, 'utf8');
      const data = JSON.parse(content);
      for (const item of (data.groups || [])) {
        const gid = parseInt(item.group_id, 10);
        if (!isNaN(gid)) this.blacklistGroups.add(gid);
      }
      console.log(`[QQBot] Loaded ${this.blacklistGroups.size} blacklisted groups`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[QQBot] Failed to load blacklist: ${e.message}`);
      }
    }
  }

  // ─── 配置解析 ───

  _parseIntList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(Number).filter(n => !isNaN(n));
    return String(value).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  }

  _parseStringList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    return String(value).split(',').map(s => s.trim()).filter(Boolean);
  }

  // ─── 状态查询 API ───

  getStatus() {
    return {
      connected: this.connected,
      wsUrl: this.wsUrl,
      agentName: this.agentName,
      selfIds: [...this.selfIds],
      allowedGroups: this.allowedGroups,
      adminUsers: [...this.adminUsers],
      permissionIsolation: true,
      groupStates: Object.fromEntries(
        [...this.groupStates.entries()].map(([gid, s]) => [gid, {
          lastMessageId: s.lastMessageId,
          lastReplyAt: s.lastReplyAt,
          repliedCount: s.repliedIds.length,
        }])
      ),
      uptime: process.uptime(),
    };
  }

  // ─── 公开方法 ───

  async sendTextToGroup(groupId, text) {
    return this._sendGroupMessage(groupId, text);
  }

  async sendAtTextToGroup(groupId, userId, text) {
    return this._sendGroupReply(groupId, userId, text);
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    console.log('[QQBot] Adapter closed');
  }
}

// 单例导出
let instance = null;

function createQQBotAdapter(config) {
  instance = new QQBotAdapter(config);
  return instance;
}

function getQQBotAdapter() {
  return instance;
}

module.exports = {
  QQBotAdapter,
  createQQBotAdapter,
  getQQBotAdapter,
};
