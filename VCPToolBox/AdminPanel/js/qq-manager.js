// AdminPanel/js/qq-manager.js
import { apiFetch, showMessage, escapeHTML } from './utils.js';
import { parseEnvToList } from './config.js';

/**
 * QQ Bot 管理模块
 * 管理 NapCat (OneBot11) WebSocket 桥接配置
 */

// QQ 配置字段定义
const QQ_CONFIG_FIELDS = [
    {
        key: 'QQ_WS_URL',
        label: 'WebSocket 地址',
        description: 'NapCat OneBot11 WebSocket 服务地址',
        type: 'string',
        default: 'ws://127.0.0.1:3001',
        placeholder: 'ws://127.0.0.1:3001'
    },
    {
        key: 'QQ_ACCESS_TOKEN',
        label: '访问令牌',
        description: 'WebSocket 连接鉴权令牌（可留空）',
        type: 'password',
        default: '',
        placeholder: '留空表示无鉴权'
    },
    {
        key: 'QQ_BOT_SELF_IDS',
        label: '机器人 QQ 号',
        description: '机器人自身的 QQ 号，多个用英文逗号分隔',
        type: 'string',
        default: '',
        placeholder: '例: 123456789,987654321'
    },
    {
        key: 'QQ_AGENT_NAME',
        label: '角色名称',
        description: '对接 VCPToolBox Chat API 时使用的角色（maid）名称',
        type: 'string',
        default: 'Grantley',
        placeholder: 'Grantley'
    },
    {
        key: 'QQ_ALLOWED_GROUPS',
        label: '允许的群号',
        description: '允许响应的 QQ 群号，多个用英文逗号分隔。留空表示响应所有群',
        type: 'string',
        default: '',
        placeholder: '例: 111222333,444555666（留空=全部）'
    },
    {
        key: 'QQ_ADMIN_USERS',
        label: '管理员 QQ 号',
        description: '管理员用户不受速率限制和消息长度限制，多个用英文逗号分隔',
        type: 'string',
        default: '',
        placeholder: '例: 123456789'
    },
    {
        key: 'QQ_KEYWORD_TRIGGERS',
        label: '关键词触发',
        description: '触发机器人回复的关键词，多个用英文逗号分隔。被 @ 时始终触发',
        type: 'string',
        default: '',
        placeholder: '例: 你好,帮我,问一下'
    },
    {
        key: 'QQ_COOLDOWN_SECONDS',
        label: '群冷却时间（秒）',
        description: '同一群组内两次回复的最短间隔秒数',
        type: 'integer',
        default: '6',
        placeholder: '6'
    },
    {
        key: 'QQ_RATE_LIMIT_PER_MINUTE',
        label: '每分钟速率限制',
        description: '单个用户每分钟最大请求次数（管理员不受限）',
        type: 'integer',
        default: '10',
        placeholder: '10'
    },
    {
        key: 'QQ_MAX_MESSAGE_LENGTH',
        label: '最大消息长度',
        description: '允许处理的最大消息字符数（管理员不受限）',
        type: 'integer',
        default: '800',
        placeholder: '800'
    },
    {
        key: 'QQ_RECENT_MSG_LIMIT',
        label: '上下文消息数量',
        description: '每个群保留的最近消息条数，用于构建对话上下文',
        type: 'integer',
        default: '40',
        placeholder: '40'
    }
];

