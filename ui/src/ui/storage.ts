const KEY = "openclaw.control.settings.v1";
const SESSION_TOKEN_KEY = "openclaw.control.session-token.v1";

import type { ThemeMode } from "./theme.ts";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
};

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readSessionToken(): string {
  const sessionStorage = getSessionStorage();
  const localStorage = getLocalStorage();
  const tokenStorage = sessionStorage ?? localStorage;
  const sessionToken = tokenStorage?.getItem(SESSION_TOKEN_KEY)?.trim() ?? "";
  if (sessionToken) {
    return sessionToken;
  }
  try {
    const raw = localStorage?.getItem(KEY);
    if (!raw) {
      return "";
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const legacyToken = typeof parsed.token === "string" ? parsed.token.trim() : "";
    if (!legacyToken) {
      return "";
    }
    tokenStorage?.setItem(SESSION_TOKEN_KEY, legacyToken);
    const sanitized = { ...parsed, token: "" };
    localStorage?.setItem(KEY, JSON.stringify(sanitized));
    return legacyToken;
  } catch {
    return "";
  }
}

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
  };
  const token = readSessionToken();

  try {
    const raw = getLocalStorage()?.getItem(KEY);
    if (!raw) {
      return { ...defaults, token };
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      gatewayUrl:
        typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
          ? parsed.gatewayUrl.trim()
          : defaults.gatewayUrl,
      token,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" && parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : defaults.theme,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean" ? parsed.chatFocusMode : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
    };
  } catch {
    return { ...defaults, token };
  }
}

export function saveSettings(next: UiSettings) {
  const localStorage = getLocalStorage();
  const sessionStorage = getSessionStorage();
  const tokenStorage = sessionStorage ?? localStorage;
  const { token, ...persisted } = next;
  localStorage?.setItem(KEY, JSON.stringify({ ...persisted, token: "" }));
  if (token.trim()) {
    tokenStorage?.setItem(SESSION_TOKEN_KEY, token);
  } else {
    tokenStorage?.removeItem(SESSION_TOKEN_KEY);
  }
}
