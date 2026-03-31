#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import WebSocket from "/app/node_modules/ws/index.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MONITOR_SETTINGS = {
  windowMinutes: 180,
  recentMsgLimit: 40,
  botCooldownMinutes: 6,
  strongSignalScore: 2,
  scanSignalScore: 1,
  agentTimeoutSeconds: 120,
};
const WS_TIMEOUT_MS = 15000;
const SEND_CONFIRM_POLL_INTERVAL_MS = 1200;
const SEND_CONFIRM_POLL_COUNT = 2;
const STATE_PATH = "/home/node/.openclaw/workspace/qq_group_monitor_state.json";
const LOCK_PATH = "/home/node/.openclaw/workspace/qq_group_monitor.lock";
const STYLE_QUOTES_PATH = "/home/node/.openclaw/workspace/finance_system/qq_chat_quotes.txt";
const MONITOR_SUPPRESSED_ERROR_LOG_PATH = "/home/node/.openclaw/workspace/qq_monitor_suppressed_errors.jsonl";
const MONITOR_SUPPRESSED_ERROR_STATS_PATH = "/home/node/.openclaw/workspace/qq_monitor_suppressed_errors_stats.json";
const SCAN_MODEL_FALLBACK = "z-ai/glm-4.5-air:free";
const DEFAULT_MONITOR_AGENT_ID = "qqmonitor";
const DEFAULT_REPLY_AGENT_ID = "qqreply";
const DEFAULT_SCAN_FALLBACK_AGENT_ID = "qqreplylite";
const STICKER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const DEFAULT_STICKER_SETTINGS = {
  enabled: false,
  mode: "balanced",
  rootPath: "",
  defaultIntensity: 50,
  defaultCooldown: 0,
  sharedMediaHostDir: "/home/node/.openclaw/shared_media",
  sharedMediaContainerDir: "/openclaw_media",
};

const DEFAULT_GROUPS = [
  { id: 1016414937, name: "25计软学习互助", focus: "software study help, debugging, coursework, and casual study chat" },
  { id: 1061966199, name: "258班学习交流群", focus: "class study help, coursework, files, and casual class chat" },
];

function parseArgs(argv) {
  const result = { dryRun: false, force: false, groupId: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--force") result.force = true;
    else if (arg === "--group" && argv[i + 1]) {
      result.groupId = Number(argv[i + 1]);
      i += 1;
    }
  }
  return result;
}

function parseGroupIdList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  }
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeGroupEntry(item) {
  if (!item || typeof item !== "object") return null;
  const id = Number(item.id ?? item.groupId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const fallback = DEFAULT_GROUPS.find((group) => group.id === id);
  return {
    id,
    name: String(item.name || fallback?.name || `group_${id}`).trim() || `group_${id}`,
    focus: String(item.focus || fallback?.focus || "study help and casual chat").trim() || "study help and casual chat",
    enabled: Boolean(item.enabled ?? true),
    priority: Number.isFinite(Number(item.priority)) ? Math.trunc(Number(item.priority)) : 0,
    replyEnabled: Boolean(item.replyEnabled ?? item.enabled ?? true),
    stickerEnabled: Boolean(item.stickerEnabled ?? true),
    stickerIntensity: Number.isFinite(Number(item.stickerIntensity)) ? Math.max(0, Math.min(100, Math.trunc(Number(item.stickerIntensity)))) : 50,
    cooldownSeconds: Number.isFinite(Number(item.cooldownSeconds)) ? Math.max(0, Math.trunc(Number(item.cooldownSeconds))) : 0,
  };
}

function resolveGroups(cfg) {
  const qq = ((cfg?.channels || {}).qq || {});
  const configured = Array.isArray(qq.monitorGroups)
    ? qq.monitorGroups.map((item) => normalizeGroupEntry(item)).filter(Boolean)
    : [];
  if (configured.length > 0) return configured.sort((a, b) => (b.priority - a.priority) || (a.id - b.id));

  const ids = parseGroupIdList(qq.allowedGroups || qq.ambientChatGroups);
  if (ids.length > 0) {
    return ids.map((id) => {
      const fallback = DEFAULT_GROUPS.find((group) => group.id === id);
      return normalizeGroupEntry(fallback || { id, name: `group_${id}`, focus: "study help and casual chat" });
    }).filter(Boolean);
  }
  return DEFAULT_GROUPS.map((item) => normalizeGroupEntry(item)).filter(Boolean);
}

function normalizePositiveNumber(value, fallback, minimum = 1) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < minimum) return fallback;
  return Math.floor(num);
}

function resolveMonitorSettings(cfg) {
  const qq = ((cfg?.channels || {}).qq || {});
  const raw = (qq.monitorSettings && typeof qq.monitorSettings === "object") ? qq.monitorSettings : {};
  return {
    windowMinutes: normalizePositiveNumber(raw.windowMinutes, DEFAULT_MONITOR_SETTINGS.windowMinutes),
    recentMsgLimit: normalizePositiveNumber(raw.recentMsgLimit, DEFAULT_MONITOR_SETTINGS.recentMsgLimit),
    botCooldownMinutes: normalizePositiveNumber(raw.botCooldownMinutes, DEFAULT_MONITOR_SETTINGS.botCooldownMinutes),
    strongSignalScore: normalizePositiveNumber(raw.strongSignalScore, DEFAULT_MONITOR_SETTINGS.strongSignalScore),
    scanSignalScore: normalizePositiveNumber(raw.scanSignalScore, DEFAULT_MONITOR_SETTINGS.scanSignalScore),
    agentTimeoutSeconds: normalizePositiveNumber(raw.agentTimeoutSeconds, DEFAULT_MONITOR_SETTINGS.agentTimeoutSeconds),
  };
}

function resolveStickerSettings(cfg) {
  const qq = ((cfg?.channels || {}).qq || {});
  const raw = (qq.stickerPacks && typeof qq.stickerPacks === "object") ? qq.stickerPacks : {};
  return {
    enabled: Boolean(raw.enabled),
    mode: ["balanced", "text-only", "sticker-first"].includes(String(raw.mode || "")) ? String(raw.mode) : DEFAULT_STICKER_SETTINGS.mode,
    rootPath: String(raw.rootPath || "").trim(),
    defaultIntensity: normalizePositiveNumber(raw.defaultIntensity, DEFAULT_STICKER_SETTINGS.defaultIntensity, 0),
    defaultCooldown: normalizePositiveNumber(raw.cooldownSeconds, DEFAULT_STICKER_SETTINGS.defaultCooldown, 0),
    sharedMediaHostDir: String(qq.sharedMediaHostDir || DEFAULT_STICKER_SETTINGS.sharedMediaHostDir).trim() || DEFAULT_STICKER_SETTINGS.sharedMediaHostDir,
    sharedMediaContainerDir: String(qq.sharedMediaContainerDir || DEFAULT_STICKER_SETTINGS.sharedMediaContainerDir).trim() || DEFAULT_STICKER_SETTINGS.sharedMediaContainerDir,
  };
}