// RAG 记忆系统依赖的 Embedding 配置
const EMBEDDING_CONFIG_FIELDS = [
    {
        key: 'EMBEDDING_API_URL',
        label: 'Embedding API 地址',
        description: '向量嵌入模型的 API 地址（留空则使用主 API 地址）',
        type: 'string',
        default: '',
        placeholder: 'https://api.example.com'
    },
    {
        key: 'EMBEDDING_API_KEY',
        label: 'Embedding API 密钥',
        description: '向量嵌入模型的 API 密钥（留空则使用主 API 密钥）',
        type: 'password',
        default: '',
        placeholder: '留空=使用主 API_Key'
    },
    {
        key: 'WhitelistEmbeddingModel',
        label: 'Embedding 模型名称',
        description: 'RAG 记忆检索使用的嵌入模型，如 gemini-embedding-2-preview、text-embedding-3-small',
        type: 'string',
        default: '',
        placeholder: 'gemini-embedding-2-preview'
    },
    {
        key: 'WhitelistEmbeddingModelMaxToken',
        label: 'Embedding 最大 Token',
        description: '单次嵌入请求的最大 Token 数',
        type: 'integer',
        default: '8000',
        placeholder: '8000'
    },
    {
        key: 'VECTORDB_DIMENSION',
        label: '向量维度',
        description: '必须与 Embedding 模型输出维度一致（gemini-embedding-2: 3072, text-embedding-3-small: 1536）',
        type: 'integer',
        default: '3072',
        placeholder: '3072'
    }
];

// 所有管理的配置键集合
const QQ_CONFIG_KEYS = new Set([...QQ_CONFIG_FIELDS, ...EMBEDDING_CONFIG_FIELDS].map(f => f.key));

// 模块状态
let fullConfigContent = '';
let parsedEntries = [];
let statusPollTimer = null;

/**
 * 初始化 QQ 管理模块
 */
export async function initializeQQManager() {
    const container = document.getElementById('qq-manager-content');
    if (!container) return;

    container.innerHTML = buildManagerHTML();
    setupEventListeners();
    await loadConfig();
    pollStatus();
}

/**
 * 构建管理界面 HTML
 */
