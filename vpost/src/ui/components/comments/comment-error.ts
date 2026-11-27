import {
  presentApiError,
  toApiError,
  type ApiErrorKind,
  type ApiErrorView,
} from "@/ui/components/feedback/present-api-error";
import { isReconnectPageCode, parseBlockedReasons } from "@/ui/schemas/comment.schema";
import type { ApiError } from "@/ui/services/api-error";
import { CommentBlockedError } from "@/ui/services/comment.api";

/**
 * Local error classification for the "Bình luận" screen.
 *
 * Extends shared `presentApiError` without editing `feedback/*` or `api-error.ts`:
 * - `PERMISSION_MISSING` / `TOKEN_INVALID` / `CHANNEL_NOT_CONFIGURED` -> reconnect `/channels` (no retry)
 * - HTTP `401` / `UNAUTHORIZED` / `TOKEN_EXPIRED` -> sign-in link `/signin` (no retry)
 * - HTTP `429` / `RATE_LIMITED` / `POSTING_TOO_FAST` -> retryable with wait-then-retry copy
 * - Network (`status === 0`) / `5xx` -> retryable
 * - Other `4xx` -> non-retryable
 */

export type CommentErrorKind = ApiErrorKind | "reconnect" | "rate-limit";

export interface CommentErrorView extends Omit<ApiErrorView, "kind"> {
  readonly kind: CommentErrorKind;
  readonly apiError: ApiError;
}

export function isCommentRateLimitError(error: ApiError): boolean {
  return (
    error.status === 429 ||
    error.code === "RATE_LIMITED" ||
    error.code === "POSTING_TOO_FAST"
  );
}

export function isCommentAuthError(error: ApiError): boolean {
  return (
    error.status === 401 ||
    error.code === "UNAUTHORIZED" ||
    error.code === "TOKEN_EXPIRED"
  );
}

/**
 * Extracts block reasons from a 422 `BLOCKED` `ApiError`.
 * Uses the structured `reasons` array when present (e.g. `CommentBlockedError`),
 * falling back to splitting `error.userMessage` by `;`.
 */
export function extractBlockedReasonsFromError(error: ApiError | null): string[] {
  if (!error || error.status !== 422 || error.code !== "BLOCKED") return [];
  if (error instanceof CommentBlockedError) {
    return parseBlockedReasons(error.userMessage, error.reasons);
  }
  const maybeReasons =
    "reasons" in error && Array.isArray((error as { reasons?: unknown }).reasons)
      ? (error as { reasons: unknown[] }).reasons.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined;
  return parseBlockedReasons(error.userMessage, maybeReasons);
}

export function presentCommentApiError(error: unknown): CommentErrorView {
  const apiError = toApiError(error);

  if (isReconnectPageCode(apiError.code)) {
    return {
      kind: "reconnect",
      title: "Page thiếu quyền đọc hoặc trả lời bình luận",
      description: apiError.userMessage,
      canRetry: false,
      apiError,
    };
  }

  if (isCommentAuthError(apiError)) {
    return {
      kind: "auth",
      title: "Phiên đăng nhập đã kết thúc",
      description: `${apiError.userMessage} Đăng nhập lại để tiếp tục — nội dung bạn đã nhập vẫn còn trên màn hình.`,
      canRetry: false,
      apiError,
    };
  }

  if (isCommentRateLimitError(apiError)) {
    return {
      kind: "rate-limit",
      title: "Facebook đang giới hạn tần suất thao tác",
      description: apiError.userMessage,
      hint: "Vui lòng chờ một lát rồi thử lại để tránh bị Facebook tạm khoá.",
      canRetry: true,
      apiError,
    };
  }

  const shared = presentApiError(apiError);
  return {
    ...shared,
    apiError,
  };
}
