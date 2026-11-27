import type { NextAuthConfig } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FACEBOOK_CONNECT_SCOPES } from "@/adapters/meta/facebook-oauth";

import {
  importPagesToVpostBackend,
  VPOST_ACTIVE_TENANT_COOKIE,
  VPOST_BACKEND_IMPORT_TIMEOUT_MS,
  VpostBackendImportError,
  type VpostBackendImportLogger,
} from "../vpost-backend-import";

/**
 * Tests for the Facebook sign-in → Python VPOST backend channel import bridge
 * and the `auth.ts` `events.signIn` hook that routes between the Python backend
 * (`VPOST_API_URL` set) and the legacy Next/Postgres store (`VPOST_API_URL`
 * unset).
 */

const USER_TOKEN = "EAAB-USER-ACCESS-TOKEN-SECRET-987654321";
const API_URL = "http://127.0.0.1:8020";
const TENANT_ID = "00000000-0000-4000-8000-000000000001";

interface LogEntry {
  level: string;
  message: string;
  bindings: Record<string, unknown>;
  context?: Record<string, unknown>;
}

function makeRecordingLogger(entries: LogEntry[]): VpostBackendImportLogger {
  const build = (bindings: Record<string, unknown>): VpostBackendImportLogger => ({
    child: (extra) => build({ ...bindings, ...extra }),
    info: (message, context) => entries.push({ level: "info", message, bindings, context }),
    warn: (message, context) => entries.push({ level: "warn", message, bindings, context }),
    error: (message, context) => entries.push({ level: "error", message, bindings, context }),
  });
  return build({});
}