function buildManagerHTML() {
    return `
        <div class="qq-manager">
            <div class="qq-status-bar">
                <div class="qq-status-indicator">
                    <span class="status-dot status-unknown"></span>
                    <span class="status-label" id="qq-status-text">检查中...</span>
                </div>
                <div class="qq-status-actions">
                    <button class="btn btn-secondary btn-sm" id="qq-refresh-status-btn" title="刷新状态">
                        <span class="material-symbols-outlined" style="font-size: 18px;">refresh</span>
                    </button>
                    <button class="btn btn-primary btn-sm" id="qq-restart-btn">
                        <span class="material-symbols-outlined" style="font-size: 18px;">restart_alt</span>
                        重启 QQ Bot
                    </button>
                </div>
            </div>

            <form id="qq-config-form" class="qq-config-form">
                <div class="qq-config-section">
                    <h3 class="section-title">
                        <span class="material-symbols-outlined">settings</span>
                        连接设置
                    </h3>
                    <div id="qq-connection-fields" class="config-fields"></div>
                </div>

                <div class="qq-config-section">
                    <h3 class="section-title">
                        <span class="material-symbols-outlined">group</span>
                        群组与权限
                    </h3>
                    <div id="qq-group-fields" class="config-fields"></div>
                </div>

                <div class="qq-config-section">
                    <h3 class="section-title">
                        <span class="material-symbols-outlined">tune</span>
                        行为参数
                    </h3>
                    <div id="qq-behavior-fields" class="config-fields"></div>
                </div>

                <div class="qq-config-section">
                    <h3 class="section-title">
                        <span class="material-symbols-outlined">psychology</span>
                        RAG 记忆系统 (Embedding)
                    </h3>
                    <p style="font-size:0.85em;color:var(--secondary-text);margin:0 0 12px;">RAG 记忆检索依赖向量嵌入模型。配置独立的 Embedding API 以启用 Agent 记忆和自我改进系统。</p>
                    <div id="qq-embedding-fields" class="config-fields"></div>
                </div>

                <div class="qq-form-actions">
                    <button type="submit" class="btn btn-primary" id="qq-save-btn">
                        <span class="material-symbols-outlined" style="font-size: 18px;">save</span>
                        保存配置
                    </button>
                    <button type="button" class="btn btn-secondary" id="qq-reset-btn">
                        <span class="material-symbols-outlined" style="font-size: 18px;">undo</span>
                        还原更改
                    </button>
                </div>
            </form>
        </div>

        <style>
            .qq-manager {
                display: flex;
                flex-direction: column;
                gap: 20px;
            }

            .qq-status-bar {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 14px 20px;
                background: var(--secondary-bg);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                backdrop-filter: blur(12px);
            }

            .qq-status-indicator {
                display: flex;
                align-items: center;
                gap: 10px;
                font-size: 0.95em;
                color: var(--primary-text);
                font-weight: 500;
            }

            .status-dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                display: inline-block;
                flex-shrink: 0;
                transition: background-color 0.3s ease, box-shadow 0.3s ease;
            }

            .status-dot.status-connected {
                background-color: #34d399;
                box-shadow: 0 0 8px rgba(52, 211, 153, 0.6);
                animation: pulse-green 2s infinite;
            }

            .status-dot.status-disconnected {
                background-color: #f87171;
                box-shadow: 0 0 8px rgba(248, 113, 113, 0.6);
            }

            .status-dot.status-connecting {
                background-color: #fbbf24;
                box-shadow: 0 0 8px rgba(251, 191, 36, 0.6);
                animation: pulse-yellow 1.5s infinite;
            }

            .status-dot.status-unknown {
                background-color: #9ca3af;
                box-shadow: 0 0 4px rgba(156, 163, 175, 0.4);
            }

            @keyframes pulse-green {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.6; }
            }

            @keyframes pulse-yellow {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.7; transform: scale(1.15); }
            }

            .qq-status-actions {
                display: flex;
                gap: 8px;
                align-items: center;
            }

            .qq-config-section {
                background: var(--secondary-bg);
                border: 1px solid var(--border-color);
                border-radius: 12px;
                padding: 20px;
                backdrop-filter: blur(12px);
            }

            .qq-config-section .section-title {
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 0 0 16px 0;
                font-size: 1em;
                font-weight: 600;
                color: var(--highlight-text);
                padding-bottom: 12px;
                border-bottom: 1px solid var(--border-color);
            }

            .qq-config-section .section-title .material-symbols-outlined {
                font-size: 20px;
                opacity: 0.8;
            }

            .config-fields {
                display: flex;
                flex-direction: column;
                gap: 16px;
            }

            .qq-field-group {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .qq-field-group label {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 0.9em;
                font-weight: 500;
                color: var(--primary-text);
            }

            .qq-field-group label .field-key {
                font-family: monospace;
                font-size: 0.8em;
                color: var(--secondary-text);
                opacity: 0.7;
            }

            .qq-field-group .field-desc {
                font-size: 0.8em;
                color: var(--secondary-text);
                margin-bottom: 4px;
                line-height: 1.4;
            }

            .qq-field-group input,
            .qq-field-group select {
                padding: 8px 12px;
                background: var(--input-bg);
                border: 1px solid var(--border-color);
                border-radius: 8px;
                color: var(--primary-text);
                font-size: 0.9em;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
                width: 100%;
                box-sizing: border-box;
            }

            .qq-field-group input:focus {
                outline: none;
                border-color: var(--highlight-text);
                box-shadow: 0 0 0 2px rgba(var(--highlight-rgb, 99, 102, 241), 0.15);
            }

            .qq-field-group input::placeholder {
                color: var(--secondary-text);
                opacity: 0.5;
            }

            .qq-field-group .input-with-toggle {
                display: flex;
                gap: 0;
                position: relative;
            }

            .qq-field-group .input-with-toggle input {
                border-top-right-radius: 0;
                border-bottom-right-radius: 0;
                flex: 1;
            }

            .qq-field-group .input-with-toggle .toggle-visibility-btn {
                padding: 8px 12px;
                background: var(--tertiary-bg);
                border: 1px solid var(--border-color);
                border-left: none;
                border-radius: 0 8px 8px 0;
                color: var(--secondary-text);
                font-size: 0.8em;
                cursor: pointer;
                white-space: nowrap;
                transition: background 0.2s ease, color 0.2s ease;
            }

            .qq-field-group .input-with-toggle .toggle-visibility-btn:hover {
                background: var(--button-bg);
                color: var(--primary-text);
            }

            .qq-form-actions {
                display: flex;
                gap: 10px;
                justify-content: flex-end;
                padding-top: 8px;
            }

            .btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 10px 20px;
                border-radius: 8px;
                font-size: 0.9em;
                font-weight: 500;
                border: 1px solid transparent;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .btn-sm {
                padding: 6px 12px;
                font-size: 0.85em;
            }

            .btn-primary {
                background: var(--button-bg);
                color: var(--primary-text);
                border-color: var(--border-color);
            }

            .btn-primary:hover {
                filter: brightness(1.15);
                transform: translateY(-1px);
            }

            .btn-secondary {
                background: var(--tertiary-bg);
                color: var(--secondary-text);
                border-color: var(--border-color);
            }

            .btn-secondary:hover {
                color: var(--primary-text);
                background: var(--secondary-bg);
            }

            .btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
                filter: none;
            }

            /* 响应式 */
            @media (max-width: 640px) {
                .qq-status-bar {
                    flex-direction: column;
                    gap: 12px;
                    align-items: flex-start;
                }

                .qq-status-actions {
                    width: 100%;
                    justify-content: flex-end;
                }

                .qq-form-actions {
                    flex-direction: column;
                }

                .qq-form-actions .btn {
                    width: 100%;
                    justify-content: center;
                }
            }
        </style>
    `;
}

