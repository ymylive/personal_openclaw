const state = {
  bootstrap: null,
};

function byId(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const node = byId(id);
  if (node) node.textContent = text;
}

function renderKv(targetId, entries) {
  const node = byId(targetId);
  if (!node) return;
  node.innerHTML = entries
    .map(
      ([label, value]) => `
        <div class="kv-item">
          <span class="kv-label">${label}</span>
          <span class="kv-value">${value ?? "n/a"}</span>
        </div>
      `
    )
    .join("");
}

function prettyJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || JSON.stringify(payload));
  }
  return payload;
}

function renderBootstrap(payload) {
  state.bootstrap = payload;
  const account = payload.account || {};
  const connection = payload.connection || {};
  const automation = payload.automation || {};
  const config = payload.config || {};

  renderKv("account-card", [
    ["登录状态", account.loggedIn ? "已登录" : "未登录"],
    ["UIN", account.uin || "n/a"],
    ["昵称", account.nickname || "n/a"],
  ]);

  renderKv("connection-card", [
    ["NapCat", connection.running ? `在线 (${connection.status || "running"})` : "离线"],
    ["OneBot", connection.onebotConfigured ? "已配置" : "未配置"],
    ["WS", connection.wsUrl || "n/a"],
  ]);

  renderKv("automation-card", [
    ["监测脚本", automation.monitorScriptPresent ? "存在" : "缺失"],
    ["自动回复脚本", automation.autoReplyScriptPresent ? "存在" : "缺失"],
    ["自动聊天", automation.enabled ? "启用" : "关闭"],
  ]);

  const qr = payload.qr || {};
  setText("qr-state", qr.available ? "检测到可用二维码" : "暂未检测到二维码");
  const qrImage = byId("qr-image");
  if (qrImage) {
    qrImage.src = qr.available ? `${document.body.dataset.qrUrl}?t=${Date.now()}` : "";
    qrImage.style.display = qr.available ? "block" : "none";
  }

  const messages = (payload.messages || {}).recent || [];
  renderMessages(messages);

  byId("system-prompt-input").value = config.systemPrompt || "";
  byId("monitor-agent-input").value = config.monitorAgentId || "";
  byId("reply-agent-input").value = config.replyAgentId || "";
  byId("automation-enabled-input").checked = Boolean((config.monitorSettings || {}).enabled ?? automation.enabled);
  byId("monitor-settings-input").value = prettyJson(config.monitorSettings || {});
  byId("sticker-settings-input").value = prettyJson(config.stickerSettings || {});
  byId("group-id-input").value = String((payload.messages || {}).defaultGroupId || "");
  byId("send-message-group-input").value = String((payload.messages || {}).defaultGroupId || "");
  byId("send-sticker-group-input").value = String((payload.messages || {}).defaultGroupId || "");

  const alerts = payload.alerts || [];
  byId("alerts-list").innerHTML = alerts.length
    ? alerts.map((item) => `<div class="alert-item">${item}</div>`).join("")
    : '<div class="alert-item ok">无告警</div>';
  byId("logs-view").textContent = (payload.logs || []).join("\n");
}

function renderMessages(messages) {
  const node = byId("message-list");
  if (!node) return;
  if (!messages.length) {
    node.innerHTML = '<div class="empty-state">暂无消息</div>';
    return;
  }
  node.innerHTML = messages
    .map(
      (item) => `
        <article class="message-item">
          <div class="message-meta">
            <strong>${item.senderName || item.userId || "未知用户"}</strong>
            <span>${item.time || ""}</span>
          </div>
          <div class="message-body">${item.rawMessage || ""}</div>
        </article>
      `
    )
    .join("");
}

async function loadBootstrap() {
  const payload = await requestJson(document.body.dataset.bootstrapUrl);
  renderBootstrap(payload);
}

async function loadMessages() {
  const groupId = byId("group-id-input").value.trim();
  const payload = await requestJson(`${document.body.dataset.messagesUrl}?groupId=${encodeURIComponent(groupId)}&limit=20`);
  renderMessages(payload.messages || []);
}

async function saveConfig() {
  const monitorSettings = JSON.parse(byId("monitor-settings-input").value || "{}");
  monitorSettings.enabled = byId("automation-enabled-input").checked;
  const stickerSettings = JSON.parse(byId("sticker-settings-input").value || "{}");
  await requestJson(document.body.dataset.configUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemPrompt: byId("system-prompt-input").value,
      monitorAgentId: byId("monitor-agent-input").value,
      replyAgentId: byId("reply-agent-input").value,
      monitorSettings,
      stickerSettings,
    }),
  });
  await loadBootstrap();
}

async function postAction(name, payload) {
  return requestJson(`${document.body.dataset.actionsBase}${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

function bindEvents() {
  byId("refresh-button").addEventListener("click", () => {
    void loadBootstrap();
  });
  byId("load-messages-button").addEventListener("click", () => {
    void loadMessages();
  });
  byId("save-config-button").addEventListener("click", () => {
    void saveConfig();
  });
  byId("restart-napcat-button").addEventListener("click", async () => {
    await postAction("restart-napcat");
    await loadBootstrap();
  });
  byId("restart-automation-button").addEventListener("click", async () => {
    await postAction("restart-automation");
    await loadBootstrap();
  });
  byId("send-message-button").addEventListener("click", async () => {
    await postAction("send-message", {
      groupId: byId("send-message-group-input").value,
      message: byId("send-message-body-input").value,
    });
    await loadMessages();
  });
  byId("send-sticker-button").addEventListener("click", async () => {
    await postAction("send-sticker", {
      groupId: byId("send-sticker-group-input").value,
      imageRef: byId("send-sticker-ref-input").value,
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  void loadBootstrap();
});
