import { z } from "zod";

/**
 * Server-side bridge from Auth.js Facebook sign-in to the Python VPOST backend.
 *
 * When `VPOST_API_URL` is configured, VPOST screens read channels from the
 * Python backend (`codebase/vpost_api.py`), not from Next/Postgres. Calling
 * `POST {VPOST_API_URL}/api/channels/import` with the User Access Token from
 * Facebook sign-in exchanges it for a long-lived token and saves every managed
 * Page as channel `fb-<page id>` in one step.
 *
 * SECURITY: the User Access Token travels ONLY in the JSON POST body and never
 * enters a URL, log message, log context, or error message.
 */

export const VPOST_BACKEND_IMPORT_TIMEOUT_MS = 20_000;
export const VPOST_ACTIVE_TENANT_COOKIE = "vpost_active_tenant";

const SAFE_ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SIGNIN_STEP = "import_on_signin";

/** Structural mirror — the app layer may not import core/ports (docs/07 §2). */
export interface VpostBackendImportLogger {
  child(bindings: Record<string, unknown>): VpostBackendImportLogger;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown> & { err?: unknown }): void;
}

export interface ImportPagesToVpostBackendInput {
  readonly apiUrl: string;
  readonly tenantId?: string | null;
  readonly userAccessToken: string;
  readonly logger: VpostBackendImportLogger;
  /** Injection seam for tests; production uses globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Override for tests; production uses VPOST_BACKEND_IMPORT_TIMEOUT_MS (20s). */
  readonly timeoutMs?: number;
}

export interface VpostBackendImportResult {
  readonly imported: number;
  readonly updated: number;
  readonly skipped: number;
}

export class VpostBackendImportError extends Error {
  readonly _tag = "VpostBackendImportError" as const;
  readonly code: string;
  readonly httpStatus: number | null;
  readonly retryable: boolean;

  constructor(
    code: string,
    options: {
      message?: string;
      httpStatus?: number | null;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    const defaultMessage =
      options.httpStatus !== undefined && options.httpStatus !== null
        ? `VPOST backend channel import failed: ${code} (HTTP ${options.httpStatus})`
        : `VPOST backend channel import failed: ${code}`;
    super(options.message ?? defaultMessage, { cause: options.cause });
    this.name = "VpostBackendImportError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = options.retryable ?? false;
  }

  static is(value: unknown): value is VpostBackendImportError {
    if (value instanceof VpostBackendImportError) return true;
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { _tag?: unknown })._tag === "VpostBackendImportError" &&
      typeof (value as { code?: unknown }).code === "string"
    );
  }
}

