/**
 * QQ Bot Module - OneBot11 WebSocket Client
 * 连接 NapCat，监听群消息，对接 VCPToolBox Chat API
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const fsPromises = require('fs').promises;
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

        // 按群指定 Agent：格式 "群号1:AgentName1,群号2:AgentName2"
        this.groupAgentMap = {};
        (config.QQ_GROUP_AGENTS || '').split(',').filter(Boolean).forEach(pair => {
            const [gid, agent] = pair.split(':').map(s => s.trim());
            if (gid && agent) this.groupAgentMap[gid] = agent;
        });

        // 按群指定关键词：格式 "群号1:词1|词2,群号2:词3|词4"
        // 未指定的群使用默认 keywords
        this.groupKeywordsMap = {};
        (config.QQ_GROUP_KEYWORDS || '').split(',').filter(Boolean).forEach(pair => {
            const idx = pair.indexOf(':');
            if (idx > 0) {
                const gid = pair.substring(0, idx).trim();
                const kws = pair.substring(idx + 1).split('|').map(s => s.trim()).filter(Boolean);
                if (gid && kws.length) this.groupKeywordsMap[gid] = kws;
            }
        });

        // 广播专用群：这些群不响应任何消息（关键词/@/水群都禁用），只接收定时推送
        this.broadcastOnlyGroups = (config.QQ_BROADCAST_ONLY_GROUPS || '').split(',').filter(Boolean);

        // 每日简报配置
        this.dailyBriefingHour = parseInt(config.QQ_DAILY_BRIEFING_HOUR || '9');      // 默认早上9点
        this.dailyBriefingMinute = parseInt(config.QQ_DAILY_BRIEFING_MINUTE || '0');  // 默认0分
        this._dailyBriefingLastDate = null;   // 记录上次推送的日期字符串，防止同一天重复
        this._dailyBriefingTimer = null;

        // Agent 人设 (loaded async in start())
        this.agentPrompt = '';        // 默认 agent prompt
        this.agentPrompts = {};       // 按 agent name 缓存的 prompts
        this.toolPassword = '';

        // ===== 自动水群配置 =====
        this.autoChat = config.QQ_AUTO_CHAT !== 'false';                        // 总开关，默认开启
        this.autoChatGroups = (config.QQ_AUTO_CHAT_GROUPS || '').split(',').filter(Boolean); // 水群白名单（空=跟随 allowedGroups）
        this.autoChatBaseProb = parseFloat(config.QQ_AUTO_CHAT_BASE_PROB) || 0.03;   // 基础触发概率 3%
        this.autoChatBurstProb = parseFloat(config.QQ_AUTO_CHAT_BURST_PROB) || 0.25; // 活跃话题触发概率 25%
        this.autoChatCooldownMin = parseInt(config.QQ_AUTO_CHAT_COOLDOWN_MIN) || 120; // 同群水群最小间隔（秒）
        this.autoChatCooldownMax = parseInt(config.QQ_AUTO_CHAT_COOLDOWN_MAX) || 600; // 同群水群最大间隔（秒）
        this.autoChatActiveHoursStart = parseInt(config.QQ_AUTO_CHAT_HOURS_START) || 8;  // 活跃时段起始
        this.autoChatActiveHoursEnd = parseInt(config.QQ_AUTO_CHAT_HOURS_END) || 1;     // 活跃时段结束（次日1点）
        this.autoChatMsgThreshold = parseInt(config.QQ_AUTO_CHAT_MSG_THRESHOLD) || 5;   // 连续N条消息后才可能触发
        this.autoChatMaxDaily = parseInt(config.QQ_AUTO_CHAT_MAX_DAILY) || 30;           // 每日每群上限

        // 水群运行时状态
        this._autoChatLastTime = new Map();      // groupId -> timestamp 上次水群时间
        this._autoChatMsgCount = new Map();       // groupId -> count 自上次触发后的消息计数
        this._autoChatDailyCount = new Map();     // groupId -> { date, count }
        this._autoChatPending = new Set();         // 正在水群中的群（防并发）
        this._autoChatTopicBuffer = new Map();     // groupId -> [最近几条消息文本] 用于话题检测

        this.ws = null;
        this.reconnectTimer = null;
        this.cleanupTimer = null;
        this.cooldowns = new Map();
        this.rateCounts = new Map();
        this.recentMessages = new Map(); // chatId -> [{role,content}]
        this.recentMessagesAccess = new Map(); // chatId -> last access timestamp
        this.pendingMedia = new Map();   // `${chatId}_${userId}` -> { imageUrls, files, timer, messageId, ... }
        this.pendingMediaCreatedAt = new Map(); // key -> creation timestamp
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

    async _loadAgentPrompt(agentNameOverride) {
        const targetAgent = agentNameOverride || this.agentName;
        try {
            // 读取 agent_map.json 找到 agent 对应的文件名
            const mapPath = path.join(__dirname, 'agent_map.json');
            const agentMap = JSON.parse(await fsPromises.readFile(mapPath, 'utf-8'));
            const fileName = agentMap[targetAgent];
            if (!fileName) {
                console.warn(`[QQBot] Agent "${targetAgent}" not found in agent_map.json`);
                return '';
            }
            // 读取 Agent 文件
            const agentPath = path.join(__dirname, 'Agent', fileName);
            let content = await fsPromises.readFile(agentPath, 'utf-8');
            // 保留 VCP 模板变量 {{...}}，让 VCP 中间层自动展开
            console.log(`[QQBot] Loaded agent prompt: ${targetAgent} -> ${fileName} (${content.length} chars)`);
            return content;
        } catch (e) {
            console.error(`[QQBot] Failed to load agent prompt: ${e.message}`);
            return '';
        }
    }

    async start() {
        this.agentPrompt = await this._loadAgentPrompt();
        this.agentPrompts[this.agentName] = this.agentPrompt;
        this.toolPassword = await this._loadToolPassword();

        // 预加载各群独立 Agent 的 prompt
        for (const [gid, agentName] of Object.entries(this.groupAgentMap)) {
            if (!this.agentPrompts[agentName]) {
                this.agentPrompts[agentName] = await this._loadAgentPrompt(agentName);
            }
            console.log(`[QQBot] Group ${gid} -> Agent: ${agentName}`);
        }

        console.log(`[QQBot] Starting... WS: ${this.wsUrl}, Default Agent: ${this.agentName}`);
        console.log(`[QQBot] Allowed groups: ${this.allowedGroups.join(', ') || 'ALL'}`);
        this._connect();
        this._watchDreamLogs();
        this._startCleanupTimer();
        this._startDailyBriefingScheduler();
    }

    /**
     * 监听梦日志目录，有新的梦感悟时私发给管理员
     */
    async _watchDreamLogs() {
        const dreamLogDir = path.join(__dirname, 'Plugin', 'AgentDream', 'dream_logs');
        try {
            await fsPromises.mkdir(dreamLogDir, { recursive: true });
        } catch (e) { /* already exists */ }

        const seen = new Set();
        // 标记已有文件避免重复发
        try {
            const existingFiles = await fsPromises.readdir(dreamLogDir);
            existingFiles.forEach(f => seen.add(f));
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
            try { this.ws.close(); } catch (e) { console.warn('[QQBot] Error closing old WS:', e.message); }
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
                console.warn('[QQBot] Failed to parse WS message:', e.message);
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

        // 广播专用群：完全不响应任何消息（只负责接收定时推送）
        if (isGroup && this.broadcastOnlyGroups.includes(String(event.group_id))) {
            return;
        }

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
            const gidStr = String(event.group_id);
            const groupKws = this.groupKeywordsMap[gidStr] || this.keywords;
            const isKeyword = hasText && groupKws.some(kw => rawText.toLowerCase().includes(kw.toLowerCase()));
            triggered = isMentioned || isKeyword;
            if (hasText && !triggered) {
                console.log(`[QQBot] 未触发 group=${gidStr} text="${rawText.substring(0,30)}" kws=[${groupKws.join(',')}] mentioned=${isMentioned}`);
            }
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
                            this.pendingMediaCreatedAt.delete(pendingKey);
                            console.log(`[QQBot] Group media buffer expired for ${pendingKey}`);
                        }, 30000) // 群聊给30秒等@
                    });
                    if (!this.pendingMediaCreatedAt.has(pendingKey)) {
                        this.pendingMediaCreatedAt.set(pendingKey, Date.now());
                    }
                    console.log(`[QQBot] Group media buffered for ${pendingKey}, waiting for @/keyword...`);
                }

                // ===== 自动水群判断 =====
                if (hasText) {
                    this._evaluateAutoChat(chatId, userId, rawText, event.sender?.nickname || '', messageId);
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
            this.pendingMediaCreatedAt.delete(pendingKey);
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
                    this.pendingMediaCreatedAt.delete(pendingKey);
                    console.log(`[QQBot] Buffer timeout: text="${buf.text.substring(0,30)}" imgs=${buf.imageUrls.length}`);
                    this._callVCPChat(chatId, userId, buf.text, buf.messageId, buf.nickname, isPrivate, buf.imageUrls, buf.files);
                }, this.mediaWaitMs)
            };
            this.pendingMedia.set(pendingKey, buf);
            this.pendingMediaCreatedAt.set(pendingKey, Date.now());
            console.log(`[QQBot] Media buffered, waiting ${this.mediaWaitMs}ms...`);
            return;
        }

        // ===== A股分析多Agent任务触发（全流程自动：Phase1 → Phase2）=====
        const aStockTrigger = cleanText.match(/格兰.{0,4}分析[aA]股|格兰.{0,4}分析(大盘|股市|行情)|跑第一(步|阶段)|第一阶段/);

        if (aStockTrigger && this._isAdminUser(userId)) {
            console.log(`[QQBot][A股] 触发全流程分析: ${cleanText}`);
            this._runAStockFullAnalysis(chatId, userId, messageId, nick, isPrivate);
            return;
        }

        // ===== 每日简报手动触发（admin）=====
        const briefingTrigger = cleanText.match(/^(推送|触发|跑)?(每日简报|简报|计软简报)/);
        if (briefingTrigger && this._isAdminUser(userId)) {
            console.log(`[QQBot][简报] 管理员手动触发: ${cleanText}`);
            this._sendGroupMsg(chatId, '收到，正在手动触发每日简报推送...');
            this._triggerDailyBriefingNow().catch(e => console.error(`[QQBot][简报] 手动触发失败: ${e.message}`));
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
        // Track last access time for LRU cleanup
        this.recentMessagesAccess.set(groupId, Date.now());
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

    /**
     * 获取指定群的 Agent 名和 prompt（支持按群独立 Agent）
     */
    _getAgentForChat(chatId) {
        const groupId = String(chatId);
        const agentName = this.groupAgentMap[groupId] || this.agentName;
        const prompt = this.agentPrompts[agentName] || this.agentPrompt;
        return { agentName, prompt };
    }

    _containsDangerousContent(text) {
        const lower = text.toLowerCase();
        return QQBot.DANGEROUS_PATTERNS.some(p => lower.includes(p.toLowerCase()));
    }

    async _callVCPChat(chatId, userId, text, messageId, nickname, isPrivate = false, imageUrls = [], files = [], options = {}) {
        const { isAutoChat = false, isAStockAnalysis = false } = options;
        try {
            const history = this.recentMessages.get(chatId) || [];
            this.recentMessagesAccess.set(chatId, Date.now());
            const isAdmin = this._isAdminUser(userId);

            // 非 admin 用户发送高危内容时直接拒绝（水群模式和系统内部任务跳过）
            if (!isAutoChat && !isAStockAnalysis && !isAdmin && this._containsDangerousContent(text)) {
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
            let envHint = isPrivate
                ? `[当前环境] QQ私聊。发消息的用户: ${nickname}(${userId})。${roleHint}`
                : `[当前环境] QQ群聊。发消息的用户: ${nickname}(${userId})。群号: ${chatId}。${roleHint}`;

            // 水群模式：追加行为约束
            if (isAutoChat) {
                envHint += `\n[水群模式] 你正在以群友身份自然地参与群聊，不是在回应别人的提问。注意：
- 说话简短随意，1-2句话，偶尔就一个词或表情
- 不要长篇大论、不要分点列举、不要markdown
- 用网络用语和口语化表达，像真人打字
- 可以吐槽、玩梗、表达情绪，不要总是附和
- 不要自我介绍或解释身份
- 禁止使用动作描写（*动作*格式）`;
            }

            // 权限控制指令：非 admin 禁止调用高危工具（天气、搜索等安全工具不限制）
            const permissionHint = isAdmin
                ? ''
                : '\n[权限限制] 当前用户为普通用户。允许使用的工具：WeatherQuery、DailyHot、AnimeFinder、ArtistMatcher等查询类工具。严禁调用以下高危工具：PowerShellExecutor、LinuxShellExecutor、FileOperator、FileServer、DailyNoteWrite、DailyNoteManager、AgentDream、ChromeBridge。严禁执行文件删除、系统命令、配置修改操作。如用户要求执行高危操作，礼貌拒绝。';

            // 按群选择 Agent（不同群可以用不同 agent 人设）
            const { agentName: chatAgentName, prompt: chatAgentPrompt } = this._getAgentForChat(chatId);

            // Agent 人设作为 system message，VCP 中间层会自动展开 {{变量}}
            const messages = [];
            if (chatAgentPrompt) {
                messages.push({ role: 'system', content: chatAgentPrompt });
            }
            // 工具密码（VCPToolCode 验证必需，每次实时读取因为密码会动态刷新）
            const currentToolPwd = await this._loadToolPassword();
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
            } else if (text && isAStockAnalysis) {
                // A股分析模式：完整 prompt 必须显式添加为 user message，不能依赖 history
                messages.push({ role: 'user', content: text });
            } else if (text) {
                // 纯文本已在 history 最后一条，不重复添加
            }

            const payload = JSON.stringify({
                model: 'gpt-5.4',
                messages: messages,
                max_tokens: isAStockAnalysis ? 8000 : (isAutoChat ? 200 : 1000),
                stream: true,
                reasoning_effort: 'high',
                maid: chatAgentName
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
                // 清理 RAG TagMemo 标签残留（如 [@!热点新闻] [@国际局势] 等）
                reply = reply.replace(/\[@!?[^\]]*\]/g, '');
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

                // A股分析模式：不发消息，返回文本内容（由调用方写文件发送）
                if (isAStockAnalysis) {
                    return reply;
                }

                // 按 AI 自行标记的分隔符 [MSG_BREAK] 拆分为多条消息
                const chunks = reply.split(/\[MSG_BREAK\]/g).map(s => s.trim()).filter(Boolean);
                const sendAction = isPrivate ? 'send_private_msg' : 'send_group_msg';
                const sendParams = isPrivate ? { user_id: parseInt(userId) } : { group_id: parseInt(chatId) };

                // 水群模式下截短回复
                if (isAutoChat && reply.length > 100) {
                    const cutIdx = reply.substring(0, 100).search(/[。！？!?\n]/);
                    reply = cutIdx > 10 ? reply.substring(0, cutIdx + 1) : reply.substring(0, 80);
                    reply = reply.trim();
                }

                for (let i = 0; i < chunks.length; i++) {
                    const segments = [];
                    // 水群模式不引用消息（真人不会每次都回复引用）
                    if (i === 0 && !isPrivate && !isAutoChat) {
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
        return null;
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

    /**
     * Periodic cleanup of unbounded Maps to prevent memory leaks.
     * Runs every 10 minutes.
     */
    _startCleanupTimer() {
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            let removedCooldowns = 0;
            let removedRateCounts = 0;
            let removedChats = 0;

            // Remove cooldowns older than 1 hour
            for (const [key, timestamp] of this.cooldowns) {
                if (now - timestamp > 60 * 60 * 1000) {
                    this.cooldowns.delete(key);
                    removedCooldowns++;
                }
            }

            // Remove rateCounts older than 2 minutes
            for (const [key, times] of this.rateCounts) {
                const recent = times.filter(t => now - t < 120000);
                if (recent.length === 0) {
                    this.rateCounts.delete(key);
                    removedRateCounts++;
                } else {
                    this.rateCounts.set(key, recent);
                }
            }

            // Remove recentMessages not accessed in 2 hours
            for (const [key, accessTime] of this.recentMessagesAccess) {
                if (now - accessTime > 2 * 60 * 60 * 1000) {
                    this.recentMessages.delete(key);
                    this.recentMessagesAccess.delete(key);
                    removedChats++;
                }
            }

            // Hard cap: if recentMessages exceeds 500 keys, evict oldest-accessed
            if (this.recentMessages.size > 500) {
                const sorted = [...this.recentMessagesAccess.entries()]
                    .sort((a, b) => a[1] - b[1]);
                const toEvict = sorted.slice(0, this.recentMessages.size - 500);
                for (const [key] of toEvict) {
                    this.recentMessages.delete(key);
                    this.recentMessagesAccess.delete(key);
                    removedChats++;
                }
            }

            // Hard cap: if pendingMedia exceeds 100 keys, evict oldest
            if (this.pendingMedia.size > 100) {
                const sorted = [...this.pendingMediaCreatedAt.entries()]
                    .sort((a, b) => a[1] - b[1]);
                const toEvict = sorted.slice(0, this.pendingMedia.size - 100);
                for (const [key] of toEvict) {
                    const entry = this.pendingMedia.get(key);
                    if (entry?.timer) clearTimeout(entry.timer);
                    this.pendingMedia.delete(key);
                    this.pendingMediaCreatedAt.delete(key);
                }
            }

            if (removedCooldowns > 0 || removedRateCounts > 0 || removedChats > 0) {
                console.log(`[QQBot] Cleanup: removed ${removedCooldowns} cooldowns, ${removedRateCounts} rateCounts, ${removedChats} stale chats`);
            }
        }, 10 * 60 * 1000); // every 10 minutes

        // Don't prevent process exit
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    // ===== A股短线分析多Agent系统 =====

    /**
     * 计算前一个交易日的日期（跳过周末）
     */
    _getLastTradingDate() {
        const d = new Date();
        const day = d.getDay();
        // 周一→退3天到周五，周日→退2天，周六→退1天，其他→退1天
        if (day === 1) d.setDate(d.getDate() - 3);
        else if (day === 0) d.setDate(d.getDate() - 2);
        else d.setDate(d.getDate() - 1);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    /**
     * 全流程自动执行：Phase1(板块研判) → Phase2(个股精选) → 合并转发消息发送
     */
    async _runAStockFullAnalysis(chatId, userId, messageId, nick, isPrivate) {
        console.log(`[QQBot][A股] 全流程启动: Phase1 → Phase2 → 合并转发`);
        const today = new Date();
        const lastTD = this._getLastTradingDate();

        // 发送进度提示
        this._sendGroupMsg(chatId, '正在执行A股全流程分析，请稍候...\n第一阶段：板块研判 + 市场情绪');

        // Phase 1: 板块研判 + 市场情绪
        const phase1Result = await this._callVCPChat(chatId, userId, this._buildAStockPhase1Prompt(), messageId, nick, isPrivate, [], [], { isAStockAnalysis: true });

        if (!phase1Result) {
            this._sendGroupMsg(chatId, '第一阶段分析未返回结果，流程中断。');
            console.error(`[QQBot][A股] Phase1 无返回`);
            return;
        }
        console.log(`[QQBot][A股] Phase1 完成 (${phase1Result.length}字)，进入 Phase2`);

        // 间隔
        this._sendGroupMsg(chatId, '第一阶段完成，正在进入第二阶段个股精选...');
        await new Promise(r => setTimeout(r, 3000));

        // Phase 2: 个股精选
        const phase2Result = await this._callVCPChat(chatId, userId, this._buildAStockPhase2Prompt(), messageId, nick, isPrivate, [], [], { isAStockAnalysis: true });

        console.log(`[QQBot][A股] Phase2 完成 (${(phase2Result || '').length}字)，开始发送`);

        // 清理 [MSG_BREAK]
        const p1Clean = (phase1Result || '[分析未返回]').replace(/\[MSG_BREAK\]/g, '\n').trim();
        const p2Clean = (phase2Result || '[选股未返回]').replace(/\[MSG_BREAK\]/g, '\n').trim();

        // 用合并转发消息发送（一个卡片包含所有内容，不刷屏）
        const botId = this.selfIds[0] || '10000';
        const botName = this.agentName || '格兰利特';
        const dateDisplay = today.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

        // 将长文本按4000字分段（QQ单条消息上限约4500字）
        const splitText = (text, maxLen = 4000) => {
            const parts = [];
            for (let i = 0; i < text.length; i += maxLen) {
                parts.push(text.substring(i, i + maxLen));
            }
            return parts.length > 0 ? parts : ['[空]'];
        };

        // 构建转发消息节点
        const forwardNodes = [];

        // 标题节点
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName,
                uin: botId,
                content: [{ type: 'text', data: { text: `📊 A股短线交易研究报告\n生成时间：${dateDisplay}\n前一交易日：${lastTD}` } }]
            }
        });

        // Phase1 内容（可能分多段）
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName,
                uin: botId,
                content: [{ type: 'text', data: { text: '═══ 第一阶段：板块研判 + 市场情绪 ═══' } }]
            }
        });
        for (const part of splitText(p1Clean)) {
            forwardNodes.push({
                type: 'node',
                data: {
                    name: botName,
                    uin: botId,
                    content: [{ type: 'text', data: { text: part } }]
                }
            });
        }

        // Phase2 内容
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName,
                uin: botId,
                content: [{ type: 'text', data: { text: '═══ 第二阶段：个股精选 ═══' } }]
            }
        });
        for (const part of splitText(p2Clean)) {
            forwardNodes.push({
                type: 'node',
                data: {
                    name: botName,
                    uin: botId,
                    content: [{ type: 'text', data: { text: part } }]
                }
            });
        }

        // 免责声明
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName,
                uin: botId,
                content: [{ type: 'text', data: { text: '⚠️ 免责声明：本报告由AI生成，仅供研究参考，不构成投资建议。投资有风险，决策需谨慎。' } }]
            }
        });

        // 发送合并转发消息
        try {
            this._sendRawMsg('send_group_forward_msg', {
                group_id: parseInt(chatId),
                messages: forwardNodes
            });
            console.log(`[QQBot][A股] 合并转发消息已发送 (${forwardNodes.length}个节点)`);
        } catch (e) {
            console.error(`[QQBot][A股] 合并转发发送失败: ${e.message}，降级为分段文本`);
            // 降级：分段发送
            const allText = `📊 A股研究报告 (${dateDisplay})\n\n【第一阶段】\n${p1Clean}\n\n【第二阶段】\n${p2Clean}`;
            for (const chunk of splitText(allText)) {
                this._sendRawMsg('send_group_msg', {
                    group_id: parseInt(chatId),
                    message: [{ type: 'text', data: { text: chunk } }]
                });
                await new Promise(r => setTimeout(r, 800));
            }
        }

        console.log(`[QQBot][A股] 全流程完成`);
    }

    /**
     * 构建第一阶段 prompt：板块研判 + 市场情绪
     */
    _buildAStockPhase1Prompt() {
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const weekday = ['周日','周一','周二','周三','周四','周五','周六'][today.getDay()];
        const lastTD = this._getLastTradingDate();

        return `[A股短线交易研究 - 第一阶段：板块研判+市场情绪]
今天是 ${dateStr} ${weekday}，前一交易日是 ${lastTD}。请作为我的A股短线交易研究助手，严格执行以下分析任务。

【强制要求】必须先用搜索工具获取真实数据，禁止凭记忆回答！

===== 搜索任务清单（按顺序执行，每项搜不到就换关键词重试一次）=====

第1轮搜索（你自己执行）：
1. 搜索「site:finance.eastmoney.com 美股 道琼斯 纳斯达克 收盘 ${lastTD}」→ 搜不到换「美股三大指数收盘 ${lastTD} 涨跌」
2. 搜索「site:finance.eastmoney.com A股 大盘 涨跌 成交额 ${lastTD}」→ 搜不到换「东方财富 A股行情 涨停跌停 ${lastTD}」
3. 搜索「同花顺 热点板块 涨幅排名 ${lastTD}」→ 搜不到换「A股板块涨幅 龙头 连板 ${lastTD}」
4. 搜索「东方财富 北向资金 净买入 ${lastTD}」→ 搜不到换「北向资金 沪深港通 净流入 ${lastTD}」

第2轮搜索（补充缺失项，你自己执行或委派Agent）：
5. 搜索「美国十年期国债收益率 美元指数 ${lastTD}」→ 搜不到换「US 10Y Treasury yield DXY ${lastTD}」
6. 搜索「富时中国A50期指 夜盘 ${lastTD}」→ 搜不到换「FTSE A50 futures ${lastTD}」
7. 搜索「恒生指数 恒生科技指数 收盘 ${lastTD}」→ 搜不到换「港股 恒指 恒科 ${lastTD}」
8. 搜索「国际原油价格 黄金 伦铜 ${lastTD}」→ 搜不到换「WTI crude gold copper price ${lastTD}」
9. 搜索「A股 连板 最高板 炸板率 涨停溢价 ${lastTD}」→ 搜不到换「连板股 晋级 断板 ${lastTD} 复盘」
10. 搜索「两融余额 融资净买入 最新」→ 搜不到换「融资余额 变化 A股 本周」

多Agent协作（可选，能加速）：
- 委派Nova执行第5~8项搜索（外围数据）
- 委派Hornet执行第9~10项搜索（A股微观数据）
- 委派爱弥斯搜索「重大政策 突发事件 地缘 最新 ${dateStr}」

===== 汇总后按以下框架输出 =====

一、隔夜及外围市场
1. 美股三大指数（道指、标普500、纳斯达克）涨跌幅+收盘点位+驱动因素
2. 美债10Y收益率、美元指数DXY变化及对A股资金面影响
3. 富时A50期指夜盘涨跌
4. 港股恒指/恒科指收盘情况
5. 原油、黄金、铜 重要异动
6. 突发地缘/政策事件

二、A股市场情绪诊断
1. 前一交易日：上证/深成指/创业板涨跌幅+收盘点位+成交额（与前日对比）+涨跌家数+涨停跌停家数
2. 情绪周期阶段（冰点→修复→升温→高潮→分歧→退潮）及判断依据
3. 连板高度（最高板几板？谁？）、连板梯队健康度
4. 涨停板次日溢价率趋势
5. 北向资金近3日净流向+重点买入方向
6. 融资余额变化

三、热点板块研判（3-5个板块）
每个板块：驱动逻辑 | 炒作阶段 | 龙头+结构 | 今日建议

四、今日策略总结
1. 进攻/防守？仓位建议
2. 重点关注1-2个板块
3. 回避方向
4. 核心风险点

要求：数据必须标注来源（搜索结果），搜不到的明确标注[未获取]，不要编造。`;
    }

    /**
     * 构建第二阶段 prompt：个股精选
     */
    _buildAStockPhase2Prompt() {
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const lastTD = this._getLastTradingDate();

        return `[A股短线交易研究 - 第二阶段：个股精选]
今天是 ${dateStr}。基于上面第一阶段的板块研判和策略结论，精选5只最值得关注的短线个股。

【强制要求】必须先搜索获取候选股数据，禁止凭记忆编造！

===== 搜索步骤 =====
1. 搜索「site:finance.eastmoney.com 涨停股 ${lastTD} 板块」→ 搜不到换「涨停复盘 龙头股 ${lastTD}」
2. 根据第一阶段确定的重点板块，搜索「板块名称 龙头股 ${lastTD} 涨幅」
3. 对候选个股逐只搜索「股票名称 技术分析 均线 成交量」或「股票代码 东方财富」获取技术面
4. 委派Hornet搜索候选股技术面数据，委派Nova搜索候选股最新利好利空消息

===== 选股标准 =====
- 市值优先50亿-500亿
- 处于上升趋势或突破关键位
- 板块正宗标的，有辨识度
- 近期放量，不选缩量滞涨
- 优先低吸/首板/二板机会，回避连续大涨透支的
- 回避ST/次新(<60天)/被监管关注的

===== 每只股票输出 =====
1. 股票名称+代码
2. 所属板块/题材
3. 推荐逻辑（2-3句）
4. 关键技术位：支撑位+压力位（具体价格）
5. 建议买入时机：竞价观察/开盘低吸/回踩确认/放量突破追入
6. 止损位（具体价格或条件）
7. 预期持有：1天/2-3天/视盘面
8. 最大风险

===== 最后 =====
5只股票优先级排序（最看好排第一），一句话总结策略思路。
数据必须来自搜索结果，搜不到标注[未获取]，不编造。`;
    }

    // ===== 自动水群系统 =====

    /**
     * 判断是否在活跃时段内
     */
    _isActiveHour() {
        const hour = new Date().getHours();
        if (this.autoChatActiveHoursEnd > this.autoChatActiveHoursStart) {
            // 同日：如 8~23
            return hour >= this.autoChatActiveHoursStart && hour < this.autoChatActiveHoursEnd;
        } else {
            // 跨日：如 8~次日1 → 8~24 || 0~1
            return hour >= this.autoChatActiveHoursStart || hour < this.autoChatActiveHoursEnd;
        }
    }

    /**
     * 检查该群今日水群次数
     */
    _checkDailyLimit(groupId) {
        const today = new Date().toDateString();
        const rec = this._autoChatDailyCount.get(groupId);
        if (!rec || rec.date !== today) {
            this._autoChatDailyCount.set(groupId, { date: today, count: 0 });
            return true;
        }
        return rec.count < this.autoChatMaxDaily;
    }

    _incrementDailyCount(groupId) {
        const today = new Date().toDateString();
        const rec = this._autoChatDailyCount.get(groupId) || { date: today, count: 0 };
        if (rec.date !== today) {
            rec.date = today;
            rec.count = 0;
        }
        rec.count++;
        this._autoChatDailyCount.set(groupId, rec);
    }

    /**
     * 检测话题热度——最近几条消息是否在讨论同一个话题 / 有趣的内容
     */
    _detectTopicHeat(groupId, newText) {
        if (!this._autoChatTopicBuffer.has(groupId)) {
            this._autoChatTopicBuffer.set(groupId, []);
        }
        const buffer = this._autoChatTopicBuffer.get(groupId);
        buffer.push(newText);
        // 只保留最近8条
        while (buffer.length > 8) buffer.shift();

        if (buffer.length < 3) return { hot: false, score: 0 };

        // 热度信号检测
        let score = 0;
        const recent = buffer.slice(-5);
        const allText = recent.join(' ');

        // 1. 多人快速发言（buffer 积累快说明活跃）
        if (recent.length >= 4) score += 0.15;

        // 2. 话题关键词重叠——有人在讨论同一件事
        const words = new Set();
        let overlap = 0;
        for (const msg of recent) {
            const segs = msg.replace(/[，。！？、\s]+/g, ' ').split(' ').filter(w => w.length >= 2);
            for (const w of segs) {
                if (words.has(w)) overlap++;
                words.add(w);
            }
        }
        if (overlap >= 3) score += 0.2;
        if (overlap >= 6) score += 0.15;

        // 3. 情绪类关键词——有趣/搞笑/争论/求助
        const emotionPatterns = [
            /哈哈|笑死|绝了|离谱|草|6{2,}|牛|卧槽|我[靠草去]|nb|666|hhh|hh|xswl|awsl/i,
            /\?{2,}|！{2,}|真的假的|不会吧|什么鬼|啊这/,
            /怎么办|求助|有没有人|谁知道|急|在线等|救/,
            /有人|来个|有无|求推荐|推荐一下|安利/,
        ];
        for (const pat of emotionPatterns) {
            if (pat.test(allText)) score += 0.1;
        }

        // 4. 提到了 bot 相关的话题（但没有@）
        const botTopics = /ai|机器人|bot|chatgpt|gpt|claude|人工智能|大模型|智能/i;
        if (botTopics.test(allText)) score += 0.2;

        // 5. 最新这条消息本身是个问句或感叹——更适合插嘴
        if (/[？?]/.test(newText)) score += 0.1;
        if (/[！!]{2,}/.test(newText)) score += 0.05;

        return { hot: score >= 0.3, score };
    }

    /**
     * 核心：评估是否自动水群
     */
    _evaluateAutoChat(chatId, userId, text, nickname, messageId) {
        if (!this.autoChat) return;

        const groupId = chatId;

        // 白名单检查
        const allowedList = this.autoChatGroups.length > 0 ? this.autoChatGroups : this.allowedGroups;
        if (allowedList.length > 0 && !allowedList.includes(groupId)) return;

        // 时段检查
        if (!this._isActiveHour()) return;

        // 每日上限
        if (!this._checkDailyLimit(groupId)) return;

        // 正在处理中
        if (this._autoChatPending.has(groupId)) return;

        // 冷却检查（动态冷却：随机在 min~max 之间）
        const now = Date.now();
        const lastTime = this._autoChatLastTime.get(groupId) || 0;
        const cooldownMs = (this.autoChatCooldownMin + Math.random() * (this.autoChatCooldownMax - this.autoChatCooldownMin)) * 1000;
        if (now - lastTime < cooldownMs) {
            // 在冷却中，只累计消息
            this._autoChatMsgCount.set(groupId, (this._autoChatMsgCount.get(groupId) || 0) + 1);
            this._detectTopicHeat(groupId, text); // 持续追踪话题
            return;
        }

        // 消息计数累积
        const msgCount = (this._autoChatMsgCount.get(groupId) || 0) + 1;
        this._autoChatMsgCount.set(groupId, msgCount);

        // 消息数不够，不触发
        if (msgCount < this.autoChatMsgThreshold) {
            this._detectTopicHeat(groupId, text);
            return;
        }

        // 话题热度分析
        const { hot, score } = this._detectTopicHeat(groupId, text);

        // 计算最终触发概率
        let prob = this.autoChatBaseProb;

        // 话题热 → 提升概率
        if (hot) prob = Math.max(prob, this.autoChatBurstProb);

        // 消息积累越多概率越高（每多5条 +5%）
        prob += Math.floor(msgCount / 5) * 0.05;

        // 深夜时段（23-1点）概率减半
        const hour = new Date().getHours();
        if (hour >= 23 || hour < 1) prob *= 0.5;

        // 概率上限 60%
        prob = Math.min(prob, 0.6);

        // 掷骰子
        const roll = Math.random();
        if (roll > prob) return;

        console.log(`[QQBot][水群] 触发! group=${groupId} prob=${(prob*100).toFixed(1)}% roll=${(roll*100).toFixed(1)}% heat=${score.toFixed(2)} msgCount=${msgCount}`);

        // 标记状态
        this._autoChatPending.add(groupId);
        this._autoChatLastTime.set(groupId, now);
        this._autoChatMsgCount.set(groupId, 0);
        this._incrementDailyCount(groupId);

        // 模拟真人：延迟一段时间再发（1.5~8秒，短消息快回复，话题热也快）
        const baseDelay = hot ? 1500 : 3000;
        const randomDelay = Math.random() * 5000;
        const typingDelay = baseDelay + randomDelay;

        setTimeout(() => {
            this._doAutoChat(groupId, text, nickname, messageId);
        }, typingDelay);
    }

    /**
     * 执行自动水群：先 AI 研判上下文是否适合插嘴，再走 VCP 完整思维链生成回复
     */
    async _doAutoChat(groupId, triggerText, triggerNickname, triggerMsgId) {
        try {
            const topicBuffer = this._autoChatTopicBuffer.get(groupId) || [];
            const history = this.recentMessages.get(groupId) || [];

            // ===== 第一步：AI 研判——当前上下文是否适合插嘴 =====
            const recentContext = topicBuffer.slice(-8).join('\n');
            const judgeMessages = [];
            if (this.agentPrompt) {
                judgeMessages.push({ role: 'system', content: this.agentPrompt });
            }
            judgeMessages.push({
                role: 'system',
                content: `你是QQ群里的一个群友。现在需要你判断：看到下面这些群聊消息后，你作为群友自然地插嘴说话是否合适？

判断标准：
- 如果大家在激烈讨论/争论某件事，你可以加入
- 如果有人说了搞笑/离谱的事，你可以吐槽
- 如果有人问了一个你恰好知道的问题，可以回答
- 如果话题和你的兴趣/专业相关，可以自然聊几句
- 如果大家在闲聊八卦、分享日常，你可以搭话
- 如果是严肃私密话题（比如有人在诉苦/求安慰/聊隐私），不要插嘴
- 如果群里很冷清就一两条消息，不要强行找话题
- 如果上下文含敏感/政治/争议话题，不要参与

你只需要回答一个JSON，不要说任何其他内容：
{"speak": true/false, "reason": "简短原因"}

如果 speak=true，reason 中简述你打算聊什么方向（不需要写完整回复）。`
            });
            // 给历史上下文
            judgeMessages.push(...history.slice(-6));
            judgeMessages.push({
                role: 'user',
                content: `最近的群聊消息:\n${recentContext}`
            });

            const judgePayload = JSON.stringify({
                model: 'gpt-5.4',
                messages: judgeMessages,
                max_tokens: 100,
                stream: true,
                maid: this.agentName
            });

            const judgeStream = await this._httpPostStream(
                `http://127.0.0.1:${this.apiPort}/v1/chat/completions`,
                judgePayload,
                { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` }
            );

            let judgeReply = '';
            for (const line of judgeStream.split('\n')) {
                if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
                try {
                    const chunk = JSON.parse(line.slice(6));
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) judgeReply += delta;
                } catch (e) { /* skip */ }
            }
            judgeReply = judgeReply.trim();

            // 解析研判结果
            let shouldSpeak = false;
            let judgeReason = '';
            try {
                // 容忍 AI 输出前后有额外文字，提取 JSON 部分
                const jsonMatch = judgeReply.match(/\{[\s\S]*?\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    shouldSpeak = parsed.speak === true;
                    judgeReason = parsed.reason || '';
                }
            } catch (e) {
                // JSON 解析失败，用关键词兜底
                shouldSpeak = /true|可以|适合|聊/.test(judgeReply) && !/false|不适合|不要/.test(judgeReply);
            }

            if (!shouldSpeak) {
                console.log(`[QQBot][水群] 研判不适合插嘴: ${judgeReason || judgeReply.substring(0, 60)}`);
                return;
            }

            console.log(`[QQBot][水群] 研判通过: ${judgeReason}`);

            // ===== 第二步：走 VCP 完整思维链，以群友身份生成回复 =====
            // 构造一个水群上下文指令作为 user message，走 _callVCPChat 的完整管线
            const autoChatPrompt = `[群聊上下文 - 水群模式] 你是群友之一，刚看到这些消息觉得想说点什么。研判方向: ${judgeReason}。直接说你想说的话就行，不需要加任何前缀、不需要引用消息。简短自然像真人。\n\n最近的消息:\n${recentContext}`;

            // 把水群指令先加入 history 作为上下文（临时，不污染）
            await this._callVCPChat(
                groupId,
                this.selfIds[0] || '0',   // userId 用 bot 自己（不触发权限检查）
                autoChatPrompt,
                triggerMsgId,
                this.agentName,            // nickname 用 agent 名
                false,                     // isPrivate
                [],                        // imageUrls
                [],                        // files
                { isAutoChat: true }       // 水群标记
            );
        } catch (e) {
            console.error(`[QQBot][水群] Error: ${e.message}`);
        } finally {
            this._autoChatPending.delete(groupId);
        }
    }

    // ===== 每日简报推送系统 =====

    /**
     * 启动每日简报调度器：每分钟检查一次是否到推送时间
     */
    _startDailyBriefingScheduler() {
        if (this.broadcastOnlyGroups.length === 0) {
            console.log('[QQBot][简报] 无广播目标群，跳过调度器启动');
            return;
        }
        console.log(`[QQBot][简报] 调度器启动：每天 ${this.dailyBriefingHour}:${String(this.dailyBriefingMinute).padStart(2,'0')} 推送到 [${this.broadcastOnlyGroups.join(',')}]`);

        this._dailyBriefingTimer = setInterval(() => {
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();
            const todayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;

            // 到达推送时间窗口（容忍 5 分钟内触发），且今天还没推过
            const hitWindow = hour === this.dailyBriefingHour && minute >= this.dailyBriefingMinute && minute < this.dailyBriefingMinute + 5;
            if (hitWindow && this._dailyBriefingLastDate !== todayKey) {
                this._dailyBriefingLastDate = todayKey;
                console.log(`[QQBot][简报] ⏰ 触发每日简报推送`);
                for (const groupId of this.broadcastOnlyGroups) {
                    this._runDailyBriefing(groupId).catch(e => console.error(`[QQBot][简报] ${groupId} 失败: ${e.message}`));
                }
            }
        }, 60 * 1000);

        if (this._dailyBriefingTimer.unref) this._dailyBriefingTimer.unref();
    }

    /**
     * 手动触发一次每日简报（测试用 / 管理员指令）
     */
    async _triggerDailyBriefingNow() {
        for (const groupId of this.broadcastOnlyGroups) {
            await this._runDailyBriefing(groupId);
        }
    }

    /**
     * 生成并推送每日简报
     */
    async _runDailyBriefing(groupId) {
        console.log(`[QQBot][简报] 开始生成 group=${groupId}`);
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const weekday = ['周日','周一','周二','周三','周四','周五','周六'][today.getDay()];

        // 进度提示
        this._sendGroupMsg(groupId, `📰 正在生成 ${dateStr} ${weekday} 的每日简报（AI动态 + GitHub优质项目），请稍候...`);

        // 第一部分：AI 模型发布新闻
        const aiPrompt = this._buildAINewsPrompt(dateStr);
        const adminUid = this.adminUsers[0] || this.selfIds[0] || '0';
        const aiResult = await this._callVCPChat(
            groupId, adminUid, aiPrompt,
            0, '系统', false, [], [],
            { isAStockAnalysis: true }  // 复用这个标记：启用大 max_tokens + 返回文本不直接发送
        );

        if (!aiResult) {
            this._sendGroupMsg(groupId, '❌ AI新闻部分生成失败，流程中断');
            return;
        }
        console.log(`[QQBot][简报] AI 新闻完成 (${aiResult.length}字)`);
        this._sendGroupMsg(groupId, `✅ AI动态已整理，继续生成 GitHub 项目推荐...`);
        await new Promise(r => setTimeout(r, 2000));

        // 第二部分：GitHub 优秀项目
        const ghPrompt = this._buildGithubTrendingPrompt(dateStr);
        const ghResult = await this._callVCPChat(
            groupId, adminUid, ghPrompt,
            0, '系统', false, [], [],
            { isAStockAnalysis: true }
        );

        console.log(`[QQBot][简报] GitHub 部分完成 (${(ghResult||'').length}字)`);

        // 清理 MSG_BREAK
        const aiClean = (aiResult || '[AI新闻生成失败]').replace(/\[MSG_BREAK\]/g, '\n').trim();
        const ghClean = (ghResult || '[GitHub推荐生成失败]').replace(/\[MSG_BREAK\]/g, '\n').trim();

        // 用合并转发卡片推送（像 A股研报一样）
        const botId = this.selfIds[0] || '10000';
        const botName = '计软每日简报';
        const dateDisplay = today.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

        const splitText = (text, maxLen = 4000) => {
            const parts = [];
            for (let i = 0; i < text.length; i += maxLen) {
                parts.push(text.substring(i, i + maxLen));
            }
            return parts.length > 0 ? parts : ['[空]'];
        };

        const forwardNodes = [];
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName, uin: botId,
                content: [{ type: 'text', data: { text: `📰 计软学习互助 · 每日简报\n${dateDisplay}\n${weekday}` } }]
            }
        });
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName, uin: botId,
                content: [{ type: 'text', data: { text: '═══ 🤖 今日 AI 模型 & 行业动态 ═══' } }]
            }
        });
        for (const part of splitText(aiClean)) {
            forwardNodes.push({
                type: 'node',
                data: { name: botName, uin: botId, content: [{ type: 'text', data: { text: part } }] }
            });
        }
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName, uin: botId,
                content: [{ type: 'text', data: { text: '═══ ⭐ 今日 GitHub 优质项目 ═══' } }]
            }
        });
        for (const part of splitText(ghClean)) {
            forwardNodes.push({
                type: 'node',
                data: { name: botName, uin: botId, content: [{ type: 'text', data: { text: part } }] }
            });
        }
        forwardNodes.push({
            type: 'node',
            data: {
                name: botName, uin: botId,
                content: [{ type: 'text', data: { text: '💡 数据来自公开信息源，仅供学习参考。\n有任何项目或新闻想要跟进，评论区留言~' } }]
            }
        });

        try {
            this._sendRawMsg('send_group_forward_msg', {
                group_id: parseInt(groupId),
                messages: forwardNodes
            });
            console.log(`[QQBot][简报] ✅ 合并转发已发送 (${forwardNodes.length} 节点)`);
        } catch (e) {
            console.error(`[QQBot][简报] 合并转发失败: ${e.message}，降级为文本`);
            const allText = `📰 每日简报 ${dateDisplay}\n\n【AI 动态】\n${aiClean}\n\n【GitHub 项目】\n${ghClean}`;
            for (const chunk of splitText(allText)) {
                this._sendRawMsg('send_group_msg', {
                    group_id: parseInt(groupId),
                    message: [{ type: 'text', data: { text: chunk } }]
                });
                await new Promise(r => setTimeout(r, 800));
            }
        }
    }

    /**
     * 构建 AI 新闻搜索 prompt
     */
    _buildAINewsPrompt(dateStr) {
        return `[每日简报任务 - 第一部分：AI 模型与行业动态 | ${dateStr}]

⚠️⚠️⚠️ 执行流程（严格按步骤，不要跳步）⚠️⚠️⚠️

**第 1 步：立即发出下面这个 TOOL_REQUEST，不要做任何其他事**

<<<[TOOL_REQUEST]>>>
tool_name:「始」FreeWebSearch「末」,
query:「始」2026 AI 大模型 最新发布「末」,
engines:「始」brave,wikipedia「末」,
max_results:「始」8「末」,
language:「始」zh-CN「末」
<<<[END_TOOL_REQUEST]>>>

**第 2 步：收到第一次搜索结果后，立即发第二个 TOOL_REQUEST（换 query）**

<<<[TOOL_REQUEST]>>>
tool_name:「始」FreeWebSearch「末」,
query:「始」OpenAI Anthropic Google 新模型 2026「末」,
engines:「始」brave,wikipedia「末」,
max_results:「始」8「末」,
language:「始」zh-CN「末」
<<<[END_TOOL_REQUEST]>>>

**第 3 步：收到第二次搜索结果后，立即发第三个 TOOL_REQUEST**

<<<[TOOL_REQUEST]>>>
tool_name:「始」FreeWebSearch「末」,
query:「始」开源大模型 llama qwen deepseek 2026「末」,
engines:「始」brave,wikipedia「末」,
max_results:「始」8「末」,
language:「始」zh-CN「末」
<<<[END_TOOL_REQUEST]>>>

**第 4 步：三次搜索全部完成后，综合所有搜索结果写最终报告**

绝对禁止的行为：
- 禁止在调用工具之前输出任何文字
- 禁止跳过任何一次搜索
- 禁止使用 TavilySearch / GoogleSearch / SerpSearch / FileOperator（这些都不可用，只允许 FreeWebSearch）
- 禁止委派其他 Agent（不要调用 AgentAssistant）
- 禁止任何角色扮演开场白
- 禁止说"搜不到"就放弃——Wikipedia 引擎在 FreeWebSearch 里是始终可用的

===== 最终报告格式（步骤 4 之后输出）=====

【今日 AI 动态】${dateStr}

1. 标题
要点：2-3 句说清楚
来源：真实 URL（必须来自搜索结果）

2. 标题
要点：...
来源：...

（继续到 5-8 条）

报告要求：
- 800-1500 字
- 纯文本无 markdown
- 优先开源模型、技术突破、学生/开发者视角
- 跳过融资/人事/八卦
- 所有 URL 必须来自上面三次搜索的真实结果，禁止编造
- 报告结尾不要加任何评论或寒暄，到最后一条动态结束即可`;
    }

    /**
     * 构建 GitHub 优秀项目搜索 prompt
     */
    _buildGithubTrendingPrompt(dateStr) {
        return `[每日简报任务 - 第二部分：GitHub 优质项目 | ${dateStr}]

⚠️⚠️⚠️ 执行流程（严格按步骤）⚠️⚠️⚠️

**第 1 步：立即发出下面这个 TOOL_REQUEST**

<<<[TOOL_REQUEST]>>>
tool_name:「始」FreeWebSearch「末」,
query:「始」github trending repository 2026「末」,
engines:「始」brave,wikipedia「末」,
max_results:「始」8「末」,
language:「始」zh-CN「末」
<<<[END_TOOL_REQUEST]>>>

**第 2 步：收到第一次结果后，立即发第二个**

<<<[TOOL_REQUEST]>>>
tool_name:「始」FreeWebSearch「末」,
query:「始」github 热门 开源项目 2026「末」,
engines:「始」brave,wikipedia「末」,
max_results:「始」8「末」,
language:「始」zh-CN「末」
<<<[END_TOOL_REQUEST]>>>

**第 3 步：收到第二次结果后，立即发第三个**

<<<[TOOL_REQUEST]>>>
tool_name:「始」FreeWebSearch「末」,
query:「始」open source AI developer tools github 2026「末」,
engines:「始」brave,wikipedia「末」,
max_results:「始」8「末」,
language:「始」zh-CN「末」
<<<[END_TOOL_REQUEST]>>>

**第 4 步：三次搜索都完成后，写最终报告**

绝对禁止：
- 禁止在调用工具前输出任何文字
- 禁止跳过任何一次搜索
- 禁止 TavilySearch / GoogleSearch / SerpSearch / FileOperator（只允许 FreeWebSearch）
- 禁止委派其他 Agent
- 禁止任何角色扮演开场白
- 禁止说"搜不到"就放弃

===== 最终报告格式 =====

【今日 GitHub 优质项目】${dateStr}

1. 项目名：owner/repo
亮点：2-3 句说清楚做什么、为什么值得学
技术栈：主要语言
适合：初学者/进阶/特定领域
链接：https://github.com/owner/repo

2. 项目名：...
...

（5-7 个项目）

报告要求：
- 600-1200 字
- 纯文本无 markdown、无寒暄、无结语
- 优先：对学生有学习价值、解决真实问题、最近活跃
- 跳过：面试题清单、awesome 列表、VSCode/React 等烂大街的、商业推广
- 所有 URL 必须来自搜索结果
- 报告到最后一个项目结束即可`;
    }

    stop() {
        console.log('[QQBot] Stopping...');
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this._dailyBriefingTimer) clearInterval(this._dailyBriefingTimer);
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }
    }
}

module.exports = QQBot;
