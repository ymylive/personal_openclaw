/**
 * QQ Bot Module - OneBot11 WebSocket Client
 * 连接 NapCat，监听群消息，对接 VCPToolBox Chat API
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

class QQBot {
    constructor(config) {
        this.wsUrl = config.QQ_WS_URL || 'ws://127.0.0.1:3001';
        this.accessToken = config.QQ_ACCESS_TOKEN || '';
        this.allowedGroups = (config.QQ_ALLOWED_GROUPS || '').split(',').filter(Boolean);
        this.selfIds = (config.QQ_BOT_SELF_IDS || '').split(',').filter(Boolean);
        this.agentName = config.QQ_AGENT_NAME || 'Grantley';
        this.keywords = (config.QQ_KEYWORD_TRIGGERS || '').split(',').filter(Boolean);
        this.cooldown = parseInt(config.QQ_COOLDOWN_SECONDS) || 6;
        this.adminUsers = (config.QQ_ADMIN_USERS || '').split(',').filter(Boolean);
        this.rateLimit = parseInt(config.QQ_RATE_LIMIT_PER_MINUTE) || 10;
        this.maxMsgLen = parseInt(config.QQ_MAX_MESSAGE_LENGTH) || 800;
        this.recentMsgLimit = parseInt(config.QQ_RECENT_MSG_LIMIT) || 40;

        this.apiKey = config.Key || '';
        this.apiPort = config.PORT || '6005';

        // 加载 Agent 人设
        this.agentPrompt = this._loadAgentPrompt();

        this.ws = null;
        this.reconnectTimer = null;
        this.cooldowns = new Map();
        this.rateCounts = new Map();
        this.recentMessages = new Map(); // groupId -> [{role,content}]
    }

    _loadAgentPrompt() {
        try {
            // 读取 agent_map.json 找到 agent 对应的文件名
            const mapPath = path.join(__dirname, 'agent_map.json');
            const agentMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
            const fileName = agentMap[this.agentName];
            if (!fileName) {
                console.warn(`[QQBot] Agent "${this.agentName}" not found in agent_map.json`);
                return '';
            }
            // 读取 Agent 文件
            const agentPath = path.join(__dirname, 'Agent', fileName);
            let content = fs.readFileSync(agentPath, 'utf-8');
            // 保留 VCP 模板变量 {{...}}，让 VCP 中间层自动展开
            console.log(`[QQBot] Loaded agent prompt: ${fileName} (${content.length} chars)`);
            return content;
        } catch (e) {
            console.error(`[QQBot] Failed to load agent prompt: ${e.message}`);
            return '';
        }
    }

    start() {
        console.log(`[QQBot] Starting... WS: ${this.wsUrl}, Agent: ${this.agentName}`);
        console.log(`[QQBot] Allowed groups: ${this.allowedGroups.join(', ') || 'ALL'}`);
        this._connect();
    }

    _connect() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }

        const url = this.accessToken
            ? `${this.wsUrl}?access_token=${this.accessToken}`
            : this.wsUrl;

        console.log(`[QQBot] Connecting to ${this.wsUrl}...`);
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log('[QQBot] WebSocket connected!');
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        });

        this.ws.on('message', (data) => {
            try {
                const event = JSON.parse(data.toString());
                this._handleEvent(event);
            } catch (e) {
                // ignore parse errors
            }
        });

        this.ws.on('close', (code) => {
            console.log(`[QQBot] WebSocket closed (${code}), reconnecting in 10s...`);
            this._scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error(`[QQBot] WebSocket error: ${err.message}`);
            this._scheduleReconnect();
        });
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connect();
        }, 10000);
    }

    _handleEvent(event) {
        // 心跳
        if (event.meta_event_type === 'heartbeat') return;

        // 只处理消息事件（群消息 + 私聊消息）
        if (event.post_type !== 'message') return;
        const isPrivate = event.message_type === 'private';
        const isGroup = event.message_type === 'group';
        if (!isPrivate && !isGroup) return;

        const chatId = isPrivate ? `private_${event.user_id}` : String(event.group_id);
        const userId = String(event.user_id);
        const messageId = event.message_id;

        // 忽略自己的消息
        if (this.selfIds.includes(userId)) return;

        // 群消息检查白名单
        if (isGroup && this.allowedGroups.length > 0 && !this.allowedGroups.includes(String(event.group_id))) return;

        // 提取纯文本
        const rawText = this._extractText(event.message);
        if (!rawText.trim()) return;

        // 保存近期消息到上下文
        this._addRecentMessage(chatId, userId, event.sender?.nickname || userId, rawText);

        // 判断是否需要响应
        if (isGroup) {
            // 群聊：需要@或关键词触发
            const isMentioned = this._isMentioned(event.message);
            const isKeyword = this.keywords.some(kw => rawText.includes(kw));
            if (!isMentioned && !isKeyword) return;
        }
        // 私聊：直接响应所有消息

        // 速率限制（非管理员）
        if (!this.adminUsers.includes(userId)) {
            if (!this._checkRate(userId)) {
                console.log(`[QQBot] Rate limited: ${userId}`);
                return;
            }
            if (rawText.length > this.maxMsgLen) {
                const tip = '消息太长了，请精简一下~';
                isPrivate ? this._sendPrivateMsg(userId, tip) : this._sendGroupMsg(chatId, tip, messageId);
                return;
            }
        }

        // 冷却检查
        const cooldownKey = chatId;
        const now = Date.now();
        if (this.cooldowns.has(cooldownKey) && now - this.cooldowns.get(cooldownKey) < this.cooldown * 1000) {
            return;
        }
        this.cooldowns.set(cooldownKey, now);

        // 清理@标记
        const cleanText = rawText.replace(/^@\S+\s*/, '').trim();
        if (!cleanText) return;

        const label = isPrivate ? 'PM' : chatId;
        console.log(`[QQBot] [${label}] ${event.sender?.nickname}(${userId}): ${cleanText.substring(0, 100)}`);

        // 构建上下文并调用 VCP Chat API
        this._callVCPChat(chatId, userId, cleanText, messageId, event.sender?.nickname || '', isPrivate);
    }

    _extractText(message) {
        if (typeof message === 'string') return message;
        if (!Array.isArray(message)) return '';
        return message
            .filter(seg => seg.type === 'text')
            .map(seg => seg.data?.text || '')
            .join('')
            .trim();
    }

    _isMentioned(message) {
        if (!Array.isArray(message)) return false;
        return message.some(seg =>
            seg.type === 'at' && this.selfIds.includes(String(seg.data?.qq))
        );
    }

    _addRecentMessage(groupId, userId, nickname, text) {
        if (!this.recentMessages.has(groupId)) {
            this.recentMessages.set(groupId, []);
        }
        const history = this.recentMessages.get(groupId);
        history.push({ role: 'user', content: `[${nickname}]: ${text}` });
        // 保留最近N条
        while (history.length > this.recentMsgLimit) {
            history.shift();
        }
    }

    _checkRate(userId) {
        const now = Date.now();
        const key = userId;
        if (!this.rateCounts.has(key)) {
            this.rateCounts.set(key, []);
        }
        const times = this.rateCounts.get(key).filter(t => now - t < 60000);
        if (times.length >= this.rateLimit) return false;
        times.push(now);
        this.rateCounts.set(key, times);
        return true;
    }

    // 高危工具/指令关键词
    static DANGEROUS_PATTERNS = [
        // 工具名
        'PowerShellExecutor', 'LinuxShellExecutor', 'FileOperator', 'FileServer',
        'DailyNoteWrite', 'DailyNoteManager', 'AgentDream', 'ChromeBridge',
        // 操作类关键词
        '删除文件', '删除日记', '执行命令', '执行脚本', '系统命令',
        'rm -', 'rm /', 'rmdir', 'del ', 'format ', 'shutdown',
        'sudo', 'chmod', 'chown', 'kill ', 'reboot',
        '修改配置', '修改系统', '重启服务', '关闭服务',
        'TOOL_REQUEST',
    ];

    _isAdminUser(userId) {
        return this.adminUsers.includes(String(userId));
    }

    _containsDangerousContent(text) {
        const lower = text.toLowerCase();
        return QQBot.DANGEROUS_PATTERNS.some(p => lower.includes(p.toLowerCase()));
    }

    async _callVCPChat(chatId, userId, text, messageId, nickname, isPrivate = false) {
        try {
            const history = this.recentMessages.get(chatId) || [];
            const isAdmin = this._isAdminUser(userId);

            // 非 admin 用户发送高危内容时直接拒绝
            if (!isAdmin && this._containsDangerousContent(text)) {
                console.log(`[QQBot] BLOCKED dangerous request from non-admin ${userId}: ${text.substring(0, 60)}`);
                const rejectMsg = '哈？这种操作可不能随便让你搞，找管理员去。';
                isPrivate ? this._sendPrivateMsg(userId, rejectMsg) : this._sendGroupMsg(chatId, rejectMsg, messageId);
                return;
            }

            const envHint = isPrivate
                ? `[当前环境] QQ私聊。发消息的用户: ${nickname}(${userId})。保持角色身份，简洁自然地回复。`
                : `[当前环境] QQ群聊。发消息的用户: ${nickname}(${userId})。群号: ${chatId}。保持角色身份，简洁自然地回复。`;

            // 权限控制指令：非 admin 禁止调用高危工具
            const permissionHint = isAdmin
                ? ''
                : '\n[权限限制] 当前用户为普通用户，严禁调用以下工具：PowerShellExecutor、LinuxShellExecutor、FileOperator、FileServer、DailyNoteWrite、DailyNoteManager、AgentDream、ChromeBridge。严禁执行任何文件删除、系统命令、配置修改操作。如用户要求执行这些操作，礼貌拒绝并告知需要管理员权限。';

            // Agent 人设作为 system message，VCP 中间层会自动展开 {{变量}}
            const messages = [];
            if (this.agentPrompt) {
                messages.push({ role: 'system', content: this.agentPrompt });
            }
            messages.push({ role: 'system', content: envHint + permissionHint });
            messages.push(...history.slice(-10)); // 最近10条上下文

            const payload = JSON.stringify({
                model: 'gpt-5.4',
                messages: messages,
                max_tokens: 1000,
                stream: true,
                maid: this.agentName
            });

            const streamData = await this._httpPostStream(`http://127.0.0.1:${this.apiPort}/v1/chat/completions`, payload, {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            });

            // 从 SSE 流中拼接 content
            let reply = '';
            const lines = streamData.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
                try {
                    const chunk = JSON.parse(line.slice(6));
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) reply += delta;
                } catch (e) { /* skip parse errors */ }
            }
            reply = reply.trim();

            if (reply) {
                // 非 admin 用户：过滤回复中可能泄露的工具调用
                if (!isAdmin) {
                    // 移除 TOOL_REQUEST 块
                    reply = reply.replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, '[工具调用已被权限系统拦截]');
                    // 移除可能的 shell 命令输出
                    reply = reply.replace(/```(?:bash|shell|powershell|cmd)[\s\S]*?```/g, '[命令已屏蔽]');
                }
                // 去除动作描写中的星号（QQ不渲染）
                reply = reply.replace(/\*(.*?)\*/g, '($1)');
                // 清理 HTML 标签（如表情包 img 标签，QQ 不渲染）
                reply = reply.replace(/<img[^>]*>/gi, '');
                reply = reply.trim();
                console.log(`[QQBot] Reply to [${chatId}]: ${reply.substring(0, 100)}...`);

                // 保存回复到上下文
                const hist = this.recentMessages.get(chatId) || [];
                hist.push({ role: 'assistant', content: reply });

                if (isPrivate) {
                    this._sendPrivateMsg(userId, reply);
                } else {
                    this._sendGroupMsg(chatId, reply, messageId);
                }
            }
        } catch (e) {
            console.error(`[QQBot] Chat API error: ${e.message}`);
        }
    }

    _httpPostStream(url, body, headers) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                method: 'POST',
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
                timeout: 120000
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
        });
    }

    _httpPost(url, body, headers) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                method: 'POST',
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
                timeout: 120000
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { resolve(null); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
        });
    }

    _sendPrivateMsg(userId, text) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const msg = {
            action: 'send_private_msg',
            params: {
                user_id: parseInt(userId),
                message: [{ type: 'text', data: { text: text } }]
            }
        };
        this.ws.send(JSON.stringify(msg));
    }

    _sendGroupMsg(groupId, text, replyMsgId) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const msg = {
            action: 'send_group_msg',
            params: {
                group_id: parseInt(groupId),
                message: replyMsgId
                    ? [
                        { type: 'reply', data: { id: String(replyMsgId) } },
                        { type: 'text', data: { text: text } }
                    ]
                    : [{ type: 'text', data: { text: text } }]
            }
        };
        this.ws.send(JSON.stringify(msg));
    }

    stop() {
        console.log('[QQBot] Stopping...');
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }
    }
}

module.exports = QQBot;
