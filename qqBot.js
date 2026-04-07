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
        this.toolPassword = '';

        this.ws = null;
        this.reconnectTimer = null;
        this.cooldowns = new Map();
        this.rateCounts = new Map();
        this.recentMessages = new Map(); // chatId -> [{role,content}]
        this.pendingMedia = new Map();   // `${chatId}_${userId}` -> { imageUrls, files, timer, messageId, ... }
        this.mediaWaitMs = 8000;         // 等待文字的超时（8秒）
    }

    async _loadToolPassword() {
        try {
            const { getAuthCode } = require('./modules/captchaDecoder');
            const pwd = await getAuthCode('./Plugin/UserAuth/code.bin');
            if (pwd) {
                console.log(`[QQBot] Tool password loaded (captcha): ${pwd.substring(0, 3)}***`);
                return pwd;
            }
        } catch (e) {
            console.warn(`[QQBot] captchaDecoder failed: ${e.message}, trying auth_code.txt`);
        }
        try {
            const code = fs.readFileSync(path.join(__dirname, 'Plugin', 'UserAuth', 'auth_code.txt'), 'utf-8').trim();
            console.log(`[QQBot] Tool password loaded (txt): ${code.substring(0, 3)}***`);
            return code;
        } catch (e) { return ''; }
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

    async start() {
        this.toolPassword = await this._loadToolPassword();
        console.log(`[QQBot] Starting... WS: ${this.wsUrl}, Agent: ${this.agentName}`);
        console.log(`[QQBot] Allowed groups: ${this.allowedGroups.join(', ') || 'ALL'}`);
        this._connect();
        this._watchDreamLogs();
    }

    /**
     * 监听梦日志目录，有新的梦感悟时私发给管理员
     */
    _watchDreamLogs() {
        const dreamLogDir = path.join(__dirname, 'Plugin', 'AgentDream', 'dream_logs');
        try {
            fs.mkdirSync(dreamLogDir, { recursive: true });
        } catch (e) { /* already exists */ }

        const seen = new Set();
        // 标记已有文件避免重复发
        try {
            fs.readdirSync(dreamLogDir).forEach(f => seen.add(f));
        } catch (e) { /* empty */ }

        fs.watch(dreamLogDir, (eventType, filename) => {
            if (!filename || !filename.endsWith('.json') || seen.has(filename)) return;
            seen.add(filename);

            // 延迟1秒等文件写完
            setTimeout(async () => {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(dreamLogDir, filename), 'utf-8'));
                    const narrative = content.dreamNarrative || '';
                    const agent = content.agentName || '未知';
                    if (!narrative) return;

                    const header = `[梦境感悟] ${agent}的梦\n\n`;
                    const fullText = header + narrative;

                    // QQ 单条消息约4500字上限，超长分段发送
                    const maxLen = 4000;
                    const parts = [];
                    for (let i = 0; i < fullText.length; i += maxLen) {
                        parts.push(fullText.substring(i, i + maxLen));
                    }

                    // 私发给所有管理员
                    for (const adminId of this.adminUsers) {
                        for (let i = 0; i < parts.length; i++) {
                            this._sendPrivateMsg(adminId, parts[i]);
                            if (i < parts.length - 1) {
                                await new Promise(r => setTimeout(r, 500));
                            }
                        }
                    }
                    console.log(`[QQBot] Dream notification sent to admins: ${filename}`);
                } catch (e) {
                    console.warn(`[QQBot] Failed to read dream log ${filename}: ${e.message}`);
                }
            }, 1500);
        });
        console.log(`[QQBot] Watching dream logs: ${dreamLogDir}`);
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

        // 提取文本、图片、文件
        const rawText = this._extractText(event.message);
        const imageUrls = this._extractImageUrls(event.message);
        const files = this._extractFiles(event.message);
        const hasText = rawText.trim().length > 0;
        const hasMedia = imageUrls.length > 0 || files.length > 0;

        if (!hasText && !hasMedia) return;

        // 保存文本到上下文
        if (hasText) {
            this._addRecentMessage(chatId, userId, event.sender?.nickname || userId, rawText);
        }

        // 群聊触发检查
        let triggered = true;
        if (isGroup) {
            const isMentioned = this._isMentioned(event.message);
            const isKeyword = hasText && this.keywords.some(kw => rawText.includes(kw));
            triggered = isMentioned || isKeyword;
            if (!triggered) {
                // 未触发时：纯图片放入缓冲区等后续@消息合并
                if (hasMedia) {
                    const pendingKey = `${chatId}_${userId}`;
                    const existing = this.pendingMedia.get(pendingKey);
                    if (existing) clearTimeout(existing.timer);
                    this.pendingMedia.set(pendingKey, {
                        imageUrls: [...(existing?.imageUrls || []), ...imageUrls],
                        files: [...(existing?.files || []), ...files],
                        messageId, nickname: event.sender?.nickname || '', isPrivate, chatId, userId,
                        timer: setTimeout(() => {
                            // 超时没人@，丢弃缓冲（群里不主动识图）
                            this.pendingMedia.delete(pendingKey);
                            console.log(`[QQBot] Group media buffer expired for ${pendingKey}`);
                        }, 30000) // 群聊给30秒等@
                    });
                    console.log(`[QQBot] Group media buffered for ${pendingKey}, waiting for @/keyword...`);
                }
                return;
            }
        }

        // 速率限制
        if (!this.adminUsers.includes(userId)) {
            if (!this._checkRate(userId)) return;
            if (hasText && rawText.length > this.maxMsgLen) {
                const tip = '消息太长了，请精简一下~';
                isPrivate ? this._sendPrivateMsg(userId, tip) : this._sendGroupMsg(chatId, tip, messageId);
                return;
            }
        }

        // 冷却检查
        const now = Date.now();
        if (this.cooldowns.has(chatId) && now - this.cooldowns.get(chatId) < this.cooldown * 1000) return;
        this.cooldowns.set(chatId, now);

        const cleanText = hasText ? rawText.replace(/^@\S+\s*/, '').trim() : '';
        const pendingKey = `${chatId}_${userId}`;
        const existing = this.pendingMedia.get(pendingKey);
        const nick = event.sender?.nickname || '';

        // ===== 图文合并缓冲 =====

        if (existing) {
            // 有缓冲 → 合并并立即发送
            clearTimeout(existing.timer);
            const allImages = [...(existing.imageUrls || []), ...imageUrls];
            const allFiles = [...(existing.files || []), ...files];
            const finalText = cleanText || existing.text || '';
            this.pendingMedia.delete(pendingKey);
            console.log(`[QQBot] Merged: text="${finalText.substring(0,30)}" imgs=${allImages.length}`);
            this._callVCPChat(chatId, userId, finalText, messageId, nick, isPrivate, allImages, allFiles);
            return;
        }

        if (hasMedia) {
            // 有图片/文件 → 缓冲等配对
            const buf = {
                text: cleanText, imageUrls: [...imageUrls], files: [...files],
                messageId, nickname: nick, isPrivate, chatId, userId,
                timer: setTimeout(() => {
                    this.pendingMedia.delete(pendingKey);
                    console.log(`[QQBot] Buffer timeout: text="${buf.text.substring(0,30)}" imgs=${buf.imageUrls.length}`);
                    this._callVCPChat(chatId, userId, buf.text, buf.messageId, buf.nickname, isPrivate, buf.imageUrls, buf.files);
                }, this.mediaWaitMs)
            };
            this.pendingMedia.set(pendingKey, buf);
            console.log(`[QQBot] Media buffered, waiting ${this.mediaWaitMs}ms...`);
            return;
        }

        // 纯文字 → 直接发送，不缓冲
        console.log(`[QQBot] [${isPrivate ? 'PM' : chatId}] ${nick}(${userId}): ${cleanText.substring(0, 80)}`);
        this._callVCPChat(chatId, userId, cleanText, messageId, nick, isPrivate, [], []);
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

    /**
     * 从 OneBot 消息段中提取图片 URL 列表
     */
    _extractImageUrls(message) {
        if (!Array.isArray(message)) return [];
        return message
            .filter(seg => seg.type === 'image' && seg.data?.url)
            .map(seg => seg.data.url);
    }

    /**
     * 从 OneBot 消息段中提取文件信息
     */
    _extractFiles(message) {
        if (!Array.isArray(message)) return [];
        return message
            .filter(seg => seg.type === 'file' && seg.data)
            .map(seg => ({ name: seg.data.name || '未知文件', url: seg.data.url || '' }));
    }

    /**
     * 下载图片并转为 base64 data URI
     */
    async _imageUrlToBase64(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? require('https') : require('http');
            client.get(url, { timeout: 15000 }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    // 跟随重定向
                    return this._imageUrlToBase64(res.headers.location).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const contentType = res.headers['content-type'] || 'image/png';
                    const mimeType = contentType.split(';')[0].trim();
                    resolve(`data:${mimeType};base64,${buffer.toString('base64')}`);
                });
                res.on('error', reject);
            }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
        });
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

    async _callVCPChat(chatId, userId, text, messageId, nickname, isPrivate = false, imageUrls = [], files = []) {
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

            // 只有 admin 用户（2104743984）才是主角——格兰最重视的搭档
            const isProtagonist = this._isAdminUser(userId);
            const roleHint = isProtagonist
                ? `这是你最重要的搭档（相当于主角亚戈），用你对最亲近伙伴的方式回应。`
                : `这是一个普通朋友/认识的人，保持友善但不会像对搭档那样亲密和特别。`;
            const envHint = isPrivate
                ? `[当前环境] QQ私聊。发消息的用户: ${nickname}(${userId})。${roleHint}`
                : `[当前环境] QQ群聊。发消息的用户: ${nickname}(${userId})。群号: ${chatId}。${roleHint}`;

            // 权限控制指令：非 admin 禁止调用高危工具（天气、搜索等安全工具不限制）
            const permissionHint = isAdmin
                ? ''
                : '\n[权限限制] 当前用户为普通用户。允许使用的工具：WeatherQuery、DailyHot、AnimeFinder、ArtistMatcher等查询类工具。严禁调用以下高危工具：PowerShellExecutor、LinuxShellExecutor、FileOperator、FileServer、DailyNoteWrite、DailyNoteManager、AgentDream、ChromeBridge。严禁执行文件删除、系统命令、配置修改操作。如用户要求执行高危操作，礼貌拒绝。';

            // Agent 人设作为 system message，VCP 中间层会自动展开 {{变量}}
            const messages = [];
            if (this.agentPrompt) {
                messages.push({ role: 'system', content: this.agentPrompt });
            }
            // 工具密码（VCPToolCode 验证必需）
            if (!this.toolPassword) this.toolPassword = await this._loadToolPassword();
            const currentToolPwd = this.toolPassword;
            const toolPasswordHint = currentToolPwd
                ? `\n[工具验证密码] 调用任何工具时，必须在 TOOL_REQUEST 中包含 tool_password:「始」${currentToolPwd}「末」 字段，否则工具调用会被拒绝。`
                : '';
            messages.push({ role: 'system', content: envHint + permissionHint + toolPasswordHint });
            // 添加历史上下文
            messages.push(...history.slice(-10));

            // 构建当前用户消息
            const hasMedia = imageUrls.length > 0 || files.length > 0;
            if (hasMedia) {
                // 图片/文件消息：构建多模态 content
                const multiContent = [];
                if (text) {
                    multiContent.push({ type: 'text', text: text });
                } else {
                    multiContent.push({ type: 'text', text: '请描述/识别这张图片' });
                }
                for (const imgUrl of imageUrls) {
                    try {
                        const dataUri = await this._imageUrlToBase64(imgUrl);
                        multiContent.push({ type: 'image_url', image_url: { url: dataUri } });
                        console.log(`[QQBot] Image -> base64 (${Math.round(dataUri.length/1024)}KB)`);
                    } catch (e) {
                        console.warn(`[QQBot] Image download failed: ${e.message}`);
                        multiContent.push({ type: 'text', text: '[图片加载失败]' });
                    }
                }
                for (const file of files) {
                    multiContent.push({ type: 'text', text: `[文件: ${file.name}${file.url ? ' ' + file.url : ''}]` });
                }
                messages.push({ role: 'user', content: multiContent });
            } else if (text) {
                // 纯文本已在 history 最后一条，不重复添加
            }

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
                // 清理所有工具调用残留（VCPLoop 处理后可能残留在流式输出中）
                reply = reply.replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, '');
                // 清理不完整的工具调用片段（流式拼接可能截断）
                reply = reply.replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*/g, '');
                // 清理「始」「末」格式的参数残留
                reply = reply.replace(/(?:maid|tool_name|tool_password|query|engines|max_results|language):「始」[^「]*「末」[,\s]*/g, '');
                // 非 admin 用户额外过滤
                if (!isAdmin) {
                    reply = reply.replace(/```(?:bash|shell|powershell|cmd)[\s\S]*?```/g, '[命令已屏蔽]');
                }
                // 去除动作/神态描写（星号包裹和括号包裹的都删掉，QQ里不需要）
                reply = reply.replace(/\*[^*]+\*/g, '');
                reply = reply.replace(/\([^)]*(?:尾巴|耳朵|虎牙|伸懒腰|挠|甩|摇|抖|压低|竖起|蹭|拍|抱|握|推|拉|站|坐|躺|走|跑|转身|低头|抬头|叹气|深呼吸|红了脸|别过脸|咬唇|皱眉|眯眼|瞪|笑|哼)[^)]*\)/g, '');
                // 清理残留的空括号和多余空白
                reply = reply.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');

                // 提取表情包图片 URL（<img src="...">）
                const emojiUrls = [];
                reply = reply.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (match, url) => {
                    emojiUrls.push(url);
                    return ''; // 从文本中移除
                });
                // 清理其他残留 HTML 标签
                reply = reply.replace(/<[^>]+>/g, '').trim();

                console.log(`[QQBot] Reply to [${chatId}]: ${reply.substring(0, 100)}${emojiUrls.length ? ` [+${emojiUrls.length}表情]` : ''}...`);

                // 保存回复到上下文
                const hist = this.recentMessages.get(chatId) || [];
                hist.push({ role: 'assistant', content: reply });

                // 按 AI 自行标记的分隔符 [MSG_BREAK] 拆分为多条消息
                const chunks = reply.split(/\[MSG_BREAK\]/g).map(s => s.trim()).filter(Boolean);
                const sendAction = isPrivate ? 'send_private_msg' : 'send_group_msg';
                const sendParams = isPrivate ? { user_id: parseInt(userId) } : { group_id: parseInt(chatId) };

                for (let i = 0; i < chunks.length; i++) {
                    const segments = [];
                    if (i === 0 && !isPrivate) {
                        segments.push({ type: 'reply', data: { id: String(messageId) } });
                    }
                    segments.push({ type: 'text', data: { text: chunks[i] } });
                    this._sendRawMsg(sendAction, { ...sendParams, message: segments });
                    // 模拟打字间隔：根据下一条长度动态调整
                    if (i < chunks.length - 1) {
                        const nextLen = chunks[i + 1]?.length || 0;
                        const delay = Math.min(400 + nextLen * 30, 2500) + Math.random() * 500;
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
                // 表情包单独甩出来
                for (const url of emojiUrls) {
                    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                    this._sendRawMsg(sendAction, { ...sendParams, message: [{ type: 'image', data: { url: url } }] });
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

    /**
     * 将长回复拆分成多条消息，按自然段落分割
     * 短回复（<80字）不拆分
     */
    _sendRawMsg(action, params) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ action, params }));
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
