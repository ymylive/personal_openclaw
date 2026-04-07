// AdminPanel/js/help-docs.js

/**
 * VCP ToolBox AdminPanel - 帮助文档系统
 * 与 index.html 中的 #help-panel 配合使用
 */

const HELP_CONTENT = {
    'basic-settings': {
        title: '基础设置',
        icon: 'settings',
        sections: [
            {
                heading: '全局基础配置 (config.env)',
                body: `<p>这是 VCPToolBox 的核心配置文件，包含所有全局环境变量。修改后部分配置需要重启服务才能生效。</p>`,
                tips: ['修改 API 密钥或端口号后必须重启服务', '布尔值使用 true/false（不区分大小写）', '包含特殊字符或换行的值请用单引号包裹']
            },
            {
                heading: '常用配置项',
                body: `<ul>
                    <li><strong>AI_MODEL / AI_BASE_URL / AI_API_KEY</strong> — 主 AI 模型的名称、API 端点和密钥</li>
                    <li><strong>EMBEDDING_MODEL</strong> — RAG 语义搜索的嵌入模型</li>
                    <li><strong>PORT</strong> — 服务监听端口，默认 6005</li>
                    <li><strong>Key</strong> — API 认证密钥，用于外部调用鉴权</li>
                    <li><strong>ADMIN_PASSWORD</strong> — 管理面板登录密码</li>
                    <li><strong>WEATHER_API_KEY / WEATHER_CITY</strong> — 天气服务配置</li>
                </ul>`
            }
        ]
    },
    'agent-management': {
        title: 'Agent 管理',
        icon: 'smart_toy',
        sections: [
            {
                heading: 'Agent 管理器',
                body: `<p>Agent 是 VCPToolBox 的核心角色系统。每个 Agent 对应一个 .txt 文件，包含角色设定和系统提示词。</p>
                <p>在映射表中定义名称→文件的映射，然后编辑 .txt 文件来定义角色行为。</p>`,
                tips: ['Agent 名称在 Chat API 中通过 maid 参数指定', '支持创建多个 Agent 切换不同角色', '修改 Agent 文件后立即生效，无需重启']
            },
            {
                heading: 'Agent 助手配置',
                body: `<p>AgentAssistant 插件支持独立的模型、性格和系统提示词。</p>
                <ul>
                    <li><strong>历史轮数</strong> — 控制上下文记忆长度，值越大消耗越高</li>
                    <li><strong>上下文保留时间</strong> — 超时自动清理</li>
                    <li><strong>异步委托模式</strong> — Agent 可后台自主执行长任务</li>
                </ul>`
            },
            {
                heading: '积分排行榜',
                body: `<p>完成异步委托任务或系统贡献将获得积分奖励。排行榜实时展示 Agent 贡献度。</p>`
            },
            {
                heading: '梦境审批',
                body: `<p>Agent 在"梦境"模式中可发起日记操作（创建/修改/删除），需管理员审批后执行。</p>`,
                tips: ['黄色标记 = 待审批，绿色 = 已批准', '批准后操作立即执行文件变更']
            }
        ]
    },
    'content-knowledge': {
        title: '内容与知识库',
        icon: 'library_books',
        sections: [
            {
                heading: '日记知识库管理',
                body: `<p>管理 RAG 系统使用的知识库和日记条目。支持多知识库、标签管理和阈值控制。</p>`,
                tips: ['每个知识库可独立设置 RAG 检索阈值', '标签用于精确控制语义检索范围', '支持批量移动和删除']
            },
            {
                heading: 'VCP 论坛',
                body: `<p>内建论坛系统，支持分板块发帖、回复和置顶。Agent 也可以参与论坛交流。</p>`
            },
            {
                heading: '多媒体 Base64 编辑器',
                body: `<p>管理图像和媒体文件的 Base64 缓存，用于在对话中嵌入图像内容。</p>`
            },
            {
                heading: 'VCPTavern 预设编辑',
                body: `<p>编辑 SillyTavern 兼容格式的角色预设文件。支持导入导出标准格式。</p>`
            }
        ]
    },
    'rag-ai': {
        title: 'RAG 与 AI',
        icon: 'psychology',
        sections: [
            {
                heading: '语义组编辑器',
                body: `<p>语义组通过关键词激活，将相关向量注入查询以提高 RAG 检索准确性。</p>
                <ul>
                    <li><strong>关键词</strong> — 用户消息包含关键词时自动激活</li>
                    <li><strong>AI 学习</strong> — 系统可自动学习新的相关词汇</li>
                </ul>`
            },
            {
                heading: '思维链编辑器',
                body: `<p>管理 RAGDiaryPlugin 的元思考链，支持创建主题和拖拽排序思维簇。</p>`,
                tips: ['思维链顺序影响 AI 推理路径', 'K 值控制每个节点的检索数量']
            },
            {
                heading: 'RAG 调参',
                body: `<p>实时调整 TagMemo 算法核心参数，所有更改立即生效。</p>`,
                tips: ['调高阈值可提升精确度但降低召回率', '建议逐步微调并观察效果']
            },
            {
                heading: '占位符查看器',
                body: `<p>查看系统提示词中所有可用占位符及当前值。支持原始文本、Markdown 渲染和 JSON 格式化视图。</p>`
            }
        ]
    },
    'tools-plugins': {
        title: '工具与插件',
        icon: 'construction',
        sections: [
            {
                heading: 'Toolbox 管理器',
                body: `<p>管理 AI 工具箱映射和内容。支持 VCP 折叠语法：</p>
                <ul>
                    <li><code>[===vcp_fold:0.55===]</code> — 累计展开模式</li>
                    <li><code>[===vcp_fold:0.55::desc:描述===]</code> — 精确展开模式</li>
                </ul>`
            },
            {
                heading: '工具列表配置编辑器',
                body: `<p>配置 AI 可调用的工具列表，包括工具名称、参数定义和调用指令。</p>`
            },
            {
                heading: '插件调用审核',
                body: `<p>控制哪些工具调用需人工审核。可设全局审核或指定工具名单。</p>`,
                tips: ['审核超时自动拒绝', '适用于敏感操作如文件操作、系统命令']
            },
            {
                heading: '预处理器顺序管理',
                body: `<p>拖拽调整消息预处理器插件的执行顺序，顺序越靠上优先级越高。</p>`
            }
        ]
    },
    'advanced': {
        title: '高级设置',
        icon: 'data_object',
        sections: [
            {
                heading: '高级变量编辑器',
                body: `<p>直接编辑 .txt 格式的高级变量文件。这些变量可在系统提示词中通过占位符引用。</p>`
            },
            {
                heading: '日程管理',
                body: `<p>创建和管理定时任务日程。支持日历视图和列表视图，日程到期时系统可自动通知 Agent。</p>`
            }
        ]
    },
    'system-ops': {
        title: '系统运维',
        icon: 'monitoring',
        sections: [
            {
                heading: '服务器日志',
                body: `<p>实时查看服务器运行日志。支持关键字过滤、行数限制和倒序显示。</p>`,
                tips: ['使用过滤功能快速定位错误', '高亮匹配关键词方便排查', '日志过大时可用"清空"重置']
            },
            {
                heading: '仪表盘监控',
                body: `<p>仪表盘提供 CPU、内存使用率、PM2 进程状态、天气、热榜等实时信息。数据每 5 秒自动刷新。</p>
                <p><strong>彩蛋：</strong>连续点击 VCP Logo 5次可进入太阳系沉浸模式！</p>`
            }
        ]
    },
    'qq-service': {
        title: 'QQ 服务',
        icon: 'chat',
        sections: [
            {
                heading: 'QQ 机器人配置',
                body: `<p>QQ 机器人通过 NapCat (OneBot11) WebSocket 桥接 QQ 群消息到 VCPToolBox Chat API。</p>
                <ul>
                    <li><strong>WebSocket 地址</strong> — NapCat 的 WS 地址，默认 ws://127.0.0.1:3001</li>
                    <li><strong>群白名单</strong> — 限制机器人只在指定群响应</li>
                    <li><strong>关键词触发</strong> — 非 @机器人 时通过关键词触发回复</li>
                    <li><strong>速率限制</strong> — 防止刷屏滥用</li>
                </ul>`,
                tips: ['首先需安装并启动 NapCat', '确保 OneBot11 正向 WebSocket 已启用', '机器人 QQ 号必须正确以避免响应自身', '留空群白名单将响应所有群（谨慎使用）']
            },
            {
                heading: 'NapCat 安装步骤',
                body: `<ol>
                    <li>下载 NapCat 并按官方文档安装</li>
                    <li>配置 OneBot11 正向 WebSocket 端口（默认 3001）</li>
                    <li>用 QQ 扫码登录</li>
                    <li>在 VCP 中配置 WebSocket 地址和机器人 QQ 号</li>
                    <li>重启 VCP 服务使 QQ 模块生效</li>
                </ol>`
            }
        ]
    }
};