/**
 * 设置事件监听器
 */
function setupEventListeners() {
    const form = document.getElementById('qq-config-form');
    const restartBtn = document.getElementById('qq-restart-btn');
    const resetBtn = document.getElementById('qq-reset-btn');
    const refreshBtn = document.getElementById('qq-refresh-status-btn');

    if (form && !form.dataset.listener) {
        form.addEventListener('submit', handleSave);
        form.dataset.listener = 'true';
    }

    if (restartBtn && !restartBtn.dataset.listener) {
        restartBtn.addEventListener('click', handleRestart);
        restartBtn.dataset.listener = 'true';
    }

    if (resetBtn && !resetBtn.dataset.listener) {
        resetBtn.addEventListener('click', () => {
            renderConfigFields();
            showMessage('已还原为上次保存的配置', 'info');
        });
        resetBtn.dataset.listener = 'true';
    }

    if (refreshBtn && !refreshBtn.dataset.listener) {
        refreshBtn.addEventListener('click', pollStatus);
        refreshBtn.dataset.listener = 'true';
    }
}

/**
 * 加载主配置文件
 */
async function loadConfig() {
    try {
        const data = await apiFetch('/admin_api/config/main', {}, false);
        fullConfigContent = data.content || '';
        parsedEntries = parseEnvToList(fullConfigContent);
        renderConfigFields();
    } catch (error) {
        console.error('加载 QQ 配置失败:', error);
        showMessage('加载 QQ 配置失败', 'error');
    }
}

/**
 * 从已解析的条目中提取指定键的值
 */
function getConfigValue(key) {
    const entry = parsedEntries.find(e => !e.isCommentOrEmpty && e.key === key);
    return entry ? entry.value : null;
}

/**
 * 渲染配置表单字段
 */
function renderConfigFields() {
    // 按分区分组字段
    const connectionKeys = ['QQ_WS_URL', 'QQ_ACCESS_TOKEN', 'QQ_BOT_SELF_IDS', 'QQ_AGENT_NAME'];
    const groupKeys = ['QQ_ALLOWED_GROUPS', 'QQ_ADMIN_USERS'];
    const behaviorKeys = ['QQ_KEYWORD_TRIGGERS', 'QQ_COOLDOWN_SECONDS', 'QQ_RATE_LIMIT_PER_MINUTE', 'QQ_MAX_MESSAGE_LENGTH', 'QQ_RECENT_MSG_LIMIT'];

    const embeddingKeys = EMBEDDING_CONFIG_FIELDS.map(f => f.key);

    renderFieldGroup('qq-connection-fields', connectionKeys);
    renderFieldGroup('qq-group-fields', groupKeys);
    renderFieldGroup('qq-behavior-fields', behaviorKeys);
    renderFieldGroup('qq-embedding-fields', embeddingKeys);
}