const BackendImportSuccessSchema = z.object({
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

const BackendErrorEnvelopeSchema = z.object({
  code: z.string().trim().min(1).optional(),
  detail: z
    .union([
      z.object({ code: z.string().trim().min(1).optional() }),
      z.string(),
    ])
    .optional(),
});

function buildImportUrl(rawApiUrl: string): string {
  const trimmed = typeof rawApiUrl === "string" ? rawApiUrl.trim() : "";
  if (trimmed.length === 0) {
    throw new VpostBackendImportError("INVALID_INPUT", {
      message: "VPOST backend apiUrl is required",
      retryable: false,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new VpostBackendImportError("INVALID_INPUT", {
      message: "VPOST backend apiUrl is not a valid URL",
      retryable: false,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VpostBackendImportError("INVALID_INPUT", {
      message: "VPOST backend apiUrl must use http or https",
      retryable: false,
    });
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new VpostBackendImportError("INVALID_INPUT", {
      message: "VPOST backend apiUrl must not contain a query string or fragment",
      retryable: false,
    });
  }

  return `${trimmed.replace(/\/+$/, "")}/api/channels/import`;
}

function parseTenantCookieValue(rawTenantId: string | null | undefined): string | null {
  if (typeof rawTenantId !== "string") return null;
  const trimmed = rawTenantId.trim();
  if (trimmed.length === 0) return null;
  if (/[\r\n;]/.test(trimmed)) {
    throw new VpostBackendImportError("INVALID_INPUT", {
      message: "VPOST_TENANT_ID contains invalid cookie characters",
      retryable: false,
    });
  }
  return trimmed;
}

function extractBackendErrorCode(payload: unknown, httpStatus: number, token: string): string {
  const parsed = BackendErrorEnvelopeSchema.safeParse(payload);
  const candidate = parsed.success
    ? (parsed.data.code ?? (typeof parsed.data.detail === "object" ? parsed.data.detail.code : undefined))
    : undefined;

  if (
    typeof candidate === "string" &&
    SAFE_ERROR_CODE_RE.test(candidate) &&
    !candidate.includes(token)
  ) {
    return candidate;
  }
  return `HTTP_${httpStatus}`;
}

function resolveTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : VPOST_BACKEND_IMPORT_TIMEOUT_MS;
}

function isAbortOrTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * POST `{apiUrl}/api/channels/import` with `{ userAccessToken }` and a 20s
 * timeout. Sends `Cookie: vpost_active_tenant=<tenantId>` only when `tenantId`
 * is non-empty. Never logs the token.
 */
export async function importPagesToVpostBackend(
  input: ImportPagesToVpostBackendInput,
): Promise<VpostBackendImportResult> {
  const log = input.logger.child({
    component: "vpost-backend-import",
    provider: "facebook",
    step: SIGNIN_STEP,
  });

  // --- Edge cases first: validate every boundary before touching the network ---
  const token = typeof input.userAccessToken === "string" ? input.userAccessToken.trim() : "";
  if (token.length === 0 || /\s/.test(token)) {
    const error = new VpostBackendImportError("INVALID_INPUT", {
      message: "Facebook userAccessToken is required and must not contain whitespace",
      retryable: false,
    });
    log.warn("Refused VPOST backend channel import: invalid user access token", {
      provider: "facebook",
      step: SIGNIN_STEP,
      code: error.code,
    });
    throw error;
  }

  let url: string;
  let tenantCookieValue: string | null;
  try {
    url = buildImportUrl(input.apiUrl);
    tenantCookieValue = parseTenantCookieValue(input.tenantId);
  } catch (error) {
    const typed = VpostBackendImportError.is(error)
      ? error
      : new VpostBackendImportError("INVALID_INPUT", { retryable: false });
    log.warn("Refused VPOST backend channel import: invalid backend configuration", {
      provider: "facebook",
      step: SIGNIN_STEP,
      code: typed.code,
    });
    throw typed;
  }

  const doFetch = input.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    const error = new VpostBackendImportError("INTERNAL", {
      message: "No fetch implementation available for VPOST backend channel import",
      retryable: false,
    });
    log.error("VPOST backend channel import unavailable: no fetch implementation", {
      provider: "facebook",
      step: SIGNIN_STEP,
      code: error.code,
    });
    throw error;
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (tenantCookieValue !== null) {
    headers.cookie = `${VPOST_ACTIVE_TENANT_COOKIE}=${tenantCookieValue}`;
  }

  const timeoutMs = resolveTimeoutMs(input.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);

  const startedAt = Date.now();
  let response: Response;
  let rawText: string;

  try {
    response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ userAccessToken: token }),
      signal: controller.signal,
    });
    rawText = await response.text();
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = timedOut || isAbortOrTimeout(error);
    const code = isTimeout ? "TIMEOUT" : "NETWORK_ERROR";
    const typed = new VpostBackendImportError(code, {
      message: isTimeout
        ? `VPOST backend channel import timed out after ${timeoutMs}ms`
        : "VPOST backend channel import failed before receiving a response",
      httpStatus: null,
      retryable: true,
      cause: error,
    });
    log.error(
      isTimeout
        ? "VPOST backend channel import timed out"
        : "VPOST backend channel import failed with a transport error",
      {
        provider: "facebook",
        step: SIGNIN_STEP,
        code,
        timeout_ms: isTimeout ? timeoutMs : undefined,
        duration_ms: durationMs,
      },
    );
    throw typed;
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  let parsedJson: unknown = null;
  let jsonValid = false;
  if (rawText.length > 0) {
    try {
      parsedJson = JSON.parse(rawText);
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
  }

  // --- Non-2xx: surface backend code without echoing raw response or token ---
  if (!response.ok) {
    const backendCode = extractBackendErrorCode(jsonValid ? parsedJson : null, response.status, token);
    const retryable = response.status >= 500 || response.status === 429;
    const typed = new VpostBackendImportError(backendCode, {
      httpStatus: response.status,
      retryable,
    });
    log.error("VPOST backend channel import returned a non-2xx response", {
      provider: "facebook",
      step: SIGNIN_STEP,
      code: backendCode,
      http_status: response.status,
      duration_ms: durationMs,
    });
    throw typed;
  }

  // --- 2xx: validate external payload shape before returning ---
  const parsedSuccess = jsonValid ? BackendImportSuccessSchema.safeParse(parsedJson) : null;
  if (!parsedSuccess || !parsedSuccess.success) {
    const issues = parsedSuccess
      ? parsedSuccess.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)")
      : ["(non-json)"];
    const typed = new VpostBackendImportError("INVALID_RESPONSE", {
      message: "VPOST backend channel import answered with an unexpected JSON shape",
      httpStatus: response.status,
      retryable: false,
    });
    log.error("VPOST backend channel import returned an unexpected response shape", {
      provider: "facebook",
      step: SIGNIN_STEP,
      code: typed.code,
      http_status: response.status,
      issues,
      duration_ms: durationMs,
    });
    throw typed;
  }

  const result: VpostBackendImportResult = {
    imported: parsedSuccess.data.imported,
    updated: parsedSuccess.data.updated,
    skipped: parsedSuccess.data.skipped,
  };
  log.info("Imported Facebook Pages into VPOST backend", {
    provider: "facebook",
    step: SIGNIN_STEP,
    imported: result.imported,
    updated: result.updated,
    skipped: result.skipped,
    has_tenant_cookie: tenantCookieValue !== null,
    duration_ms: durationMs,
  });
  return result;
}