function expectNoTokenLogged(entries: LogEntry[], token: string = USER_TOKEN): void {
  expect(JSON.stringify(entries)).not.toContain(token);
}

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function makeFakeFetch(
  responder: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function expectBackendError(promise: Promise<unknown>): Promise<VpostBackendImportError> {
  const caught = await promise.then(() => null).catch((err: unknown) => err);
  expect(VpostBackendImportError.is(caught)).toBe(true);
  return caught as VpostBackendImportError;
}

// --- Mocks for testing the real `auth.ts` events.signIn hook -----------------

const {
  capturedAuthFactories,
  facebookProviderSpy,
  legacyImportSpy,
  resolveAccountSpy,
  requireTenantSpy,
  connectImportSpy,
  mockContainerLoggerHolder,
} = vi.hoisted(() => ({
  capturedAuthFactories: [] as Array<() => NextAuthConfig>,
  facebookProviderSpy: vi.fn((options: Record<string, unknown>) => ({
    id: "facebook",
    type: "oauth",
    options,
  })),
  legacyImportSpy: vi.fn(async () => undefined),
  resolveAccountSpy: vi.fn(async () => null),
  requireTenantSpy: vi.fn(async () => {
    throw new Error("requireTenant should not be called on backend path");
  }),
  connectImportSpy: vi.fn(async () => ({ imported: 0, updated: 0, skipped: 0 })),
  mockContainerLoggerHolder: {
    current: null as VpostBackendImportLogger | null,
  },
}));

vi.mock("next-auth", () => ({
  CredentialsSignin: class CredentialsSignin extends Error {},
  default: (configOrFactory: NextAuthConfig | (() => NextAuthConfig)) => {
    if (typeof configOrFactory === "function") {
      capturedAuthFactories.push(configOrFactory);
    }
    return {
      handlers: {},
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  },
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((options: Record<string, unknown>) => ({ id: "google", options })),
}));

vi.mock("next-auth/providers/facebook", () => ({
  default: facebookProviderSpy,
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((options: Record<string, unknown>) => ({ id: "password", options })),
}));

vi.mock("../auth.config", () => ({
  loadAuthEnv: () => ({
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    SESSION_SECRET: "s".repeat(32),
  }),
  buildBaseAuthConfig: (): NextAuthConfig => ({
    providers: [],
    callbacks: {},
    events: {},
  }),
}));

vi.mock("@/composition/config", () => ({
  loadMetaOAuthConfig: () => ({
    META_APP_ID: "meta-app-id",
    META_APP_SECRET: "meta-app-secret",
    META_OAUTH_REDIRECT_URI: "https://vpost.example.com/api/channels/callback",
  }),
}));

vi.mock("@/composition/container", () => ({
  FACEBOOK_CONNECT_SCOPES,
  getContainer: () => ({
    logger: mockContainerLoggerHolder.current!,
    usecases: {
      operatorAccounts: {
        resolve: resolveAccountSpy,
        signIn: vi.fn(),
        provision: vi.fn(),
      },
      requireTenant: requireTenantSpy,
      connectChannels: {
        importChannels: connectImportSpy,
      },
      passwordAuth: {
        signIn: vi.fn(),
      },
    },
  }),
}));

vi.mock("../signin-channel-import", () => ({
  importChannelsFromSignIn: legacyImportSpy,
}));

// Load `auth.ts` AFTER mocks are registered so `NextAuth(factory)` captures the builder.
await import("../auth");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// --- Edge cases first: importPagesToVpostBackend -----------------------------

describe("importPagesToVpostBackend — input validation before network", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["token with spaces", "bad token with space"],
  ])("refuses %s userAccessToken without calling fetch or logging it", async (_label, badToken) => {
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() => jsonResponse({}));

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: API_URL,
        tenantId: TENANT_ID,
        userAccessToken: badToken,
        logger: makeRecordingLogger(logs),
        fetchImpl,
      }),
    );

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.httpStatus).toBeNull();
    expect(error.retryable).toBe(false);
    expect(requests).toHaveLength(0);
    if (badToken.trim().length > 0) {
      expectNoTokenLogged(logs, badToken);
      expect(error.message).not.toContain(badToken);
    }
  });

  it.each([
    ["empty apiUrl", ""],
    ["non-URL", "not-a-url"],
    ["non-http scheme", "ftp://127.0.0.1:8020"],
    ["apiUrl with query string", "http://127.0.0.1:8020?foo=bar"],
    ["apiUrl with fragment", "http://127.0.0.1:8020#frag"],
  ])("refuses %s without calling fetch", async (_label, badUrl) => {
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() => jsonResponse({}));

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: badUrl,
        userAccessToken: USER_TOKEN,
        logger: makeRecordingLogger(logs),
        fetchImpl,
      }),
    );

    expect(error.code).toBe("INVALID_INPUT");
    expect(requests).toHaveLength(0);
    expectNoTokenLogged(logs);
  });

  it("refuses tenantId containing cookie control characters", async () => {
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() => jsonResponse({}));

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: API_URL,
        tenantId: "tenant-1; evil=1",
        userAccessToken: USER_TOKEN,
        logger: makeRecordingLogger(logs),
        fetchImpl,
      }),
    );

    expect(error.code).toBe("INVALID_INPUT");
    expect(requests).toHaveLength(0);
    expectNoTokenLogged(logs);
  });
});