function buildSignalSnapshot(signals) {
  return {
    score: Number(signals?.score || 0),
    totalMessages: Number(signals?.totalMessages || 0),
    uniqueUsers: Number(signals?.uniqueUsers || 0),
    hasQuestion: Boolean(signals?.hasQuestion),
    hasMedia: Boolean(signals?.hasMedia),
    denseBurst: Boolean(signals?.denseBurst),
    multiSpeaker: Boolean(signals?.multiSpeaker),
    tailInteresting: Boolean(signals?.tailInteresting),
    shouldScan: Boolean(signals?.shouldScan),
    shouldAutoReply: Boolean(signals?.shouldAutoReply),
  };
}

function buildStateRecord(params) {
  const {
    prev,
    mark,
    lastHumanKey,
    decision,
    decisionReason,
    nowIso,
    deliveredText,
    repliedHumanKey,
    signals,
    monitorSettings,
    group,
    agents,
    scanMeta,
    scanFallbackReason,
    replyMeta,
  } = params;
  return {
    lastFingerprint: mark,
    lastHumanMessageKey: lastHumanKey,
    lastRunAt: nowIso,
    lastDecision: decision,
    lastDecisionReason: String(decisionReason || decision || "unknown"),
    lastDeliveredAt: prev.lastDeliveredAt || null,
    lastDeliveredText: deliveredText !== undefined ? deliveredText : (prev.lastDeliveredText || ""),
    lastRepliedHumanMessageKey: repliedHumanKey !== undefined ? repliedHumanKey : (prev.lastRepliedHumanMessageKey || ""),
    lastActivityScore: Number(signals?.score || 0),
    lastSignals: buildSignalSnapshot(signals),
    lastSignalSnapshot: buildSignalSnapshot(signals),
    lastMonitorSettings: { ...monitorSettings },
    groupName: String(group?.name || ""),
    lastGroupProfile: {
      id: Number(group?.id || 0),
      name: String(group?.name || ""),
      focus: String(group?.focus || ""),
    },
    lastAgentRoute: {
      replyAgentId: String(agents?.replyAgentId || ""),
      scanFallbackAgentId: String(agents?.scanFallbackAgentId || ""),
    },
    lastScanProvider: scanMeta?.provider || null,
    lastScanModel: scanMeta?.model || null,
    lastScanFallbackReason: scanFallbackReason || null,
    lastScanMeta: {
      provider: scanMeta?.provider || null,
      model: scanMeta?.model || null,
      fallback: Boolean(scanMeta?.fallback),
      reason: scanFallbackReason || null,
    },
    lastReplyProvider: replyMeta?.provider || null,
    lastReplyModel: replyMeta?.model || null,
    lastReplyMeta: {
      provider: replyMeta?.provider || null,
      model: replyMeta?.model || null,
      attempts: Number(replyMeta?.attempts || 0),
      textLength: Number(replyMeta?.textLength || 0),
      delivered: Boolean(replyMeta?.delivered),
      deliveredAt: replyMeta?.deliveredAt || null,
    },
  };
}

function updateStateMeta(state, groups, monitorSettings) {
  const safeState = state && typeof state === "object" ? state : {};
  safeState.meta = {
    version: 2,
    updatedAt: new Date().toISOString(),
    activeGroups: (Array.isArray(groups) ? groups : []).map((group) => ({
      id: Number(group?.id || 0),
      name: String(group?.name || ""),
      focus: String(group?.focus || ""),
    })),
    monitorSettings: { ...monitorSettings },
  };
  return safeState;
}

async function listStickerEmotionPacks(rootPath) {
  const cleanRoot = String(rootPath || "").trim();
  if (!cleanRoot) return [];
  let entries = [];
  try {
    entries = await fs.readdir(cleanRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(cleanRoot, entry.name);
    let files = [];
    try {
      files = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const images = files
      .filter((item) => item.isFile() && STICKER_IMAGE_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
      .map((item) => path.join(dirPath, item.name));
    if (images.length === 0) continue;
    packs.push({ emotion: entry.name, images });
  }
  return packs.sort((a, b) => a.emotion.localeCompare(b.emotion, "zh-CN"));
}

function buildStickerContext(group, stickerSettings, stickerPacks, prevState = {}) {
  const enabled = Boolean(
    stickerSettings.enabled
    && group?.enabled !== false
    && group?.replyEnabled !== false
    && group?.stickerEnabled !== false
    && stickerSettings.mode !== "text-only"
    && Array.isArray(stickerPacks)
    && stickerPacks.length > 0
  );
  const cooldownSeconds = Number(group?.cooldownSeconds ?? stickerSettings.defaultCooldown ?? 0) || 0;
  const lastStickerAt = Date.parse(String(prevState?.lastStickerAt || "")) || 0;
  const cooldownOpen = !cooldownSeconds || !lastStickerAt || (Date.now() - lastStickerAt >= cooldownSeconds * 1000);
  const emotions = enabled && cooldownOpen ? stickerPacks.map((item) => item.emotion) : [];
  return {
    enabled: enabled && cooldownOpen,
    mode: String(stickerSettings.mode || "balanced"),
    defaultIntensity: Number(group?.stickerIntensity ?? stickerSettings.defaultIntensity ?? 50) || 50,
    cooldownSeconds,
    cooldownOpen,
    emotions,
  };
}

function parseStickerDirective(rawText = "") {
  const matched = String(rawText || "").match(/\[\[sticker:([^\]]+)\]\]\s*$/i);
  if (!matched) return { text: String(rawText || "").trim(), stickerEmotion: "" };
  const stickerEmotion = String(matched[1] || "").trim();
  const text = String(rawText || "").replace(/\[\[sticker:[^\]]+\]\]\s*$/i, "").trim();
  return { text, stickerEmotion };
}

function selectStickerPack(stickerPacks, stickerEmotion) {
  const target = String(stickerEmotion || "").trim().toLowerCase();
  if (!target || target === "none") return null;
  return (Array.isArray(stickerPacks) ? stickerPacks : []).find((item) => String(item.emotion || "").trim().toLowerCase() === target) || null;
}

async function stageStickerForNapCat(stickerSettings, stickerPack, sessionKey) {
  if (!stickerPack || !Array.isArray(stickerPack.images) || stickerPack.images.length === 0) return null;
  const hostDir = String(stickerSettings.sharedMediaHostDir || "").trim();
  const containerDir = String(stickerSettings.sharedMediaContainerDir || "").trim();
  if (!hostDir || !containerDir) return null;
  const selected = stickerPack.images[createHash("sha1").update(String(sessionKey || stickerPack.emotion)).digest()[0] % stickerPack.images.length];
  const ext = path.extname(selected).toLowerCase() || ".png";
  const safeEmotion = String(stickerPack.emotion || "sticker").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "sticker";
  const filename = `${safeEmotion}-${sessionKey || Date.now()}${ext}`;
  const destination = path.join(hostDir, filename);
  try {
    await fs.mkdir(hostDir, { recursive: true });
    await fs.copyFile(selected, destination);
  } catch {
    return null;
  }
  return `[CQ:image,file=file://${containerDir.replace(/\/$/, "")}/${filename}]`;
}

async function loadJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return fallback; }
}

