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

        // Agent 人设 (loaded async in start())
        this.agentPrompt = '';
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

    async _loadAgentPrompt() {
        try {
            // 读取 agent_map.json 找到 agent 对应的文件名
            const mapPath = path.join(__dirname, 'agent_map.json');
            const agentMap = JSON.parse(await fsPromises.readFile(mapPath, 'utf-8'));
            const fileName = agentMap[this.agentName];
            if (!fileName) {
                console.warn(`[QQBot] Agent "${this.agentName}" not found in agent_map.json`);
                return '';
            }
            // 读取 Agent 文件
            const agentPath = path.join(__dirname, 'Agent', fileName);
            let content = await fsPromises.readFile(agentPath, 'utf-8');
            // 保留 VCP 模板变量 {{...}}，让 VCP 中间层自动展开
            console.log(`[QQBot] Loaded agent prompt: ${fileName} (${content.length} chars)`);
            return content;
        } catch (e) {
            console.error(`[QQBot] Failed to load agent prompt: ${e.message}`);
            return '';
        }
    }

    async start() {
        this.agentPrompt = await this._loadAgentPrompt();
        this.toolPassword = await this._loadToolPassword();
        console.log(`[QQBot] Starting... WS: ${this.wsUrl}, Agent: ${this.agentName}`);
        console.log(`[QQBot] Allowed groups: ${this.allowedGroups.join(', ') || 'ALL'}`);
        this._connect();
        this._watchDreamLogs();
        this._startCleanupTimer();
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

        // ===== A股分析多Agent任务触发 =====
        const aStockTrigger = cleanText.match(/格兰.{0,4}分析[aA]股|格兰.{0,4}分析(大盘|股市|行情)|跑第一(步|阶段)|第一阶段/);
        const aStockPhase2 = cleanText.match(/跑第二(步|阶段)|第二阶段|选股/);

        if (aStockTrigger && this._isAdminUser(userId)) {
            console.log(`[QQBot][A股] 触发第一阶段分析: ${cleanText}`);
            this._callVCPChat(chatId, userId, this._buildAStockPhase1Prompt(), messageId, nick, isPrivate, [], [], { isAStockAnalysis: true });
            return;
        }

        if (aStockPhase2 && this._isAdminUser(userId)) {
            console.log(`[QQBot][A股] 触发第二阶段选股: ${cleanText}`);
            this._callVCPChat(chatId, userId, this._buildAStockPhase2Prompt(), messageId, nick, isPrivate, [], [], { isAStockAnalysis: true });
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

            // 非 admin 用户发送高危内容时直接拒绝（水群模式跳过）
            if (!isAutoChat && !isAdmin && this._containsDangerousContent(text)) {
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

            // Agent 人设作为 system message，VCP 中间层会自动展开 {{变量}}
            const messages = [];
            if (this.agentPrompt) {
                messages.push({ role: 'system', content: this.agentPrompt });
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
     * 构建第一阶段 prompt：板块研判 + 市场情绪
     * 格兰作为主Agent编排，通过AgentAssistant委派子Agent并行搜索
     */
    _buildAStockPhase1Prompt() {
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const weekday = ['周日','周一','周二','周三','周四','周五','周六'][today.getDay()];

        return `[A股短线交易研究 - 第一阶段：板块研判+市场情绪]
今天是 ${dateStr} ${weekday}。请作为我的A股短线交易研究助手，严格执行以下分析任务。

【强制要求】你必须先使用FreeWebSearch或其他搜索工具获取真实数据后再分析，禁止凭记忆回答！
搜索步骤（按顺序执行）：
1. 搜索「美股收盘 道琼斯 纳斯达克 标普500 ${dateStr}」
2. 搜索「A股行情 涨停 跌停 涨跌家数 ${dateStr}」
3. 搜索「A股热点板块 题材 龙头 连板 ${dateStr}」
4. 搜索「北向资金 今日流向 ${dateStr}」

完成搜索后，你还可以调用AgentAssistant委派其他Agent补充数据。建议分工：
- 委派Nova搜索「富时A50期指 美债收益率 美元指数 黄金原油」
- 委派Hornet搜索「A股连板股 涨停板次日溢价 情绪周期」
- 委派爱弥斯搜索「重大政策 地缘政治 宏观经济 最新」

汇总所有数据后，按以下框架输出分析报告：

===== 分析框架 =====

一、隔夜及外围市场
1. 美股三大指数（道指、标普500、纳斯达克）前一交易日表现及驱动因素
2. 美债收益率、美元指数变化及对A股资金面影响
3. 富时A50期指夜盘表现
4. 港股恒指/恒科指近期走势
5. 大宗商品（原油、铜、黄金）重要异动
6. 突发地缘政治或重大政策事件

二、A股市场情绪诊断
1. 前一交易日概况：上证/深成指/创业板涨跌幅、成交额、涨跌家数比、涨停/跌停家数
2. 当前情绪周期阶段（冰点→修复→升温→高潮→分歧→退潮），给出判断依据
3. 连板高度（最高板几板？谁？）、连板梯队是否健康
4. 涨停板次日溢价率趋势
5. 北向资金近3日流向及重点方向
6. 融资余额变化趋势

三、热点板块研判（3-5个板块）
每个板块分析：驱动逻辑、持续性判断（启动/加速/高潮/分歧/退潮）、板块龙头和结构、今日操作建议

四、今日策略总结
1. 进攻还是防守？仓位建议
2. 重点关注的1-2个板块及原因
3. 需要回避的方向
4. 核心风险点

要求：基于最新真实数据分析，给出有逻辑支撑的明确判断。无法获取的数据明确说明，不要编造。`;
    }

    /**
     * 构建第二阶段 prompt：个股精选
     */
    _buildAStockPhase2Prompt() {
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

        return `[A股短线交易研究 - 第二阶段：个股精选]
今天是 ${dateStr}。基于刚才第一阶段的分析结论（特别是策略总结和重点板块），精选5只最值得关注的个股。

【强制要求】你必须先使用FreeWebSearch搜索工具获取候选股票的真实数据后再推荐，禁止凭记忆编造！
搜索步骤：
1. 搜索「${dateStr} A股 涨停 龙头股 板块」找到今日/昨日热点个股
2. 对每个候选股搜索「股票名称 技术分析 支撑位 压力位」获取技术面数据
3. 可以委派Hornet搜索个股技术面，委派Nova搜索个股最新消息

选股标准：
- 市值优先50亿-500亿，流动性好弹性足
- 技术面处于上升趋势或突破关键位置
- 题材纯正，是板块正宗标的
- 在板块中有市场辨识度（龙头/人气股优先）
- 近期有明显量能配合，不选缩量滞涨
- 避免已连续大涨严重透支的个股；优先低吸或首板/二板机会
- 回避ST股、上市不满60天的次新股、被监管关注的个股

每只股票输出：
1. 股票名称+代码
2. 所属板块/题材
3. 推荐逻辑（2-3句话）
4. 关键技术位：支撑位、压力位（具体价格）
5. 建议买入时机
6. 止损位
7. 预期持有周期
8. 风险提示

最后给出5只股票的优先级排序，并用一句话说明整体策略思路。
要求：基于真实最新数据，不要编造价格和成交量。无法获取的信息明确说明。`;
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

    stop() {
        console.log('[QQBot] Stopping...');
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }
    }
}

module.exports = QQBot;
