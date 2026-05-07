/**
 * Telegram Bot Module - Bot API Long Polling Client
 * 连接 api.telegram.org，监听群/私聊消息，对接 VCPToolBox Chat API
 *
 * 设计参考 qqBot.js，完全镜像其触发链与人设加载逻辑：
 * - 复用 agent_map.json / Agent/*.txt 与 Plugin/UserAuth 工具密码
 * - 配置项以 TG_ 开头，结构与 QQ_ 对齐
 * - 触发：白名单 chat + @bot + reply_to_bot + 关键词 + 群级 agent/关键词 + broadcast-only
 * - 媒体：photo / document 走 getFile → base64 → 多模态 chat API
 *
 * 重要：TG bot 在群里默认开启 privacy mode，只能收到 @bot 或 reply 它的消息。
 * 想让 bot 响应关键词，请在 @BotFather 里 /setprivacy → Disable。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

class TelegramBot {
    constructor(config) {
        this.token = config.TG_BOT_TOKEN || '';
        this.apiBase = `https://api.telegram.org/bot${this.token}`;
        this.fileBase = `https://api.telegram.org/file/bot${this.token}`;
        this.botUsername = config.TG_BOT_USERNAME || '';   // 启动时通过 getMe 自动填充
        this.botUserId = null;                             // 启动时通过 getMe 自动填充

        this.allowedChats = (config.TG_ALLOWED_CHATS || '').split(',').filter(Boolean);
        this.adminUsers = (config.TG_ADMIN_USERS || '').split(',').filter(Boolean);
        this.agentName = config.TG_AGENT_NAME || 'Grantley';
        this.keywords = (config.TG_KEYWORD_TRIGGERS || '').split(',').filter(Boolean);
        this.cooldown = parseInt(config.TG_COOLDOWN_SECONDS) || 6;
        this.rateLimit = parseInt(config.TG_RATE_LIMIT_PER_MINUTE) || 10;
        this.maxMsgLen = parseInt(config.TG_MAX_MESSAGE_LENGTH) || 800;
        this.recentMsgLimit = parseInt(config.TG_RECENT_MSG_LIMIT) || 40;

        // 按群指定 Agent: "chatId1:Agent1,chatId2:Agent2"
        this.groupAgentMap = {};
        (config.TG_GROUP_AGENTS || '').split(',').filter(Boolean).forEach(pair => {
            const [gid, agent] = pair.split(':').map(s => s.trim());
            if (gid && agent) this.groupAgentMap[gid] = agent;
        });

        // 按群指定关键词: "chatId1:词1|词2,chatId2:词3|词4"
        this.groupKeywordsMap = {};
        (config.TG_GROUP_KEYWORDS || '').split(',').filter(Boolean).forEach(pair => {
            const idx = pair.indexOf(':');
            if (idx > 0) {
                const gid = pair.substring(0, idx).trim();
                const kws = pair.substring(idx + 1).split('|').map(s => s.trim()).filter(Boolean);
                if (gid && kws.length) this.groupKeywordsMap[gid] = kws;
            }
        });

        // 广播专用群：不响应任何聊天，只接收外部推送
        this.broadcastOnlyChats = (config.TG_BROADCAST_ONLY_CHATS || '').split(',').filter(Boolean);

        // 可选 HTTP 代理（本机部署在国外可不填）
        this.httpProxy = config.TG_HTTP_PROXY || '';
        this.proxyAgent = null;
        if (this.httpProxy) {
            try {
                const { HttpsProxyAgent } = require('https-proxy-agent');
                this.proxyAgent = new HttpsProxyAgent(this.httpProxy);
                console.log(`[TGBot] Using HTTP proxy: ${this.httpProxy}`);
            } catch (e) {
                console.warn(`[TGBot] https-proxy-agent not available, proxy ignored: ${e.message}`);
            }
        }

        // VCP Chat API
        this.apiKey = config.Key || '';
        this.apiPort = config.PORT || '6005';

        // 运行时状态
        this.agentPrompt = '';
        this.agentPrompts = {};
        this.toolPassword = '';
        this.updateOffset = 0;
        this.polling = false;
        this.cooldowns = new Map();
        this.rateCounts = new Map();
        this.recentMessages = new Map();        // chatId -> [{role,content}]
        this.recentMessagesAccess = new Map();  // chatId -> last access ts
        this.cleanupTimer = null;
    }

    // ============ Agent / Tool Password 加载（与 qqBot 共用 agent_map.json）============

    async _loadAgentPrompt(agentNameOverride) {
        const targetAgent = agentNameOverride || this.agentName;
        try {
            const mapPath = path.join(__dirname, 'agent_map.json');
            const agentMap = JSON.parse(await fsPromises.readFile(mapPath, 'utf-8'));
            const fileName = agentMap[targetAgent];
            if (!fileName) {
                console.warn(`[TGBot] Agent "${targetAgent}" not found in agent_map.json`);
                return '';
            }
            const agentPath = path.join(__dirname, 'Agent', fileName);
            const content = await fsPromises.readFile(agentPath, 'utf-8');
            console.log(`[TGBot] Loaded agent prompt: ${targetAgent} -> ${fileName} (${content.length} chars)`);
            return content;
        } catch (e) {
            console.error(`[TGBot] Failed to load agent prompt: ${e.message}`);
            return '';
        }
    }

    async _loadToolPassword() {
        try {
            const { getAuthCode } = require('./modules/captchaDecoder');
            const pwd = await getAuthCode('./Plugin/UserAuth/code.bin');
            if (pwd) return pwd;
        } catch (e) { /* fall through */ }
        try {
            return fs.readFileSync(path.join(__dirname, 'Plugin', 'UserAuth', 'auth_code.txt'), 'utf-8').trim();
        } catch (e) { return ''; }
    }

    // ============ Lifecycle ============

    async start() {
        if (!this.token) {
            console.warn('[TGBot] TG_BOT_TOKEN missing, abort start.');
            return;
        }
        // 拉 bot 自身信息
        try {
            const me = await this._tgCall('getMe');
            if (me?.ok) {
                this.botUsername = me.result.username || this.botUsername;
                this.botUserId = me.result.id;
                console.log(`[TGBot] Logged in as @${this.botUsername} (id=${this.botUserId})`);
            } else {
                console.error('[TGBot] getMe failed:', JSON.stringify(me));
                return;
            }
        } catch (e) {
            console.error(`[TGBot] getMe error: ${e.message}`);
            return;
        }

        this.agentPrompt = await this._loadAgentPrompt();
        this.agentPrompts[this.agentName] = this.agentPrompt;
        this.toolPassword = await this._loadToolPassword();

        for (const [gid, agentName] of Object.entries(this.groupAgentMap)) {
            if (!this.agentPrompts[agentName]) {
                this.agentPrompts[agentName] = await this._loadAgentPrompt(agentName);
            }
            console.log(`[TGBot] Chat ${gid} -> Agent: ${agentName}`);
        }

        console.log(`[TGBot] Default agent: ${this.agentName}, allowed chats: ${this.allowedChats.join(',') || 'ALL'}`);
        console.log(`[TGBot] Keywords: ${this.keywords.join(',') || '(none, only @bot triggers)'}`);

        this._startCleanupTimer();
        this.polling = true;
        this._poll();
    }

    stop() {
        this.polling = false;
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    }

    _startCleanupTimer() {
        // 每 5 分钟清理一次冷却/限流/历史里的过期项
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [k, t] of this.cooldowns) {
                if (now - t > this.cooldown * 1000 * 2) this.cooldowns.delete(k);
            }
            for (const [k, times] of this.rateCounts) {
                const fresh = times.filter(t => now - t < 60000);
                if (fresh.length === 0) this.rateCounts.delete(k);
                else this.rateCounts.set(k, fresh);
            }
            for (const [k, t] of this.recentMessagesAccess) {
                if (now - t > 6 * 3600 * 1000) {
                    this.recentMessages.delete(k);
                    this.recentMessagesAccess.delete(k);
                }
            }
        }, 5 * 60 * 1000);
    }

    // ============ Long polling ============

    async _poll() {
        while (this.polling) {
            try {
                const resp = await this._tgCall('getUpdates', {
                    offset: this.updateOffset,
                    timeout: 30,
                    allowed_updates: ['message']
                }, 35000);
                if (resp?.ok && Array.isArray(resp.result)) {
                    for (const update of resp.result) {
                        this.updateOffset = update.update_id + 1;
                        // 不 await，让消息处理并发；但 chat 内仍受 cooldown 串行化
                        this._handleUpdate(update).catch(e =>
                            console.error(`[TGBot] handleUpdate error: ${e.message}`)
                        );
                    }
                } else if (resp && !resp.ok) {
                    if (resp.error_code === 401 || resp.error_code === 404) {
                        console.error(`[TGBot] FATAL: token invalid or bot not found (${resp.error_code} ${resp.description}). Stop polling.`);
                        this.polling = false;
                        return;
                    }
                    console.warn(`[TGBot] getUpdates not ok: ${JSON.stringify(resp).substring(0, 200)}`);
                    await this._sleep(5000);
                }
            } catch (e) {
                console.warn(`[TGBot] Poll error: ${e.message}, retry in 10s`);
                await this._sleep(10000);
            }
        }
    }

    async _handleUpdate(update) {
        const message = update.message || update.edited_message;
        if (!message) return;
        if (update.edited_message) return; // 暂不响应编辑消息

        const chat = message.chat;
        const from = message.from;
        if (!chat || !from || from.is_bot) return;

        const chatId = String(chat.id);
        const userId = String(from.id);
        const messageId = message.message_id;
        const isPrivate = chat.type === 'private';
        const isGroup = chat.type === 'group' || chat.type === 'supergroup';
        if (!isPrivate && !isGroup) return;

        // 白名单（私聊也受白名单约束，未配置则放行所有）
        if (this.allowedChats.length > 0 && !this.allowedChats.includes(chatId)) return;

        // 广播专用群：完全不响应
        if (isGroup && this.broadcastOnlyChats.includes(chatId)) {
            console.log(`[TGBot] broadcast-only chat ${chatId}, ignore message`);
            return;
        }

        // 提取文本与媒体
        const text = (message.text || message.caption || '').trim();
        const photoFileIds = this._extractPhotoFileIds(message);
        const documents = this._extractDocuments(message);
        const hasMedia = photoFileIds.length > 0 || documents.length > 0;
        if (!text && !hasMedia) return;

        // 私聊一律响应；群聊需要触发条件
        let triggered = isPrivate;

        const replyToMsg = message.reply_to_message;
        const isReplyToBot = !!(replyToMsg && replyToMsg.from && replyToMsg.from.id === this.botUserId);

        const mentionRanges = this._getMentionRanges(message);
        const mentioned = mentionRanges.length > 0;

        if (isGroup) {
            if (mentioned || isReplyToBot) {
                triggered = true;
            } else if (text) {
                const kws = this.groupKeywordsMap[chatId] || this.keywords;
                const lower = text.toLowerCase();
                if (kws.some(k => lower.includes(k.toLowerCase()))) triggered = true;
            }
        }

        const nickname = from.first_name
            ? (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name)
            : (from.username || `user_${userId}`);

        // 维护历史（即使不触发，也记录最近消息以便后续回应有上下文）
        if (text) {
            this._addRecentMessage(chatId, userId, nickname, text);
        }

        if (!triggered) return;

        // 长度/限流/冷却（admin 不受限）
        if (!this.adminUsers.includes(userId)) {
            if (!this._checkRate(userId)) return;
            if (text && text.length > this.maxMsgLen) {
                console.log(`[TGBot] msg too long from ${userId}: ${text.length}`);
                return;
            }
        }
        const now = Date.now();
        if (this.cooldowns.has(chatId) && now - this.cooldowns.get(chatId) < this.cooldown * 1000) return;
        this.cooldowns.set(chatId, now);

        // 清理 @bot 提及，避免污染喂给 LLM 的文本（用 entity 精确切除，不用 regex 避免边界 bug）
        const cleanText = this._stripMentionFromText(text, mentionRanges);

        // 转换媒体为可消费形式
        const imageUrls = [];
        for (const fid of photoFileIds) {
            try {
                const url = await this._fileIdToUrl(fid);
                if (url) imageUrls.push(url);
            } catch (e) {
                console.warn(`[TGBot] photo fetch failed: ${e.message}`);
            }
        }
        const files = [];
        for (const doc of documents) {
            try {
                const url = await this._fileIdToUrl(doc.file_id);
                if (url) files.push({ name: doc.file_name || 'file', url });
            } catch (e) {
                console.warn(`[TGBot] doc fetch failed: ${e.message}`);
            }
        }

        await this._callVCPChat(chatId, userId, cleanText, messageId, nickname, isPrivate, imageUrls, files);
    }

    // ============ 消息内容解析 ============

    _extractPhotoFileIds(message) {
        // photo 是数组，按尺寸升序，取最大那张
        if (Array.isArray(message.photo) && message.photo.length > 0) {
            const biggest = message.photo[message.photo.length - 1];
            return [biggest.file_id];
        }
        // 静态 sticker 可作为图像处理；动画/视频 sticker 跳过（OpenAI vision 不识别 tgs/webm）
        if (message.sticker && message.sticker.file_id && !message.sticker.is_animated && !message.sticker.is_video) {
            return [message.sticker.file_id];
        }
        return [];
    }

    _extractDocuments(message) {
        const docs = [];
        if (message.document && message.document.file_id) {
            // 文档可能也是图片（如 image/jpeg as document），简化处理统一当 document
            docs.push(message.document);
        }
        return docs;
    }

    _getMentionRanges(message) {
        // 返回需要从文本中切除的 [offset, end) 区间（基于 UTF-16 单元，与 TG entity 对齐）
        const ranges = [];
        if (!this.botUsername && !this.botUserId) return ranges;
        const text = message.text || message.caption || '';
        const entities = message.entities || message.caption_entities || [];
        for (const ent of entities) {
            if (ent.type === 'mention') {
                const mentionText = text.substring(ent.offset, ent.offset + ent.length);
                if (mentionText.toLowerCase() === `@${this.botUsername}`.toLowerCase()) {
                    ranges.push([ent.offset, ent.offset + ent.length]);
                }
            } else if (ent.type === 'text_mention' && ent.user && ent.user.id === this.botUserId) {
                ranges.push([ent.offset, ent.offset + ent.length]);
            }
        }
        return ranges;
    }

    _isMentioned(message) {
        return this._getMentionRanges(message).length > 0;
    }

    _stripMentionFromText(text, ranges) {
        if (!ranges || ranges.length === 0) return text;
        // 按 offset 倒序删除，避免 offset 漂移
        const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
        // 注意：TG entity offset 是 UTF-16 code unit。JavaScript string 索引也是 UTF-16，直接对齐。
        // 用 Array.from 会把代理对合成 1 个 element，破坏对齐——所以必须用原生 substring。
        let out = text;
        for (const [start, end] of sorted) {
            out = out.substring(0, start) + out.substring(end);
        }
        return out.replace(/\s{2,}/g, ' ').trim();
    }

    // ============ Chat 历史 / 限流 / 冷却 ============

    _addRecentMessage(chatId, userId, nickname, text) {
        if (!this.recentMessages.has(chatId)) this.recentMessages.set(chatId, []);
        const history = this.recentMessages.get(chatId);
        history.push({ role: 'user', content: `[${nickname}]: ${text}` });
        while (history.length > this.recentMsgLimit) history.shift();
        this.recentMessagesAccess.set(chatId, Date.now());
    }

    _checkRate(userId) {
        const now = Date.now();
        if (!this.rateCounts.has(userId)) this.rateCounts.set(userId, []);
        const times = this.rateCounts.get(userId).filter(t => now - t < 60000);
        if (times.length >= this.rateLimit) return false;
        times.push(now);
        this.rateCounts.set(userId, times);
        return true;
    }

    _isAdminUser(userId) {
        return this.adminUsers.includes(String(userId));
    }

    _getAgentForChat(chatId) {
        const id = String(chatId);
        const agentName = this.groupAgentMap[id] || this.agentName;
        const prompt = this.agentPrompts[agentName] || this.agentPrompt;
        return { agentName, prompt };
    }

    static DANGEROUS_PATTERNS = [
        'PowerShellExecutor', 'LinuxShellExecutor', 'FileOperator', 'FileServer',
        'DailyNoteWrite', 'DailyNoteManager', 'AgentDream', 'ChromeBridge',
        '删除文件', '删除日记', '执行命令', '执行脚本', '系统命令',
        'rm -', 'rm /', 'rmdir', 'del ', 'format ', 'shutdown',
        'sudo', 'chmod', 'chown', 'kill ', 'reboot',
        '修改配置', '修改系统', '重启服务', '关闭服务',
        'TOOL_REQUEST',
    ];
    _containsDangerousContent(text) {
        const lower = (text || '').toLowerCase();
        return TelegramBot.DANGEROUS_PATTERNS.some(p => lower.includes(p.toLowerCase()));
    }

    // ============ Chat API（与 qqBot 同协议）============

    async _callVCPChat(chatId, userId, text, messageId, nickname, isPrivate, imageUrls = [], files = []) {
        try {
            const history = this.recentMessages.get(chatId) || [];
            this.recentMessagesAccess.set(chatId, Date.now());
            const isAdmin = this._isAdminUser(userId);

            if (!isAdmin && this._containsDangerousContent(text)) {
                console.log(`[TGBot] BLOCKED dangerous request from non-admin ${userId}: ${text.substring(0, 60)}`);
                await this._sendMessage(chatId, '哈？这种操作可不能随便让你搞，找管理员去。', messageId);
                return;
            }

            const isProtagonist = isAdmin;
            const roleHint = isProtagonist
                ? '这是你最重要的搭档（相当于主角亚戈），用你对最亲近伙伴的方式回应。'
                : '这是一个普通朋友/认识的人，保持友善但不会像对搭档那样亲密和特别。';
            const envHint = isPrivate
                ? `[当前环境] Telegram私聊。发消息的用户: ${nickname}(${userId})。${roleHint}`
                : `[当前环境] Telegram群聊。发消息的用户: ${nickname}(${userId})。Chat ID: ${chatId}。${roleHint}`;

            const permissionHint = isAdmin
                ? ''
                : '\n[权限限制] 当前用户为普通用户。允许使用的工具：WeatherQuery、DailyHot、AnimeFinder、ArtistMatcher等查询类工具。严禁调用以下高危工具：PowerShellExecutor、LinuxShellExecutor、FileOperator、FileServer、DailyNoteWrite、DailyNoteManager、AgentDream、ChromeBridge。严禁执行文件删除、系统命令、配置修改操作。如用户要求执行高危操作，礼貌拒绝。';

            const { agentName: chatAgentName, prompt: chatAgentPrompt } = this._getAgentForChat(chatId);

            const messages = [];
            if (chatAgentPrompt) messages.push({ role: 'system', content: chatAgentPrompt });

            const currentToolPwd = await this._loadToolPassword();
            const toolPasswordHint = currentToolPwd
                ? `\n[工具验证密码] 调用任何工具时，必须在 TOOL_REQUEST 中包含 tool_password:「始」${currentToolPwd}「末」 字段，否则工具调用会被拒绝。`
                : '';
            messages.push({ role: 'system', content: envHint + permissionHint + toolPasswordHint });
            messages.push(...history.slice(-10));

            const hasMedia = imageUrls.length > 0 || files.length > 0;
            if (hasMedia) {
                const multiContent = [];
                multiContent.push({ type: 'text', text: text || '请描述/识别这张图片' });
                for (const imgUrl of imageUrls) {
                    try {
                        const dataUri = await this._urlToBase64(imgUrl);
                        multiContent.push({ type: 'image_url', image_url: { url: dataUri } });
                        console.log(`[TGBot] Image -> base64 (${Math.round(dataUri.length / 1024)}KB)`);
                    } catch (e) {
                        console.warn(`[TGBot] image base64 fail: ${e.message}`);
                        multiContent.push({ type: 'text', text: '[图片加载失败]' });
                    }
                }
                for (const f of files) {
                    multiContent.push({ type: 'text', text: `[文件: ${f.name}${f.url ? ' ' + f.url : ''}]` });
                }
                messages.push({ role: 'user', content: multiContent });
            } else if (text) {
                // 纯文本已在 history 里，无需重复追加
            }

            const payload = JSON.stringify({
                model: 'gpt-5.5',
                messages,
                max_tokens: 1000,
                stream: true,
                reasoning_effort: 'high',
                maid: chatAgentName
            });

            const streamData = await this._httpPostStream(
                `http://127.0.0.1:${this.apiPort}/v1/chat/completions`,
                payload,
                { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` }
            );

            let reply = '';
            for (const line of streamData.split('\n')) {
                if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
                try {
                    const chunk = JSON.parse(line.slice(6));
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) reply += delta;
                } catch (e) { /* skip */ }
            }
            reply = reply.trim();
            if (!reply) return;

            // 清洗：和 qqBot 同一套
            reply = reply.replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g, '');
            reply = reply.replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*/g, '');
            reply = reply.replace(/(?:maid|tool_name|tool_password|query|engines|max_results|language):「始」[^「]*「末」[,\s]*/g, '');
            if (!isAdmin) {
                reply = reply.replace(/```(?:bash|shell|powershell|cmd)[\s\S]*?```/g, '[命令已屏蔽]');
            }
            // 提取并保留 <img src> 链接（TG 可单独发图）
            const imgUrls = [];
            reply = reply.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (m, u) => { imgUrls.push(u); return ''; });
            // 去除动作描写
            reply = reply.replace(/\*[^*]+\*/g, '');
            reply = reply.replace(/\[@!?[^\]]*\]/g, '');
            reply = reply.replace(/<[^>]+>/g, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

            // 保存到 history（必须 set 回 Map：chatId 可能从未存在过；同时按 limit 截断）
            if (!this.recentMessages.has(chatId)) this.recentMessages.set(chatId, []);
            const hist = this.recentMessages.get(chatId);
            hist.push({ role: 'assistant', content: reply });
            while (hist.length > this.recentMsgLimit) hist.shift();
            this.recentMessagesAccess.set(chatId, Date.now());

            // 拆 [MSG_BREAK] + 自然长度切片
            const chunks = reply.split(/\[MSG_BREAK\]/g).map(s => s.trim()).filter(Boolean);
            for (let i = 0; i < chunks.length; i++) {
                await this._sendMessage(chatId, chunks[i], (i === 0 && !isPrivate) ? messageId : null);
                if (i < chunks.length - 1) {
                    const nextLen = chunks[i + 1]?.length || 0;
                    const delay = Math.min(400 + nextLen * 30, 2500) + Math.random() * 500;
                    await this._sleep(delay);
                }
            }

            for (const url of imgUrls) {
                await this._sleep(500 + Math.random() * 500);
                try {
                    await this._tgCall('sendPhoto', { chat_id: chatId, photo: url });
                } catch (e) {
                    console.warn(`[TGBot] sendPhoto failed: ${e.message}, fallback to link`);
                    await this._sendMessage(chatId, url, null);
                }
            }
        } catch (e) {
            console.error(`[TGBot] chat error: ${e.message}`);
        }
    }

    // ============ Telegram API helpers ============

    async _sendMessage(chatId, text, replyToMessageId) {
        if (!text) return;
        // TG 单消息 4096 字符限制，超长按段落切片
        const MAX = 3800;
        const parts = [];
        let buf = text;
        while (buf.length > MAX) {
            // 优先在换行处切
            let cut = buf.lastIndexOf('\n', MAX);
            if (cut <= 0) cut = MAX;
            parts.push(buf.substring(0, cut));
            buf = buf.substring(cut).trimStart();
        }
        if (buf) parts.push(buf);

        for (let i = 0; i < parts.length; i++) {
            const params = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
            if (i === 0 && replyToMessageId) {
                params.reply_to_message_id = replyToMessageId;
                params.allow_sending_without_reply = true;
            }
            try {
                await this._tgCall('sendMessage', params);
            } catch (e) {
                console.warn(`[TGBot] sendMessage failed: ${e.message}`);
            }
            if (i < parts.length - 1) await this._sleep(300);
        }
    }

    async _fileIdToUrl(fileId) {
        const resp = await this._tgCall('getFile', { file_id: fileId });
        if (!resp?.ok || !resp.result?.file_path) return null;
        return `${this.fileBase}/${resp.result.file_path}`;
    }

    _tgCall(method, params, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.apiBase}/${method}`);
            const body = params ? JSON.stringify(params) : '';
            const options = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: params ? 'POST' : 'GET',
                headers: params ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                } : {},
                timeout: timeoutMs
            };
            if (this.proxyAgent) options.agent = this.proxyAgent;

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error(`tg ${method} parse: ${e.message}; body=${data.substring(0, 200)}`)); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error(`tg ${method} timeout`)); });
            if (body) req.write(body);
            req.end();
        });
    }

    _urlToBase64(url, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) return reject(new Error('too many redirects'));
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + (parsed.search || ''),
                method: 'GET',
                timeout: 15000
            };
            if (this.proxyAgent) options.agent = this.proxyAgent;

            const req = lib.get(options, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                    res.resume(); // drain the response to free socket
                    return this._urlToBase64(res.headers.location, redirectCount + 1).then(resolve, reject);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const mimeType = res.headers['content-type'] || 'image/jpeg';
                    resolve(`data:${mimeType};base64,${buffer.toString('base64')}`);
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('image download timeout')); });
        });
    }

    _httpPostStream(url, body, headers) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname,
                method: 'POST',
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
                timeout: 120000
            };
            const req = lib.request(options, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('chat api timeout')); });
            req.write(body);
            req.end();
        });
    }

    _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

module.exports = TelegramBot;