describe("importPagesToVpostBackend — timeout, transport and non-2xx handling", () => {
  it("enforces the default 20s timeout and throws typed TIMEOUT error", async () => {
    vi.useFakeTimers();
    const logs: LogEntry[] = [];
    const { fetchImpl } = makeFakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("Aborted", "TimeoutError"));
          });
        }),
    );

    expect(VPOST_BACKEND_IMPORT_TIMEOUT_MS).toBe(20_000);

    const promise = importPagesToVpostBackend({
      apiUrl: API_URL,
      tenantId: TENANT_ID,
      userAccessToken: USER_TOKEN,
      logger: makeRecordingLogger(logs),
      fetchImpl,
    });
    const handled = promise.then(() => null).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(19_999);
    // Still pending right before 20s; advancing the final 1ms triggers the timeout.
    await vi.advanceTimersByTimeAsync(1);

    const error = await handled;
    expect(VpostBackendImportError.is(error)).toBe(true);
    const typed = error as VpostBackendImportError;
    expect(typed.code).toBe("TIMEOUT");
    expect(typed.httpStatus).toBeNull();
    expect(typed.retryable).toBe(true);
    expect(logs.some((entry) => entry.level === "error" && entry.context?.code === "TIMEOUT")).toBe(
      true,
    );
    expectNoTokenLogged(logs);
  });

  it("aborts with TIMEOUT under a real short timeout budget", async () => {
    const logs: LogEntry[] = [];
    const { fetchImpl } = makeFakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: API_URL,
        userAccessToken: USER_TOKEN,
        logger: makeRecordingLogger(logs),
        fetchImpl,
        timeoutMs: 25,
      }),
    );

    expect(error.code).toBe("TIMEOUT");
    expect(error.retryable).toBe(true);
    expectNoTokenLogged(logs);
  });

  it("maps transport failures to typed NETWORK_ERROR without logging the token", async () => {
    const logs: LogEntry[] = [];
    const { fetchImpl } = makeFakeFetch(() => Promise.reject(new TypeError("fetch failed")));

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: API_URL,
        userAccessToken: USER_TOKEN,
        logger: makeRecordingLogger(logs),
        fetchImpl,
      }),
    );

    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.httpStatus).toBeNull();
    expect(error.retryable).toBe(true);
    expectNoTokenLogged(logs);
  });

  it.each([
    [400, { code: "TOKEN_INVALID", message: "Token hết hạn" }, "TOKEN_INVALID", false],
    [403, { code: "FORBIDDEN", message: "Khác tenant" }, "FORBIDDEN", false],
    [502, { code: "GRAPH_UNREACHABLE", message: "Facebook không phản hồi" }, "GRAPH_UNREACHABLE", true],
    [400, { detail: { code: "APP_NOT_CONFIGURED", message: "Missing app" } }, "APP_NOT_CONFIGURED", false],
  ])(
    "throws typed error with backend code on HTTP %i",
    async (status, body, expectedCode, expectedRetryable) => {
      const logs: LogEntry[] = [];
      const { fetchImpl } = makeFakeFetch(() => jsonResponse(body, status));

      const error = await expectBackendError(
        importPagesToVpostBackend({
          apiUrl: API_URL,
          tenantId: TENANT_ID,
          userAccessToken: USER_TOKEN,
          logger: makeRecordingLogger(logs),
          fetchImpl,
        }),
      );

      expect(error.code).toBe(expectedCode);
      expect(error.httpStatus).toBe(status);
      expect(error.retryable).toBe(expectedRetryable);
      expect(
        logs.some(
          (entry) =>
            entry.level === "error" &&
            entry.context?.code === expectedCode &&
            entry.context?.http_status === status,
        ),
      ).toBe(true);
      expectNoTokenLogged(logs);
    },
  );

  it("falls back to HTTP_<status> on non-JSON 502 HTML and never echoes the token", async () => {
    const logs: LogEntry[] = [];
    const { fetchImpl } = makeFakeFetch(
      () =>
        new Response(`<html>502 Bad Gateway echoed ${USER_TOKEN}</html>`, {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: API_URL,
        userAccessToken: USER_TOKEN,
        logger: makeRecordingLogger(logs),
        fetchImpl,
      }),
    );

    expect(error.code).toBe("HTTP_502");
    expect(error.httpStatus).toBe(502);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(USER_TOKEN);
    expectNoTokenLogged(logs);
  });

  it("never leaks the token even if a backend error body echoes it in code or message", async () => {
    const logs: LogEntry[] = [];
    const { fetchImpl } = makeFakeFetch(() =>
      jsonResponse({ code: USER_TOKEN, message: `Invalid token ${USER_TOKEN}` }, 400),
    );

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: API_URL,
        userAccessToken: USER_TOKEN,
        logger: makeRecordingLogger(logs),
        fetchImpl,
      }),
    );

    expect(error.code).toBe("HTTP_400");
    expect(error.message).not.toContain(USER_TOKEN);
    expectNoTokenLogged(logs);
  });

  it("rejects a 200 response missing required count fields as INVALID_RESPONSE", async () => {
    const logs: LogEntry[] = [];
    const { fetchImpl } = makeFakeFetch(() => jsonResponse({ imported: 2 }));

    const error = await expectBackendError(
      importPagesToVpostBackend({
        apiUrl: API_URL,
        userAccessToken: USER_TOKEN,
        logger: makeRecordingLogger(logs),
        fetchImpl,
      }),
    );

    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.httpStatus).toBe(200);
    expect(error.retryable).toBe(false);
    expectNoTokenLogged(logs);
  });
});