/**
 * 渲染一组字段
 */
function renderFieldGroup(containerId, keys) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    keys.forEach(key => {
        const fieldDef = QQ_CONFIG_FIELDS.find(f => f.key === key) || EMBEDDING_CONFIG_FIELDS.find(f => f.key === key);
        if (!fieldDef) return;

        const currentValue = getConfigValue(key);
        const displayValue = currentValue !== null ? currentValue : fieldDef.default;

        const group = document.createElement('div');
        group.className = 'qq-field-group';

        // Label
        const label = document.createElement('label');
        label.setAttribute('for', `qq-field-${key}`);
        label.innerHTML = `${escapeHTML(fieldDef.label)} <span class="field-key">${escapeHTML(key)}</span>`;
        group.appendChild(label);

        // Description
        if (fieldDef.description) {
            const desc = document.createElement('div');
            desc.className = 'field-desc';
            desc.textContent = fieldDef.description;
            group.appendChild(desc);
        }

        // Input
        if (fieldDef.type === 'password') {
            const wrapper = document.createElement('div');
            wrapper.className = 'input-with-toggle';

            const input = document.createElement('input');
            input.type = 'password';
            input.id = `qq-field-${key}`;
            input.name = key;
            input.value = displayValue;
            input.placeholder = fieldDef.placeholder || '';
            input.dataset.configKey = key;

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'toggle-visibility-btn';
            toggleBtn.textContent = '显示';
            toggleBtn.addEventListener('click', () => {
                if (input.type === 'password') {
                    input.type = 'text';
                    toggleBtn.textContent = '隐藏';
                } else {
                    input.type = 'password';
                    toggleBtn.textContent = '显示';
                }
            });

            wrapper.appendChild(input);
            wrapper.appendChild(toggleBtn);
            group.appendChild(wrapper);
        } else {
            const input = document.createElement('input');
            input.type = fieldDef.type === 'integer' ? 'number' : 'text';
            input.id = `qq-field-${key}`;
            input.name = key;
            input.value = displayValue;
            input.placeholder = fieldDef.placeholder || '';
            input.dataset.configKey = key;
            if (fieldDef.type === 'integer') {
                input.step = '1';
                input.min = '0';
            }
            group.appendChild(input);
        }

        container.appendChild(group);
    });
}

/**
 * 处理保存配置
 */