/**
 * 渲染帮助分类内容为 HTML
 */
function renderCategoryHTML(categoryId, data) {
    return `
        <div class="help-category" data-help-id="${categoryId}">
            <div class="help-category-header">
                <span class="material-symbols-outlined">${data.icon}</span>
                <span class="help-category-title">${data.title}</span>
                <span class="material-symbols-outlined" style="font-size: 18px; color: var(--secondary-text); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);">expand_more</span>
            </div>
            <div class="help-category-content">
                ${data.sections.map(sec => `
                    <div class="help-section">
                        <h4>${sec.heading}</h4>
                        ${sec.body}
                        ${sec.tips ? `
                            <div class="help-tip">
                                <strong>提示：</strong>
                                <ul style="margin: 4px 0 0 0; padding-left: 16px;">
                                    ${sec.tips.map(t => `<li>${t}</li>`).join('')}
                                </ul>
                            </div>
                        ` : ''}
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

let initialized = false;

/**
 * 初始化帮助文档系统
 * 使用 index.html 中已定义的 #help-panel 元素
 */
export function initializeHelpSystem() {
    if (initialized) return;
    initialized = true;

    const helpButton = document.getElementById('help-center-button');
    const helpPanel = document.getElementById('help-panel');
    const helpClose = document.getElementById('help-panel-close');
    const helpBackdrop = helpPanel?.querySelector('.help-panel-backdrop');
    const helpBody = document.getElementById('help-panel-body');

    if (!helpPanel || !helpBody) {
        console.warn('[HelpDocs] Help panel elements not found in DOM.');
        return;
    }

    // 渲染所有帮助分类
    helpBody.innerHTML = Object.entries(HELP_CONTENT)
        .map(([id, data]) => renderCategoryHTML(id, data))
        .join('');

    // 分类折叠/展开
    helpBody.querySelectorAll('.help-category-header').forEach(header => {
        header.addEventListener('click', () => {
            const category = header.closest('.help-category');
            const chevron = header.querySelector('.material-symbols-outlined:last-child');
            category.classList.toggle('expanded');
            if (chevron) {
                chevron.style.transform = category.classList.contains('expanded') ? 'rotate(180deg)' : '';
            }
        });
    });

    function openHelp(targetCategoryId) {
        helpPanel.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';

        if (targetCategoryId) {
            const target = helpBody.querySelector(`[data-help-id="${targetCategoryId}"]`);
            if (target && !target.classList.contains('expanded')) {
                target.classList.add('expanded');
                const chevron = target.querySelector('.help-category-header .material-symbols-outlined:last-child');
                if (chevron) chevron.style.transform = 'rotate(180deg)';
                setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
            }
        }
    }

    function closeHelp() {
        helpPanel.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    if (helpButton) helpButton.addEventListener('click', () => openHelp());
    if (helpClose) helpClose.addEventListener('click', closeHelp);
    if (helpBackdrop) helpBackdrop.addEventListener('click', closeHelp);

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && helpPanel.getAttribute('aria-hidden') === 'false') {
            closeHelp();
        }
    });

    // 为侧边栏导航分组添加帮助按钮
    const navGroups = document.querySelectorAll('.nav-group');
    navGroups.forEach(group => {
        const groupId = group.dataset.group;
        if (groupId && HELP_CONTENT[groupId]) {
            const header = group.querySelector('.nav-group-header');
            if (header) {
                const helpBtn = document.createElement('button');
                helpBtn.className = 'nav-group-help-btn';
                helpBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">help_outline</span>';
                helpBtn.title = `${HELP_CONTENT[groupId].title} 帮助`;
                helpBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openHelp(groupId);
                });
                // 插入到 chevron 前面
                const chevron = header.querySelector('.nav-group-chevron');
                if (chevron) {
                    header.insertBefore(helpBtn, chevron);
                } else {
                    header.appendChild(helpBtn);
                }
            }
        }
    });
}

/**
 * 获取帮助内容
 */
export function getHelpContent(categoryId) {
    return HELP_CONTENT[categoryId] || null;
}