// --- Happy paths: request shape and response ---------------------------------

describe("importPagesToVpostBackend — request shape & success", () => {
  it("POSTs JSON { userAccessToken } to {apiUrl}/api/channels/import with tenant cookie when tenantId is set", async () => {
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() =>
      jsonResponse({
        tenantId: TENANT_ID,
        imported: 2,
        updated: 1,
        skipped: 1,
        channels: [{ channelId: "fb-111", name: "Shop A" }],
      }),
    );

    const result = await importPagesToVpostBackend({
      apiUrl: `${API_URL}///`,
      tenantId: `  ${TENANT_ID}  `,
      userAccessToken: USER_TOKEN,
      logger: makeRecordingLogger(logs),
      fetchImpl,
    });

    expect(result).toEqual({ imported: 2, updated: 1, skipped: 1 });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req.url).toBe(`${API_URL}/api/channels/import`);
    expect(req.init?.method).toBe("POST");
    expect(req.init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      cookie: `${VPOST_ACTIVE_TENANT_COOKIE}=${TENANT_ID}`,
    });
    expect(req.init?.body).toBe(JSON.stringify({ userAccessToken: USER_TOKEN }));
    expect(req.init?.signal).toBeInstanceOf(AbortSignal);
    expect(
      logs.some(
        (entry) =>
          entry.level === "info" &&
          entry.context?.imported === 2 &&
          entry.context?.updated === 1 &&
          entry.context?.skipped === 1,
      ),
    ).toBe(true);
    expectNoTokenLogged(logs);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace", "   "],
  ])("omits the cookie header when tenantId is %s", async (_label, tenantId) => {
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() =>
      jsonResponse({ imported: 1, updated: 0, skipped: 0 }),
    );

    const result = await importPagesToVpostBackend({
      apiUrl: API_URL,
      tenantId,
      userAccessToken: USER_TOKEN,
      logger: makeRecordingLogger(logs),
      fetchImpl,
    });

    expect(result).toEqual({ imported: 1, updated: 0, skipped: 0 });
    expect(requests).toHaveLength(1);
    const headers = requests[0].init?.headers as Record<string, string>;
    expect(headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect("cookie" in headers).toBe(false);
    expectNoTokenLogged(logs);
  });
});

// --- Integration with auth.ts Facebook sign-in hook & scopes -----------------