async function handleSave(e) {
    e.preventDefault();

    const saveBtn = document.getElementById('qq-save-btn');
    if (saveBtn) saveBtn.disabled = true;

    try {
        // 收集表单中所有 QQ 配置值（含 Embedding 配置）
        const formValues = {};
        [...QQ_CONFIG_FIELDS, ...EMBEDDING_CONFIG_FIELDS].forEach(field => {
            const input = document.querySelector(`[data-config-key="${field.key}"]`);
            if (input) {
                formValues[field.key] = input.value;
            }
        });

        // 重建完整配置：遍历原始条目，更新 QQ 相关的值
        const newLines = [];
        const writtenKeys = new Set();

        parsedEntries.forEach(entry => {
            if (entry.isCommentOrEmpty) {
                newLines.push(entry.value);
            } else if (QQ_CONFIG_KEYS.has(entry.key)) {
                // QQ 配置项 - 使用表单值
                const newValue = formValues[entry.key] !== undefined ? formValues[entry.key] : entry.value;
                if (entry.isMultilineQuoted || newValue.includes('\n')) {
                    newLines.push(`${entry.key}='${newValue}'`);
                } else {
                    newLines.push(`${entry.key}=${newValue}`);
                }
                writtenKeys.add(entry.key);
            } else {
                // 非 QQ 配置项 - 原样保留
                if (entry.isMultilineQuoted) {
                    newLines.push(`${entry.key}='${entry.value}'`);
                } else {
                    newLines.push(`${entry.key}=${entry.value}`);
                }
            }
        });

        // 追加配置文件中不存在但表单中有值的新键（含 Embedding 配置）
        [...QQ_CONFIG_FIELDS, ...EMBEDDING_CONFIG_FIELDS].forEach(field => {
            if (!writtenKeys.has(field.key) && formValues[field.key] !== undefined && formValues[field.key] !== '') {
                newLines.push(`${field.key}=${formValues[field.key]}`);
            }
        });

        const newContent = newLines.join('\n');

        await apiFetch('/admin_api/config/main', {
            method: 'POST',
            body: JSON.stringify({ content: newContent })
        });

        showMessage('QQ Bot 配置已保存', 'success');

        // 重新加载以同步状态
        fullConfigContent = newContent;
        parsedEntries = parseEnvToList(fullConfigContent);
    } catch (error) {
        console.error('保存 QQ 配置失败:', error);
        showMessage('保存配置失败: ' + error.message, 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

/**
 * 处理重启 QQ Bot
 */
async function handleRestart() {
    const restartBtn = document.getElementById('qq-restart-btn');
    if (restartBtn) restartBtn.disabled = true;

    updateStatusUI('connecting', '正在重启...');

    try {
        await apiFetch('/admin_api/qq/restart', { method: 'POST' });
        showMessage('QQ Bot 重启指令已发送', 'success');
        // 延迟后检查状态
        setTimeout(() => pollStatus(), 3000);
    } catch (error) {
        console.error('重启 QQ Bot 失败:', error);
        showMessage('重启失败: ' + error.message, 'error');
        updateStatusUI('disconnected', '重启失败');
    } finally {
        if (restartBtn) restartBtn.disabled = false;
    }
}

/**
 * 查询并更新 QQ Bot 状态
 */
async function pollStatus() {
    try {
        const data = await apiFetch('/admin_api/qq/status', {}, false);
        if (data && typeof data === 'object') {
            const status = data.status || 'unknown';
            const statusMap = {
                'connected': { css: 'connected', text: '已连接' },
                'running': { css: 'connected', text: '运行中' },
                'disconnected': { css: 'disconnected', text: '未连接' },
                'stopped': { css: 'disconnected', text: '已停止' },
                'connecting': { css: 'connecting', text: '连接中...' },
                'error': { css: 'disconnected', text: '连接错误' }
            };
            const info = statusMap[status] || { css: 'unknown', text: status };
            const extra = data.uptime ? ` (运行 ${formatUptime(data.uptime)})` : '';
            updateStatusUI(info.css, info.text + extra);
        } else {
            updateStatusUI('unknown', '状态未知');
        }
    } catch (error) {
        // 状态接口不可用时静默处理
        updateStatusUI('disconnected', '无法获取状态');
    }
}

/**
 * 更新状态指示器 UI
 */
function updateStatusUI(statusClass, text) {
    const dot = document.querySelector('.qq-status-indicator .status-dot');
    const label = document.getElementById('qq-status-text');

    if (dot) {
        dot.className = `status-dot status-${statusClass}`;
    }
    if (label) {
        label.textContent = text;
    }
}

/**
 * 格式化运行时间
 */
function formatUptime(seconds) {
    if (!seconds || seconds < 0) return '未知';
    if (seconds < 60) return `${Math.floor(seconds)}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}小时${mins > 0 ? mins + '分钟' : ''}`;
}

/**
 * 清理模块（页面切换时调用）
 */
export function cleanupQQManager() {
    if (statusPollTimer) {
        clearInterval(statusPollTimer);
        statusPollTimer = null;
    }
}