async function saveJson(path, data) {
  await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function loadStyleQuotes(limit = 8) {
  try {
    const raw = await fs.readFile(STYLE_QUOTES_PATH, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(path, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const raw = (await fs.readFile(path, "utf8")).trim();
        const pid = Number.parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 1) {
          await fs.unlink(path);
          continue;
        }
        try {
          process.kill(pid, 0);
        } catch (pidError) {
          if (pidError?.code === "ESRCH") {
            await fs.unlink(path);
            continue;
          }
        }
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        try {
          await fs.unlink(path);
          continue;
        } catch {}
      }
      return null;
    }
  }
  return null;
}

async function releaseLock(handle, path) {
  if (!handle) return;
  try { await handle.close(); } catch {}
  try { await fs.unlink(path); } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripSpecial(raw = "") {
  let text = String(raw || "");
  for (const ch of ["*", "#", "~", "`", ">", "[", "]", "{", "}", "_", "|", "^"]) {
    text = text.split(ch).join(" ");
  }
  return text.replace(/\s+/g, " ").trim();
}

const UPSTREAM_REPLY_ERROR_PATTERNS = [
  /agent failed before reply:/i,
  /context overflow/i,
  /message ordering conflict/i,
  /this request requires more credits/i,
  /visit https?:\/\/openrouter\.ai\/settings\/credits/i,
  /insufficient credits/i,
  /provider returned error/i,
  /authentication failed/i,
  /\b(?:401|402|403|429|500|502|503|504)\b[^\n]{0,160}(?:openrouter|credits|rate limit|max tokens|provider|request)/i,
  /openrouter[^\n]{0,160}(?:credits|rate limit|max tokens|provider|request)/i,
];

function looksLikeUpstreamReplyErrorText(raw = "") {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return UPSTREAM_REPLY_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function classifyUpstreamReplyError(raw = "") {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "upstream_error";
  if (/context overflow/i.test(text)) return "context_overflow";
  if (/message ordering conflict/i.test(text)) return "message_ordering_conflict";
  if (/(?:requires more credits|insufficient credits|settings\/credits)/i.test(text)) return "credits";
  if (/(?:\b429\b|rate limit)/i.test(text)) return "rate_limit";
  if (/(?:\b401\b|\b403\b|authentication failed|unauthorized|api key)/i.test(text)) return "auth";
  if (/(?:\b5\d\d\b|provider returned error)/i.test(text)) return "provider_error";
  return "upstream_error";
}

async function recordSuppressedMonitorError(entry = {}) {
  const preview = stripSpecial(String(entry.text || entry.error || "")).slice(0, 240);
  const reason = String(entry.reason || classifyUpstreamReplyError(entry.text || entry.error || ""));
  const record = {
    ts: new Date().toISOString(),
    source: String(entry.source || "qq_monitor"),
    reason,
    groupId: Number.isFinite(Number(entry.groupId)) ? Number(entry.groupId) : null,
    groupName: String(entry.groupName || ""),
    agentId: String(entry.agentId || ""),
    provider: String(entry.provider || ""),
    model: String(entry.model || ""),
    preview,
  };
  try {
    await fs.appendFile(MONITOR_SUPPRESSED_ERROR_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch {}
  try {
    const prev = await loadJson(MONITOR_SUPPRESSED_ERROR_STATS_PATH, { total: 0, byReason: {}, bySource: {}, lastAt: null, last: null });
    const next = {
      total: Number(prev?.total || 0) + 1,
      byReason: { ...(prev?.byReason || {}), [reason]: Number(prev?.byReason?.[reason] || 0) + 1 },
      bySource: { ...(prev?.bySource || {}), [record.source]: Number(prev?.bySource?.[record.source] || 0) + 1 },
      lastAt: record.ts,
      last: record,
    };
    await saveJson(MONITOR_SUPPRESSED_ERROR_STATS_PATH, next);
  } catch {}
}

function sanitizeReplyText(raw = "") {
  const text = stripSpecial(raw);
  if (!text) return "";
  if (looksLikeUpstreamReplyErrorText(text)) return "";
  return text;
}

function cleanCQText(raw = "") {
  return stripSpecial(
    String(raw || "")
      .replace(/\[CQ:reply,[^\]]+\]/g, "")
      .replace(/\[CQ:at,[^\]]+\]/g, "")
      .replace(/\[CQ:image,[^\]]+\]/g, " image ")
      .replace(/\[CQ:face,[^\]]+\]/g, " emoji ")
      .replace(/\[CQ:record,[^\]]+\]/g, " audio ")
      .replace(/\[CQ:video,[^\]]+\]/g, " video ")
      .replace(/\[CQ:file,[^\]]+\]/g, " file ")
      .replace(/\[CQ:[^\]]+\]/g, " ")
  );
}

function displayName(message) {
  return String(message?.sender?.card || message?.sender?.nickname || message?.user_id || "classmate").trim() || "classmate";
}

function fingerprint(items) {
  return items.slice(-3).map((item) => `${item.time}:${item.userId}:${item.text}`).join("||");
}

function latestHumanMessageKey(items) {
  const last = Array.isArray(items) && items.length > 0 ? items[items.length - 1] : null;
  if (!last) return "";
  return `${last.time}:${last.userId}:${last.text}`;
}

