import {
  COMMENT_REPLY_MAX_LENGTH,
  CommentBlockedErrorBodySchema,
  CommentListResponseSchema,
  CommentMutationResponseSchema,
  CommentPatchDraftResponseSchema,
  CommentSyncResponseSchema,
  parseBlockedReasons,
  type CommentFilter,
  type CommentListResponse,
  type CommentMutationResponse,
  type CommentPatchDraftResponse,
  type CommentStatus,
  type CommentSyncResponse,
} from "@/ui/schemas/comment.schema";
import type { ModerationAction } from "@/ui/schemas/moderation.schema";

import { ApiError, CLIENT_ERROR_CODES } from "./api-error";
import { apiRequest, toApiErrorBody } from "./http-client";

/**
 * Typed 422 BLOCKED error carrying the structured `reasons` array from
 * `POST /api/comments/{id}/reply` without modifying shared `ApiError`.
 */
export class CommentBlockedError extends ApiError {
  readonly reasons: readonly string[];

  constructor(params: {
    status: number;
    userMessage: string;
    reasons: readonly string[];
    message?: string;
  }) {
    super({
      code: "BLOCKED",
      status: params.status,
      userMessage: params.userMessage,
      message: params.message ?? `BLOCKED (HTTP ${params.status})`,
    });
    this.name = "CommentBlockedError";
    this.reasons = params.reasons;
  }
}

/**
 * Data layer for `/api/comments/*`. Every response is parsed with zod via `apiRequest`.
 */

/** AI draft generation runs a model call plus up to one retry. */
export const AI_DRAFT_TIMEOUT_MS = 90_000;

/** Syncing comments pages through Graph API per published post. */
export const SYNC_TIMEOUT_MS = 60_000;

/**
 * Facebook Graph API reply/hide calls wait up to 30s server-side
 * (`codebase/facebook.py`); keep client timeout comfortably above that.
 */
export const COMMENT_SEND_TIMEOUT_MS = 45_000;
export const COMMENT_HIDE_TIMEOUT_MS = 45_000;

/** Single query-key factory so cache reads and invalidations never drift. */
export const commentKeys = {
  all: (tenantKey: string) => ["comments", tenantKey] as const,
  list: (tenantKey: string, filter: CommentFilter) =>
    [
      "comments",
      tenantKey,
      "list",
      filter.status,
      filter.moderation ?? "all",
      filter.channelId ?? "all",
      filter.postJobId ?? "all",
      filter.q ?? "",
    ] as const,
};

