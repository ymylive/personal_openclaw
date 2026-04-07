/**
 * QQ Bot Module - OneBot11 WebSocket Client
 * 连接 NapCat，监听群消息，对接 VCPToolBox Chat API
 */
const WebSocket = require('ws');
const http = require('http');

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

        this.ws = null;
        this.reconnectTimer = null;
        this.cooldowns = new Map();
        this.rateCounts = new Map();
        this.recentMessages = new Map(); // groupId -> [{role,content}]
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

        // 只处理群消息
        if (event.post_type !== 'message' || event.message_type !== 'group') return;

        const groupId = String(event.group_id);
        const userId = String(event.user_id);
        const messageId = event.message_id;

        // 忽略自己的消息
        if (this.selfIds.includes(userId)) return;

        // 检查群白名单
        if (this.allowedGroups.length > 0 && !this.allowedGroups.includes(groupId)) return;

        // 提取纯文本
        const rawText = this._extractText(event.message);
        if (!rawText.trim()) return;

        // 保存近期消息到上下文
        this._addRecentMessage(groupId, userId, event.sender?.nickname || userId, rawText);

        // 判断是否需要响应
        const isMentioned = this._isMentioned(event.message);
        const isKeyword = this.keywords.some(kw => rawText.includes(kw));

        if (!isMentioned && !isKeyword) return;

        // 速率限制（非管理员）
        if (!this.adminUsers.includes(userId)) {
            if (!this._checkRate(userId)) {
                console.log(`[QQBot] Rate limited: ${userId}`);
                return;
            }
            if (rawText.length > this.maxMsgLen) {
                this._sendGroupMsg(groupId, '消息太长了，请精简一下~', messageId);
                return;
            }
        }

        // 冷却检查
        const cooldownKey = `${groupId}`;
        const now = Date.now();
        if (this.cooldowns.has(cooldownKey) && now - this.cooldowns.get(cooldownKey) < this.cooldown * 1000) {
            return;
        }
        this.cooldowns.set(cooldownKey, now);

        // 清理@标记
        const cleanText = rawText.replace(/^@\S+\s*/, '').trim();
        if (!cleanText) return;

        console.log(`[QQBot] [${groupId}] ${event.sender?.nickname}(${userId}): ${cleanText.substring(0, 100)}`);

        // 构建上下文并调用 VCP Chat API
        this._callVCPChat(groupId, userId, cleanText, messageId, event.sender?.nickname || '');
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

    async _callVCPChat(groupId, userId, text, messageId, nickname) {
        try {
            const history = this.recentMessages.get(groupId) || [];
            // 构建消息：近期上下文 + 当前消息
            const messages = [
                { role: 'system', content: `当前是QQ群聊环境。发消息的用户: ${nickname}(${userId})。群号: ${groupId}。请以你的角色身份回复，保持简洁自然。` },
                ...history.slice(-10) // 最近10条上下文
            ];

            const payload = JSON.stringify({
                model: 'gpt-5.4',
                messages: messages,
                max_tokens: 1000,
                stream: false,
                maid: this.agentName
            });

            const result = await this._httpPost(`http://127.0.0.1:${this.apiPort}/v1/chat/completions`, payload, {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            });

            if (result && result.choices && result.choices[0]) {
                let reply = result.choices[0].message?.content || '';
                // 清理 VCP 流式格式残留
                reply = reply.replace(/^data:\s*\{.*?"content":"(.*?)"\}.*$/gm, '$1');
                reply = reply.replace(/data: \[DONE\]/g, '').trim();

                if (reply) {
                    // 去除动作描写中的星号（QQ不渲染）
                    reply = reply.replace(/\*(.*?)\*/g, '($1)');
                    console.log(`[QQBot] Reply to [${groupId}]: ${reply.substring(0, 100)}...`);

                    // 保存回复到上下文
                    const hist = this.recentMessages.get(groupId) || [];
                    hist.push({ role: 'assistant', content: reply });

                    this._sendGroupMsg(groupId, reply, messageId);
                }
            }
        } catch (e) {
            console.error(`[QQBot] Chat API error: ${e.message}`);
        }
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