function sessionTag(value) {
  return createHash("sha1").update(String(value || "none")).digest("hex").slice(0, 12);
}

function isQuestionText(raw = "") {
  const text = stripSpecial(raw);
  return /[??]/.test(text)
    || /(\u5417|\u5462)$/.test(text)
    || /(\u548b|\u600e\u4e48|\u4e3a\u4ec0\u4e48|\u5565|\u4ec0\u4e48|\u8981\u4e0d\u8981|\u597d\u4e0d\u597d|\u884c\u4e0d\u884c|\u80fd\u4e0d\u80fd|\u662f\u4e0d\u662f|\u6709\u65e0|\u8c01\u61c2|\u8c01\u4f1a|\u8c01\u77e5\u9053)/.test(text);
}

function isMediaLikeText(raw = "") {
  return /\b(image|file|video|audio)\b|https?:\/\/\S+/i.test(String(raw || ""));
}

function isLowValueText(raw = "") {
  const text = stripSpecial(raw).replace(/\s+/g, "");
  return /^(?:[16?]+|ok|OK|hhh+)$/i.test(text)
    || /^(?:\u8349|\u8279|\u6069|\u54e6|\u597d|\u884c|\u6536\u5230|\u77e5\u9053\u4e86|\u786e\u5b9e|\u54c8\u54c8+|\u7b11\u6b7b|\u725b|\u9006\u5929|\u4e50|\u7ef7|\u662f\u5417|\u597d\u73a9\u5417|\u5f97\u5bf9\u7535\u6ce2)$/u.test(text);
}

function computeActivitySignals(items, settings = DEFAULT_MONITOR_SETTINGS) {
  const recent = (Array.isArray(items) ? items : []).slice(-12);
  const totalMessages = recent.length;
  const uniqueUsers = new Set(recent.map((item) => item.userId).filter(Boolean)).size;
  const first = recent[0] || null;
  const last = recent[recent.length - 1] || null;
  const hasQuestion = recent.some((item) => isQuestionText(item.text));
  const hasMedia = recent.some((item) => isMediaLikeText(item.text));
  const denseBurst = Boolean(first && last && totalMessages >= 3 && last.time - first.time <= 12 * 60);
  const multiSpeaker = uniqueUsers >= 2;
  const tailInteresting = recent.slice(-3).some((item) => !isLowValueText(item.text));
  const latestInteresting = Boolean(last && !isLowValueText(last.text));
  let score = 0;
  if (hasQuestion) score += 2;
  if (hasMedia) score += 2;
  if (totalMessages >= 2) score += 1;
  if (multiSpeaker && totalMessages >= 2) score += 2;
  if (denseBurst) score += 2;
  if (tailInteresting) score += 1;
  if (latestInteresting) score += 1;
  return {
    score,
    totalMessages,
    uniqueUsers,
    hasQuestion,
    hasMedia,
    denseBurst,
    multiSpeaker,
    tailInteresting,
    latestInteresting,
    shouldScan: totalMessages >= 1 && (latestInteresting || tailInteresting || score >= settings.scanSignalScore || hasQuestion || hasMedia),
    shouldAutoReply: totalMessages >= 1 && tailInteresting && (score >= settings.strongSignalScore || hasQuestion || hasMedia || latestInteresting),
  };
}

class OneBotRpc {
  constructor(wsUrl, token) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.ws = null;
    this.pending = new Map();
  }

  rejectPending(error) {
    const reason = error instanceof Error ? error : new Error(String(error || "OneBot socket error"));
    for (const [echo, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(echo);
      entry.reject(reason);
    }
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    await new Promise((resolve, reject) => {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      const socket = new WebSocket(this.wsUrl, { headers });
      this.ws = socket;
      let settled = false;
      const fail = (error) => {
        const reason = error instanceof Error ? error : new Error(String(error || "OneBot socket error"));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (this.ws === socket) this.ws = null;
          reject(reason);
        }
        this.rejectPending(reason);
        try { socket.close(); } catch {}
      };
      const timer = setTimeout(() => fail(new Error("OneBot connect timeout")), WS_TIMEOUT_MS);
      socket.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.on("message", (buf) => {
        try {
          const payload = JSON.parse(buf.toString("utf8"));
          const echo = payload?.echo;
          if (!echo || !this.pending.has(echo)) return;
          const entry = this.pending.get(echo);
          clearTimeout(entry.timer);
          this.pending.delete(echo);
          if (payload.status === "ok") entry.resolve(payload.data);
          else {
            const reason = [payload?.msg, payload?.wording, payload?.retcode != null ? `retcode ${payload.retcode}` : ""]
              .filter(Boolean)
              .join(" ")
              .trim() || "OneBot API failed";
            const error = new Error(reason);
            error.payload = payload;
            entry.reject(error);
          }
        } catch {}
      });
      socket.on("close", () => fail(new Error("OneBot socket closed")));
      socket.on("error", (err) => fail(err));
    });
  }

  async call(action, params = {}, timeoutMs = WS_TIMEOUT_MS) {
    await this.connect();
    return await new Promise((resolve, reject) => {
      const echo = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot timeout ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }), (err) => {
          if (!err) return;
          clearTimeout(timer);
          this.pending.delete(echo);
          reject(err instanceof Error ? err : new Error(String(err || `OneBot send failed ${action}`)));
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error instanceof Error ? error : new Error(String(error || `OneBot send failed ${action}`)));
      }
    });
  }

  async close() {
    if (!this.ws) return;
    const socket = this.ws;
    this.ws = null;
    this.rejectPending(new Error("OneBot socket closed"));
    try { socket.close(); } catch {}
  }
}

function normalize(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      time: Number(message?.time || 0),
      userId: Number(message?.user_id || message?.sender?.user_id || 0),
      senderName: displayName(message),
      text: cleanCQText(message?.raw_message || ""),
    }))
    .filter((item) => item.time > 0 && item.text)
    .sort((a, b) => a.time - b.time);
}