function requireCommentId(commentId: string, caller: string): string {
  const id = commentId.trim();
  if (id.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${caller} requires a commentId`,
      userMessage: "Thiếu mã bình luận.",
    });
  }
  return id;
}

function requireReplyText(text: string, caller: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${caller} requires non-empty text`,
      userMessage: "Nội dung trả lời không được để trống.",
    });
  }
  if (trimmed.length > COMMENT_REPLY_MAX_LENGTH) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${caller} text exceeds ${COMMENT_REPLY_MAX_LENGTH} characters`,
      userMessage: `Nội dung trả lời tối đa ${COMMENT_REPLY_MAX_LENGTH.toLocaleString("vi-VN")} ký tự.`,
    });
  }
  return trimmed;
}

export interface ListCommentsParams {
  status?: CommentStatus | null;
  moderation?: ModerationAction | null;
  channelId?: string | null;
  postJobId?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
}

export async function listComments(
  params: ListCommentsParams,
  signal?: AbortSignal,
): Promise<CommentListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.moderation) query.set("moderation", params.moderation);
  if (params.channelId) query.set("channelId", params.channelId);
  if (params.postJobId) query.set("postJobId", params.postJobId);
  if (params.q) query.set("q", params.q);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));

  const qs = query.toString();
  return apiRequest(qs ? `/api/comments?${qs}` : "/api/comments", {
    schema: CommentListResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu danh sách bình luận không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export interface SyncCommentsParams {
  channelId?: string | null;
  postJobId?: string | null;
  lookbackDays?: number | null;
}

export async function syncComments(
  params: SyncCommentsParams = {},
  signal?: AbortSignal,
): Promise<CommentSyncResponse> {
  const body: Record<string, unknown> = {};
  const channelId = params.channelId?.trim();
  const postJobId = params.postJobId?.trim();
  if (channelId) body.channelId = channelId;
  if (postJobId) body.postJobId = postJobId;
  if (typeof params.lookbackDays === "number" && Number.isInteger(params.lookbackDays)) {
    body.lookbackDays = params.lookbackDays;
  }

  return apiRequest("/api/comments/sync", {
    method: "POST",
    body,
    schema: CommentSyncResponseSchema,
    signal,
    timeoutMs: SYNC_TIMEOUT_MS,
    malformedMessage:
      "Kết quả đồng bộ bình luận không đúng định dạng. Hãy tải lại trang để kiểm tra.",
  });
}

export async function generateCommentDraft(
  commentId: string,
  signal?: AbortSignal,
): Promise<CommentMutationResponse> {
  const id = requireCommentId(commentId, "generateCommentDraft");
  return apiRequest(`/api/comments/${encodeURIComponent(id)}/draft`, {
    method: "POST",
    body: {},
    schema: CommentMutationResponseSchema,
    signal,
    timeoutMs: AI_DRAFT_TIMEOUT_MS,
    malformedMessage:
      "Kết quả tạo nháp AI không đúng định dạng. Hãy thử lại hoặc tự soạn câu trả lời.",
  });
}

export async function saveCommentDraft(
  params: { commentId: string; text: string },
  signal?: AbortSignal,
): Promise<CommentPatchDraftResponse> {
  const id = requireCommentId(params.commentId, "saveCommentDraft");
  const text = requireReplyText(params.text, "saveCommentDraft");
  return apiRequest(`/api/comments/${encodeURIComponent(id)}/draft`, {
    method: "PATCH",
    body: { text },
    schema: CommentPatchDraftResponseSchema,
    signal,
    malformedMessage:
      "Kết quả lưu nháp trả lời không đúng định dạng. Hãy tải lại để kiểm tra bản nháp.",
  });
}

/**
 * Sends a reply to Facebook. Must only be invoked from explicit operator approval.
 * Preserves the structured `reasons` array on 422 `BLOCKED` responses (falling back
 * to splitting `message` when absent) without modifying shared `http-client.ts`.
 */
export async function sendCommentReply(
  params: { commentId: string; text: string },
  signal?: AbortSignal,
): Promise<CommentMutationResponse> {
  const id = requireCommentId(params.commentId, "sendCommentReply");
  const text = requireReplyText(params.text, "sendCommentReply");
  const path = `/api/comments/${encodeURIComponent(id)}/reply`;

  const timeout = AbortSignal.timeout(COMMENT_SEND_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
      cache: "no-store",
      signal: combinedSignal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    const isTimeout = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new ApiError({
      code: isTimeout ? CLIENT_ERROR_CODES.TIMEOUT : CLIENT_ERROR_CODES.NETWORK,
      status: 0,
      message: cause instanceof Error ? cause.message : String(cause),
      userMessage: isTimeout
        ? "Máy chủ phản hồi quá lâu. Hãy thử lại."
        : "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.",
      cause,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status: response.status,
      message: "Response body is not valid JSON",
      userMessage:
        "Máy chủ trả về dữ liệu không đọc được. Hãy thử lại; nếu vẫn lỗi, báo quản trị viên.",
      cause,
    });
  }

  if (!response.ok) {
    if (response.status === 422) {
      const blocked = CommentBlockedErrorBodySchema.safeParse(payload);
      if (blocked.success) {
        throw new CommentBlockedError({
          status: response.status,
          userMessage: blocked.data.message,
          reasons: parseBlockedReasons(blocked.data.message, blocked.data.reasons),
        });
      }
    }
    throw toApiErrorBody(response.status, payload);
  }

  const parsed = CommentMutationResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      status: response.status,
      message: `POST ${path} payload failed validation: ${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
      userMessage:
        "Kết quả gửi trả lời không đúng định dạng. Hãy kiểm tra lại trên Facebook trước khi gửi lại.",
    });
  }

  return parsed.data;
}

export async function ignoreComment(
  commentId: string,
  signal?: AbortSignal,
): Promise<CommentMutationResponse> {
  const id = requireCommentId(commentId, "ignoreComment");
  return apiRequest(`/api/comments/${encodeURIComponent(id)}/ignore`, {
    method: "POST",
    body: {},
    schema: CommentMutationResponseSchema,
    signal,
    malformedMessage:
      "Kết quả cập nhật trạng thái bỏ qua không đúng định dạng. Hãy tải lại danh sách.",
  });
}

export async function unignoreComment(
  commentId: string,
  signal?: AbortSignal,
): Promise<CommentMutationResponse> {
  const id = requireCommentId(commentId, "unignoreComment");
  return apiRequest(`/api/comments/${encodeURIComponent(id)}/unignore`, {
    method: "POST",
    body: {},
    schema: CommentMutationResponseSchema,
    signal,
    malformedMessage:
      "Kết quả khôi phục bình luận không đúng định dạng. Hãy tải lại danh sách.",
  });
}

export async function setCommentHidden(
  params: { commentId: string; hidden: boolean },
  signal?: AbortSignal,
): Promise<CommentMutationResponse> {
  const id = requireCommentId(params.commentId, "setCommentHidden");
  return apiRequest(`/api/comments/${encodeURIComponent(id)}/hide`, {
    method: "POST",
    body: { hidden: Boolean(params.hidden) },
    schema: CommentMutationResponseSchema,
    signal,
    timeoutMs: COMMENT_HIDE_TIMEOUT_MS,
    malformedMessage:
      "Kết quả ẩn/hiện bình luận không đúng định dạng. Hãy tải lại để kiểm tra trạng thái.",
  });
}