describe("auth.ts Facebook sign-in hook", () => {
  function buildAuthConfig(logs: LogEntry[]): NextAuthConfig {
    mockContainerLoggerHolder.current = makeRecordingLogger(logs);
    const factory = capturedAuthFactories[capturedAuthFactories.length - 1];
    expect(factory).toBeTypeOf("function");
    return factory();
  }

  it("asks Facebook sign-in for both comment permissions via FACEBOOK_CONNECT_SCOPES", () => {
    const logs: LogEntry[] = [];
    buildAuthConfig(logs);

    expect(facebookProviderSpy).toHaveBeenCalledTimes(1);
    const callArg = facebookProviderSpy.mock.calls[0]?.[0] as {
      authorization?: { params?: { scope?: string } };
    };
    const scopes = (callArg?.authorization?.params?.scope ?? "").split(",");
    expect(scopes).toEqual([
      "public_profile",
      "email",
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
      "pages_read_user_content",
      "pages_manage_engagement",
    ]);
  });

  it("uses the Python backend import when VPOST_API_URL is set (with VPOST_TENANT_ID cookie) and skips legacy membership import", async () => {
    vi.stubEnv("VPOST_API_URL", API_URL);
    vi.stubEnv("VPOST_TENANT_ID", TENANT_ID);
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() =>
      jsonResponse({ imported: 3, updated: 0, skipped: 0 }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const config = buildAuthConfig(logs);
    await config.events?.signIn?.({
      user: { id: "u-1" },
      account: {
        provider: "facebook",
        type: "oauth",
        providerAccountId: "992710700450296",
        access_token: USER_TOKEN,
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${API_URL}/api/channels/import`);
    expect(requests[0].init?.method).toBe("POST");
    expect(requests[0].init?.body).toBe(JSON.stringify({ userAccessToken: USER_TOKEN }));
    expect(requests[0].init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      cookie: `${VPOST_ACTIVE_TENANT_COOKIE}=${TENANT_ID}`,
    });
    expect(legacyImportSpy).not.toHaveBeenCalled();
    expect(resolveAccountSpy).not.toHaveBeenCalled();
    expect(requireTenantSpy).not.toHaveBeenCalled();
    expectNoTokenLogged(logs);
  });

  it("omits cookie on the backend path when VPOST_TENANT_ID is unset", async () => {
    vi.stubEnv("VPOST_API_URL", API_URL);
    vi.stubEnv("VPOST_TENANT_ID", "");
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() =>
      jsonResponse({ imported: 1, updated: 0, skipped: 0 }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const config = buildAuthConfig(logs);
    await config.events?.signIn?.({
      user: { id: "u-1" },
      account: {
        provider: "facebook",
        type: "oauth",
        providerAccountId: "992710700450296",
        access_token: USER_TOKEN,
      },
    });

    expect(requests).toHaveLength(1);
    const headers = requests[0].init?.headers as Record<string, string>;
    expect("cookie" in headers).toBe(false);
    expect(legacyImportSpy).not.toHaveBeenCalled();
    expectNoTokenLogged(logs);
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
  ])("keeps the legacy importChannelsFromSignIn path when VPOST_API_URL is %s", async (_label, apiUrl) => {
    vi.stubEnv("VPOST_API_URL", apiUrl);
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() => jsonResponse({}));
    vi.stubGlobal("fetch", fetchImpl);

    const config = buildAuthConfig(logs);
    await config.events?.signIn?.({
      user: { id: "u-1" },
      account: {
        provider: "facebook",
        type: "oauth",
        providerAccountId: "992710700450296",
        access_token: USER_TOKEN,
      },
    });

    expect(requests).toHaveLength(0);
    expect(legacyImportSpy).toHaveBeenCalledTimes(1);
    expect(legacyImportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.any(Object),
      }),
      {
        userAccessToken: USER_TOKEN,
        sessionEmail: "fb-992710700450296@facebook.local",
        facebookUserId: "992710700450296",
      },
    );
  });

  it("never blocks sign-in when the backend import fails, logs provider/step/code, and never logs the token", async () => {
    vi.stubEnv("VPOST_API_URL", API_URL);
    vi.stubEnv("VPOST_TENANT_ID", TENANT_ID);
    const logs: LogEntry[] = [];
    const { fetchImpl } = makeFakeFetch(() =>
      jsonResponse({ code: "GRAPH_UNREACHABLE", message: `Failed for ${USER_TOKEN}` }, 502),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const config = buildAuthConfig(logs);
    await expect(
      config.events?.signIn?.({
        user: { id: "u-1" },
        account: {
          provider: "facebook",
          type: "oauth",
          providerAccountId: "992710700450296",
          access_token: USER_TOKEN,
        },
      }),
    ).resolves.toBeUndefined();

    expect(legacyImportSpy).not.toHaveBeenCalled();
    expect(
      logs.some(
        (entry) =>
          entry.level === "error" &&
          entry.context?.provider === "facebook" &&
          entry.context?.step === "import_on_signin" &&
          entry.context?.code === "GRAPH_UNREACHABLE",
      ),
    ).toBe(true);
    expectNoTokenLogged(logs);
  });

  it("ignores non-facebook sign-in events", async () => {
    vi.stubEnv("VPOST_API_URL", API_URL);
    const logs: LogEntry[] = [];
    const { fetchImpl, requests } = makeFakeFetch(() => jsonResponse({}));
    vi.stubGlobal("fetch", fetchImpl);

    const config = buildAuthConfig(logs);
    await config.events?.signIn?.({
      user: { id: "u-1" },
      account: {
        provider: "google",
        type: "oauth",
        providerAccountId: "google-sub-1",
        access_token: USER_TOKEN,
      },
    });

    expect(requests).toHaveLength(0);
    expect(legacyImportSpy).not.toHaveBeenCalled();
  });
});