function buildDecisionPrompt(group, transcript, signals) {
  const records = transcript.map((item) => `${item.senderName}: ${item.text}`).join("\n");
  return [
    `Group: ${group.name}`,
    `Topic: ${group.focus}`,
    "Character: Grantly from Knight Academy, a tiger beastman.",
    "Task: decide whether Grantly should naturally jump into this QQ group chat right now.",
    "Be willing to speak if the room is clearly on one live thread, joking around, asking something, or reacting to an image, file, or link.",
    "Stay silent only if the chat is dead, fully wrapped up, or any reply would feel forced.",
    "Do not be overly cautious.",
    "If there is a direct question, a visible reaction to an image, file, or link, or even one fresh meaningful human message that clearly opens a live thread, lean toward speak=true.",
    "If the thread is asking for specific facts, technical details, or confirmation that are not clearly supported by the recent chat, do not force an authoritative answer just because it is a question.",
    "Only choose speak=true in that case if Grantly can naturally admit uncertainty, ask for the missing evidence, or react without inventing facts. Otherwise lean speak=false.",
    `Activity hints: score=${signals.score}; recent_messages=${signals.totalMessages}; speakers=${signals.uniqueUsers}; question=${signals.hasQuestion}; media_or_link=${signals.hasMedia}; active_burst=${signals.denseBurst}; tail_interesting=${signals.tailInteresting}; auto_reply_bias=${signals.shouldAutoReply}.`,
    'Return JSON only in this shape: {"speak": true} or {"speak": false}.',
    "Recent human messages only. Bot messages are excluded from this transcript.",
    "Recent chat:",
    records,
  ].join("\n");
}

function buildReplyPrompt(group, transcript, signals, styleQuotes = [], stickerContext = null) {
  const records = transcript.map((item) => `${item.senderName}: ${item.text}`).join("\n");
  const styleBlock = styleQuotes.length
    ? ["Style examples (learn the tone, do not copy mechanically):", ...styleQuotes.map((line) => `- ${line}`)].join("\n")
    : "";
  const stickerBlock = stickerContext?.enabled
    ? [
        `Local sticker packs available: ${stickerContext.emotions.join(", ")}.`,
        `Sticker mode: ${stickerContext.mode}; intensity=${stickerContext.defaultIntensity}; per-group cooldown_seconds=${stickerContext.cooldownSeconds}.`,
        "If one local sticker would clearly improve the message, append a final line exactly like [[sticker:emotion-name]] using only one emotion from the available list.",
        "If no sticker should be sent, append [[sticker:none]].",
        "Do not mention the sticker directive in the visible message text.",
      ].join("\n")
    : "Sticker sending is disabled for this reply. Do not append any sticker directive.";
  return [
    "You are Grantly from Knight Academy.",
    "You are a tiger beastman speaking naturally in a modern QQ group.",
    `Group: ${group.name}.`,
    `Topic: ${group.focus}.`,
    `Activity hints: score=${signals.score}; recent_messages=${signals.totalMessages}; speakers=${signals.uniqueUsers}; question=${signals.hasQuestion}; media_or_link=${signals.hasMedia}; active_burst=${signals.denseBurst}.`,
    "Task: write exactly one message Grantly should send right now into this group.",
    "The transcript below contains only recent non-bot human messages.",
    "Reply to the strongest live thread in the recent chat.",
    "You are already sure he should speak, so do not stay silent.",
    "Sound like a real person in the room, not a service bot and not a role card being read aloud.",
    "Usually one short Chinese sentence. Two short Chinese sentences max.",
    "Prefer spoken Chinese. Natural, grounded, a little rough, warm underneath.",
    "QQ群里常见的好口气是：短句、直给、轻吐槽、少客套、少废话。",
    "Short beats polished. Human beats clever. Do not over-explain.",
    "You can tease lightly, grumble lightly, or be blunt, but do not be mean, smug, preachy, or oily.",
    "If the room is joking, match the room lightly. If the room is asking for help, answer directly and stop.",
    "If you do not know, say so plainly.",
    "If the transcript does not provide clear evidence, do not invent facts. Do not guess numbers, times, versions, file contents, links, identities, or outcomes.",
    "不懂就直说不确定；没有明确证据就不要编，不要把猜测说成事实。",
    "If a question needs missing specifics, ask for the exact screenshot, file, error text, or source instead of guessing.",
    "For bug/platform/schoolwork topics, mild frustration or dry humor is fine, but keep it friendly and useful.",
    "No customer-service phrasing. No tutor voice. No summary voice. No fake enthusiasm.",
    "Do not mention transcript, analysis, scanning, bot, AI, or rules.",
    "Plain text only. No markdown. No emoji. No decorative symbols.",
    stickerBlock,
    styleBlock,
    "Recent messages:",
    records,
  ].filter(Boolean).join("\n");
}

function extractRawPayloadText(result) {
  const payloads = result?.result?.payloads;
  if (!Array.isArray(payloads)) return "";
  return payloads.map((item) => String(item?.text || "").trim()).filter(Boolean).join("\n").trim();
}

function extractDecision(rawText) {
  const raw = String(rawText || "").replace(/\r/g, "").trim();
  if (!raw) return { speak: false, reason: "empty" };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.speak === "boolean") return { speak: parsed.speak };
  } catch {}
  const normalized = raw.replace(/\s+/g, "_").toUpperCase();
  if (["NO_REPLY", "NO", "0", "FALSE"].includes(normalized)) {
    return { speak: false, reason: "model_declined" };
  }
  if (["SHOULD_REPLY", "YES", "1", "TRUE"].includes(normalized)) {
    return { speak: true };
  }
  return { speak: false, reason: "invalid_decision" };
}

function extractReplyText(result) {
  return sanitizeReplyText(extractRawPayloadText(result));
}

function resolveOpenRouterConfig(cfg) {
  const provider = cfg?.models?.providers?.openrouter || {};
  const baseUrl = String(provider.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const apiKey = String(provider.apiKey || "");
  if (!apiKey) throw new Error("missing openrouter api key");
  return { baseUrl, apiKey };
}

function hasAgent(cfg, agentId) {
  const target = String(agentId || "").trim();
  if (!target) return false;
  return Array.isArray(cfg?.agents?.list) && cfg.agents.list.some((item) => item?.id === target);
}

function resolveMonitorAgentId(cfg) {
  const configured = String(cfg?.channels?.qq?.monitorAgentId || "").trim();
  if (configured && hasAgent(cfg, configured)) return configured;
  return hasAgent(cfg, DEFAULT_MONITOR_AGENT_ID) ? DEFAULT_MONITOR_AGENT_ID : DEFAULT_MONITOR_AGENT_ID;
}

function resolveReplyAgentId(cfg) {
  const configured = String(cfg?.channels?.qq?.replyAgentId || "").trim();
  if (configured && hasAgent(cfg, configured)) return configured;
  if (hasAgent(cfg, DEFAULT_REPLY_AGENT_ID)) return DEFAULT_REPLY_AGENT_ID;
  return hasAgent(cfg, "qqreplylite") ? "qqreplylite" : DEFAULT_REPLY_AGENT_ID;
}

function resolveScanFallbackAgentId(cfg) {
  const configured = String(cfg?.channels?.qq?.scanFallbackAgentId || "").trim();
  if (configured && hasAgent(cfg, configured)) return configured;
  if (hasAgent(cfg, DEFAULT_SCAN_FALLBACK_AGENT_ID)) return DEFAULT_SCAN_FALLBACK_AGENT_ID;
  return resolveReplyAgentId(cfg);
}

function resolveScanModel(cfg) {
  const agents = cfg?.agents?.list || [];
  const monitorAgentId = resolveMonitorAgentId(cfg);
  const scanAgent = agents.find((item) => item?.id === monitorAgentId);
  const primary = String(scanAgent?.model?.primary || "");
  if (primary.startsWith("openrouter/")) return primary.slice("openrouter/".length);
  if (primary) return primary;
  return SCAN_MODEL_FALLBACK;
}

function parseOpenRouterContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => typeof item?.text === "string" ? item.text : "").join("\n").trim();
  }
  return "";
}

