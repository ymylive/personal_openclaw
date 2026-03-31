(function () {
  "use strict";

  var DEFAULT_LANGUAGE = "zh-CN";
  var LANGUAGE_STORAGE_KEY = "openclaw.qqDashboard.language";
  var CONFIG_LIMITS = {
    priorityMin: -10,
    priorityMax: 10,
    intensityMin: 0,
    intensityMax: 100,
    cooldownMin: 0,
    cooldownMax: 86400
  };

  var TRANSLATIONS = {
    "zh-CN": {
      title: "OpenClaw QQ 工作台",
      "hero.eyebrow": "OpenClaw QQ 运行驾驶舱",
      "hero.title": "QQ 模块工作台",
      "hero.refresh": "立即刷新",
      "metrics.connection": "连接状态",
      "metrics.listenerCount": "监听器数量",
      "metrics.allowedGroups": "允许群组",
      "metrics.monitoredGroups": "监控群组",
      "metrics.attachments": "附件能力",
      "metrics.recentError": "最近错误",
      "login.kicker": "扫码登录",
      "login.title": "直接扫码恢复 QQ",
      "login.status": "登录状态",
      "login.decodeLink": "打开解码链接",
      "login.empty": "二维码还没生成，稍后刷新。",
      "login.status.scan-required": "等待扫码",
      "login.status.login-error": "登录异常",
      "login.status.ready": "已在线",
      "login.status.unknown": "状态未知",
      "login.status.not-configured": "未配置",
      "listener.kicker": "监听覆盖",
      "listener.title": "QQ 在线范围",
      "listener.runtime": "运行状态",
      "listener.allowedGroupLabel": "允许群组",
      "listener.monitoredGroupLabel": "监控群组",
      "listener.noState": "尚未发现监听状态文件。",
      "listener.groupLastMessage": "群 {groupId}：最后消息 {messageId}",
      "listener.noAllowedGroups": "尚未配置允许群组。",
      "listener.noMonitoredGroups": "尚未配置监控群组。",
      "listener.groupLabel": "群 {groupId}",
      "activity.kicker": "运行备注",
      "activity.title": "信号与健康度",
      "activity.wsUrl": "WebSocket 地址",
      "activity.token": "令牌",
      "activity.extractor": "提取器",
      "recent.kicker": "近期活动",
      "recent.title": "实时观察",
      "recent.none": "暂无近期 QQ 活动记录。",
      "recent.listenerCheckpoint": "监听检查点",
      "recent.groupLastSeen": "群 {groupId} 最后看到的消息是 {messageId}",
      "attachments.kicker": "附件管线",
      "attachments.title": "媒体与提取",
      "attachments.noModes": "暂无已报告的附件模式。",
      "safeguards.kicker": "防护项",
      "safeguards.title": "配置护栏",
      "safeguards.wsConfig": "WebSocket 配置",
      "safeguards.wsConfigReady": "QQ 的 wsUrl 已配置。",
      "safeguards.wsConfigMissing": "QQ 的 wsUrl 缺失。",
      "safeguards.token": "访问令牌",
      "safeguards.tokenReady": "认证令牌已存在。",
      "safeguards.tokenMissing": "认证令牌缺失。",
      "safeguards.extractor": "附件提取器",
      "safeguards.extractorReady": "提取器路径可用。",
      "safeguards.extractorMissing": "提取器路径缺失。",
      "logs.kicker": "日志",
      "logs.title": "活动轨迹",
      "logs.none": "未登记任何 QQ 日志。",
      "logs.empty": "暂无最近日志行。",
      "logs.allEmpty": "QQ 日志文件存在，但最近没有活动。",
      "logs.available": "可用",
      "logs.missing": "缺失",
      "language.label": "语言",
      "language.switchToEnglish": "English",
      "language.switchToChinese": "中文",
      "mode.bootstrap": "模式：完整载入",
      "mode.heartbeat": "模式：心跳刷新",
      "time.lastUpdated": "最后更新：{value}",
      "status.configured": "已配置",
      "status.missingConfig": "缺少配置",
      "status.ready": "可用",
      "status.notWired": "未接线",
      "status.none": "无",
      "status.active": "运行中",
      "status.idle": "空闲",
      "status.present": "已存在",
      "status.missing": "缺失",
      "health.good": "健康",
      "health.warn": "需关注",
      "health.critical": "严重",
      "summary.ready": "QQ 运行概览已就绪。",
      "summary.awaitHealth": "等待 QQ 健康信号。",
      "summary.statusRefreshed": "QQ 状态已刷新。",
      "summary.attachmentReady": "附件提取已为 QQ 媒体请求完成配置。",
      "summary.attachmentMissing": "附件提取器尚未配置。",
      "summary.attachmentHintsReady": "工作台已准备好展示支持的附件路径。",
      "summary.attachmentHintsMissing": "提取器接入后会显示支持的附件模式。",
      "groups.kicker": "群组控制",
      "groups.title": "监控群策略",
      "groups.add": "新增群组行",
      "groups.noRows": "暂未配置可编辑群组。",
      "groups.loading": "正在读取 QQ 配置…",
      "groups.summary": "可在这里直接编辑群组策略并保存到 /qq/api/config。",
      "groups.columns.id": "群号",
      "groups.columns.enabled": "启用",
      "groups.columns.label": "标签",
      "groups.columns.focus": "焦点",
      "groups.columns.priority": "优先级",
      "groups.columns.reply": "回复",
      "groups.columns.sticker": "贴图",
      "groups.columns.intensity": "贴图强度",
      "groups.columns.cooldown": "冷却秒数",
      "groups.columns.actions": "操作",
      "groups.remove": "删除",
      "stickers.kicker": "贴图包",
      "stickers.title": "本地贴图平衡策略",
      "stickers.root": "贴图根目录",
      "stickers.enabled": "启用贴图发送",
      "stickers.mode": "全局模式",
      "stickers.mode.balanced": "Balanced（平衡）",
      "stickers.mode.textOnly": "仅文本",
      "stickers.mode.stickerFirst": "贴图优先",
      "stickers.defaultIntensity": "默认贴图强度",
      "stickers.defaultCooldown": "默认冷却（秒）",
      "stickers.refresh": "刷新贴图扫描",
      "stickers.summary.empty": "尚未发现情绪目录。",
      "stickers.summary.ready": "已发现 {emotionCount} 个情绪目录，共 {totalImages} 张图片。",
      "stickers.problem.none": "未发现贴图扫描问题。",
      "config.save": "保存配置",
      "config.reload": "重新读取",
      "config.loading": "正在读取配置 API…",
      "config.loaded": "配置已加载，可编辑后保存。",
      "config.saved": "配置已保存。",
      "config.saveFailed": "配置保存失败，请检查字段。",
      "config.loadFailed": "读取 /qq/api/config 失败。",
      "config.validation": "验证失败：\n{details}",
      "stickers.loadFailed": "读取 /qq/api/stickers 失败。",
      "fatal.loadFailed": "QQ 工作台加载运行数据失败。",
      "fatal.retryHint": "请求失败，请检查 QQ dashboard 服务后重试。",
      "server.summary.configuredNoState": "QQ 已配置，但尚未观察到监听状态。",
      "server.summary.notConfigured": "QQ 尚未配置，请先补充 wsUrl 和令牌。",
      "server.summary.errorDetected": "QQ 工作台检测到最近运行中有错误。",
      "server.summary.running": "QQ 监听器已在 {count} 个跟踪群位上激活。",
      "api.Images and screenshots": "图片与截图",
      "api.Office documents and text files": "Office 文档与文本文件",
      "api.CQ image URL extraction": "CQ 图片地址提取",
      "api.Graceful empty-state handling": "空态平滑处理"
    },
    en: {
      title: "OpenClaw QQ Dashboard",
      "hero.eyebrow": "OpenClaw QQ operations cockpit",
      "hero.title": "QQ Module Dashboard",
      "hero.refresh": "Refresh now",
      "metrics.connection": "Connection",
      "metrics.listenerCount": "Listener count",
      "metrics.allowedGroups": "Allowed groups",
      "metrics.monitoredGroups": "Monitored groups",
      "metrics.attachments": "Attachments",
      "metrics.recentError": "Recent error",
      "login.kicker": "QQ login",
      "login.title": "Scan to reconnect",
      "login.status": "Login status",
      "login.decodeLink": "Open decode link",
      "login.empty": "QR code not available yet. Refresh in a moment.",
      "login.status.scan-required": "Scan required",
      "login.status.login-error": "Login error",
      "login.status.ready": "Ready",
      "login.status.unknown": "Unknown",
      "login.status.not-configured": "Not configured",
      "listener.kicker": "Listener coverage",
      "listener.title": "Where QQ is online",
      "listener.runtime": "Runtime",
      "listener.allowedGroupLabel": "Allowed groups",
      "listener.monitoredGroupLabel": "Monitored groups",
      "listener.noState": "No listener state files found yet.",
      "listener.groupLastMessage": "Group {groupId}: last message {messageId}",
      "listener.noAllowedGroups": "No allowed groups configured yet.",
      "listener.noMonitoredGroups": "No monitored groups configured yet.",
      "listener.groupLabel": "Group {groupId}",
      "activity.kicker": "Runtime notes",
      "activity.title": "Signals & health",
      "activity.wsUrl": "WebSocket URL",
      "activity.token": "Token",
      "activity.extractor": "Extractor",
      "recent.kicker": "Recent activity",
      "recent.title": "Live observations",
      "recent.none": "No recent QQ activity recorded yet.",
      "recent.listenerCheckpoint": "Listener checkpoint",
      "recent.groupLastSeen": "Group {groupId} last seen message {messageId}",
      "attachments.kicker": "Attachment pipeline",
      "attachments.title": "Media & extracts",
      "attachments.noModes": "No attachment modes reported.",
      "safeguards.kicker": "Safeguards",
      "safeguards.title": "Configuration guardrails",
      "safeguards.wsConfig": "WebSocket config",
      "safeguards.wsConfigReady": "wsUrl is configured for QQ.",
      "safeguards.wsConfigMissing": "wsUrl is missing.",
      "safeguards.token": "Access token",
      "safeguards.tokenReady": "Token present for authenticated QQ calls.",
      "safeguards.tokenMissing": "Token missing.",
      "safeguards.extractor": "Attachment extractor",
      "safeguards.extractorReady": "Extractor path is available.",
      "safeguards.extractorMissing": "Extractor path is missing.",
      "logs.kicker": "Logs",
      "logs.title": "Activity trail",
      "logs.none": "No QQ logs are registered.",
      "logs.empty": "No recent log lines.",
      "logs.allEmpty": "QQ log files exist, but no recent activity was captured.",
      "logs.available": "available",
      "logs.missing": "missing",
      "language.label": "Language",
      "language.switchToEnglish": "English",
      "language.switchToChinese": "中文",
      "mode.bootstrap": "Mode: bootstrap",
      "mode.heartbeat": "Mode: heartbeat",
      "time.lastUpdated": "Last updated: {value}",
      "status.configured": "Configured",
      "status.missingConfig": "Missing config",
      "status.ready": "Ready",
      "status.notWired": "Not wired",
      "status.none": "None",
      "status.active": "Active",
      "status.idle": "Idle",
      "status.present": "Present",
      "status.missing": "Missing",
      "health.good": "Healthy",
      "health.warn": "Needs attention",
      "health.critical": "Critical",
      "summary.ready": "QQ runtime overview is ready.",
      "summary.awaitHealth": "Awaiting QQ health telemetry.",
      "summary.statusRefreshed": "QQ status refreshed.",
      "summary.attachmentReady": "Attachment extraction is configured for QQ media requests.",
      "summary.attachmentMissing": "Attachment extractor is not configured yet.",
      "summary.attachmentHintsReady": "The dashboard is ready to surface supported attachment paths.",
      "summary.attachmentHintsMissing": "Supported attachment modes will appear after the extractor is wired.",
      "groups.kicker": "Group control",
      "groups.title": "Monitored group policy",
      "groups.add": "Add group row",
      "groups.noRows": "No editable group rows yet.",
      "groups.loading": "Loading QQ config…",
      "groups.summary": "Edit group policy rows here and save them to /qq/api/config.",
      "groups.columns.id": "Group ID",
      "groups.columns.enabled": "Enabled",
      "groups.columns.label": "Label",
      "groups.columns.focus": "Focus",
      "groups.columns.priority": "Priority",
      "groups.columns.reply": "Reply",
      "groups.columns.sticker": "Sticker",
      "groups.columns.intensity": "Intensity",
      "groups.columns.cooldown": "Cooldown",
      "groups.columns.actions": "Actions",
      "groups.remove": "Remove",
      "stickers.kicker": "Sticker packs",
      "stickers.title": "Balanced local sticker policy",
      "stickers.root": "Sticker root directory",
      "stickers.enabled": "Enable sticker sending",
      "stickers.mode": "Global mode",
      "stickers.mode.balanced": "Balanced",
      "stickers.mode.textOnly": "Text only",
      "stickers.mode.stickerFirst": "Sticker first",
      "stickers.defaultIntensity": "Default sticker intensity",
      "stickers.defaultCooldown": "Default cooldown (seconds)",
      "stickers.refresh": "Refresh sticker scan",
      "stickers.summary.empty": "No emotion directories discovered yet.",
      "stickers.summary.ready": "Discovered {emotionCount} emotion directories with {totalImages} images.",
      "stickers.problem.none": "No sticker scan problems detected.",
      "config.save": "Save config",
      "config.reload": "Reload config",
      "config.loading": "Loading configuration API…",
      "config.loaded": "Configuration loaded. You can edit and save.",
      "config.saved": "Configuration saved.",
      "config.saveFailed": "Configuration save failed. Review field values.",
      "config.loadFailed": "Failed to load /qq/api/config.",
      "config.validation": "Validation failed:\n{details}",
      "stickers.loadFailed": "Failed to load /qq/api/stickers.",
      "fatal.loadFailed": "QQ dashboard failed to load runtime data.",
      "fatal.retryHint": "Request failed. Check the QQ dashboard server and retry.",
      "server.summary.configuredNoState": "QQ is configured, but no listener state has been observed yet.",
      "server.summary.notConfigured": "QQ channel is not configured yet. Add wsUrl and token to bring the module online.",
      "server.summary.errorDetected": "QQ dashboard detected an error in recent runtime activity.",
      "server.summary.running": "QQ listeners are active across {count} tracked group slots.",
      "api.Images and screenshots": "Images and screenshots",
      "api.Office documents and text files": "Office documents and text files",
      "api.CQ image URL extraction": "CQ image URL extraction",
      "api.Graceful empty-state handling": "Graceful empty-state handling"
    }
  };

  function q(selector) {
    return document.querySelector(selector);
  }

  var body = document.body;
  var config = {
    bootstrapUrl: body.dataset.bootstrapUrl || "/qq/api/bootstrap",
    statusUrl: body.dataset.statusUrl || "/qq/api/status",
    configUrl: "/qq/api/config",
    stickersUrl: "/qq/api/stickers"
  };

  var elements = {
    pageShell: q(".page-shell"),
    refreshButton: q("[data-refresh]"),
    languageLabel: q("[data-language-label]"),
    languageToggle: q("[data-language-toggle]"),
    currentMode: q("[data-current-mode]"),
    generatedAt: q("[data-generated-at]"),
    heroSummary: q("[data-hero-summary]"),
    healthLevel: q("[data-health-level]"),
    connectionStatus: q("[data-connection-status]"),
    loginPanel: q("[data-login-panel]"),
    loginSummary: q("[data-login-summary]"),
    loginStatus: q("[data-login-status]"),
    loginQr: q("[data-login-qr]"),
    loginLink: q("[data-login-link]"),
    loginEmpty: q("[data-login-empty]"),
    listenerCount: q("[data-listener-count]"),
    groupCount: q("[data-group-count]"),
    monitoredCount: q("[data-monitored-count]"),
    attachmentStatus: q("[data-attachment-status]"),
    lastError: q("[data-last-error]"),
    listenerRunning: q("[data-listener-running]"),
    groups: q("[data-groups]"),
    monitoredGroups: q("[data-monitored-groups]"),
    lastMessageIds: q("[data-last-message-ids]"),
    healthSummary: q("[data-health-summary]"),
    wsUrl: q("[data-ws-url]"),
    hasToken: q("[data-has-token]"),
    extractorStatus: q("[data-extractor-status]"),
    attachmentHints: q("[data-attachment-hints]"),
    attachmentConfig: q("[data-attachment-config]"),
    supportedHints: q("[data-supported-hints]"),
    recentActivity: q("[data-recent-activity]"),
    safeguards: q("[data-safeguards]"),
    logs: q("[data-logs]"),
    groupEditorSummary: q("[data-group-editor-summary]"),
    groupRows: q("[data-group-rows]"),
    groupAddButton: q("[data-group-add]"),
    stickerRootInput: q("[data-sticker-root]"),
    stickerEnabledInput: q("[data-sticker-enabled]"),
    stickerModeInput: q("[data-sticker-mode]"),
    stickerDefaultIntensityInput: q("[data-sticker-default-intensity]"),
    stickerDefaultCooldownInput: q("[data-sticker-default-cooldown]"),
    stickerRefreshButton: q("[data-sticker-refresh]"),
    stickerSummary: q("[data-sticker-summary]"),
    stickerPacks: q("[data-sticker-packs]"),
    stickerProblems: q("[data-sticker-problems]"),
    configStatus: q("[data-config-status]"),
    configSaveButton: q("[data-config-save]"),
    configResetButton: q("[data-config-reset]")
  };

  var appState = {
    language: resolveInitialLanguage(),
    bootstrapPayload: null,
    statusPayload: null,
    configPayload: null,
    stickersPayload: null,
    groupsDraft: [],
    stickersDraft: defaultStickerDraft(),
    configDirty: false
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    applyLanguage();
    if (elements.refreshButton) elements.refreshButton.addEventListener("click", handleRefresh);
    if (elements.languageToggle) elements.languageToggle.addEventListener("click", handleLanguageToggle);
    if (elements.groupAddButton) elements.groupAddButton.addEventListener("click", handleGroupAdd);
    if (elements.groupRows) {
      elements.groupRows.addEventListener("click", handleGroupRowsClick);
      elements.groupRows.addEventListener("input", handleGroupRowsInput);
      elements.groupRows.addEventListener("change", handleGroupRowsInput);
    }
    if (elements.stickerRefreshButton) elements.stickerRefreshButton.addEventListener("click", handleStickerRefresh);
    if (elements.configSaveButton) elements.configSaveButton.addEventListener("click", handleConfigSave);
    if (elements.configResetButton) elements.configResetButton.addEventListener("click", handleConfigReload);
    bindStickerInputs();
    renderConfigEditors();
    setupIntersectionObserver();
    setupAutoRefreshIndicator();
    loadBootstrap();
  }

  async function loadBootstrap() {
    setBusy(true);
    try {
      var payload = await fetchJson(config.bootstrapUrl);
      appState.bootstrapPayload = payload;
      setMode("bootstrap");
      renderBootstrap(payload);
      applyStaggeredAnimations();
      var statusPayload = await fetchJson(config.statusUrl);
      appState.statusPayload = statusPayload;
      renderStatus(statusPayload);
      await loadConfigAndStickerState({ softFail: true });
    } catch (error) {
      renderFatalState(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setBusy(true);
    try {
      setMode("heartbeat");
      var payload = await fetchJson(config.statusUrl);
      appState.statusPayload = payload;
      renderStatus(payload);
      await loadStickerInventory({ softFail: true });
    } catch (error) {
      renderFatalState(error);
    } finally {
      setBusy(false);
    }
  }

  async function fetchJson(url, requestOptions) {
    var options = requestOptions || {};
    var response = await fetch(url, Object.assign({}, options, {
      headers: Object.assign({ Accept: "application/json" }, options.headers || {})
    }));
    if (!response.ok) {
      var error = new Error("Request failed: " + response.status);
      error.status = response.status;
      try {
        error.payload = await response.json();
      } catch (parseError) {
        error.payload = null;
      }
      throw error;
    }
    return response.json();
  }

  function renderBootstrap(payload) {
    var health = payload.health || {};
    var listener = payload.listener || {};
    var connection = payload.connection || {};
    var attachments = payload.attachments || {};

    text(elements.generatedAt, t("time.lastUpdated", { value: formatDateTime(payload.generatedAt) }));
    text(elements.heroSummary, translateServerSummary(health.summary || t("summary.ready"), payload));
    renderHealthPill(health.level || "warn");
    text(elements.connectionStatus, connection.configured ? t("status.configured") : t("status.missingConfig"));
    text(elements.listenerCount, String(listener.listenerCount || 0));
    text(elements.groupCount, String((listener.groups || []).length));
    text(elements.monitoredCount, String((listener.monitoredGroups || []).length));
    text(elements.attachmentStatus, attachments.extractorConfigured ? t("status.ready") : t("status.notWired"));
    text(elements.lastError, health.lastError || t("status.none"));
    text(elements.listenerRunning, listener.running ? t("status.active") : t("status.idle"));
    text(elements.healthSummary, translateServerSummary(health.summary || t("summary.awaitHealth"), payload));
    text(elements.wsUrl, connection.wsUrl || t("status.missingConfig"));
    text(elements.hasToken, connection.hasToken ? t("status.present") : t("status.missing"));
    text(elements.extractorStatus, attachments.extractorConfigured ? t("status.configured") : t("status.missing"));
    renderLoginPanel(payload.login || {});
    text(elements.attachmentConfig, attachments.extractorConfigured ? t("summary.attachmentReady") : t("summary.attachmentMissing"));
    text(elements.attachmentHints, attachments.extractorConfigured ? t("summary.attachmentHintsReady") : t("summary.attachmentHintsMissing"));

    renderGroupList(elements.groups, listener.groups || [], function (groupId) {
      return t("listener.groupLabel", { groupId: groupId });
    }, t("listener.noAllowedGroups"));
    renderGroupList(elements.monitoredGroups, listener.monitoredGroups || [], function (group) {
      return group.name ? group.name + " (" + group.groupId + ")" : t("listener.groupLabel", { groupId: group.groupId });
    }, t("listener.noMonitoredGroups"));
    renderLastMessageIds(listener.lastMessageIds || {});
    renderAttachmentHints(attachments.supportedHints || []);
    renderRecentActivity(payload);
    renderSafeguards(payload);
    renderLogs(payload.logs || []);
  }

  function renderStatus(payload) {
    if (!payload || !payload.health) return;
    renderHealthPill(payload.health.level || "warn");
    text(elements.heroSummary, translateServerSummary(payload.health.summary || t("summary.statusRefreshed"), payload));
    if (payload.generatedAt) {
      text(elements.generatedAt, t("time.lastUpdated", { value: formatDateTime(payload.generatedAt) }));
    }
    text(elements.lastError, payload.lastError || t("status.none"));
    text(elements.connectionStatus, payload.connection && payload.connection.configured ? t("status.configured") : t("status.missingConfig"));
    text(elements.listenerCount, String(payload.listenerCount || 0));
    text(elements.groupCount, String(payload.groups ? payload.groups.allowedCount : 0));
    text(elements.monitoredCount, String(payload.groups ? payload.groups.monitoredCount : 0));
    text(elements.attachmentStatus, payload.attachments && payload.attachments.extractorConfigured ? t("status.ready") : t("status.notWired"));
    renderLoginPanel(payload.login || {});
    if (payload.listener && payload.listener.lastMessageIds) {
      renderLastMessageIds(payload.listener.lastMessageIds);
    }
  }

  function defaultStickerDraft() {
    return {
      enabled: false,
      rootPath: "",
      mode: "balanced",
      defaultIntensity: 50,
      defaultCooldown: 0
    };
  }

  function cloneGroupRecord(group) {
    return {
      groupId: group.groupId || "",
      name: group.name || "",
      focus: group.focus || "",
      enabled: Boolean(group.enabled),
      priority: group.priority == null ? 0 : group.priority,
      replyEnabled: group.replyEnabled == null ? Boolean(group.enabled) : Boolean(group.replyEnabled),
      stickerEnabled: group.stickerEnabled == null ? true : Boolean(group.stickerEnabled),
      stickerIntensity: group.stickerIntensity == null ? 50 : group.stickerIntensity,
      cooldownSeconds: group.cooldownSeconds == null ? 0 : group.cooldownSeconds
    };
  }

  function normalizeStickerDraft(stickers) {
    return {
      enabled: Boolean(stickers && stickers.enabled),
      rootPath: String(stickers && stickers.rootPath || "").trim(),
      mode: normalizeStickerMode(stickers && stickers.mode),
      defaultIntensity: clampNumber(stickers && stickers.defaultIntensity, CONFIG_LIMITS.intensityMin, CONFIG_LIMITS.intensityMax, 50),
      defaultCooldown: clampNumber(stickers && (stickers.defaultCooldown != null ? stickers.defaultCooldown : stickers.defaultCooldownSeconds), CONFIG_LIMITS.cooldownMin, CONFIG_LIMITS.cooldownMax, 0)
    };
  }

  async function loadConfigAndStickerState(options) {
    var opts = options || {};
    try {
      await loadEditableConfig();
      await loadStickerInventory({ softFail: opts.softFail });
    } catch (error) {
      if (!opts.softFail) throw error;
      setConfigStatus("error", t("config.loadFailed"));
    }
  }

  async function loadEditableConfig() {
    setConfigStatus("neutral", t("config.loading"));
    var payload = await fetchJson(config.configUrl);
    appState.configPayload = payload;
    appState.groupsDraft = (payload.groups || []).map(cloneGroupRecord);
    appState.stickersDraft = normalizeStickerDraft(payload.stickers || {});
    appState.configDirty = false;
    renderConfigEditors();
    setConfigStatus("success", t("config.loaded"));
  }

  async function loadStickerInventory(options) {
    var opts = options || {};
    try {
      var payload = await fetchJson(config.stickersUrl);
      appState.stickersPayload = payload;
      renderStickerInventory(payload);
    } catch (error) {
      appState.stickersPayload = null;
      renderStickerInventory(null);
      if (!opts.softFail) {
        setStickerProblems(t("stickers.loadFailed"), true);
        throw error;
      }
    }
  }

  function renderConfigEditors() {
    renderGroupEditorRows(appState.groupsDraft);
    renderStickerDraft(appState.stickersDraft || defaultStickerDraft());
  }

  function renderGroupEditorRows(groups) {
    if (!elements.groupRows) return;
    elements.groupRows.innerHTML = "";
    text(elements.groupEditorSummary, groups.length ? t("groups.summary") : t("groups.noRows"));
    if (!groups.length) {
      elements.groupRows.appendChild(buildEmptyState(t("groups.noRows")));
      return;
    }
    groups.forEach(function (group, index) {
      elements.groupRows.appendChild(buildGroupRow(group, index));
    });
  }

  function buildGroupRow(group, index) {
    var row = document.createElement("div");
    row.className = "group-editor-row";
    row.dataset.groupIndex = String(index);
    row.innerHTML = [
      '<input class="text-input" type="number" min="1" step="1" data-field="groupId" value="' + escapeHtml(group.groupId) + '">',
      '<label class="toggle-field"><input type="checkbox" data-field="enabled"' + (group.enabled ? " checked" : "") + '><span></span></label>',
      '<input class="text-input" type="text" data-field="name" value="' + escapeHtml(group.name) + '">',
      '<input class="text-input" type="text" data-field="focus" value="' + escapeHtml(group.focus) + '">',
      '<input class="text-input" type="number" min="' + CONFIG_LIMITS.priorityMin + '" max="' + CONFIG_LIMITS.priorityMax + '" step="1" data-field="priority" value="' + escapeHtml(group.priority) + '">',
      '<label class="toggle-field"><input type="checkbox" data-field="replyEnabled"' + (group.replyEnabled ? " checked" : "") + '><span></span></label>',
      '<label class="toggle-field"><input type="checkbox" data-field="stickerEnabled"' + (group.stickerEnabled ? " checked" : "") + '><span></span></label>',
      '<input class="text-input" type="number" min="' + CONFIG_LIMITS.intensityMin + '" max="' + CONFIG_LIMITS.intensityMax + '" step="1" data-field="stickerIntensity" value="' + escapeHtml(group.stickerIntensity) + '">',
      '<input class="text-input" type="number" min="' + CONFIG_LIMITS.cooldownMin + '" max="' + CONFIG_LIMITS.cooldownMax + '" step="1" data-field="cooldownSeconds" value="' + escapeHtml(group.cooldownSeconds) + '">',
      '<button class="group-remove-btn" type="button" data-remove-group="' + escapeHtml(index) + '">' + escapeHtml(t("groups.remove")) + "</button>"
    ].join("");
    return row;
  }

  function renderStickerDraft(stickers) {
    if (elements.stickerRootInput) elements.stickerRootInput.value = stickers.rootPath || "";
    if (elements.stickerEnabledInput) elements.stickerEnabledInput.checked = Boolean(stickers.enabled);
    if (elements.stickerModeInput) elements.stickerModeInput.value = stickers.mode || "balanced";
    if (elements.stickerDefaultIntensityInput) elements.stickerDefaultIntensityInput.value = String(stickers.defaultIntensity);
    if (elements.stickerDefaultCooldownInput) elements.stickerDefaultCooldownInput.value = String(stickers.defaultCooldown);
  }

  function renderStickerInventory(payload) {
    if (!elements.stickerPacks || !elements.stickerSummary) return;
    elements.stickerPacks.innerHTML = "";
    if (!payload || !payload.emotions || !payload.emotions.length) {
      elements.stickerPacks.appendChild(buildEmptyState(t("stickers.summary.empty")));
      text(elements.stickerSummary, t("stickers.summary.empty"));
      setStickerProblems(payload && payload.problems ? payload.problems.join("\n") : t("stickers.problem.none"), Boolean(payload && payload.problems && payload.problems.length));
      return;
    }
    text(elements.stickerSummary, t("stickers.summary.ready", {
      emotionCount: payload.emotionCount || payload.emotions.length,
      totalImages: payload.totalImages || 0
    }));
    payload.emotions.forEach(function (item) {
      var node = document.createElement("article");
      node.className = "sticker-pack-item";
      node.innerHTML =
        '<span class="sticker-pack-item__emotion">' + escapeHtml(item.emotion) + "</span>" +
        '<span class="sticker-pack-item__count">' + escapeHtml(String(item.imageCount || 0)) + "</span>";
      elements.stickerPacks.appendChild(node);
    });
    setStickerProblems(payload.problems && payload.problems.length ? payload.problems.join("\n") : t("stickers.problem.none"), Boolean(payload.problems && payload.problems.length));
  }

  function bindStickerInputs() {
    [
      elements.stickerRootInput,
      elements.stickerEnabledInput,
      elements.stickerModeInput,
      elements.stickerDefaultIntensityInput,
      elements.stickerDefaultCooldownInput
    ].forEach(function (node) {
      if (!node) return;
      node.addEventListener("input", handleStickerInput);
      node.addEventListener("change", handleStickerInput);
    });
  }

  function handleStickerInput() {
    appState.stickersDraft = collectStickerDraft();
    markConfigDirty();
  }

  function handleGroupAdd() {
    appState.groupsDraft.push(cloneGroupRecord({
      groupId: "",
      name: "",
      focus: "",
      enabled: true,
      priority: 0,
      replyEnabled: true,
      stickerEnabled: true,
      stickerIntensity: appState.stickersDraft.defaultIntensity,
      cooldownSeconds: appState.stickersDraft.defaultCooldown
    }));
    appState.configDirty = true;
    renderGroupEditorRows(appState.groupsDraft);
  }

  function handleGroupRowsClick(event) {
    var button = event.target.closest("[data-remove-group]");
    if (!button) return;
    var index = Number(button.dataset.removeGroup);
    if (Number.isNaN(index)) return;
    appState.groupsDraft.splice(index, 1);
    appState.configDirty = true;
    renderGroupEditorRows(appState.groupsDraft);
  }

  function handleGroupRowsInput(event) {
    var row = event.target.closest(".group-editor-row");
    if (!row) return;
    var index = Number(row.dataset.groupIndex);
    var field = event.target.dataset.field;
    if (Number.isNaN(index) || !field || !appState.groupsDraft[index]) return;
    var next = cloneGroupRecord(appState.groupsDraft[index]);
    if (event.target.type === "checkbox") next[field] = event.target.checked;
    else next[field] = event.target.value;
    appState.groupsDraft[index] = next;
    appState.configDirty = true;
  }

  async function handleStickerRefresh() {
    appState.stickersDraft = collectStickerDraft();
    await loadStickerInventory({ softFail: false });
  }

  async function handleConfigReload() {
    await loadConfigAndStickerState({ softFail: false });
  }

  async function handleConfigSave() {
    setConfigStatus("neutral", t("config.loading"));
    try {
      var payload = collectConfigPayload();
      var result = await fetchJson(config.configUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      appState.configPayload = result.config || payload;
      appState.groupsDraft = (appState.configPayload.groups || []).map(cloneGroupRecord);
      appState.stickersDraft = normalizeStickerDraft(appState.configPayload.stickers || {});
      appState.configDirty = false;
      renderConfigEditors();
      setConfigStatus("success", t("config.saved"));
      await loadStickerInventory({ softFail: true });
    } catch (error) {
      if (error && error.payload && error.payload.error === "VALIDATION_FAILED") {
        setConfigStatus("error", t("config.validation", { details: formatValidationErrors(error.payload.details || []) }));
        return;
      }
      setConfigStatus("error", t("config.saveFailed"));
    }
  }

  function collectConfigPayload() {
    return {
      groups: appState.groupsDraft.map(normalizeGroupForSave),
      stickers: collectStickerDraft()
    };
  }

  function collectStickerDraft() {
    return normalizeStickerDraft({
      enabled: elements.stickerEnabledInput ? elements.stickerEnabledInput.checked : false,
      rootPath: elements.stickerRootInput ? elements.stickerRootInput.value : "",
      mode: elements.stickerModeInput ? elements.stickerModeInput.value : "balanced",
      defaultIntensity: elements.stickerDefaultIntensityInput ? elements.stickerDefaultIntensityInput.value : 50,
      defaultCooldown: elements.stickerDefaultCooldownInput ? elements.stickerDefaultCooldownInput.value : 0
    });
  }

  function normalizeGroupForSave(group) {
    return {
      groupId: clampNumber(group.groupId, 1, Number.MAX_SAFE_INTEGER, 0),
      name: String(group.name || "").trim(),
      focus: String(group.focus || "").trim(),
      enabled: Boolean(group.enabled),
      priority: clampNumber(group.priority, CONFIG_LIMITS.priorityMin, CONFIG_LIMITS.priorityMax, 0),
      replyEnabled: Boolean(group.replyEnabled),
      stickerEnabled: Boolean(group.stickerEnabled),
      stickerIntensity: clampNumber(group.stickerIntensity, CONFIG_LIMITS.intensityMin, CONFIG_LIMITS.intensityMax, 50),
      cooldownSeconds: clampNumber(group.cooldownSeconds, CONFIG_LIMITS.cooldownMin, CONFIG_LIMITS.cooldownMax, 0)
    };
  }

  function normalizeStickerMode(value) {
    return ["balanced", "text-only", "sticker-first"].indexOf(value) >= 0 ? value : "balanced";
  }

  function clampNumber(value, min, max, fallback) {
    var next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    next = Math.round(next);
    if (next < min) return min;
    if (next > max) return max;
    return next;
  }

  function setConfigStatus(kind, message) {
    if (!elements.configStatus) return;
    elements.configStatus.classList.remove("is-error", "is-success");
    if (kind === "error") elements.configStatus.classList.add("is-error");
    if (kind === "success") elements.configStatus.classList.add("is-success");
    text(elements.configStatus, message);
  }

  function setStickerProblems(message, isError) {
    if (!elements.stickerProblems) return;
    elements.stickerProblems.classList.toggle("is-error", Boolean(isError));
    text(elements.stickerProblems, message || "");
  }

  function formatValidationErrors(details) {
    return details.map(function (item) {
      return (item.field || "field") + ": " + (item.message || "invalid");
    }).join("\n");
  }

  function markConfigDirty() {
    appState.configDirty = true;
    setConfigStatus("neutral", t("config.loaded"));
  }

  function renderLoginPanel(login) {
    if (!elements.loginPanel) return;
    text(elements.loginSummary, login.summary || t("login.empty"));
    text(elements.loginStatus, t("login.status." + (login.status || "unknown")));
    if (elements.loginQr) {
      if (login.qrDataUrl) {
        elements.loginQr.src = login.qrDataUrl;
        elements.loginQr.hidden = false;
      } else {
        elements.loginQr.removeAttribute("src");
        elements.loginQr.hidden = true;
      }
    }
    if (elements.loginEmpty) {
      elements.loginEmpty.hidden = Boolean(login.qrDataUrl);
      text(elements.loginEmpty, t("login.empty"));
    }
    if (elements.loginLink) {
      if (login.qrDecodeUrl) {
        elements.loginLink.href = login.qrDecodeUrl;
        elements.loginLink.hidden = false;
        text(elements.loginLink, t("login.decodeLink"));
      } else {
        elements.loginLink.hidden = true;
        elements.loginLink.removeAttribute("href");
      }
    }
  }

  function renderHealthPill(level) {
    var labelMap = { good: t("health.good"), warn: t("health.warn"), critical: t("health.critical") };
    if (!elements.healthLevel) return;
    elements.healthLevel.dataset.level = level;
    elements.healthLevel.textContent = labelMap[level] || "Unknown";
  }

  function renderGroupList(node, items, formatter, emptyMessage) {
    if (!node) return;
    node.innerHTML = "";
    if (!items.length) {
      node.appendChild(buildEmptyState(emptyMessage));
      return;
    }
    items.forEach(function (item) {
      var chip = document.createElement("span");
      chip.textContent = formatter(item);
      node.appendChild(chip);
    });
  }

  function renderLastMessageIds(items) {
    var keys = Object.keys(items);
    if (!elements.lastMessageIds) return;
    if (!keys.length) {
      text(elements.lastMessageIds, t("listener.noState"));
      return;
    }
    text(elements.lastMessageIds, keys.map(function (key) {
      return t("listener.groupLastMessage", { groupId: key, messageId: items[key] });
    }).join(" | "));
  }

  function renderAttachmentHints(hints) {
    if (!elements.supportedHints) return;
    elements.supportedHints.innerHTML = "";
    if (!hints.length) {
      elements.supportedHints.appendChild(buildEmptyState(t("attachments.noModes")));
      return;
    }
    hints.forEach(function (hint) {
      var item = document.createElement("li");
      item.textContent = translateApiText(hint);
      elements.supportedHints.appendChild(item);
    });
  }

  function renderRecentActivity(payload) {
    if (!elements.recentActivity) return;
    var logs = payload.logs || [];
    var lastMessageIds = (payload.listener && payload.listener.lastMessageIds) || {};
    var items = [];
    Object.keys(lastMessageIds).forEach(function (groupId) {
      items.push({ title: t("recent.listenerCheckpoint"), body: t("recent.groupLastSeen", { groupId: groupId, messageId: lastMessageIds[groupId] }) });
    });
    logs.forEach(function (section) {
      if (section.lines && section.lines.length) items.push({ title: section.name + " log", body: section.lines[section.lines.length - 1] });
    });
    elements.recentActivity.innerHTML = "";
    if (!items.length) {
      elements.recentActivity.appendChild(buildEmptyState(t("recent.none")));
      return;
    }
    var list = document.createElement("div");
    list.className = "activity-list";
    items.slice(0, 5).forEach(function (item) {
      var node = document.createElement("article");
      node.className = "activity-item";
      node.innerHTML = "<strong>" + escapeHtml(item.title) + "</strong><span>" + escapeHtml(item.body) + "</span>";
      list.appendChild(node);
    });
    elements.recentActivity.appendChild(list);
  }

  function renderSafeguards(payload) {
    if (!elements.safeguards) return;
    var connection = payload.connection || {};
    var attachments = payload.attachments || {};
    var items = [
      { title: t("safeguards.wsConfig"), body: connection.configured ? t("safeguards.wsConfigReady") : t("safeguards.wsConfigMissing") },
      { title: t("safeguards.token"), body: connection.hasToken ? t("safeguards.tokenReady") : t("safeguards.tokenMissing") },
      { title: t("safeguards.extractor"), body: attachments.extractorConfigured ? t("safeguards.extractorReady") : t("safeguards.extractorMissing") }
    ];
    elements.safeguards.innerHTML = "";
    var list = document.createElement("div");
    list.className = "safeguard-list";
    items.forEach(function (item) {
      var node = document.createElement("article");
      node.className = "safeguard-item";
      node.innerHTML = "<strong>" + escapeHtml(item.title) + "</strong><span>" + escapeHtml(item.body) + "</span>";
      list.appendChild(node);
    });
    elements.safeguards.appendChild(list);
  }

  function renderLogs(logs) {
    if (!elements.logs) return;
    elements.logs.innerHTML = "";
    if (!logs.length) {
      elements.logs.appendChild(buildEmptyState(t("logs.none")));
      return;
    }
    var hasContent = false;
    logs.forEach(function (section) {
      var card = document.createElement("article");
      card.className = "log-entry";
      var title = document.createElement("div");
      title.className = "log-entry__meta";
      title.textContent = section.name + " | " + (section.exists ? t("logs.available") : t("logs.missing"));
      card.appendChild(title);
      if (section.lines && section.lines.length) {
        hasContent = true;
        section.lines.forEach(function (line) {
          var lineNode = document.createElement("div");
          lineNode.textContent = line;
          card.appendChild(lineNode);
        });
      } else {
        card.appendChild(buildEmptyState(t("logs.empty")));
      }
      elements.logs.appendChild(card);
    });
    if (!hasContent) elements.logs.prepend(buildEmptyState(t("logs.allEmpty")));
  }

  function renderFatalState(error) {
    renderHealthPill("critical");
    text(elements.heroSummary, t("fatal.loadFailed"));
    text(elements.lastError, String(error && error.message ? error.message : error));
    if (elements.logs) {
      elements.logs.innerHTML = "";
      elements.logs.appendChild(buildEmptyState(t("fatal.retryHint")));
    }
  }

  function buildEmptyState(message) {
    var node = document.createElement("div");
    node.className = "empty-state";
    node.textContent = message;
    return node;
  }

  function text(node, value) {
    if (node) node.textContent = value;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setBusy(isBusy) {
    if (elements.pageShell) elements.pageShell.dataset.state = isBusy ? "loading" : "ready";
    if (elements.refreshButton) elements.refreshButton.disabled = isBusy;
  }

  function formatDateTime(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function resolveInitialLanguage() {
    var stored = "";
    try {
      stored = localStorage.getItem(LANGUAGE_STORAGE_KEY) || "";
    } catch (error) {
      stored = "";
    }
    if (TRANSLATIONS[stored]) return stored;
    var language = String(navigator.language || DEFAULT_LANGUAGE).toLowerCase();
    return language.indexOf("zh") === 0 ? "zh-CN" : "en";
  }

  function handleLanguageToggle() {
    appState.language = appState.language === "zh-CN" ? "en" : "zh-CN";
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, appState.language);
    } catch (error) {}
    applyLanguage();
    if (appState.bootstrapPayload) renderBootstrap(appState.bootstrapPayload);
    if (appState.statusPayload) renderStatus(appState.statusPayload);
    renderConfigEditors();
    if (appState.stickersPayload) renderStickerInventory(appState.stickersPayload);
  }

  function applyLanguage() {
    document.documentElement.lang = appState.language;
    document.title = t(body.dataset.titleKey || "title");
    document.querySelectorAll("[data-i18n]").forEach(function (node) {
      text(node, t(node.dataset.i18n));
    });
    document.querySelectorAll("[data-group-label-key]").forEach(function (node) {
      node.dataset.groupLabel = t(node.dataset.groupLabelKey);
    });
    if (elements.languageLabel) text(elements.languageLabel, t("language.label"));
    if (elements.languageToggle) text(elements.languageToggle, appState.language === "zh-CN" ? t("language.switchToEnglish") : t("language.switchToChinese"));
    if (elements.currentMode) setMode("bootstrap");
  }

  function setMode(mode) {
    text(elements.currentMode, t(mode === "heartbeat" ? "mode.heartbeat" : "mode.bootstrap"));
  }

  function t(key, vars) {
    var table = TRANSLATIONS[appState.language] || TRANSLATIONS[DEFAULT_LANGUAGE];
    var template = table[key] || TRANSLATIONS.en[key] || key;
    return String(template).replace(/\{(\w+)\}/g, function (_, name) {
      return vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : "";
    });
  }

  function translateApiText(textValue) {
    return t("api." + textValue);
  }

  function translateServerSummary(summary, payload) {
    if (!summary) return t("summary.ready");
    if (summary === "QQ is configured, but no listener state has been observed yet.") return t("server.summary.configuredNoState");
    if (summary === "QQ channel is not configured yet. Add wsUrl and token to bring the module online.") return t("server.summary.notConfigured");
    if (summary === "QQ dashboard detected an error in recent runtime activity.") return t("server.summary.errorDetected");
    if (summary.indexOf("QQ listeners are active across ") === 0) {
      return t("server.summary.running", {
        count: payload && payload.listener ? payload.listener.listenerCount || payload.listenerCount || 0 : 0
      });
    }
    return summary;
  }

  function applyStaggeredAnimations() {
    document.querySelectorAll(".panel[data-animate]").forEach(function (panel, index) {
      panel.style.setProperty("--delay", (index * 80) + "ms");
    });
    document.querySelectorAll(".metric-card[data-animate]").forEach(function (card, index) {
      card.style.setProperty("--delay", (index * 60) + "ms");
    });
  }

  function setupIntersectionObserver() {
    if (!("IntersectionObserver" in window)) {
      document.querySelectorAll("[data-animate]").forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    document.querySelectorAll("[data-animate]").forEach(function (el) {
      observer.observe(el);
    });
  }

  function setupAutoRefreshIndicator() {
    var timerId = null;
    function resetTimer() {
      if (timerId) clearTimeout(timerId);
      if (elements.refreshButton) elements.refreshButton.classList.remove("btn--needs-refresh");
      timerId = setTimeout(function () {
        if (elements.refreshButton && !elements.refreshButton.disabled) {
          elements.refreshButton.classList.add("btn--needs-refresh");
        }
      }, 60000);
    }
    resetTimer();
    if (elements.refreshButton) elements.refreshButton.addEventListener("click", resetTimer);
  }
})();
