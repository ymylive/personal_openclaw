(function () {
  "use strict";

  var APP_TIME_ZONE = "Asia/Shanghai";
  var STAGES = ["news", "morning", "noon", "health"];
  var MARKETS = ["A", "HK", "US"];
  var STAGE_LABELS = {
    news: "08:00 新闻 / News",
    morning: "10:00 晨报 / Morning",
    noon: "12:00 午报 / Noon",
    health: "健康 / Health"
  };
  var STAGE_SHORT_LABELS = {
    news: "08:00",
    morning: "10:00",
    noon: "12:00",
    health: "健康 / Health"
  };

  function bi(zh, en) {
    return zh + " / " + en;
  }

  function q(id) {
    return document.getElementById(id);
  }

  var body = document.body;
  var config = {
    bootstrapUrl: body.dataset.bootstrapUrl || "/finance/api/bootstrap",
    statusUrl: body.dataset.statusUrl || "/finance/api/status",
    historyUrl: body.dataset.historyUrl || "/finance/api/history-index",
    archiveBase: body.dataset.archiveBase || "/finance/api/archive/"
  };

  var appState = {
    mode: "latest",
    selectedDate: "",
    availableDates: [],
    payload: null,
    lastGoodPayload: null,
    lastStatus: null,
    lastError: null,
    filters: {
      stage: "all",
      market: "ALL"
    },
    recommendedPollSeconds: 60,
    pollTimer: null,
    pollPromise: null,
    initialized: false,
    busy: false,
    canvasBalanceFrame: null,
    canvasResizeTimer: null,
    focus: {
      activeLabel: "",
      returnNode: null
    }
  };

  var el = {
    heroDeck: q("hero-deck"),
    workspaceModePill: q("workspace-mode-pill"),
    refreshHealthPill: q("refresh-health-pill"),
    latestButton: q("latest-button"),
    refreshButton: q("refresh-button"),
    stateBanner: q("state-banner"),
    tradingDayValue: q("trading-day-value"),
    sessionValue: q("session-value"),
    pushClockPills: q("push-clock-pills"),
    pushClockMeta: q("push-clock-meta"),
    marketTemperatureGrid: q("market-temperature-grid"),
    portfolioSummaryValue: q("portfolio-summary-value"),
    portfolioSummaryMeta: q("portfolio-summary-meta"),
    accessWindowValue: q("access-window-value"),
    accessWindowMeta: q("access-window-meta"),
    refreshValue: q("refresh-value"),
    workspaceDateMeta: q("workspace-date-meta"),
    archiveSummaryCopy: q("archive-summary-copy"),
    historyDateSelect: q("history-date-select"),
    loadHistoryButton: q("load-history-button"),
    stageFilterGroup: q("stage-filter-group"),
    marketFilterGroup: q("market-filter-group"),
    archiveMiniStats: q("archive-mini-stats"),
    timelineList: q("timeline-list"),
    referenceCardList: q("reference-card-list"),
    canvasTitle: q("canvas-title"),
    canvasCopy: q("canvas-copy"),
    canvasGrid: document.querySelector(".canvas-grid"),
    marketBreadthChart: q("market-breadth-chart"),
    candidateDistributionChart: q("candidate-distribution-chart"),
    marketSummaryCards: q("market-summary-cards"),
    morningOverlapList: q("morning-overlap-list"),
    newsBriefList: q("news-brief-list"),
    morningDriverList: q("morning-driver-list"),
    portfolioPanelCopy: q("portfolio-panel-copy"),
    portfolioMetricGrid: q("portfolio-metric-grid"),
    noonReadingList: q("noon-reading-list"),
    portfolioCurveChart: q("portfolio-curve-chart"),
    allocationList: q("allocation-list"),
    riskStrip: q("risk-strip"),
    holdingList: q("holding-list"),
    contributorsList: q("contributors-list"),
    detractorsList: q("detractors-list"),
    healthCard: q("health-card"),
    deliveryCard: q("delivery-card"),
    privateLinkCard: q("private-link-card"),
    autorefreshCard: q("autorefresh-card"),
    compactNewsList: q("compact-news-list"),
    globalState: q("global-state"),
    globalStateKicker: q("global-state-kicker"),
    globalStateTitle: q("global-state-title"),
    globalStateMessage: q("global-state-message"),
    stateRetryButton: q("state-retry-button"),
    stateLinkButton: q("state-link-button"),
    focusOverlay: q("focus-overlay"),
    focusOverlayBackdrop: q("focus-overlay-backdrop"),
    focusShellKicker: q("focus-shell-kicker"),
    focusShellTitle: q("focus-shell-title"),
    focusShellBody: q("focus-shell-body"),
    focusCloseButton: q("focus-close-button")
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindEvents();

    var initialState = getRequestedState();
    if (initialState && initialState !== "authorized") {
      showGlobalState(initialState);
      if (initialState === "expired" || initialState === "unauthorized") {
        return;
      }
    }

    showGlobalState("loading");
    loadInitial();
  }

  function bindEvents() {
    if (el.refreshButton) {
      el.refreshButton.addEventListener("click", function () {
        if (appState.mode === "archive" && appState.selectedDate && appState.selectedDate !== getLatestDate()) {
          loadArchive(appState.selectedDate);
          return;
        }
        loadLatest();
      });
    }

    if (el.latestButton) {
      el.latestButton.addEventListener("click", function () {
        loadLatest();
      });
    }

    if (el.loadHistoryButton) {
      el.loadHistoryButton.addEventListener("click", function () {
        var selected = el.historyDateSelect ? el.historyDateSelect.value : "";
        if (selected) {
          loadArchive(selected);
          return;
        }
        loadLatest();
      });
    }

    if (el.historyDateSelect) {
      el.historyDateSelect.addEventListener("change", function () {
        var selected = el.historyDateSelect.value;
        if (!selected) {
          appState.mode = "latest";
          renderArchiveControls();
        }
      });
    }

    if (el.stageFilterGroup) {
      el.stageFilterGroup.addEventListener("click", function (event) {
        var target = event.target.closest("[data-stage-filter]");
        if (!target) {
          return;
        }
        appState.filters.stage = target.getAttribute("data-stage-filter") || "all";
        updateFilterButtons();
        renderAll();
      });
    }

    if (el.marketFilterGroup) {
      el.marketFilterGroup.addEventListener("click", function (event) {
        var target = event.target.closest("[data-market-filter]");
        if (!target) {
          return;
        }
        appState.filters.market = target.getAttribute("data-market-filter") || "ALL";
        updateFilterButtons();
        renderAll();
      });
    }

    if (el.stateRetryButton) {
      el.stateRetryButton.addEventListener("click", function () {
        if (appState.mode === "archive" && appState.selectedDate && appState.selectedDate !== getLatestDate()) {
          loadArchive(appState.selectedDate);
          return;
        }
        loadLatest();
      });
    }

    document.addEventListener("click", function (event) {
      var readingToggle = event.target.closest("[data-reading-toggle]");
      if (readingToggle) {
        event.preventDefault();
        toggleReadingCard(readingToggle);
        return;
      }

      var readingCopy = event.target.closest("[data-reading-copy]");
      if (readingCopy) {
        event.preventDefault();
        handleReadingCopy(readingCopy);
        return;
      }

      var readingSummary = event.target.closest(".reading-section summary");
      if (readingSummary) {
        window.setTimeout(function () {
          syncReadingCardState(readingSummary.closest("[data-reading-card]"));
        }, 0);
      }

      if (event.target.closest("[data-focus-close]")) {
        closeFocusView();
        return;
      }

      var card = event.target.closest(".focusable-card");
      if (!card || card.closest(".focus-shell-body")) {
        return;
      }

      if (isFocusInteractiveTarget(event.target, card)) {
        return;
      }

      event.preventDefault();
      openFocusView(card, card);
    });

    if (el.focusOverlayBackdrop) {
      el.focusOverlayBackdrop.setAttribute("data-focus-close", "true");
    }

    if (el.focusCloseButton) {
      el.focusCloseButton.setAttribute("data-focus-close", "true");
    }

    window.addEventListener("resize", function () {
      if (appState.canvasResizeTimer) {
        window.clearTimeout(appState.canvasResizeTimer);
      }
      appState.canvasResizeTimer = window.setTimeout(function () {
        appState.canvasResizeTimer = null;
        scheduleCanvasBalance();
      }, 90);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && el.focusOverlay && el.focusOverlay.classList.contains("is-active")) {
        event.preventDefault();
        closeFocusView();
        return;
      }

      if ((event.key === "Enter" || event.key === " " || event.key === "Spacebar") && event.target && event.target.classList && event.target.classList.contains("focusable-card")) {
        event.preventDefault();
        openFocusView(event.target, event.target);
      }
    });
  }

  function isFocusInteractiveTarget(target, card) {
    if (!target || !card) {
      return false;
    }

    var interactive = target.closest([
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "label",
      "summary",
      "[role='button']",
      "[role='link']",
      "[contenteditable='true']"
    ].join(","));

    return !!interactive && interactive !== card;
  }

  async function loadInitial() {
    try {
      await loadLatest({ background: false });
      var requestedDate = new URL(window.location.href).searchParams.get("date");
      if (requestedDate && requestedDate !== getLatestDate() && appState.availableDates.indexOf(requestedDate) !== -1) {
        await loadArchive(requestedDate, { background: true });
      } else {
        syncUrl();
      }
    } catch (error) {
      handleLoadError(error, false);
    }
  }

  function assertFinanceScope(payload) {
    if (!payload || payload.module !== "finance") {
      throw new Error("Expected finance payload");
    }
    return payload;
  }

  async function loadLatest(options) {
    options = options || {};
    setBusy(true);

    if (!options.background && !appState.lastGoodPayload) {
      showGlobalState("loading");
    }

    try {
      var payload = assertFinanceScope(await requestJson(config.bootstrapUrl));
      consumePayload(payload, "latest");
      syncHistoryIndex();
    } catch (error) {
      handleLoadError(error, true);
    } finally {
      setBusy(false);
    }
  }

  async function loadArchive(date, options) {
    options = options || {};
    if (!date) {
      return loadLatest(options);
    }

    setBusy(true);
    showBanner(bi("正在载入历史回放 " + formatDateLabel(date), "Loading archive replay for " + formatDateLabel(date)), "info");

    try {
      var payload = assertFinanceScope(await requestJson(config.archiveBase + encodeURIComponent(date)));
      consumePayload(payload, "archive");
      syncHistoryIndex();
    } catch (error) {
      handleLoadError(error, true);
    } finally {
      setBusy(false);
    }
  }

  async function syncHistoryIndex() {
    try {
      var payload = await requestJson(config.historyUrl);
      if (payload && payload.ok) {
        appState.availableDates = uniqueDates((payload.available_dates || []).concat(appState.availableDates));
        renderArchiveControls();
      }
    } catch (error) {
      if (isUnauthorizedError(error)) {
        handleLoadError(error, true);
      }
    }
  }

  async function pollStatus() {
    if (!appState.initialized || document.hidden) {
      return;
    }

    try {
      var status = await requestJson(config.statusUrl);
      appState.lastStatus = status;
      updateRefreshHealth();
      renderTopStatus();
      renderLiveRail();

      var latestGeneratedAt = status.latest_generated_at;
      var currentGeneratedAt = getDay().generated_at;
      if (appState.mode === "latest" && isLater(latestGeneratedAt, currentGeneratedAt)) {
        await loadLatest({ background: true });
      }
    } catch (error) {
      if (isUnauthorizedError(error)) {
        handleLoadError(error, true);
        return;
      }

      appState.lastError = error;
      showBanner(bi("自动刷新已暂停，当前显示最近一次成功快照。", "Auto-refresh paused. Showing the last successful snapshot."), "warning");
      updateRefreshHealth();
      renderLiveRail();
    }
  }

  function pollStatusSingleFlight() {
    if (appState.pollPromise) {
      return appState.pollPromise;
    }
    if (appState.busy) {
      return Promise.resolve();
    }

    var request = pollStatus();
    appState.pollPromise = request.finally(function () {
      appState.pollPromise = null;
    });
    return appState.pollPromise;
  }

  async function requestJson(url) {
    var response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json"
      }
    });

    var text = await response.text();
    var data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        if (response.ok) {
          throw createError("FINANCE_BAD_RESPONSE", bi("工作台返回了无法解析的数据。", "Dashboard returned unreadable data."), response.status);
        }
      }
    }

    if (!response.ok) {
      throw normalizeHttpError(response.status, data);
    }

    return data || {};
  }

  function normalizeHttpError(status, data) {
    var code = data && data.error && data.error.code ? data.error.code : "";
    var message = data && data.error && data.error.message ? data.error.message : "Dashboard request failed.";

    if (!code) {
      if (status === 401) {
        code = "FINANCE_SESSION_REQUIRED";
      } else if (status === 404) {
        code = "FINANCE_ARCHIVE_NOT_FOUND";
      } else {
        code = "FINANCE_DATA_UNAVAILABLE";
      }
    }

    return createError(code, message, status);
  }

  function createError(code, message, status) {
    var error = new Error(message);
    error.code = code;
    error.status = status || 0;
    return error;
  }

  function handleLoadError(error, allowFallback) {
    if (isUnauthorizedError(error)) {
      clearPolling();
      showBanner(bi("会话已失效，请从今日 Telegram 链接重新进入。", "Session expired. Re-enter from today's Telegram link."), "warning");
      showGlobalState("unauthorized");
      return;
    }

    if (error.code === "FINANCE_ARCHIVE_NOT_FOUND") {
      showBanner(bi("所选历史快照不存在。", "Selected archive snapshot is not available."), "warning");
      if (!appState.lastGoodPayload) {
        showGlobalState("empty");
      }
      return;
    }

    if (allowFallback && appState.lastGoodPayload) {
      appState.lastError = error;
      hideGlobalState();
      showBanner(bi("接口刷新失败，当前显示最近一次成功快照。", "API refresh failed. Showing the last successful snapshot."), "warning");
      updateRefreshHealth();
      renderLiveRail();
      return;
    }

    showGlobalState("error", {
      message: error && error.message ? error.message : bi("暂时无法载入金融数据。", "Unable to load finance data.")
    });
  }

  function isUnauthorizedError(error) {
    return !!error && (error.code === "FINANCE_SESSION_REQUIRED" || error.status === 401);
  }

  function consumePayload(payload, mode) {
    if (!payload || !payload.ok || !payload.day) {
      throw createError("FINANCE_DATA_UNAVAILABLE", bi("金融数据尚未就绪。", "Finance data is not available yet."), 500);
    }

    appState.payload = payload;
    appState.lastGoodPayload = payload;
    appState.lastError = null;
    appState.mode = mode;
    appState.selectedDate = payload.day.history && payload.day.history.selected_date ? payload.day.history.selected_date : (payload.day.date || "");
    appState.availableDates = uniqueDates((payload.day.history && payload.day.history.available_dates || []).concat(appState.availableDates));
    appState.recommendedPollSeconds = getPollSeconds(payload);
    appState.initialized = true;

    hideGlobalState();
    clearBanner();
    renderAll();
    updateRefreshHealth();
    schedulePolling(appState.recommendedPollSeconds);
    syncUrl();
  }

  function schedulePolling(seconds) {
    clearPolling();
    var safeSeconds = Math.max(15, Number(seconds) || 60);
    appState.pollTimer = window.setInterval(function () {
      pollStatusSingleFlight();
    }, safeSeconds * 1000);
  }

  function clearPolling() {
    if (appState.pollTimer) {
      window.clearInterval(appState.pollTimer);
      appState.pollTimer = null;
    }
  }

  function setBusy(busy) {
    appState.busy = busy;
    if (el.refreshButton) {
      el.refreshButton.disabled = busy;
    }
    if (el.latestButton) {
      el.latestButton.disabled = busy;
    }
    if (el.loadHistoryButton) {
      el.loadHistoryButton.disabled = busy;
    }
    if (el.historyDateSelect) {
      el.historyDateSelect.disabled = busy;
    }
  }

  function renderAll() {
    updateFilterButtons();
    renderHero();
    renderTopStatus();
    renderArchiveControls();
    renderTimeline();
    renderReferenceCards();
    renderMarketCanvas();
    renderPortfolioPanel();
    renderLiveRail();
    decorateFocusableCards();
    scheduleCanvasBalance();
  }

  function renderHero() {
    var day = getDay();
    var marketLabel = appState.filters.market === "ALL" ? "A 股 / 港股 / 美股" : marketDisplayName(appState.filters.market);
    var stageLabel = appState.filters.stage === "all" ? bi("全阶段", "All stages") : STAGE_LABELS[appState.filters.stage];
    var workspaceLabel = appState.mode === "latest" ? bi("最新工作台", "Latest workspace") : bi("历史回放", "Archive replay");
    var dateLabel = day.date ? formatDateLabel(day.date) : bi("当前交易日", "Current day");

    if (el.workspaceModePill) {
      el.workspaceModePill.textContent = workspaceLabel;
    }

    if (el.heroDeck) {
      el.heroDeck.textContent = dateLabel + " · " + marketLabel + " · " + stageLabel + " · " + bi("联动 AI 模拟持仓", "linked AI simulated portfolio");
    }

    updateRefreshHealth();
  }

  function renderTopStatus() {
    var day = getDay();
    var topStatus = day.top_status || {};
    var session = day.session || {};
    var pushes = getStageMeta();
    var marketTemperatures = topStatus.market_temperatures || {};
    var portfolioSummary = topStatus.portfolio_summary || {};
    var health = day.content && day.content.health || {};
    var healthSeverity = health.severity || inferHealthSeverity(health);

    if (el.tradingDayValue) {
      el.tradingDayValue.textContent = topStatus.trading_day === false ? bi("休市", "Market pause") : bi("交易日", "Trading day");
    }

    if (el.sessionValue) {
      el.sessionValue.textContent = session.authorized
        ? bi("会话有效至 " + formatTime(session.valid_until), "Session live until " + formatTime(session.valid_until))
        : bi("需要当日会话", "Session required");
    }

    if (el.pushClockPills) {
      setHTML(el.pushClockPills, STAGES.map(function (stage) {
        return statusPillHTML(STAGE_SHORT_LABELS[stage], pushes[stage].status || "pending", true);
      }).join(""));
    }

    if (el.pushClockMeta) {
      el.pushClockMeta.textContent = healthSeverity === "critical"
        ? bi("健康告警已触发", "Health alert active")
        : bi("08:00 / 10:00 / 12:00 + 实时轮询", "08:00 / 10:00 / 12:00 with live polling");
    }

    if (el.marketTemperatureGrid) {
      setHTML(el.marketTemperatureGrid, MARKETS.map(function (market) {
        var value = marketTemperatures[market] || getMarketSummary(day.content && day.content.morning, market).temperature || bi("暂未就绪", "Not ready");
        return [
          '<div class="temperature-chip tone-neutral">',
          "<span>" + escapeHtml(marketToneLabel(market)) + "</span>",
          "<strong>" + escapeHtml(value) + "</strong>",
          "</div>"
        ].join("");
      }).join(""));
    }

    if (el.portfolioSummaryValue) {
      el.portfolioSummaryValue.textContent = formatCurrency(portfolioSummary.portfolio_value);
    }

    if (el.portfolioSummaryMeta) {
      var holdingCount = asNumber(portfolioSummary.holding_count);
      var summaryParts = [];
      summaryParts.push(formatSignedRatioPercent(portfolioSummary.daily_pnl_pct) + " " + bi("日内", "day"));
      summaryParts.push(formatSignedRatioPercent(portfolioSummary.turnover_pct) + " " + bi("换手", "turnover"));
      if (holdingCount !== null) {
        summaryParts.push(formatNumber(holdingCount) + " " + bi("持仓", "holdings"));
      }
      el.portfolioSummaryMeta.textContent = summaryParts.join(" / ");
    }

    if (el.accessWindowValue) {
      el.accessWindowValue.textContent = session.authorized ? bi("已授权", "Authorized") : bi("等待授权", "Awaiting authorization");
    }

    if (el.accessWindowMeta) {
      var accessMode = prettyAccessMode(day.access && day.access.access_mode);
      el.accessWindowMeta.textContent = session.valid_until
        ? bi("有效至 " + formatDateTime(session.valid_until), "Valid until " + formatDateTime(session.valid_until)) + " · " + accessMode
        : bi("仅限当日会话", "Current-day session only");
    }

    if (el.refreshValue) {
      el.refreshValue.textContent = formatDateTime(topStatus.last_refresh_at || day.generated_at || appState.lastStatus && appState.lastStatus.now);
    }

    if (el.workspaceDateMeta) {
      el.workspaceDateMeta.textContent = appState.mode === "latest"
        ? bi("最新视图", "Latest view") + " · " + formatDateLabel(day.date)
        : bi("历史回放", "Archive replay") + " · " + formatDateLabel(appState.selectedDate);
    }
  }

  function renderArchiveControls() {
    var day = getDay();
    var latestDate = day.date || "";
    var dates = uniqueDates([latestDate].concat(appState.availableDates));
    appState.availableDates = dates;

    if (el.historyDateSelect) {
      var currentValue = appState.mode === "archive" ? appState.selectedDate : "";
      var options = ['<option value="">' + escapeHtml(bi("最新可用", "Latest available")) + (latestDate ? " · " + escapeHtml(formatDateLabel(latestDate)) : "") + "</option>"];

      dates.forEach(function (date) {
        options.push('<option value="' + escapeHtml(date) + '"' + (currentValue === date ? " selected" : "") + ">" + escapeHtml(formatDateLabel(date)) + "</option>");
      });

      setHTML(el.historyDateSelect, options.join(""));
    }

    if (el.archiveSummaryCopy) {
      el.archiveSummaryCopy.textContent = appState.mode === "latest"
        ? bi("最新模式跟随主工作台数据，并持续轮询状态更新。", "Latest mode follows the canonical payload and keeps polling for status updates.")
        : bi("历史模式会固定选定日期，并在同一工作台里回放当日全量快照。", "Archive mode pins a selected date and replays the full day snapshot in the same shell.");
    }

    if (el.archiveMiniStats) {
      var miniStats = [
        miniStatHTML(bi("所选日期", "Selected day"), appState.mode === "archive" ? formatDateLabel(appState.selectedDate) : bi("最新", "Latest")),
        miniStatHTML(bi("可回放日期", "Available replays"), String(dates.length || 0)),
        miniStatHTML(bi("推送焦点", "Push emphasis"), appState.filters.stage === "all" ? bi("全阶段", "All stages") : STAGE_LABELS[appState.filters.stage]),
        miniStatHTML(bi("市场范围", "Market scope"), appState.filters.market === "ALL" ? "A / HK / US" : marketDisplayName(appState.filters.market))
      ];
      setHTML(el.archiveMiniStats, miniStats.join(""));
    }
  }

  function renderTimeline() {
    var day = getDay();
    var content = day.content || {};
    var pushes = getStageMeta();
    var visibleStages = STAGES.filter(function (stage) {
      return appState.filters.stage === "all" || appState.filters.stage === stage;
    });

    if (!visibleStages.length) {
      renderEmpty(el.timelineList, bi("未选择推送阶段", "No stage selected"), bi("请选择一种推送类型以查看时间轴卡片。", "Choose a push type to inspect timeline cards."));
      return;
    }

    var cards = visibleStages.map(function (stage) {
      var stageContent = content[stage] || {};
      var summary = summarizeStage(stage, stageContent, day);
      var highlights = buildStageHighlights(stage, stageContent, day);
      return [
        '<article class="timeline-card" data-stage="' + escapeHtml(stage) + '">',
        '<div class="timeline-card-head">',
        "<div>",
        "<h3>" + escapeHtml(STAGE_LABELS[stage]) + "</h3>",
        '<p class="timeline-card-meta">' + escapeHtml(formatDateTime(stageContent.generated_at || pushes[stage].generated_at || day.generated_at)) + "</p>",
        "</div>",
        statusPillHTML(prettyStageStatus(pushes[stage].status || stageContent.status || "pending"), pushes[stage].status || stageContent.status || "pending", true),
        "</div>",
        summary ? '<p class="timeline-card-copy">' + escapeHtml(summary) + "</p>" : "",
        highlights.length
          ? '<ul class="timeline-card-list">' + highlights.map(function (item) {
            return "<li>" + escapeHtml(item) + "</li>";
          }).join("") + "</ul>"
          : "",
        stageDeliveryHTML(stageContent.telegram_delivery || pushes[stage].telegram_delivery),
        "</article>"
      ].join("");
    });

    setHTML(el.timelineList, cards.join(""));
  }

  function renderReferenceCards() {
    var day = getDay();
    var news = day.content && day.content.news || {};
    var morning = day.content && day.content.morning || {};
    var noon = day.content && day.content.noon || {};
    var health = day.content && day.content.health || {};
    var items = [];

    if (isStageVisible("news")) {
      safeArray(news.watch_points).slice(0, 2).forEach(function (item) {
        items.push({
          tag: bi("新闻观察", "News watch"),
          title: bi("观察点", "Watch point"),
          copy: item
        });
      });
    }

    if (isStageVisible("morning")) {
      if (morning.ai_reference && morning.ai_reference.note) {
        items.push({
          tag: bi("晨报 / AI", "Morning / AI"),
          title: bi("晨报重叠备注", "Morning overlap note"),
          copy: morning.ai_reference.note
        });
      }

      var topPositions = safeArray(morning.ai_reference && morning.ai_reference.top_positions).slice(0, 2);
      if (topPositions.length) {
        items.push({
          tag: bi("晨报组合", "Morning book"),
          title: bi("重点引用持仓", "Top referenced holdings"),
          copy: topPositions.map(function (item) {
            return (item.display_symbol || item.symbol || item.name || bi("持仓", "Holding")) + " " + formatRatioPercent(item.portfolio_pct);
          }).join(" · ")
        });
      }
    }

    if (isStageVisible("noon")) {
      safeArray(noon.advice).slice(0, 3).forEach(function (item) {
        items.push({
          tag: bi("午间建议", "Noon advice"),
          title: bi("组合叙事", "Portfolio narrative"),
          copy: item
        });
      });
    }

    if (isStageVisible("health")) {
      if (health.severity && health.severity !== "none") {
        items.push({
          tag: bi("健康", "Health"),
          title: prettySeverity(health.severity) + " " + bi("源状态", "source state"),
          copy: safeArray(health.issues).slice(0, 2).join(" · ") || bi("数据源问题会在右侧 live rail 中高亮。", "Source issues are highlighted in the live rail.")
        });
      }
    }

    if (!items.length) {
      renderEmpty(el.referenceCardList, bi("参考卡片将在此出现", "Reference cards will appear here"), bi("观察点、AI 备注、投资建议和源健康状态会在这里汇总。", "Watch points, AI notes, advice, and source health will populate here."));
      return;
    }

    setHTML(el.referenceCardList, items.map(function (item) {
      return [
        '<article class="reference-card">',
        '<span class="reference-tag">' + escapeHtml(item.tag) + "</span>",
        "<h3>" + escapeHtml(item.title) + "</h3>",
        "<p>" + escapeHtml(item.copy) + "</p>",
        "</article>"
      ].join("");
    }).join(""));
  }

  function renderMarketCanvas() {
    var day = getDay();
    var morning = day.content && day.content.morning || {};
    var markets = morning.markets || {};
    var marketKeys = getVisibleMarketKeys(markets);

    if (el.canvasTitle) {
      el.canvasTitle.textContent = marketKeys.length
        ? marketKeys.map(marketDisplayName).join(" · ") + " · " + bi("宽度与持仓联动", "breadth & portfolio linkage")
        : bi("晨间宽度、分布与持仓联动", "Morning breadth, distribution, and linkage");
    }

    if (el.canvasCopy) {
      el.canvasCopy.textContent = appState.filters.stage === "all" || appState.filters.stage === "morning"
        ? bi("中心画布先给出图表，再解释这些信号为何影响 AI 模拟持仓。", "The canvas stays chart-first, then explains why those setups matter for the simulated portfolio.")
        : bi("即使切到其他阶段，晨间上下文也会保留，作为后续推送与持仓复盘的底图。", "Morning context remains visible because it anchors later pushes and portfolio review.");
    }

    renderBreadthChart(marketKeys.map(function (key) {
      return { key: key, summary: markets[key] || {} };
    }));

    renderCandidateDistributionChart(marketKeys.map(function (key) {
      return { key: key, summary: markets[key] || {} };
    }));

    renderMarketSummaryCards(marketKeys.map(function (key) {
      return { key: key, summary: markets[key] || {} };
    }));

    renderMorningOverlap(morning);
    renderNewsBriefs(day.content && day.content.news || {});
    renderMorningDrivers(morning);
  }

  function renderPortfolioPanelLegacy() {
    var day = getDay();
    var morning = day.content && day.content.morning || {};
    var noon = day.content && day.content.noon || {};
    var summary = noon.portfolio_summary || day.top_status && day.top_status.portfolio_summary || {};
    var positions = getSortedPositions(noon);
    var allocations = getAllocationRows(noon);
    var overlapItems = buildOverlapItems(morning, positions);
    var risk = computeRisk(positions);

    if (el.portfolioPanelCopy) {
      el.portfolioPanelCopy.textContent = bi("晨报重叠 " + overlapItems.length + " 个，当前为 " + risk.label + "，共 " + positions.length + " 个持仓。", "There are " + overlapItems.length + " overlaps with morning ideas, " + risk.label + " across " + positions.length + " holdings.");
    }

    if (el.portfolioMetricGrid) {
      var metrics = [
        metricCardHTML(bi("账户净值", "Account value"), formatCurrency(summary.portfolio_value), bi("当前 AI 模拟账户净值。", "Current simulated account value."), "neutral"),
        metricCardHTML(bi("当日盈亏", "Daily PnL"), formatSignedCurrency(summary.daily_pnl_amount), formatSignedRatioPercent(summary.daily_pnl_pct), toneFromNumeric(summary.daily_pnl_amount)),
        metricCardHTML(bi("换手规模", "Turnover"), formatCurrency(summary.turnover_amount), formatSignedRatioPercent(summary.turnover_pct) + " " + bi("占组合", "of portfolio"), toneFromNumeric(summary.turnover_pct)),
        metricCardHTML(bi("持仓数量", "Holdings"), String(positions.length || asNumber(summary.holding_count) || 0), bi("当前 AI 模拟持仓数量。", "Current simulated positions."), "neutral"),
        metricCardHTML(bi("重叠数量", "Overlap count"), String(overlapItems.length), bi("晨报优选与模拟仓的交集。", "Morning picks intersecting with the book."), overlapItems.length ? "positive" : "neutral"),
        metricCardHTML(bi("风险姿态", "Risk posture"), risk.label, bi("最大单仓 ", "Largest line ") + formatRatioPercent(risk.largestPct) + " · " + bi("前三合计 ", "top three ") + formatRatioPercent(risk.topThreePct), risk.tone)
      ];
      setHTML(el.portfolioMetricGrid, metrics.join(""));
    }

    renderPortfolioPath(summary);
    renderAllocationList(allocations);
    renderRiskStrip(risk, overlapItems.length);
    renderHoldingList(positions);
    renderImpactList(el.contributorsList, safeArray(summary.top_contributors), bi("贡献项", "Contributors"));
    renderImpactList(el.detractorsList, safeArray(summary.top_detractors), bi("拖累项", "Detractors"));
  }

  function renderLiveRail() {
    var day = getDay();
    var content = day.content || {};
    var pushes = getStageMeta();
    var health = content.health || {};
    var access = day.access || {};
    var session = day.session || {};
    var severity = health.severity || inferHealthSeverity(health);
    var news = content.news || {};

    if (el.healthCard) {
      el.healthCard.className = "live-card " + toneClassName(severity === "none" ? "positive" : severity);
      setHTML(el.healthCard, [
        "<h3>" + escapeHtml(bi("数据源健康", "Source health")) + "</h3>",
        "<p>" + escapeHtml(severity === "none" ? bi("监控中的数据源当前健康。", "All monitored sources look healthy.") : prettySeverity(severity) + " " + bi("覆盖异常已触发。", "coverage issue detected.")) + "</p>",
        safeArray(health.issues).length
          ? '<ul class="live-meta-list">' + safeArray(health.issues).slice(0, 4).map(function (item) {
            return "<li>" + escapeHtml(item) + "</li>";
          }).join("") + "</ul>"
          : '<ul class="live-meta-list"><li>' + escapeHtml(bi("暂无活跃问题。", "No active issues reported.")) + "</li></ul>"
      ].join(""));
    }

    if (el.deliveryCard) {
      var deliveryItems = STAGES.map(function (stage) {
        var delivery = pushes[stage].telegram_delivery || {};
        return [
          '<div class="delivery-item">',
          "<span>" + escapeHtml(STAGE_LABELS[stage]) + "</span>",
          statusPillHTML(prettyStageStatus(delivery.status || pushes[stage].status || "pending"), delivery.status || pushes[stage].status || "pending", true),
          "</div>"
        ].join("");
      }).join("");

      setHTML(el.deliveryCard, [
        "<h3>" + escapeHtml(bi("Telegram 投递", "Telegram delivery")) + "</h3>",
        "<p>" + escapeHtml(bi("Telegram 仅推送私有链接，叙事与分析保留在工作台内。", "Telegram remains URL-only. Narrative stays inside the dashboard.")) + "</p>",
        '<div class="delivery-list">' + deliveryItems + "</div>"
      ].join(""));
    }

    if (el.privateLinkCard) {
      el.privateLinkCard.className = "live-card tone-neutral";
      setHTML(el.privateLinkCard, [
        "<h3>" + escapeHtml(bi("私有链接窗口", "Private link window")) + "</h3>",
        "<p>" + escapeHtml(session.authorized ? bi("当日会话已生效。", "Current-day session is active.") : bi("需要今日 Telegram 私有链接完成授权。", "A current-day Telegram access link is required.")) + "</p>",
        '<ul class="live-meta-list">',
        "<li>" + escapeHtml(bi("入口", "Entry route")) + ": " + escapeHtml(access.entry_route || "/finance") + "</li>",
        "<li>" + escapeHtml(bi("访问模式", "Access mode")) + ": " + escapeHtml(prettyAccessMode(access.access_mode)) + "</li>",
        "<li>" + escapeHtml(bi("有效至", "Valid until")) + ": " + escapeHtml(formatDateTime(session.valid_until || day.index_valid_until || access.session_valid_until)) + "</li>",
        "</ul>"
      ].join(""));
    }

    if (el.autorefreshCard) {
      var refreshTone = appState.lastError ? "warning" : (appState.mode === "archive" ? "neutral" : "positive");
      el.autorefreshCard.className = "live-card " + toneClassName(refreshTone);
      setHTML(el.autorefreshCard, [
        "<h3>" + escapeHtml(bi("自动刷新", "Auto-refresh")) + "</h3>",
        "<p>" + escapeHtml(appState.lastError
          ? bi("接口异常后已暂停轮询，当前保留最近一次成功快照。", "Polling paused after an API issue. The last successful snapshot stays on screen.")
          : (appState.mode === "archive"
            ? bi("历史回放已固定，直到你切回最新视图。", "Archive replay is pinned until you switch back to latest.")
            : bi("最新模式会轮询状态接口，以捕捉新的金融分析产物。", "Latest mode polls the status endpoint to catch new finance artifacts."))) + "</p>",
        '<ul class="live-meta-list">',
        "<li>" + escapeHtml(bi("最新生成", "Latest generated")) + ": " + escapeHtml(formatDateTime(appState.lastStatus && appState.lastStatus.latest_generated_at || day.generated_at)) + "</li>",
        "<li>" + escapeHtml(bi("建议轮询", "Recommended poll")) + ": " + escapeHtml(String(appState.lastStatus && appState.lastStatus.recommended_poll_seconds || appState.recommendedPollSeconds || 60)) + "s</li>",
        "<li>" + escapeHtml(bi("当前时间", "Now")) + ": " + escapeHtml(formatDateTime(appState.lastStatus && appState.lastStatus.now || day.generated_at)) + "</li>",
        "</ul>"
      ].join(""));
    }

    renderCompactNews(news);
  }

  function renderBreadthChart(entries) {
    var hasData = entries.some(function (entry) {
      var breadth = entry.summary && entry.summary.breadth || {};
      return Number(asNumber(breadth.total) || asNumber(breadth.up) || asNumber(breadth.down) || asNumber(breadth.flat));
    });

    if (!hasData) {
      renderEmpty(el.marketBreadthChart, bi("宽度图表暂未就绪", "Breadth chart not available yet"), bi("市场扫描完成后，这里会展示晨间涨跌宽度。", "Morning breadth data will render here after the scan finishes."));
      return;
    }

    var rows = entries.map(function (entry) {
      var breadth = entry.summary && entry.summary.breadth || {};
      var up = asNumber(breadth.up) || 0;
      var down = asNumber(breadth.down) || 0;
      var flat = asNumber(breadth.flat) || 0;
      var total = asNumber(breadth.total) || (up + down + flat);
      var upWidth = total ? (up / total) * 100 : 0;
      var flatWidth = total ? (flat / total) * 100 : 0;
      var downWidth = total ? (down / total) * 100 : 0;

      return [
        '<div class="breadth-row">',
        '<div class="breadth-row-label">' + escapeHtml(marketDisplayName(entry.key)) + "</div>",
        '<div class="stacked-bar">',
        buildSegment(upWidth, "segment-up"),
        buildSegment(flatWidth, "segment-flat"),
        buildSegment(downWidth, "segment-down"),
        "</div>",
        '<div class="breadth-meta">' + escapeHtml(up + " / " + flat + " / " + down) + "</div>",
        "</div>"
      ].join("");
    });

    setHTML(el.marketBreadthChart, [
      '<div class="breadth-list">',
      rows.join(""),
      "</div>",
      '<div class="legend-row">',
      '<span class="legend-chip"><span class="legend-swatch segment-up"></span>' + escapeHtml(bi("上涨", "Up")) + "</span>",
      '<span class="legend-chip"><span class="legend-swatch segment-flat"></span>' + escapeHtml(bi("平盘", "Flat")) + "</span>",
      '<span class="legend-chip"><span class="legend-swatch segment-down"></span>' + escapeHtml(bi("下跌", "Down")) + "</span>",
      "</div>"
    ].join(""));
  }

  function renderCandidateDistributionChart(entries) {
    var maxCount = 0;
    entries.forEach(function (entry) {
      maxCount = Math.max(maxCount, asNumber(entry.summary && entry.summary.candidate_count) || 0);
    });

    if (!maxCount) {
      renderEmpty(el.candidateDistributionChart, bi("候选分布暂未就绪", "Candidate distribution not available yet"), bi("晨间扫描完成后，可见市场会在这里显示候选数量。", "Visible markets will show candidate counts after the morning scan."));
      return;
    }

    var columns = entries.map(function (entry) {
      var count = asNumber(entry.summary && entry.summary.candidate_count) || 0;
      var height = maxCount ? Math.max(8, (count / maxCount) * 100) : 0;
      return [
        '<div class="candidate-column">',
        '<div class="candidate-bar">',
        '<div class="candidate-bar-fill" style="height:' + escapeHtml(height.toFixed(2)) + '%"></div>',
        "</div>",
        '<div class="candidate-label">' + escapeHtml(marketDisplayName(entry.key)) + "</div>",
        '<div class="candidate-value">' + escapeHtml(formatNumber(count)) + " " + escapeHtml(bi("个候选", "candidates")) + "</div>",
        "</div>"
      ].join("");
    });

    setHTML(el.candidateDistributionChart, '<div class="candidate-chart">' + columns.join("") + "</div>");
  }

  function renderMarketSummaryCards(entries) {
    if (!entries.length) {
      renderEmpty(el.marketSummaryCards, bi("市场摘要待就绪", "Market summary pending"), bi("请选择一个可见市场，或等待晨报数据填充摘要卡片。", "Select a visible market or wait for the morning payload."));
      return;
    }

    var html = entries.map(function (entry) {
      var summary = entry.summary || {};
      var indexRow = safeArray(summary.indices)[0];
      var leaderRow = safeArray(summary.leaders)[0];
      var pickRows = safeArray(summary.picks).slice(0, 3);

      return [
        '<article class="summary-card">',
        '<div class="summary-head">',
        "<div>",
        '<h3 class="summary-market">' + escapeHtml(marketDisplayName(entry.key)) + "</h3>",
        '<p class="summary-temp">' + escapeHtml(summary.temperature || bi("暂未就绪", "Not ready")) + "</p>",
        "</div>",
        '<span class="inline-pill">' + escapeHtml(String(asNumber(summary.candidate_count) || 0)) + " " + escapeHtml(bi("个机会", "setups")) + "</span>",
        "</div>",
        '<div class="summary-block">',
        summaryRowHTML(bi("宽度", "Breadth"), breadthLabel(summary.breadth)),
        summaryRowHTML(bi("指数脉冲", "Index pulse"), marketRowLabel(indexRow)),
        summaryRowHTML(bi("领涨", "Leader"), marketRowLabel(leaderRow)),
        "</div>",
        pickRows.length ? '<div class="inline-list">' + pickRows.map(function (item) {
          return '<span class="inline-pill">' + escapeHtml((item.display_symbol || item.symbol || item.name || bi("标的", "Pick")) + " " + formatSignedPercent(item.pct_chg)) + "</span>";
        }).join("") + "</div>" : '<div class="inline-list"><span class="inline-pill">' + escapeHtml(bi("暂无优选", "No picks yet")) + "</span></div>",
        "</article>"
      ].join("");
    }).join("");

    setHTML(el.marketSummaryCards, html);
  }

  function renderMorningOverlap(morning) {
    var positions = getSortedPositions(getDay().content && getDay().content.noon || {});
    var overlapItems = buildOverlapItems(morning, positions);

    if (!overlapItems.length) {
      renderEmpty(el.morningOverlapList, bi("暂未发现重叠", "No overlap yet"), bi("晨报优选与 AI 模拟持仓的交集会在这里显示。", "Morning picks and simulated positions are compared here."));
      return;
    }

    setHTML(el.morningOverlapList, overlapItems.slice(0, 6).map(function (item) {
      return [
        '<article class="overlap-card">',
        "<div>",
        '<div class="overlap-symbol">' + escapeHtml(item.display_symbol || item.symbol || item.name || bi("观点", "Idea")) + "</div>",
        "<p>" + escapeHtml(item.name || bi("未命名标的", "Unnamed instrument")) + "</p>",
        '<p class="overlap-meta">' + escapeHtml((item.market ? marketDisplayName(item.market) + " · " : "") + (item.note || bi("来自晨报与 AI 联动参考。", "Referenced by the morning AI linkage."))) + "</p>",
        "</div>",
        '<span class="overlap-flag">' + escapeHtml(item.held ? bi("已在持仓", "In portfolio") : bi("观察名单", "Watchlist")) + "</span>",
        "</article>"
      ].join("");
    }).join(""));
  }

  function renderNewsBriefsLegacy(news) {
    var cards = [];
    var selectedNews = safeArray(news.selected_news).slice(0, 6);
    var watchPoints = safeArray(news.watch_points).slice(0, 6);
    var newsSummary = news.news_summary || {};
    var reportDigest = parseReportDigest(news.message_text);

    if (newsSummary.headline || safeArray(newsSummary.bullets).length) {
      cards.push([
        '<article class="news-card news-card--summary">',
        '<p class="news-kicker">' + escapeHtml(newsSummary.mode === "openclaw" ? bi("OpenClaw 摘要", "OpenClaw brief") : bi("摘要", "Summary")) + "</p>",
        newsSummary.headline ? '<p class="news-title">' + escapeHtml(newsSummary.headline) + "</p>" : "",
        safeArray(newsSummary.bullets).length
          ? '<ul class="note-list">' + safeArray(newsSummary.bullets).slice(0, 3).map(function (item) {
            return "<li>" + escapeHtml(item) + "</li>";
          }).join("") + "</ul>"
          : "",
        newsSummary.risk_note ? '<p class="news-meta">' + escapeHtml(newsSummary.risk_note) + "</p>" : "",
        "</article>"
      ].join(""));
    }

    if (reportDigest.title || reportDigest.sections.length) {
      cards.push([
        '<article class="news-card news-card--reading">',
        '<p class="news-kicker">' + escapeHtml(bi("详细新闻报", "Detailed briefing")) + "</p>",
        reportDigest.title ? '<p class="news-title">' + escapeHtml(reportDigest.title) + "</p>" : "",
        safeArray(reportDigest.intro).length
          ? '<div class="reading-intro">' + safeArray(reportDigest.intro).slice(0, 2).map(function (item) {
            return "<p>" + escapeHtml(item) + "</p>";
          }).join("") + "</div>"
          : "",
        reportDigest.sections.length
          ? '<div class="reading-stack">' + reportDigest.sections.map(function (section, index) {
            return [
              '<details class="reading-section"' + (index === 0 ? " open" : "") + ">",
              "<summary>" + escapeHtml(section.title) + "</summary>",
              '<div class="reading-section-content">',
              section.rows.length
                ? '<ul class="reading-section-list">' + section.rows.map(function (item) {
                  return "<li>" + escapeHtml(item) + "</li>";
                }).join("") + "</ul>"
                : "",
              "</div>",
              "</details>"
            ].join("");
          }).join("") + "</div>"
          : "",
        "</article>"
      ].join(""));
    }

    selectedNews.forEach(function (item) {
      var url = safeUrl(item.url);
      cards.push([
        '<article class="news-card">',
        '<p class="news-kicker">' + escapeHtml(bi("精选标题", "Selected headline")) + "</p>",
        url !== "#"
          ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">'
          : "<div>",
        '<p class="news-title">' + escapeHtml(item.title || bi("未命名标题", "Untitled headline")) + "</p>",
        url !== "#" ? "</a>" : "</div>",
        item.ai_summary ? '<p class="news-brief">' + escapeHtml(item.ai_summary) + "</p>" : "",
        '<p class="news-meta">' + escapeHtml((item.source || bi("来源待补", "Source pending")) + " · " + formatDateTime(item.published_at)) + "</p>",
        "</article>"
      ].join(""));
    });

    if (watchPoints.length) {
      cards.push([
        '<article class="news-card">',
        '<p class="news-kicker">' + escapeHtml(bi("观察点", "Watch points")) + "</p>",
        '<ul class="note-list">',
        watchPoints.map(function (item) {
          return "<li>" + escapeHtml(item) + "</li>";
        }).join(""),
        "</ul>",
        "</article>"
      ].join(""));
    }

    if (!cards.length) {
      renderEmpty(el.newsBriefList, bi("新闻流暂未就绪", "News stream not available yet"), bi("08:00 新闻推送完成后，精选标题和观察点会在这里出现。", "Selected headlines and watch points appear here after the 08:00 push."));
      return;
    }

    setHTML(el.newsBriefList, cards.join(""));
  }

  function renderMorningDriversLegacy(morning) {
    var drivers = safeArray(morning.drivers).slice(0, 4);
    var errors = toKeyValuePairs(morning.errors);
    var items = [];

    drivers.forEach(function (item) {
      var url = safeUrl(item.url);
      items.push([
        '<article class="driver-item">',
        '<div class="driver-copy">',
        '<p class="driver-label">' + escapeHtml(bi("驱动", "Driver")) + "</p>",
        url !== "#"
          ? '<a class="driver-link" href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener"><p class="driver-title">' + escapeHtml(item.title || bi("未命名驱动", "Untitled driver")) + "</p></a>"
          : '<p class="driver-title">' + escapeHtml(item.title || bi("未命名驱动", "Untitled driver")) + "</p>",
        item.ai_summary ? '<p class="driver-brief">' + escapeHtml(item.ai_summary) + "</p>" : "",
        '<p class="driver-meta">' + escapeHtml((item.source || bi("来源待补", "Source pending")) + " · " + formatDateTime(item.published_at)) + "</p>",
        "</div>",
        statusPillHTML(bi("实时", "Live"), "ready", true),
        "</article>"
      ].join(""));
    });

    errors.slice(0, 2).forEach(function (entry) {
      items.push([
        '<article class="driver-item">',
        '<div class="driver-copy">',
        '<p class="driver-label">' + escapeHtml(bi("覆盖备注", "Coverage note")) + "</p>",
        '<p class="driver-title">' + escapeHtml(entry.key) + "</p>",
        '<p class="driver-meta">' + escapeHtml(entry.value) + "</p>",
        "</div>",
        statusPillHTML(bi("源", "Source"), "warning", true),
        "</article>"
      ].join(""));
    });

    if (!items.length) {
      renderEmpty(el.morningDriverList, bi("晨间驱动待就绪", "Morning drivers pending"), bi("晨报准备完成后，跨市场驱动与覆盖备注会在这里出现。", "Cross-market catalysts and coverage notes appear here when the morning payload is ready."));
      return;
    }

    setHTML(el.morningDriverList, items.join(""));
  }

  function renderPortfolioPath(summary) {
    var previous = asNumber(summary.previous_portfolio_value);
    var current = asNumber(summary.portfolio_value);

    if (previous === null && current === null) {
      renderEmpty(el.portfolioCurveChart, bi("净值路径暂不可用", "Portfolio path unavailable"), bi("午间组合分析带出净值数据后，这里会绘制会话路径。", "The portfolio panel will draw a path once noon analysis includes value data."));
      return;
    }

    var values;
    if (previous !== null && current !== null) {
      values = [
        previous,
        previous + ((current - previous) * 0.28),
        previous + ((current - previous) * 0.62),
        current
      ];
    } else {
      var baseline = current !== null ? current : previous;
      values = [baseline, baseline, baseline, baseline];
    }

    var labels = ["昨收", "开盘", "中段", "现在"];
    setHTML(el.portfolioCurveChart, '<div class="sparkline-shell">' + buildSparklineSVG(values, labels) + "</div>");
  }

  function renderAllocationList(allocations) {
    if (!allocations.length) {
      renderEmpty(el.allocationList, bi("敞口分布暂未就绪", "Allocation split not available yet"), bi("午间组合分析准备完成后，这里会出现分类敞口。", "Allocation buckets appear here once noon analysis is ready."));
      return;
    }

    setHTML(el.allocationList, allocations.slice(0, 6).map(function (item) {
      var pct = asNumber(item.category_pct) || 0;
      var amount = asNumber(item.category_amount);
      var picks = safeArray(item.picks).slice(0, 2).map(function (pick) {
        return pick.symbol || pick.name || bi("持仓", "Holding");
      }).join(" · ");
      var metaParts = [
        amount === null ? "" : formatCurrency(amount),
        picks ? bi("重点", "Focus") + " " + picks : ""
      ].filter(Boolean);
      return [
        '<div class="exposure-row">',
        '<div class="exposure-head">',
        '<div class="exposure-copy">',
        '<span class="exposure-name">' + escapeHtml(item.name || item.key || bi("分类", "Bucket")) + "</span>",
        metaParts.length ? '<p class="exposure-meta">' + escapeHtml(metaParts.join(" · ")) + "</p>" : "",
        "</div>",
        "<strong>" + escapeHtml(formatRatioPercent(pct)) + "</strong>",
        "</div>",
        '<div class="bar-track"><div class="bar-fill" style="width:' + escapeHtml(scaleRatioPercent(pct).toFixed(2)) + '%"></div></div>',
        "</div>"
      ].join("");
    }).join(""));
  }

  function renderRiskStrip(risk, overlapCount) {
    setHTML(el.riskStrip, [
      riskChipHTML(bi("最大单仓", "Largest line"), formatRatioPercent(risk.largestPct), bi("当前最高单一持仓权重。", "Highest single position weight.")),
      riskChipHTML(bi("前三合计", "Top three"), formatRatioPercent(risk.topThreePct), bi("前三大持仓合计占比。", "Combined share of the top three holdings.")),
      riskChipHTML(bi("重叠数量", "Overlap"), String(overlapCount), bi("晨报观点中已反映到模拟仓的数量。", "Morning ideas currently reflected in the simulated book."))
    ].join(""));
  }

  function renderHoldingList(positions) {
    if (!positions.length) {
      renderEmpty(el.holdingList, bi("持仓暂未就绪", "Holdings not available yet"), bi("午间组合数据就绪后，这里会列出当前 AI 模拟持仓。", "Current simulated holdings appear here when the noon payload is present."));
      return;
    }

    setHTML(el.holdingList, positions.slice(0, 6).map(function (item) {
      var pct = asNumber(item.portfolio_pct) || 0;
      var amount = asNumber(item.amount_usd);
      var symbol = item.symbol || "";
      var metaParts = [
        item.category || bi("分类待补", "Category pending"),
        amount === null ? "" : formatCurrency(amount),
        formatDateTime(item.updated_at)
      ].filter(Boolean);
      return [
        '<article class="holding-item">',
        '<div class="holding-main">',
        '<div class="holding-headline">',
        '<p class="holding-name">' + escapeHtml(item.name || symbol || bi("未命名持仓", "Unnamed position")) + "</p>",
        symbol ? '<span class="holding-symbol">' + escapeHtml(symbol) + "</span>" : "",
        "</div>",
        '<p class="holding-meta">' + escapeHtml(metaParts.join(" · ")) + "</p>",
        '<div class="holding-bar-track"><div class="holding-bar-fill" style="width:' + escapeHtml(scaleRatioPercent(pct).toFixed(2)) + '%"></div></div>',
        "</div>",
        '<div class="holding-weight"><strong>' + escapeHtml(formatRatioPercent(pct)) + '</strong><span>' + escapeHtml(bi("组合占比", "Portfolio share")) + "</span></div>",
        "</article>"
      ].join("");
    }).join(""));
  }

  function renderImpactList(container, items, emptyLabel) {
    if (!container) {
      return;
    }

    if (!items.length) {
      renderEmpty(container, emptyLabel + " " + bi("待就绪", "pending"), emptyLabel + " " + bi("会在收益归因数据准备完成后显示。", "will appear here when PnL attribution is available."));
      return;
    }

    setHTML(container, items.slice(0, 5).map(function (item) {
      return [
        '<article class="impact-entry">',
        "<div>",
        '<p class="impact-name">' + escapeHtml(item.name || item.symbol || bi("未命名标的", "Unnamed line")) + "</p>",
        '<p class="impact-meta">' + escapeHtml((item.category || bi("分类待补", "Category pending")) + " · " + formatSignedRatioPercent(item.ret_1d)) + "</p>",
        "</div>",
        '<div class="impact-value">' + escapeHtml(formatSignedCurrency(item.pnl_amount)) + "</div>",
        "</article>"
      ].join("");
    }).join(""));
  }

  function renderCompactNewsLegacy(news) {
    var items = safeArray(news.selected_news).slice(0, 8);
    if (!items.length) {
      renderEmpty(el.compactNewsList, bi("标题脉冲待就绪", "Headline pulse pending"), bi("新闻工件生成后，最新标题会在这里叠放显示。", "Latest headlines will stack here once the news artifact is ready."));
      return;
    }

    setHTML(el.compactNewsList, items.map(function (item) {
      var url = safeUrl(item.url);
      return [
        '<a class="compact-news-link" href="' + escapeHtml(url) + '" ' + (url !== "#" ? 'target="_blank" rel="noreferrer noopener"' : "") + ">",
        "<strong>" + escapeHtml(item.title || bi("未命名标题", "Untitled headline")) + "</strong>",
        "<span>" + escapeHtml((item.source || bi("来源待补", "Source pending")) + " · " + formatDateTime(item.published_at)) + "</span>",
        "</a>"
      ].join("");
    }).join(""));
  }

  function parseReportDigest(messageText) {
    var text = String(messageText || "").replace(/\r/g, "").trim();
    if (!text) {
      return { title: "", intro: [], sections: [] };
    }

    var blocks = text.split(/\n\s*\n+/).map(function (block) {
      return block.trim();
    }).filter(Boolean);

    if (!blocks.length) {
      return { title: "", intro: [], sections: [] };
    }

    var headLines = blocks.shift().split("\n").map(function (line) {
      return line.trim();
    }).filter(Boolean);

    return {
      title: headLines[0] || "",
      intro: headLines.slice(1, 3),
      sections: blocks.map(function (block, index) {
        var lines = block.split("\n").map(function (line) {
          return line.trim();
        }).filter(Boolean);
        if (!lines.length) {
          return null;
        }
        return {
          title: lines.length > 1 ? lines[0] : bi("阅读详情 " + String(index + 1), "Read more " + String(index + 1)),
          rows: lines.length > 1 ? lines.slice(1) : lines
        };
      }).filter(Boolean)
    };
  }

  function renderNewsBriefs(news) {
    var cards = [];
    var selectedNews = safeArray(news.selected_news).slice(0, 6);
    var watchPoints = safeArray(news.watch_points).slice(0, 6);
    var newsSummary = news.news_summary || {};
    var reportDigest = parseReportDigest(news.message_text);

    if (newsSummary.headline || safeArray(newsSummary.bullets).length) {
      cards.push([
        '<article class="news-card news-card--summary">',
        '<p class="news-kicker">' + escapeHtml(newsSummary.mode === "openclaw" ? bi("OpenClaw 摘要", "OpenClaw brief") : bi("摘要", "Summary")) + "</p>",
        newsSummary.headline ? '<p class="news-title">' + escapeHtml(newsSummary.headline) + "</p>" : "",
        safeArray(newsSummary.bullets).length
          ? '<ul class="note-list">' + safeArray(newsSummary.bullets).slice(0, 3).map(function (item) {
            return "<li>" + escapeHtml(item) + "</li>";
          }).join("") + "</ul>"
          : "",
        newsSummary.risk_note ? '<p class="news-meta">' + escapeHtml(newsSummary.risk_note) + "</p>" : "",
        "</article>"
      ].join(""));
    }

    if (reportDigest.title || reportDigest.sections.length) {
      cards.push(buildReadingCardHTML({
        kicker: bi("详细新闻报", "Detailed briefing"),
        title: reportDigest.title || newsSummary.headline || bi("今日新闻报", "Daily news briefing"),
        intro: reportDigest.intro,
        sections: reportDigest.sections
      }));
    }

    selectedNews.forEach(function (item) {
      var url = safeUrl(item.url);
      cards.push([
        '<article class="news-card">',
        '<p class="news-kicker">' + escapeHtml(bi("精选标题", "Selected headline")) + "</p>",
        url !== "#"
          ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">'
          : "<div>",
        '<p class="news-title">' + escapeHtml(item.title || bi("未命名标题", "Untitled headline")) + "</p>",
        url !== "#" ? "</a>" : "</div>",
        item.ai_summary ? '<p class="news-brief">' + escapeHtml(item.ai_summary) + "</p>" : "",
        '<p class="news-meta">' + escapeHtml((item.source || bi("来源待补", "Source pending")) + " · " + formatDateTime(item.published_at)) + "</p>",
        "</article>"
      ].join(""));
    });

    if (watchPoints.length) {
      cards.push([
        '<article class="news-card">',
        '<p class="news-kicker">' + escapeHtml(bi("观察点", "Watch points")) + "</p>",
        '<ul class="note-list">',
        watchPoints.map(function (item) {
          return "<li>" + escapeHtml(item) + "</li>";
        }).join(""),
        "</ul>",
        "</article>"
      ].join(""));
    }

    if (!cards.length) {
      renderEmpty(el.newsBriefList, bi("新闻流暂未就绪", "News stream not available yet"), bi("08:00 新闻推送完成后，精选标题和观察点会在这里出现。", "Selected headlines and watch points appear here after the 08:00 push."));
      return;
    }

    setHTML(el.newsBriefList, cards.join(""));
    syncReadingCardStates(el.newsBriefList);
  }

  function renderMorningDrivers(morning) {
    var drivers = safeArray(morning.drivers).slice(0, 4);
    var errors = toKeyValuePairs(morning.errors);
    var reportDigest = parseReportDigest(morning.message_text);
    var readingSections = reportDigest.sections.slice();
    var items = [];

    if (morning.ai_reference && morning.ai_reference.note) {
      readingSections.unshift({
        title: bi("AI 联动备注", "AI linkage note"),
        rows: [morning.ai_reference.note]
      });
    }

    if (drivers.length) {
      readingSections.push({
        title: bi("晨间核心驱动", "Core morning drivers"),
        rows: drivers.slice(0, 3).map(function (item) {
          return item.ai_summary || item.title || bi("未命名驱动", "Untitled driver");
        })
      });
    }

    if (reportDigest.title || reportDigest.intro.length || readingSections.length) {
      items.push(buildReadingCardHTML({
        kicker: bi("晨报长读", "Morning briefing"),
        title: reportDigest.title || bi("交易日晨报", "Trading-day morning note"),
        intro: reportDigest.intro,
        sections: readingSections
      }));
    }

    drivers.forEach(function (item) {
      var url = safeUrl(item.url);
      items.push([
        '<article class="driver-item">',
        '<div class="driver-copy">',
        '<p class="driver-label">' + escapeHtml(bi("驱动", "Driver")) + "</p>",
        url !== "#"
          ? '<a class="driver-link" href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener"><p class="driver-title">' + escapeHtml(item.title || bi("未命名驱动", "Untitled driver")) + "</p></a>"
          : '<p class="driver-title">' + escapeHtml(item.title || bi("未命名驱动", "Untitled driver")) + "</p>",
        item.ai_summary ? '<p class="driver-brief">' + escapeHtml(item.ai_summary) + "</p>" : "",
        '<p class="driver-meta">' + escapeHtml((item.source || bi("来源待补", "Source pending")) + " · " + formatDateTime(item.published_at)) + "</p>",
        "</div>",
        statusPillHTML(bi("实时", "Live"), "ready", true),
        "</article>"
      ].join(""));
    });

    errors.slice(0, 2).forEach(function (entry) {
      items.push([
        '<article class="driver-item">',
        '<div class="driver-copy">',
        '<p class="driver-label">' + escapeHtml(bi("覆盖备注", "Coverage note")) + "</p>",
        '<p class="driver-title">' + escapeHtml(entry.key) + "</p>",
        '<p class="driver-meta">' + escapeHtml(entry.value) + "</p>",
        "</div>",
        statusPillHTML(bi("源", "Source"), "warning", true),
        "</article>"
      ].join(""));
    });

    if (!items.length) {
      renderEmpty(el.morningDriverList, bi("晨间驱动待就绪", "Morning drivers pending"), bi("晨报准备完成后，跨市场驱动与覆盖备注会在这里出现。", "Cross-market catalysts and coverage notes appear here when the morning payload is ready."));
      return;
    }

    setHTML(el.morningDriverList, items.join(""));
    syncReadingCardStates(el.morningDriverList);
  }

  function renderPortfolioPanel() {
    var day = getDay();
    var morning = day.content && day.content.morning || {};
    var noon = day.content && day.content.noon || {};
    var summary = noon.portfolio_summary || day.top_status && day.top_status.portfolio_summary || {};
    var positions = getSortedPositions(noon);
    var allocations = getAllocationRows(noon);
    var overlapItems = buildOverlapItems(morning, positions);
    var risk = computeRisk(positions);

    if (el.portfolioPanelCopy) {
      el.portfolioPanelCopy.textContent = bi("晨报重叠 " + overlapItems.length + " 个，当前为 " + risk.label + "，共 " + positions.length + " 个持仓。", "There are " + overlapItems.length + " overlaps with morning ideas, " + risk.label + " across " + positions.length + " holdings.");
    }

    if (el.portfolioMetricGrid) {
      var metrics = [
        metricCardHTML(bi("账户净值", "Account value"), formatCurrency(summary.portfolio_value), bi("当前 AI 模拟账户净值。", "Current simulated account value."), "neutral"),
        metricCardHTML(bi("当日盈亏", "Daily PnL"), formatSignedCurrency(summary.daily_pnl_amount), formatSignedRatioPercent(summary.daily_pnl_pct), toneFromNumeric(summary.daily_pnl_amount)),
        metricCardHTML(bi("换手规模", "Turnover"), formatCurrency(summary.turnover_amount), formatSignedRatioPercent(summary.turnover_pct) + " " + bi("占组合", "of portfolio"), toneFromNumeric(summary.turnover_pct)),
        metricCardHTML(bi("持仓数量", "Holdings"), String(positions.length || asNumber(summary.holding_count) || 0), bi("当前 AI 模拟持仓数量。", "Current simulated positions."), "neutral"),
        metricCardHTML(bi("重叠数量", "Overlap count"), String(overlapItems.length), bi("晨报优选与模拟仓的交集。", "Morning picks intersecting with the book."), overlapItems.length ? "positive" : "neutral"),
        metricCardHTML(bi("风险姿态", "Risk posture"), risk.label, bi("最大单仓", "Largest line") + " " + formatRatioPercent(risk.largestPct) + " · " + bi("前三合计", "top three") + " " + formatRatioPercent(risk.topThreePct), risk.tone)
      ];
      setHTML(el.portfolioMetricGrid, metrics.join(""));
    }

    renderPortfolioPath(summary);
    renderNoonBriefing(noon);
    renderAllocationList(allocations);
    renderRiskStrip(risk, overlapItems.length);
    renderHoldingList(positions);
    renderImpactList(el.contributorsList, safeArray(summary.top_contributors), bi("贡献项", "Contributors"));
    renderImpactList(el.detractorsList, safeArray(summary.top_detractors), bi("拖累项", "Detractors"));
  }

  function renderCompactNews(news) {
    var items = safeArray(news.selected_news).slice(0, 8);
    if (!items.length) {
      renderEmpty(el.compactNewsList, bi("标题脉冲待就绪", "Headline pulse pending"), bi("新闻工件生成后，最新标题会在这里叠放显示。", "Latest headlines will stack here once the news artifact is ready."));
      return;
    }

    setHTML(el.compactNewsList, items.map(function (item) {
      var url = safeUrl(item.url);
      return [
        '<a class="compact-news-link" href="' + escapeHtml(url) + '" ' + (url !== "#" ? 'target="_blank" rel="noreferrer noopener"' : "") + ">",
        "<strong>" + escapeHtml(item.title || bi("未命名标题", "Untitled headline")) + "</strong>",
        item.ai_summary ? '<span class="compact-news-copy">' + escapeHtml(item.ai_summary) + "</span>" : "",
        "<span>" + escapeHtml((item.source || bi("来源待补", "Source pending")) + " · " + formatDateTime(item.published_at)) + "</span>",
        "</a>"
      ].join("");
    }).join(""));
  }

  function renderNoonBriefing(noon) {
    if (!el.noonReadingList) {
      return;
    }

    var reportDigest = parseReportDigest(noon.message_text);
    var aiSummary = noon.ai_summary || {};
    var advice = safeArray(noon.advice).slice(0, 4);
    var intro = reportDigest.intro.slice();
    var sections = reportDigest.sections.slice();
    var aiRows = [];

    if (aiSummary.headline && intro.indexOf(aiSummary.headline) === -1) {
      intro.unshift(aiSummary.headline);
    }
    aiRows = aiRows.concat(safeArray(aiSummary.bullets).slice(0, 4));
    if (aiSummary.risk_note) {
      aiRows.push(aiSummary.risk_note);
    }
    if (aiRows.length) {
      sections.unshift({
        title: bi("AI 摘要", "AI synopsis"),
        rows: aiRows
      });
    }
    if (advice.length) {
      sections.push({
        title: bi("组合建议", "Portfolio advice"),
        rows: advice
      });
    }

    if (!reportDigest.title && !intro.length && !sections.length && !aiSummary.headline) {
      renderEmpty(el.noonReadingList, bi("午报长读待就绪", "Noon briefing pending"), bi("午间分析准备完成后，这里会出现 AI 总结与组合建议。", "The noon analysis, AI summary, and portfolio advice will appear here once generated."));
      return;
    }

    setHTML(el.noonReadingList, buildReadingCardHTML({
      kicker: bi("午报长读", "Noon briefing"),
      title: reportDigest.title || aiSummary.headline || bi("AI 模拟持仓午报", "AI portfolio noon note"),
      intro: intro.slice(0, 3),
      sections: sections
    }));
    syncReadingCardStates(el.noonReadingList);
  }

  function buildReadingCardHTML(options) {
    options = options || {};
    var intro = safeArray(options.intro).map(normalizeReadingText).filter(Boolean).slice(0, 3);
    var sections = safeArray(options.sections).map(function (section, index) {
      return normalizeReadingSection(section, index);
    }).filter(Boolean);
    var copyText = buildReadingCopyText({
      title: options.title,
      intro: intro,
      sections: sections
    });
    var className = ["news-card", "news-card--reading", options.className || ""].join(" ").trim();
    var actions = [];

    if (sections.length) {
      actions.push('<button class="reading-action" type="button" data-reading-toggle aria-expanded="false">' + escapeHtml(bi("展开全部", "Expand all")) + "</button>");
    }
    if (copyText) {
      actions.push('<button class="reading-action" type="button" data-reading-copy="' + escapeHtml(encodeDataPayload(copyText)) + '">' + escapeHtml(bi("复制摘要", "Copy summary")) + "</button>");
    }

    return [
      '<article class="' + escapeHtml(className) + '" data-reading-card>',
      '<div class="reading-head">',
      '<div class="reading-head-copy">',
      '<p class="news-kicker">' + escapeHtml(options.kicker || bi("长读卡片", "Reading card")) + "</p>",
      options.title ? '<p class="news-title">' + escapeHtml(options.title) + "</p>" : "",
      "</div>",
      actions.length ? '<div class="reading-actions">' + actions.join("") + "</div>" : "",
      "</div>",
      intro.length
        ? '<div class="reading-intro">' + intro.map(function (item) {
          return "<p>" + escapeHtml(item) + "</p>";
        }).join("") + "</div>"
        : "",
      sections.length
        ? '<div class="reading-stack">' + sections.map(function (section, index) {
          return [
            '<details class="reading-section"' + (index === 0 ? " open" : "") + ">",
            "<summary>" + escapeHtml(section.title) + "</summary>",
            '<div class="reading-section-content">',
            section.rows.length
              ? '<ul class="reading-section-list">' + section.rows.map(function (item) {
                return "<li>" + escapeHtml(item) + "</li>";
              }).join("") + "</ul>"
              : "",
            "</div>",
            "</details>"
          ].join("");
        }).join("") + "</div>"
        : "",
      "</article>"
    ].join("");
  }

  function normalizeReadingSection(section, index) {
    if (!section) {
      return null;
    }

    var rows = safeArray(section.rows).map(normalizeReadingText).filter(Boolean);
    var title = normalizeReadingText(section.title);
    if (!title && !rows.length) {
      return null;
    }

    return {
      title: title || bi("阅读详情 " + String(index + 1), "Read more " + String(index + 1)),
      rows: rows
    };
  }

  function normalizeReadingText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function buildReadingCopyText(options) {
    options = options || {};
    var lines = [];

    if (normalizeReadingText(options.title)) {
      lines.push(normalizeReadingText(options.title));
    }

    safeArray(options.intro).forEach(function (item) {
      var normalized = normalizeReadingText(item);
      if (normalized) {
        lines.push(normalized);
      }
    });

    safeArray(options.sections).forEach(function (section) {
      if (!section) {
        return;
      }

      var title = normalizeReadingText(section.title);
      if (title) {
        lines.push(title);
      }

      safeArray(section.rows).forEach(function (item) {
        var normalized = normalizeReadingText(item);
        if (normalized) {
          lines.push("- " + normalized);
        }
      });
    });

    return lines.join("\n").trim();
  }

  function syncReadingCardStates(container) {
    if (!container) {
      return;
    }

    Array.prototype.forEach.call(container.querySelectorAll("[data-reading-card]"), function (card) {
      syncReadingCardState(card);
    });
  }

  function syncReadingCardState(card) {
    if (!card) {
      return;
    }

    var toggle = card.querySelector("[data-reading-toggle]");
    if (!toggle) {
      return;
    }

    var sections = Array.prototype.slice.call(card.querySelectorAll(".reading-section"));
    var allOpen = sections.length && sections.every(function (section) {
      return section.open;
    });

    toggle.textContent = allOpen ? bi("收起章节", "Collapse sections") : bi("展开全部", "Expand all");
    toggle.setAttribute("aria-expanded", allOpen ? "true" : "false");
    card.classList.toggle("is-expanded", !!allOpen);
  }

  function toggleReadingCard(button) {
    var card = button && button.closest("[data-reading-card]");
    if (!card) {
      return;
    }

    var sections = Array.prototype.slice.call(card.querySelectorAll(".reading-section"));
    if (!sections.length) {
      return;
    }

    var shouldOpen = sections.some(function (section) {
      return !section.open;
    });
    sections.forEach(function (section) {
      section.open = shouldOpen;
    });
    syncReadingCardState(card);
  }

  function handleReadingCopy(button) {
    var text = decodeDataPayload(button && button.getAttribute("data-reading-copy"));
    if (!text) {
      return;
    }

    copyTextToClipboard(text).then(function () {
      showBanner(bi("阅读摘要已复制到剪贴板。", "Reading summary copied to clipboard."), "info");
      window.setTimeout(clearBanner, 2200);
    }).catch(function () {
      showBanner(bi("复制失败，请手动选择文本。", "Copy failed. Please select the text manually."), "warning");
    });
  }

  function encodeDataPayload(value) {
    return encodeURIComponent(String(value || ""));
  }

  function decodeDataPayload(value) {
    if (!value) {
      return "";
    }

    try {
      return decodeURIComponent(String(value));
    } catch (_error) {
      return String(value);
    }
  }

  function copyTextToClipboard(text) {
    var normalized = String(text || "").trim();
    if (!normalized) {
      return Promise.reject(new Error("empty_copy_text"));
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(normalized);
    }

    return new Promise(function (resolve, reject) {
      var textarea = document.createElement("textarea");
      textarea.value = normalized;
      textarea.setAttribute("readonly", "readonly");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      try {
        if (document.execCommand("copy")) {
          document.body.removeChild(textarea);
          resolve();
          return;
        }
      } catch (error) {
        document.body.removeChild(textarea);
        reject(error);
        return;
      }

      document.body.removeChild(textarea);
      reject(new Error("copy_command_failed"));
    });
  }

  function scheduleCanvasBalance() {
    if (!el.canvasGrid) {
      return;
    }

    if (appState.canvasBalanceFrame) {
      window.cancelAnimationFrame(appState.canvasBalanceFrame);
    }

    appState.canvasBalanceFrame = window.requestAnimationFrame(function () {
      appState.canvasBalanceFrame = null;
      balanceCanvasCards();
    });
  }

  function ensureCanvasColumns() {
    if (!el.canvasGrid) {
      return null;
    }

    var hero = el.canvasGrid.querySelector(".canvas-card--hero");
    if (!hero) {
      return null;
    }

    var primary = document.getElementById("canvas-column-primary");
    var secondary = document.getElementById("canvas-column-secondary");

    if (!primary) {
      primary = document.createElement("div");
      primary.id = "canvas-column-primary";
      primary.className = "canvas-column";
    }

    if (!secondary) {
      secondary = document.createElement("div");
      secondary.id = "canvas-column-secondary";
      secondary.className = "canvas-column";
    }

    hero.insertAdjacentElement("afterend", primary);
    primary.insertAdjacentElement("afterend", secondary);

    return {
      hero: hero,
      primary: primary,
      secondary: secondary
    };
  }

  function balanceCanvasCards() {
    var columns = ensureCanvasColumns();
    if (!columns) {
      return;
    }

    var cards = Array.prototype.slice.call(el.canvasGrid.querySelectorAll(".canvas-card:not(.canvas-card--hero)"));
    if (!cards.length) {
      return;
    }

    cards.forEach(function (card, index) {
      if (!card.getAttribute("data-canvas-order")) {
        card.setAttribute("data-canvas-order", String(index + 1));
      }
    });

    cards.sort(function (left, right) {
      return (Number(left.getAttribute("data-canvas-order")) || 0) - (Number(right.getAttribute("data-canvas-order")) || 0);
    });

    var availableWidth = Math.max(el.canvasGrid.getBoundingClientRect().width || 0, el.canvasGrid.clientWidth || 0);
    var shouldStack = window.matchMedia("(max-width: 980px)").matches || availableWidth < 980;
    el.canvasGrid.classList.toggle("is-stacked", shouldStack);

    if (shouldStack) {
      cards.forEach(function (card) {
        columns.primary.appendChild(card);
      });
      return;
    }

    var heights = [0, 0];
    cards.forEach(function (card) {
      var estimatedHeight = Math.max(card.getBoundingClientRect().height || 0, card.scrollHeight || 0, 220);
      var targetIndex = heights[0] <= heights[1] ? 0 : 1;
      var target = targetIndex === 0 ? columns.primary : columns.secondary;
      target.appendChild(card);
      heights[targetIndex] += estimatedHeight + 16;
    });
  }

  function decorateFocusableCardsLegacy() {
    var selector = [
      ".canvas-card",
      "#push-timeline",
      "#workspace-reference-panel",
      "#ai-portfolio-panel .subpanel",
      ".live-card",
      "#live-rail .subpanel"
    ].join(",");

    Array.prototype.forEach.call(document.querySelectorAll(selector), function (card) {
      if (!card || card.querySelector(".focus-trigger")) {
        return;
      }

      card.classList.add("focusable-card");
      card.setAttribute("data-focus-label", resolveFocusLabel(card));

      var button = document.createElement("button");
      button.type = "button";
      button.className = "focus-trigger";
      button.textContent = bi("聚焦", "Focus");
      button.setAttribute("aria-label", bi("放大查看 ", "Open focus view for ") + resolveFocusLabel(card));
      card.appendChild(button);
    });
  }

  function decorateFocusableCards() {
    var selector = [
      ".canvas-card",
      "#push-timeline",
      "#workspace-reference-panel",
      "#ai-portfolio-panel .subpanel",
      ".live-card",
      "#live-rail .subpanel"
    ].join(",");

    Array.prototype.forEach.call(document.querySelectorAll(selector), function (card) {
      if (!card) {
        return;
      }

      var label = resolveFocusLabel(card);
      card.classList.add("focusable-card");
      card.setAttribute("data-focus-ready", "true");
      card.setAttribute("data-focus-label", label);
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-haspopup", "dialog");
      card.setAttribute("aria-label", bi("鏀惧ぇ鏌ョ湅 ", "Open focus view for ") + label);
    });
  }

  function resolveFocusLabel(card) {
    if (!card) {
      return bi("内容详情", "Detail view");
    }

    var heading = card.querySelector("h2, h3, .summary-market");
    if (heading && heading.textContent.trim()) {
      return clipText(heading.textContent.trim(), 90);
    }

    if (card.id === "push-timeline") {
      return bi("多阶段推送", "Multi-stage pushes");
    }
    if (card.id === "workspace-reference-panel") {
      return bi("叙事锚点", "Narrative anchors");
    }

    return bi("内容详情", "Detail view");
  }

  function resolveFocusKicker(card) {
    if (!card) {
      return bi("聚焦查看", "Focus view");
    }

    var kicker = card.querySelector(".panel-kicker, .status-label, .news-kicker, .driver-label");
    if (kicker && kicker.textContent.trim()) {
      return clipText(kicker.textContent.trim(), 72);
    }

    return bi("聚焦查看", "Focus view");
  }

  function openFocusView(card, trigger) {
    if (!card || !el.focusOverlay || !el.focusShellBody || !el.focusShellTitle) {
      return;
    }

    appState.focus.returnNode = trigger || document.activeElement;
    appState.focus.activeLabel = resolveFocusLabel(card);

    var clone = card.cloneNode(true);
    sanitizeFocusClone(clone);
    clone.classList.add("focus-shell-card");

    el.focusShellBody.innerHTML = "";
    el.focusShellBody.appendChild(clone);
    if (el.focusShellKicker) {
      el.focusShellKicker.textContent = resolveFocusKicker(card);
    }
    el.focusShellTitle.textContent = appState.focus.activeLabel;

    el.focusOverlay.classList.remove("is-hidden");
    window.requestAnimationFrame(function () {
      el.focusOverlay.classList.add("is-active");
      el.focusOverlay.setAttribute("aria-hidden", "false");
      document.body.classList.add("focus-mode-open");
      if (el.focusCloseButton) {
        el.focusCloseButton.focus();
      }
    });
  }

  function closeFocusView() {
    if (!el.focusOverlay || el.focusOverlay.classList.contains("is-hidden")) {
      return;
    }

    el.focusOverlay.classList.remove("is-active");
    el.focusOverlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("focus-mode-open");

    window.setTimeout(function () {
      if (!el.focusOverlay || el.focusOverlay.classList.contains("is-active")) {
        return;
      }
      el.focusOverlay.classList.add("is-hidden");
      if (el.focusShellBody) {
        el.focusShellBody.innerHTML = "";
      }
    }, 220);

    if (appState.focus.returnNode && typeof appState.focus.returnNode.focus === "function") {
      appState.focus.returnNode.focus();
    }
  }

  function sanitizeFocusCloneLegacy(node) {
    if (!node) {
      return;
    }

    if (node.removeAttribute) {
      node.removeAttribute("id");
      node.removeAttribute("data-focus-label");
    }

    Array.prototype.forEach.call(node.querySelectorAll("[id]"), function (item) {
      item.removeAttribute("id");
    });

    Array.prototype.forEach.call(node.querySelectorAll(".focus-trigger"), function (item) {
      item.remove();
    });
  }

  function sanitizeFocusClone(node) {
    if (!node) {
      return;
    }

    if (node.removeAttribute) {
      node.removeAttribute("id");
      node.removeAttribute("data-focus-label");
      node.removeAttribute("data-focus-ready");
      node.removeAttribute("tabindex");
      node.removeAttribute("aria-haspopup");
      node.removeAttribute("aria-label");
    }

    if (node.classList) {
      node.classList.remove("focusable-card");
    }

    Array.prototype.forEach.call(node.querySelectorAll("[id]"), function (item) {
      item.removeAttribute("id");
    });

    Array.prototype.forEach.call(node.querySelectorAll("[data-focus-label], [data-focus-ready], [tabindex], [aria-haspopup], [aria-label]"), function (item) {
      item.removeAttribute("data-focus-label");
      item.removeAttribute("data-focus-ready");
      item.removeAttribute("tabindex");
      item.removeAttribute("aria-haspopup");
      item.removeAttribute("aria-label");
    });

    Array.prototype.forEach.call(node.querySelectorAll(".focusable-card"), function (item) {
      item.classList.remove("focusable-card");
    });

    Array.prototype.forEach.call(node.querySelectorAll(".focus-trigger"), function (item) {
      item.remove();
    });
  }

  function renderEmpty(container, title, message) {
    if (!container) {
      return;
    }
    setHTML(container, [
      '<div class="empty-note">',
      "<strong>" + escapeHtml(title) + "</strong>",
      "<p>" + escapeHtml(message) + "</p>",
      "</div>"
    ].join(""));
  }

  function showBanner(message, tone) {
    if (!el.stateBanner) {
      return;
    }
    el.stateBanner.textContent = message;
    el.stateBanner.className = "state-banner state-banner--" + (tone || "info");
  }

  function clearBanner() {
    if (!el.stateBanner) {
      return;
    }
    el.stateBanner.className = "state-banner is-hidden";
    el.stateBanner.textContent = "";
  }

  function showGlobalState(kind, overrides) {
    overrides = overrides || {};
    if (kind === "authorized") {
      hideGlobalState();
      return;
    }

    var copyMap = {
      loading: {
        kicker: bi("金融分析工作台", "Finance dashboard"),
        title: bi("正在加载工作台", "Loading workbench"),
        message: bi("正在准备最新金融工作台。", "Preparing the latest finance workspace.")
      },
      unauthorized: {
        kicker: bi("需要会话", "Session required"),
        title: bi("请从今日 Telegram 链接进入", "Open from today's Telegram link"),
        message: bi("只有当日私有链接成功建立会话 Cookie 后，工作台才会打开。", "This dashboard opens only after the current-day Telegram access link creates the finance session cookie.")
      },
      expired: {
        kicker: bi("链接已失效", "Link expired"),
        title: bi("私有链接已过期", "Access link has expired"),
        message: bi("请重新打开今日 Telegram 链接，建立新的金融工作台会话。", "Open the current-day Telegram link again to create a fresh finance session.")
      },
      empty: {
        kicker: bi("快照缺失", "Snapshot missing"),
        title: bi("金融快照尚未生成", "No finance snapshot available yet"),
        message: bi("所请求的历史日期或推送阶段还没有生成。", "The requested archive day or push stage has not been generated.")
      },
      error: {
        kicker: bi("工作台不可用", "Dashboard unavailable"),
        title: bi("暂时无法载入金融数据", "Unable to load finance data"),
        message: bi("待金融接口恢复后再重试。", "Retry once the finance APIs are available.")
      }
    };

    var selected = copyMap[kind] || copyMap.error;
    if (!el.globalState) {
      return;
    }

    el.globalStateKicker.textContent = overrides.kicker || selected.kicker;
    el.globalStateTitle.textContent = overrides.title || selected.title;
    el.globalStateMessage.textContent = overrides.message || selected.message;
    el.globalState.classList.remove("is-hidden");
  }

  function hideGlobalState() {
    if (el.globalState) {
      el.globalState.classList.add("is-hidden");
    }
  }

  function updateRefreshHealth() {
    if (!el.refreshHealthPill) {
      return;
    }

    var tone = "positive";
    var text = bi("自动刷新", "Auto-refresh") + " " + String(appState.lastStatus && appState.lastStatus.recommended_poll_seconds || appState.recommendedPollSeconds || 60) + "s";

    if (appState.mode === "archive") {
      tone = "neutral";
      text = bi("历史回放已固定", "Archive pinned");
    }

    if (appState.lastError) {
      tone = "warning";
      text = bi("当前显示旧快照", "Showing stale snapshot");
    }

    setElementTone(el.refreshHealthPill, "hero-chip", tone);
    el.refreshHealthPill.textContent = text;
  }

  function setElementTone(node, baseClass, tone) {
    if (!node) {
      return;
    }
    node.className = baseClass + " " + toneClassName(tone);
  }

  function updateFilterButtons() {
    updateButtonGroup(el.stageFilterGroup, "data-stage-filter", appState.filters.stage);
    updateButtonGroup(el.marketFilterGroup, "data-market-filter", appState.filters.market);
  }

  function updateButtonGroup(container, attribute, value) {
    if (!container) {
      return;
    }

    Array.prototype.forEach.call(container.querySelectorAll("[" + attribute + "]"), function (button) {
      button.classList.toggle("is-active", button.getAttribute(attribute) === value);
    });
  }

  function getDay() {
    if (appState.payload && appState.payload.day) {
      return appState.payload.day;
    }
    if (appState.lastGoodPayload && appState.lastGoodPayload.day) {
      return appState.lastGoodPayload.day;
    }
    return {};
  }

  function getLatestDate() {
    return getDay().date || appState.availableDates[0] || "";
  }

  function getRequestedState() {
    var params = new URL(window.location.href).searchParams;
    var stateFromQuery = params.get("state");
    var stateFromBody = body.dataset.pageState || "authorized";
    var allowed = ["authorized", "loading", "unauthorized", "expired", "empty", "error"];

    if (allowed.indexOf(stateFromQuery) !== -1) {
      return stateFromQuery;
    }

    if (allowed.indexOf(stateFromBody) !== -1) {
      return stateFromBody;
    }

    return "authorized";
  }

  function syncUrl() {
    var url = new URL(window.location.href);
    if (appState.mode === "archive" && appState.selectedDate && appState.selectedDate !== getLatestDate()) {
      url.searchParams.set("date", appState.selectedDate);
    } else {
      url.searchParams.delete("date");
    }
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.pathname + url.search);
  }

  function getPollSeconds(payload) {
    return payload && payload.day && payload.day.refresh && asNumber(payload.day.refresh.recommended_poll_seconds) || 60;
  }

  function getStageMeta() {
    var day = getDay();
    var content = day.content || {};
    var topStatus = day.top_status && day.top_status.pushes || {};
    var liveStatus = appState.lastStatus && appState.lastStatus.pushes || {};
    var result = {};

    STAGES.forEach(function (stage) {
      var stageContent = content[stage] || {};
      var top = topStatus[stage] || {};
      var live = liveStatus[stage] || {};
      result[stage] = {
        status: live.status || top.status || stageContent.status || (stage === "health" ? "not_triggered" : "pending"),
        generated_at: top.generated_at || stageContent.generated_at || "",
        telegram_delivery: top.telegram_delivery || stageContent.telegram_delivery || {}
      };
    });

    return result;
  }

  function getVisibleMarketKeys(markets) {
    var available = MARKETS.filter(function (key) {
      return markets && markets[key];
    });

    if (appState.filters.market !== "ALL") {
      return available.indexOf(appState.filters.market) !== -1 ? [appState.filters.market] : [];
    }

    return available;
  }

  function getMarketSummary(morning, market) {
    var markets = morning && morning.markets || {};
    return markets[market] || {};
  }

  function getSortedPositions(noon) {
    return safeArray(noon.positions).slice().sort(function (left, right) {
      return (asNumber(right.portfolio_pct) || 0) - (asNumber(left.portfolio_pct) || 0);
    });
  }

  function getAllocationRows(noon) {
    var allocations = safeArray(noon.allocations).map(function (item) {
      return {
        key: item.key,
        name: item.name || item.key,
        category_pct: asNumber(item.category_pct) || 0,
        category_amount: asNumber(item.category_amount)
      };
    });

    if (allocations.length) {
      return allocations.sort(function (left, right) {
        return right.category_pct - left.category_pct;
      });
    }

    var grouped = {};
    safeArray(noon.positions).forEach(function (item) {
      var key = item.category || "Other";
      if (!grouped[key]) {
        grouped[key] = {
          key: key,
          name: key,
          category_pct: 0
        };
      }
      grouped[key].category_pct += asNumber(item.portfolio_pct) || 0;
    });

    return Object.keys(grouped).map(function (key) {
      return grouped[key];
    }).sort(function (left, right) {
      return right.category_pct - left.category_pct;
    });
  }

  function buildOverlapItems(morning, positions) {
    var explicit = safeArray(morning.ai_reference && morning.ai_reference.overlap_picks);
    var positionMap = {};

    positions.forEach(function (item) {
      positionMap[normalizeSymbol(item.symbol)] = item;
    });

    if (explicit.length) {
      return explicit.map(function (item) {
        return {
          market: item.market,
          symbol: item.symbol,
          display_symbol: item.display_symbol,
          name: item.name,
          held: !!positionMap[normalizeSymbol(item.symbol)],
          note: positionMap[normalizeSymbol(item.symbol)] ? bi("已在 AI 模拟持仓中。", "Already held in the simulated portfolio.") : bi("晨报参考标的。", "Morning reference idea.")
        };
      });
    }

    return collectMorningPicks(morning).filter(function (item) {
      return !!positionMap[normalizeSymbol(item.symbol)];
    }).map(function (item) {
      return {
        market: item.market,
        symbol: item.symbol,
        display_symbol: item.display_symbol,
        name: item.name,
        held: true,
        note: bi("根据晨报优选与午间持仓的同名标的推导。", "Derived from shared symbols between morning picks and noon positions.")
      };
    });
  }

  function collectMorningPicks(morning) {
    var results = [];
    var markets = morning.markets || {};

    MARKETS.forEach(function (market) {
      safeArray(markets[market] && markets[market].picks).forEach(function (item) {
        results.push({
          market: market,
          symbol: item.symbol,
          display_symbol: item.display_symbol,
          name: item.name
        });
      });
    });

    return results;
  }

  function computeRisk(positions) {
    var largestPct = positions.length ? asNumber(positions[0].portfolio_pct) || 0 : 0;
    var topThreePct = positions.slice(0, 3).reduce(function (sum, item) {
      return sum + (asNumber(item.portfolio_pct) || 0);
    }, 0);

    if (largestPct >= 30 || topThreePct >= 60) {
      return {
        largestPct: largestPct,
        topThreePct: topThreePct,
        label: bi("高集中", "High concentration"),
        tone: "negative"
      };
    }

    if (largestPct >= 20 || topThreePct >= 45) {
      return {
        largestPct: largestPct,
        topThreePct: topThreePct,
        label: bi("中等集中", "Moderate concentration"),
        tone: "warning"
      };
    }

    return {
      largestPct: largestPct,
      topThreePct: topThreePct,
      label: bi("相对均衡", "Balanced book"),
      tone: "positive"
    };
  }

  function buildStageHighlights(stage, stageContent, day) {
    var items = [];

    if (stage === "news") {
      items = items.concat(safeArray((stageContent.news_summary || {}).bullets).slice(0, 3));
      if (!items.length) {
        safeArray(stageContent.selected_news).slice(0, 2).forEach(function (item) {
          items.push(item.ai_summary || item.title);
        });
      }
      if (!items.length) {
        items = items.concat(safeArray(stageContent.watch_points).slice(0, 2));
      }
    } else if (stage === "morning") {
      var marketCount = getVisibleMarketKeys(stageContent.markets || {}).reduce(function (sum, key) {
        return sum + (asNumber(stageContent.markets[key] && stageContent.markets[key].candidate_count) || 0);
      }, 0);
      var overlapCount = buildOverlapItems(stageContent, getSortedPositions(day.content && day.content.noon || {})).length;
      if (marketCount) {
        items.push(
          bi(
            "扫描 " + formatNumber(marketCount) + " 个候选，与模拟仓重叠 " + String(overlapCount) + " 个。",
            "Scanned " + formatNumber(marketCount) + " candidates with " + String(overlapCount) + " simulated-book overlaps."
          )
        );
      }
      safeArray(stageContent.drivers).slice(0, 2).forEach(function (item) {
        items.push(item.ai_summary || item.title);
      });
      if (stageContent.ai_reference && stageContent.ai_reference.note) {
        items.push(stageContent.ai_reference.note);
      }
    } else if (stage === "noon") {
      items = items.concat(safeArray((stageContent.ai_summary || {}).bullets).slice(0, 3));
      if (stageContent.ai_summary && stageContent.ai_summary.risk_note) {
        items.push(stageContent.ai_summary.risk_note);
      }
      if (!items.length) {
        items = items.concat(safeArray(stageContent.advice).slice(0, 3));
      }
    } else {
      items = items.concat(safeArray(stageContent.issues).slice(0, 3));
    }

    var seen = {};
    return items.map(function (item) {
      return clipText(item, 120);
    }).filter(function (item) {
      var key = String(item || "").trim();
      if (!key || seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    }).slice(0, 3);
  }

  function summarizeStage(stage, stageContent, day) {
    if (stage === "news") {
      return (stageContent.news_summary && stageContent.news_summary.headline)
        || (safeArray(stageContent.selected_news)[0] && (safeArray(stageContent.selected_news)[0].ai_summary || safeArray(stageContent.selected_news)[0].title))
        || safeArray(stageContent.watch_points)[0]
        || clipText(stageContent.message_text, 150)
        || bi("新闻阶段暂未就绪。", "News stage is not available yet.");
    }

    if (stage === "morning") {
      var firstDriver = safeArray(stageContent.drivers)[0];
      if (firstDriver && (firstDriver.ai_summary || firstDriver.title)) {
        return firstDriver.ai_summary || clipText(firstDriver.title, 120);
      }
      var marketCount = getVisibleMarketKeys(stageContent.markets || {}).reduce(function (sum, key) {
        return sum + (asNumber(stageContent.markets[key] && stageContent.markets[key].candidate_count) || 0);
      }, 0);
      var overlapCount = buildOverlapItems(stageContent, getSortedPositions(day.content && day.content.noon || {})).length;
      return marketCount
        ? bi("可见市场共筛出 " + String(marketCount) + " 个候选，和模拟仓有 " + String(overlapCount) + " 个重叠。", String(marketCount) + " candidates across visible markets with " + String(overlapCount) + " portfolio overlaps.")
        : stageContent.ai_reference && stageContent.ai_reference.note
          || clipText(stageContent.message_text, 150)
          || bi("晨报阶段暂未就绪。", "Morning stage is not available yet.");
    }

    if (stage === "noon") {
      if (stageContent.ai_summary && stageContent.ai_summary.headline) {
        return stageContent.ai_summary.headline;
      }
      var summary = stageContent.portfolio_summary || {};
      var value = asNumber(summary.portfolio_value);
      return value !== null
        ? bi("组合净值 " + formatCurrency(value) + "，当日变动 " + formatSignedRatioPercent(summary.daily_pnl_pct) + "。", "Portfolio at " + formatCurrency(value) + " with " + formatSignedRatioPercent(summary.daily_pnl_pct) + " daily change.")
        : safeArray(stageContent.advice)[0]
          || clipText(stageContent.message_text, 150)
          || bi("午报阶段暂未就绪。", "Noon stage is not available yet.");
    }

    var severity = stageContent.severity || inferHealthSeverity(stageContent);
    return severity !== "none"
      ? prettySeverity(severity) + " " + bi("健康状态", "health state") + ": " + (safeArray(stageContent.issues)[0] || bi("检测到覆盖异常。", "Coverage issue detected."))
      : bi("当前没有活跃的数据源健康告警。", "No active source-health warnings.");
  }

  function inferHealthSeverity(health) {
    if (health.severity) {
      return health.severity;
    }
    if (safeArray(health.critical_issues).length) {
      return "critical";
    }
    if (safeArray(health.warning_issues).length || safeArray(health.issues).length) {
      return "warning";
    }
    return "none";
  }

  function buildSparklineSVG(values, labels) {
    var width = 320;
    var height = 140;
    var paddingX = 16;
    var paddingY = 18;
    var minValue = Math.min.apply(Math, values);
    var maxValue = Math.max.apply(Math, values);
    var range = maxValue - minValue || 1;
    var innerWidth = width - (paddingX * 2);
    var innerHeight = height - (paddingY * 2);
    var points = values.map(function (value, index) {
      var x = paddingX + ((innerWidth / Math.max(values.length - 1, 1)) * index);
      var y = paddingY + (innerHeight - (((value - minValue) / range) * innerHeight));
      return { x: x, y: y, value: value };
    });

    var linePath = points.map(function (point, index) {
      return (index ? "L" : "M") + point.x.toFixed(2) + "," + point.y.toFixed(2);
    }).join(" ");

    var areaPath = linePath + " L" + points[points.length - 1].x.toFixed(2) + "," + (height - paddingY).toFixed(2) + " L" + points[0].x.toFixed(2) + "," + (height - paddingY).toFixed(2) + " Z";
    var gridLines = [0.2, 0.5, 0.8].map(function (ratio) {
      var y = paddingY + (innerHeight * ratio);
      return '<line class="sparkline-grid-line" x1="' + paddingX + '" x2="' + (width - paddingX) + '" y1="' + y.toFixed(2) + '" y2="' + y.toFixed(2) + '"></line>';
    }).join("");

    var pointNodes = points.map(function (point, index) {
      return [
        '<circle class="sparkline-point" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="4"></circle>',
        '<text class="sparkline-label" x="' + point.x.toFixed(2) + '" y="' + (height - 6).toFixed(2) + '" text-anchor="middle">' + escapeHtml(labels[index] || "") + "</text>"
      ].join("");
    }).join("");

    return [
      '<svg viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + escapeHtml(bi("会话净值路径", "Portfolio session path")) + '">',
      gridLines,
      '<path class="sparkline-area" d="' + areaPath + '"></path>',
      '<path class="sparkline-line" d="' + linePath + '"></path>',
      pointNodes,
      "</svg>"
    ].join("");
  }

  function stageDeliveryHTML(delivery) {
    if (!delivery || !delivery.status) {
      return "";
    }
    return '<p class="timeline-card-meta">' + escapeHtml(bi("Telegram 投递", "Telegram delivery")) + ' · ' + escapeHtml(prettyStageStatus(delivery.status)) + '</p>';
  }

  function statusPillHTML(label, status, compact) {
    var tone = toneClassName(statusTone(status));
    return [
      '<span class="status-pill ' + tone + (compact ? " status-pill--compact" : "") + '">',
      '<span class="status-pill__dot" aria-hidden="true"></span>',
      "<span>" + escapeHtml(label) + "</span>",
      "</span>"
    ].join("");
  }

  function miniStatHTML(label, value) {
    return [
      '<div class="mini-stat">',
      '<p class="status-label">' + escapeHtml(label) + "</p>",
      "<strong>" + escapeHtml(value) + "</strong>",
      "</div>"
    ].join("");
  }

  function metricCardHTML(label, value, meta, tone) {
    return [
      '<article class="metric-card ' + toneClassName(tone) + '">',
      '<p class="metric-label">' + escapeHtml(label) + "</p>",
      '<p class="metric-value">' + escapeHtml(value) + "</p>",
      '<p class="metric-meta">' + escapeHtml(meta) + "</p>",
      "</article>"
    ].join("");
  }

  function riskChipHTML(label, value, meta) {
    return [
      '<div class="risk-chip">',
      '<span class="status-label">' + escapeHtml(label) + "</span>",
      "<strong>" + escapeHtml(value) + "</strong>",
      '<p class="status-meta">' + escapeHtml(meta) + "</p>",
      "</div>"
    ].join("");
  }

  function summaryRowHTML(label, value) {
    return [
      '<div class="summary-row">',
      "<span>" + escapeHtml(label) + "</span>",
      "<strong>" + escapeHtml(value) + "</strong>",
      "</div>"
    ].join("");
  }

  function buildSegment(width, className) {
    if (!width) {
      return "";
    }
    return '<span class="stacked-segment ' + className + '" style="width:' + escapeHtml(width.toFixed(2)) + '%"></span>';
  }

  function setHTML(node, html) {
    if (node) {
      node.innerHTML = html;
    }
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function toKeyValuePairs(record) {
    if (!record || typeof record !== "object") {
      return [];
    }

    return Object.keys(record).map(function (key) {
      return {
        key: key,
        value: String(record[key])
      };
    });
  }

  function uniqueDates(values) {
    var filtered = values.filter(Boolean);
    var map = {};
    filtered.forEach(function (value) {
      map[value] = true;
    });

    return Object.keys(map).sort(function (left, right) {
      return left < right ? 1 : -1;
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeUrl(value) {
    var text = String(value || "");
    return /^https?:\/\//i.test(text) ? text : "#";
  }

  function clipText(value, limit) {
    var text = String(value || "").trim();
    if (!text) {
      return "";
    }
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  }

  function asNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function toneFromNumeric(value) {
    var number = asNumber(value);
    if (number === null || number === 0) {
      return "neutral";
    }
    return number > 0 ? "positive" : "negative";
  }

  function toneClassName(tone) {
    var key = tone || "neutral";
    if (key === "ready" || key === "positive") {
      return "tone-positive";
    }
    if (key === "pending" || key === "warning") {
      return "tone-warning";
    }
    if (key === "failed" || key === "negative") {
      return "tone-negative";
    }
    if (key === "critical") {
      return "tone-critical";
    }
    return "tone-neutral";
  }

  function statusTone(status) {
    var value = String(status || "").toLowerCase();
    if (value === "ready" || value === "sent") {
      return "ready";
    }
    if (value === "failed") {
      return "failed";
    }
    if (value === "critical") {
      return "critical";
    }
    if (value === "warning") {
      return "warning";
    }
    if (value === "skipped" || value === "not_triggered") {
      return "neutral";
    }
    return "pending";
  }

  function prettyStageStatus(status) {
    var value = String(status || "").toLowerCase();
    var labels = {
      pending: bi("待执行", "Pending"),
      ready: bi("就绪", "Ready"),
      sent: bi("已发送", "Sent"),
      failed: bi("失败", "Failed"),
      warning: bi("警示", "Warning"),
      critical: bi("严重", "Critical"),
      skipped: bi("跳过", "Skipped"),
      not_triggered: bi("未触发", "Not triggered")
    };
    return labels[value] || bi("待执行", "Pending");
  }

  function prettySeverity(severity) {
    var value = String(severity || "none").toLowerCase();
    var labels = {
      none: bi("正常", "Normal"),
      warning: bi("警示", "Warning"),
      critical: bi("严重", "Critical")
    };
    return labels[value] || bi("正常", "Normal");
  }

  function marketDisplayName(market) {
    if (market === "A") {
      return bi("A 股", "A-Share");
    }
    if (market === "HK") {
      return bi("港股", "Hong Kong");
    }
    if (market === "US") {
      return bi("美股", "US");
    }
    return String(market || "");
  }

  function marketToneLabel(market) {
    if (market === "A" || market === "HK" || market === "US") {
      return market;
    }
    return String(market || "");
  }

  function prettyAccessMode(mode) {
    var value = String(mode || "daily_key_to_cookie").toLowerCase();
    if (value === "daily_key_to_cookie") {
      return bi("日密钥转会话", "Daily key to session");
    }
    return value.replace(/_/g, " ");
  }

  function breadthLabel(breadth) {
    breadth = breadth || {};
    var up = asNumber(breadth.up) || 0;
    var down = asNumber(breadth.down) || 0;
    var flat = asNumber(breadth.flat) || 0;
    return up + " " + bi("涨", "up") + " / " + flat + " " + bi("平", "flat") + " / " + down + " " + bi("跌", "down");
  }

  function marketRowLabel(item) {
    if (!item) {
      return bi("暂未就绪", "Not ready");
    }
    var label = item.display_symbol || item.symbol || item.name || bi("标的", "Instrument");
    var pct = asNumber(item.pct_chg);
    return pct === null ? label : label + " " + formatSignedPercent(pct);
  }

  function normalizeSymbol(value) {
    return String(value || "").replace(/\s+/g, "").toUpperCase();
  }

  function scaleRatioPercent(value) {
    var number = asNumber(value);
    if (number === null || number <= 0) {
      return 0;
    }
    return Math.max(4, Math.min(100, number * 100));
  }

  function formatRatioPercent(value) {
    var number = asNumber(value);
    if (number === null) {
      return "n/a";
    }
    var percent = number * 100;
    return percent.toFixed(Math.abs(percent) >= 10 ? 1 : 2) + "%";
  }

  function formatSignedRatioPercent(value) {
    var number = asNumber(value);
    if (number === null) {
      return "n/a";
    }
    var percent = number * 100;
    var sign = percent > 0 ? "+" : "";
    return sign + percent.toFixed(Math.abs(percent) >= 10 ? 1 : 2) + "%";
  }

  function isStageVisible(stage) {
    return appState.filters.stage === "all" || appState.filters.stage === stage;
  }

  function isLater(left, right) {
    var leftTime = Date.parse(left || "");
    var rightTime = Date.parse(right || "");
    if (!Number.isFinite(leftTime)) {
      return false;
    }
    if (!Number.isFinite(rightTime)) {
      return true;
    }
    return leftTime > rightTime;
  }

  function parseDateForZone(value) {
    if (!value) {
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(value + "T00:00:00+08:00");
    }
    return new Date(value);
  }

  function formatDateLabel(value) {
    var date = parseDateForZone(value);
    if (!date || Number.isNaN(date.getTime())) {
      return bi("暂未就绪", "Not ready");
    }
    return new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIME_ZONE,
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(date);
  }

  function formatDateTime(value) {
    var date = parseDateForZone(value);
    if (!date || Number.isNaN(date.getTime())) {
      return bi("暂未就绪", "Not ready");
    }
    return new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIME_ZONE,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function formatTime(value) {
    var date = parseDateForZone(value);
    if (!date || Number.isNaN(date.getTime())) {
      return bi("暂未就绪", "Not ready");
    }
    return new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function formatNumber(value) {
    var number = asNumber(value);
    if (number === null) {
      return "0";
    }
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0
    }).format(number);
  }

  function formatPercent(value) {
    var number = asNumber(value);
    if (number === null) {
      return "n/a";
    }
    return number.toFixed(Math.abs(number) >= 10 ? 1 : 2) + "%";
  }

  function formatSignedPercent(value) {
    var number = asNumber(value);
    if (number === null) {
      return "n/a";
    }
    var sign = number > 0 ? "+" : "";
    return sign + number.toFixed(Math.abs(number) >= 10 ? 1 : 2) + "%";
  }

  function formatCurrency(value) {
    var number = asNumber(value);
    if (number === null) {
      return bi("暂未就绪", "Not ready");
    }
    var digits = Math.abs(number) < 100 ? 2 : 0;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    }).format(number);
  }

  function formatSignedCurrency(value) {
    var number = asNumber(value);
    if (number === null) {
      return "n/a";
    }
    var sign = number > 0 ? "+" : "";
    return sign + formatCurrency(number);
  }
}());