async function runScanModel(cfg, prompt) {
  const { baseUrl, apiKey } = resolveOpenRouterConfig(cfg);
  const model = resolveScanModel(cfg);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "openclaw-qq-group-monitor/1.0",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 64,
      reasoning: {
        effort: "none",
        exclude: true,
      },
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content: "You are a binary classifier for whether Grantly should naturally jump into a QQ group chat. Output valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`openrouter scan failed ${response.status}: ${raw.slice(0, 500)}`);
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`openrouter scan invalid json: ${String(error)} ${raw.slice(0, 500)}`);
  }
  return {
    text: parseOpenRouterContent(data),
    meta: { provider: "openrouter", model },
  };
}

async function runReplyAgent(agentId, sessionId, prompt, thinking = "medium", timeoutSeconds = DEFAULT_MONITOR_SETTINGS.agentTimeoutSeconds) {
  const args = [
    "agent",
    "--agent", agentId,
    "--session-id", sessionId,
    "--message", prompt,
    "--thinking", thinking,
    "--timeout", String(timeoutSeconds),
    "--json",
  ];
  const { stdout } = await execFileAsync("node", ["/app/openclaw.mjs", ...args], {
    env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONIOENCODING: "UTF-8", PYTHONUTF8: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runFallbackScan(agentId, sessionId, prompt, settings = DEFAULT_MONITOR_SETTINGS) {
  const result = await runReplyAgent(agentId, sessionId, prompt, "low", settings.agentTimeoutSeconds);
  const meta = result?.result?.meta?.agentMeta || {};
  return {
    text: extractRawPayloadText(result),
    meta: {
      provider: meta.provider || null,
      model: meta.model || null,
      fallback: true,
    },
  };
}

async function runReplyWithRetry(agentId, sessionId, prompt, settings = DEFAULT_MONITOR_SETTINGS) {
  const attempts = ["medium", "low"];
  let lastResult = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const thinking = attempts[index];
    const result = await runReplyAgent(agentId, `${sessionId}-r${index + 1}`, prompt, thinking, settings.agentTimeoutSeconds);
    const rawText = extractRawPayloadText(result);
    const parsed = parseStickerDirective(rawText);
    const text = sanitizeReplyText(parsed.text);
    const suppressedUpstreamError = !!rawText && looksLikeUpstreamReplyErrorText(rawText);
    const suppressedReason = suppressedUpstreamError ? classifyUpstreamReplyError(rawText) : null;
    const meta = result?.result?.meta?.agentMeta || {};
    lastResult = { text, rawText, meta, attempts: index + 1, suppressedUpstreamError, suppressedReason, stickerEmotion: parsed.stickerEmotion };
    if (text || suppressedUpstreamError) return lastResult;
  }
  return lastResult || { text: "", rawText: "", meta: {}, attempts: 0, suppressedUpstreamError: false, suppressedReason: null, stickerEmotion: "" };
}

function normalizeConfirmText(raw = "") {
  return String(raw || "").replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
}

function findDeliveredMessage(messages, text, selfId = 0, sentAfterSec = 0) {
  const target = normalizeConfirmText(text);
  if (!target) return null;
  const items = Array.isArray(messages) ? messages : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const itemTime = Number(item?.time || 0);
    if (sentAfterSec && itemTime && itemTime < sentAfterSec - 5) continue;
    const userId = Number(item?.userId || 0);
    if (selfId && userId && userId !== selfId) continue;
    if (normalizeConfirmText(item?.text || "") === target) return item;
  }
  return null;
}

function looksLikeRetryableSendError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return text.includes("timeout") || text.includes("retcode 1200") || text.includes(" 1200");
}

async function confirmDeliveredMessage(rpc, groupId, text, selfId = 0, sentAfterSec = 0) {
  for (let attempt = 0; attempt < SEND_CONFIRM_POLL_COUNT; attempt += 1) {
    if (attempt > 0) await sleep(SEND_CONFIRM_POLL_INTERVAL_MS);
    try {
      const history = await rpc.call("get_group_msg_history", { group_id: groupId });
      const matched = findDeliveredMessage(normalize(history?.messages || []), text, selfId, sentAfterSec);
      if (matched) return matched;
    } catch {}
  }
  return null;
}

