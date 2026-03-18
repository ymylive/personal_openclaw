import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn(() => ({}));
const resolveMarkdownTableModeMock = vi.fn(() => "preserve");
const convertMarkdownTablesMock = vi.fn((text: string) => text);
const recordActivityMock = vi.fn();
const resolveAccountMock = vi.fn();
const generateSignatureMock = vi.fn(() => ({ random: "random", signature: "signature" }));

vi.mock("./runtime.js", () => ({
  getNextcloudTalkRuntime: () => ({
    config: { loadConfig: loadConfigMock },
    channel: {
      text: {
        resolveMarkdownTableMode: resolveMarkdownTableModeMock,
        convertMarkdownTables: convertMarkdownTablesMock,
      },
      activity: { record: recordActivityMock },
    },
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveNextcloudTalkAccount: (...args: unknown[]) => resolveAccountMock(...args),
}));

vi.mock("./signature.js", () => ({
  generateNextcloudTalkSignature: (...args: unknown[]) => generateSignatureMock(...args),
}));

import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";

function createResponse(params: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
}) {
  return {
    ok: params.ok,
    status: params.status,
    json: vi.fn(async () => params.json ?? {}),
    text: vi.fn(async () => params.text ?? ""),
  };
}

describe("nextcloud-talk redaction", () => {
  const fetchMock = vi.fn();
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    resolveAccountMock.mockReturnValue({
      accountId: "default",
      baseUrl: "https://nextcloud.example",
      secret: "bot-secret",
      config: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redacts the room token in verbose send logs", async () => {
    fetchMock.mockResolvedValueOnce(
      createResponse({
        ok: true,
        status: 200,
        json: { ocs: { data: { id: 123 } } },
      }),
    );

    await sendMessageNextcloudTalk("nextcloud-talk:room:super-secret-room", "hello", {
      verbose: true,
    });

    const logMessage = String(consoleLogSpy.mock.calls[0]?.[0] ?? "");
    expect(logMessage).toContain("[redacted-room-token]");
    expect(logMessage).not.toContain("super-secret-room");
  });

  it("redacts the room token in send errors", async () => {
    fetchMock.mockResolvedValueOnce(
      createResponse({
        ok: false,
        status: 404,
        text: "room super-secret-room does not exist",
      }),
    );

    let thrown: unknown;
    try {
      await sendMessageNextcloudTalk("super-secret-room", "hello");
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("room not found");
    expect(message).not.toContain("super-secret-room");
  });

  it("redacts the room token in reaction errors", async () => {
    fetchMock.mockResolvedValueOnce(
      createResponse({
        ok: false,
        status: 500,
        text: "failed to post /bot/super-secret-room/reaction/42",
      }),
    );

    let thrown: unknown;
    try {
      await sendReactionNextcloudTalk("super-secret-room", "42", ":+1:");
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("[redacted-room-token]");
    expect(message).not.toContain("super-secret-room");
  });

  it("redacts the room token in room lookup logs", async () => {
    fetchMock.mockResolvedValueOnce(
      createResponse({
        ok: false,
        status: 404,
      }),
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    await resolveNextcloudTalkRoomKind({
      account: {
        accountId: "default",
        enabled: true,
        baseUrl: "https://nextcloud.example",
        secret: "bot-secret",
        secretSource: "config",
        config: {
          apiUser: "alice",
          apiPassword: "password",
        },
      },
      roomToken: "super-secret-room-lookup",
      runtime: runtime as never,
    });

    const logMessage = String(runtime.log.mock.calls[0]?.[0] ?? "");
    expect(logMessage).toContain("[redacted-room-token]");
    expect(logMessage).not.toContain("super-secret-room-lookup");
  });
});