async function sendReply(rpc, groupId, text, selfId = 0) {
  const sentAfterSec = Math.floor(Date.now() / 1000);
  try {
    return await rpc.call("send_group_msg", { group_id: groupId, message: text });
  } catch (error) {
    if (!looksLikeRetryableSendError(error)) throw error;
    const matched = await confirmDeliveredMessage(rpc, groupId, text, selfId, sentAfterSec);
    if (matched) {
      return { confirmedBy: "group_history", message_id: matched?.messageId || null, time: matched?.time || sentAfterSec };
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const lockHandle = await acquireLock(LOCK_PATH);
  if (!lockHandle) {
    console.log(JSON.stringify([{ skipped: "lock_held" }], null, 2));
    return;
  }
  const cfg = await loadJson("/home/node/.openclaw/openclaw.json", {});
  const qq = ((cfg.channels || {}).qq || {});
  const monitorAgentId = resolveMonitorAgentId(cfg);
  const replyAgentId = resolveReplyAgentId(cfg);
  const scanFallbackAgentId = resolveScanFallbackAgentId(cfg);
  const monitorSettings = resolveMonitorSettings(cfg);
  const stickerSettings = resolveStickerSettings(cfg);
  const stickerPacks = await listStickerEmotionPacks(stickerSettings.rootPath);
  const groups = resolveGroups(cfg);
  const state = updateStateMeta(await loadJson(STATE_PATH, { groups: {} }), groups, monitorSettings);
  const selected = args.groupId ? groups.filter((item) => item.id === args.groupId) : groups;
  const rpc = new OneBotRpc(String(qq.wsUrl || ""), String(qq.accessToken || ""));
  const self = await rpc.call("get_login_info", {});
  const selfId = Number(self?.user_id || 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const summary = [];
  try {
    for (const group of selected) {
      if (!group.enabled) {
        summary.push({ groupId: group.id, skipped: "group_disabled" });
        continue;
      }
      if (!group.replyEnabled && !args.force) {
        summary.push({ groupId: group.id, skipped: "reply_disabled" });
        continue;
      }
      const history = await rpc.call("get_group_msg_history", { group_id: group.id });
      const items = normalize(history?.messages || []);
      const recent = items.filter((item) => item.time >= nowSec - monitorSettings.windowMinutes * 60);
      const allHuman = items.filter((item) => item.userId && item.userId !== selfId);
      const humanRecent = recent.filter((item) => item.userId && item.userId !== selfId);
      const signalSource = humanRecent;
      const lastBotAt = recent.filter((item) => item.userId === selfId).map((item) => item.time).sort((a, b) => b - a)[0] || 0;
      const mark = fingerprint(signalSource);
      const lastHumanKey = latestHumanMessageKey(humanRecent);
      const prev = state.groups[String(group.id)] || {};
      const signals = computeActivitySignals(signalSource, monitorSettings);
      if (!args.force && humanRecent.length === 0) {
        state.groups[String(group.id)] = buildStateRecord({
          prev,
          mark,
          lastHumanKey,
          decision: "skip:no_recent_human_messages",
          decisionReason: "no_recent_human_messages",
          nowIso: new Date().toISOString(),
          signals,
          monitorSettings,
          group,
          agents: { replyAgentId, scanFallbackAgentId },
          scanMeta: { provider: "local", model: "heuristic", fallback: false },
          scanFallbackReason: null,
          replyMeta: null,
        });
        summary.push({ groupId: group.id, skipped: "no_recent_human_messages", totalMessages: items.length, recentMessages: recent.length, humanRecent: humanRecent.length });
        continue;
      }
      if (!args.force && (!lastHumanKey || lastHumanKey === String(prev.lastHumanMessageKey || ""))) {
        state.groups[String(group.id)] = buildStateRecord({
          prev,
          mark,
          lastHumanKey,
          decision: "skip:no_new_human_messages",
          decisionReason: "no_new_human_messages",
          nowIso: new Date().toISOString(),
          signals,
          monitorSettings,
          group,
          agents: { replyAgentId, scanFallbackAgentId },
          scanMeta: { provider: "local", model: "heuristic", fallback: false },
          scanFallbackReason: null,
          replyMeta: null,
        });
        summary.push({ groupId: group.id, skipped: "no_new_human_messages", lastHumanKey, prevLastHumanKey: String(prev.lastHumanMessageKey || "") });
        continue;
      }
      if (!args.force && String(prev.lastRepliedHumanMessageKey || "") === String(lastHumanKey || "")) {
        state.groups[String(group.id)] = buildStateRecord({
          prev,
          mark,
          lastHumanKey,
          decision: "skip:already_replied_to_latest_human_message",
          decisionReason: "already_replied_to_latest_human_message",
          nowIso: new Date().toISOString(),
          signals,
          monitorSettings,
          group,
          agents: { replyAgentId, scanFallbackAgentId },
          scanMeta: { provider: "local", model: "heuristic", fallback: false },
          scanFallbackReason: null,
          replyMeta: null,
        });
        summary.push({ groupId: group.id, skipped: "already_replied_to_latest_human_message" });
        continue;
      }
      if (!args.force && lastBotAt && nowSec - lastBotAt < monitorSettings.botCooldownMinutes * 60) {
        state.groups[String(group.id)] = buildStateRecord({
          prev,
          mark,
          lastHumanKey,
          decision: "skip:bot_recently_spoke",
          decisionReason: "bot_recently_spoke",
          nowIso: new Date().toISOString(),
          signals,
          monitorSettings,
          group,
          agents: { replyAgentId, scanFallbackAgentId },
          scanMeta: { provider: "local", model: "heuristic", fallback: false },
          scanFallbackReason: null,
          replyMeta: null,
        });
        summary.push({ groupId: group.id, skipped: "bot_recently_spoke" });
        continue;
      }
      let transcript = humanRecent.slice(-monitorSettings.recentMsgLimit);
      if (transcript.length === 0) {
        state.groups[String(group.id)] = buildStateRecord({
          prev,
          mark,
          lastHumanKey,
          decision: "skip:empty_transcript",
          decisionReason: "empty_transcript",
          nowIso: new Date().toISOString(),
          signals,
          monitorSettings,
          group,
          agents: { replyAgentId, scanFallbackAgentId },
          scanMeta: { provider: "local", model: "heuristic", fallback: false },
          scanFallbackReason: null,
          replyMeta: null,
        });
        summary.push({ groupId: group.id, skipped: "empty_transcript" });
        continue;
      }

      if (!args.force && !signals.shouldScan) {
        state.groups[String(group.id)] = buildStateRecord({
          prev,
          mark,
          lastHumanKey,
          decision: "skip:low_activity_signal",
          decisionReason: "low_activity_signal",
          nowIso: new Date().toISOString(),
          signals,
          monitorSettings,
          group,
          agents: { replyAgentId, scanFallbackAgentId },
          scanMeta: { provider: "local", model: "heuristic", fallback: false },
          scanFallbackReason: null,
          replyMeta: null,
        });
        if (!args.dryRun) await saveJson(STATE_PATH, state);
        summary.push({
          groupId: group.id,
          skipped: "low_activity_signal",
          signalScore: signals.score,
          speakers: signals.uniqueUsers,
          messages: signals.totalMessages,
          hasQuestion: signals.hasQuestion,
          hasMedia: signals.hasMedia,
        });
        continue;
      }

      const sessionKey = sessionTag(lastHumanKey || mark || Date.now());
      const decisionPrompt = buildDecisionPrompt(group, transcript, signals);
      let decisionText = "";
      let decision = { speak: false, reason: "empty" };
      let decisionMeta = {};
      let scanFallbackReason = null;

      try {
        const decisionResult = await runScanModel(cfg, decisionPrompt);
        decisionText = decisionResult?.text || "";
        decision = extractDecision(decisionText);
        decisionMeta = decisionResult?.meta || {};
        if (!decision.speak && ["empty", "invalid_decision"].includes(String(decision.reason || ""))) {
          throw new Error(`scan undecidable: ${decision.reason || "unknown"}`);
        }
      } catch (error) {
        scanFallbackReason = String(error?.message || error || "scan_failed");
        if (looksLikeUpstreamReplyErrorText(scanFallbackReason)) {
          await recordSuppressedMonitorError({
            source: "scan_primary",
            groupId: group.id,
            groupName: group.name,
            agentId: monitorAgentId,
            provider: "openrouter",
            model: resolveScanModel(cfg),
            reason: classifyUpstreamReplyError(scanFallbackReason),
            error: scanFallbackReason,
          });
        }
        const fallbackScan = await runFallbackScan(scanFallbackAgentId, `${scanFallbackAgentId}-scan-${group.id}-${sessionKey}`, decisionPrompt, monitorSettings);
        decisionText = fallbackScan?.text || "";
        decision = extractDecision(decisionText);
        decisionMeta = fallbackScan?.meta || {};
      }

      state.groups[String(group.id)] = buildStateRecord({
        prev,
        mark,
        lastHumanKey,
        decision: decision.speak ? "reply" : `skip:${decision.reason || "unknown"}`,
        decisionReason: decision.speak ? "reply" : (decision.reason || "unknown"),
        nowIso: new Date().toISOString(),
        signals,
        monitorSettings,
        group,
        agents: { replyAgentId, scanFallbackAgentId },
        scanMeta: decisionMeta,
        scanFallbackReason,
        replyMeta: null,
      });

      if (!decision.speak) {
        if (!args.dryRun) await saveJson(STATE_PATH, state);
        summary.push({
          groupId: group.id,
          skipped: "llm_no_reply",
          reason: decision.reason || "model_declined",
          signalScore: signals.score,
          decisionText,
          scanProvider: decisionMeta.provider || null,
          scanModel: decisionMeta.model || null,
          scanFallbackReason,
        });
        continue;
      }

      const styleQuotes = await loadStyleQuotes();
      const stickerContext = buildStickerContext(group, stickerSettings, stickerPacks, prev);
      const replyPrompt = buildReplyPrompt(group, transcript, signals, styleQuotes, stickerContext);
      const replyResult = await runReplyWithRetry(replyAgentId, `${replyAgentId}-${group.id}-${sessionKey}`, replyPrompt, monitorSettings);
      const replyText = replyResult?.text || "";
      const requestedStickerEmotion = String(replyResult?.stickerEmotion || "").trim();
      const suppressedReplyError = Boolean(replyResult?.suppressedUpstreamError);
      const suppressedReason = String(replyResult?.suppressedReason || "");
      const replyMeta = {
        ...(replyResult?.meta || {}),
        attempts: Number(replyResult?.attempts || 0),
        textLength: replyText.length,
        rawTextLength: String(replyResult?.rawText || "").length,
      };
      if (suppressedReplyError) {
        await recordSuppressedMonitorError({
          source: "reply_primary",
          groupId: group.id,
          groupName: group.name,
          agentId: replyAgentId,
          provider: replyMeta.provider || "",
          model: replyMeta.model || "",
          reason: suppressedReason,
          text: replyResult?.rawText || "",
        });
      }
      state.groups[String(group.id)] = buildStateRecord({
        prev,
        mark,
        lastHumanKey,
        decision: replyText ? "reply" : (suppressedReplyError ? "skip:suppressed_upstream_error" : "skip:empty_reply_model"),
        decisionReason: replyText ? "reply" : (suppressedReplyError ? (suppressedReason || "suppressed_upstream_error") : "empty_reply_model"),
        nowIso: new Date().toISOString(),
        signals,
        monitorSettings,
        group,
        agents: { replyAgentId, scanFallbackAgentId },
        scanMeta: decisionMeta,
        scanFallbackReason,
        replyMeta,
      });

      if (!replyText) {
        summary.push({
          groupId: group.id,
          skipped: suppressedReplyError ? "suppressed_upstream_error" : "empty_reply_model",
          suppressedReason: suppressedReplyError ? (suppressedReason || null) : null,
          signalScore: signals.score,
          decisionText,
          scanProvider: decisionMeta.provider || null,
          scanModel: decisionMeta.model || null,
          scanFallbackReason,
          replyProvider: replyMeta.provider || null,
          replyModel: replyMeta.model || null,
        });
        continue;
      }

      const stickerPack = stickerContext.enabled ? selectStickerPack(stickerPacks, requestedStickerEmotion) : null;
      const stickerSegment = stickerPack ? await stageStickerForNapCat(stickerSettings, stickerPack, sessionKey) : null;
      const outboundMessage = stickerSegment ? `${replyText}\n${stickerSegment}` : replyText;

      if (!args.dryRun) {
        await sendReply(rpc, group.id, outboundMessage, selfId);
        state.groups[String(group.id)].lastDeliveredAt = new Date().toISOString();
        state.groups[String(group.id)].lastDeliveredText = replyText;
        state.groups[String(group.id)].lastRepliedHumanMessageKey = lastHumanKey || "";
        state.groups[String(group.id)].lastStickerAt = stickerSegment ? state.groups[String(group.id)].lastDeliveredAt : (prev.lastStickerAt || null);
        state.groups[String(group.id)].lastStickerEmotion = stickerPack ? stickerPack.emotion : "";
        state.groups[String(group.id)].lastReplyMeta = {
          ...(state.groups[String(group.id)].lastReplyMeta || {}),
          delivered: true,
          deliveredAt: state.groups[String(group.id)].lastDeliveredAt,
          stickerEmotion: stickerPack ? stickerPack.emotion : null,
          stickerAttached: Boolean(stickerSegment),
        };
        await saveJson(STATE_PATH, state);
      }

      summary.push({
        groupId: group.id,
        dryRun: args.dryRun,
        signalScore: signals.score,
        deliveredText: replyText,
        stickerEmotion: stickerPack ? stickerPack.emotion : null,
        decisionText,
        scanProvider: decisionMeta.provider || null,
        scanModel: decisionMeta.model || null,
        scanFallbackReason,
        replyProvider: replyMeta.provider || null,
        replyModel: replyMeta.model || null,
      });
    }
  } finally {
    await rpc.close();
    if (!args.dryRun) {
      await saveJson(STATE_PATH, state);
    }
    await releaseLock(lockHandle, LOCK_PATH);
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
