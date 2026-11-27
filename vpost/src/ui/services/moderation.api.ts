import {
  BULK_SELECTION_MAX,
  BulkCommentsResponseSchema,
  ClassifyCommentResponseSchema,
  MODERATION_LOG_DEFAULT_LIMIT,
  ModerationLogResponseSchema,
  ModerationSettingsListResponseSchema,
  ModerationSettingUpdateInputSchema,
  ModerationSettingUpdateResponseSchema,
  type BulkCommentAction,
  type BulkCommentsResponse,
  type ClassifyCommentResponse,
  type ModerationLogAction,
  type ModerationLogActor,
  type ModerationLogFilter,
  type ModerationLogResponse,
  type ModerationSettingsListResponse,
  type ModerationSettingUpdateInput,
  type ModerationSettingUpdateResponse,
} from "@/ui/schemas/moderation.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for comment moderation endpoints in `codebase/moderation_api.py`.
 * Every response is parsed with zod via `apiRequest`.
 */

/** Bulk actions can perform up to 50 sequential Graph API writes with pauses. */
const BULK_ACTION_TIMEOUT_MS = 90_000;

/** On-demand classification can fall back to an AI model call. */
const CLASSIFY_TIMEOUT_MS = 60_000;

/** Single query-key factory for moderation settings and audit log caches. */
export const moderationKeys = {
  all: (tenantKey: string) => ["comments-moderation", tenantKey] as const,
  settings: (tenantKey: string) => ["comments-moderation", tenantKey, "settings"] as const,
  logAll: (tenantKey: string) => ["comments-moderation", tenantKey, "log"] as const,
  log: (tenantKey: string, filter: ModerationLogFilter) =>
    [
      "comments-moderation",
      tenantKey,
      "log",
      filter.pageId ?? "all",
      filter.action ?? "all",
      filter.actor ?? "all",
    ] as const,
};

function normalizeUniqueIds(rawIds: readonly string[], caller: string): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  if (unique.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${caller} requires at least one comment id`,
      userMessage: "Vui lòng chọn ít nhất một bình luận để thao tác.",
    });
  }
  if (unique.length > BULK_SELECTION_MAX) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${caller} accepts at most ${BULK_SELECTION_MAX} unique ids`,
      userMessage: `Mỗi lượt thao tác hàng loạt chỉ hỗ trợ tối đa ${BULK_SELECTION_MAX} bình luận.`,
    });
  }
  return unique;
}

function requireNonEmptyId(value: string, caller: string, userMessage: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `${caller} requires a non-empty identifier`,
      userMessage,
    });
  }
  return trimmed;
}

export interface RunBulkCommentActionParams {
  readonly ids: readonly string[];
  readonly action: BulkCommentAction;
  /** Required to be `true` when `action === "delete"`. Omitted for all other actions. */
  readonly confirm?: boolean;
}

/**
 * Executes a bulk moderation action (`POST /api/comments/bulk`).
 * Enforces confirm-before-delete on the client as well as the backend.
 */
export async function runBulkCommentAction(
  params: RunBulkCommentActionParams,
  signal?: AbortSignal,
): Promise<BulkCommentsResponse> {
  const ids = normalizeUniqueIds(params.ids, "runBulkCommentAction");

  if (params.action === "delete" && params.confirm !== true) {
    throw new ApiError({
      code: "CONFIRM_REQUIRED",
      status: 400,
      message: "Bulk delete requires explicit confirm=true",
      userMessage: `Xoá vĩnh viễn ${ids.length} bình luận trên Facebook cần xác nhận trước khi thực hiện.`,
    });
  }

  // Strict backend model (`extra="forbid"`): only send `confirm` for delete.
  const body =
    params.action === "delete"
      ? { ids, action: params.action, confirm: true }
      : { ids, action: params.action };

  return apiRequest("/api/comments/bulk", {
    method: "POST",
    body,
    schema: BulkCommentsResponseSchema,
    signal,
    timeoutMs: BULK_ACTION_TIMEOUT_MS,
    malformedMessage:
      "Kết quả thao tác hàng loạt không đúng định dạng. Hãy tải lại danh sách để đối chiếu.",
  });
}

export async function listModerationSettings(
  signal?: AbortSignal,
): Promise<ModerationSettingsListResponse> {
  return apiRequest("/api/comments/moderation-settings", {
    schema: ModerationSettingsListResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu cài đặt tự kiểm duyệt không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function updateModerationSetting(
  pageId: string,
  input: ModerationSettingUpdateInput,
  signal?: AbortSignal,
): Promise<ModerationSettingUpdateResponse> {
  const safePageId = requireNonEmptyId(
    pageId,
    "updateModerationSetting",
    "Thiếu mã Fanpage cần lưu cài đặt kiểm duyệt.",
  );

  // PHASE2(complaint-autohide): Strip/reject any non-v1 auto-hide categories before
  // calling the strict backend route (`COMPLAINT_AUTOHIDE_DISABLED`).
  const dedupedCategories = Array.from(new Set(input.categories));
  const validated = ModerationSettingUpdateInputSchema.safeParse({
    enabled: input.enabled,
    mode: input.mode,
    categories: dedupedCategories,
    threshold: input.threshold,
  });

  if (!validated.success) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 400,
      message: `updateModerationSetting invalid input: ${validated.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
      userMessage: "Thông số cài đặt tự kiểm duyệt không hợp lệ. Vui lòng kiểm tra lại.",
    });
  }

  return apiRequest(`/api/comments/moderation-settings/${encodeURIComponent(safePageId)}`, {
    method: "PUT",
    body: validated.data,
    schema: ModerationSettingUpdateResponseSchema,
    signal,
    malformedMessage:
      "Kết quả lưu cài đặt tự kiểm duyệt không đúng định dạng. Hãy tải lại trang để kiểm tra.",
  });
}

export interface ListModerationLogParams {
  readonly pageId?: string | null;
  readonly action?: ModerationLogAction | null;
  readonly actor?: ModerationLogActor | null;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export async function listModerationLog(
  params: ListModerationLogParams = {},
  signal?: AbortSignal,
): Promise<ModerationLogResponse> {
  const query = new URLSearchParams();
  const pageId = params.pageId?.trim();
  if (pageId) query.set("pageId", pageId);
  if (params.action) query.set("action", params.action);
  if (params.actor) query.set("actor", params.actor);
  if (params.cursor) query.set("cursor", params.cursor);
  const limit = params.limit ?? MODERATION_LOG_DEFAULT_LIMIT;
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) {
    query.set("limit", String(limit));
  }

  const qs = query.toString();
  return apiRequest(qs ? `/api/comments/moderation-log?${qs}` : "/api/comments/moderation-log", {
    schema: ModerationLogResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu nhật ký kiểm duyệt không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

/** Re-runs classification for one customer comment without hiding or deleting. */
export async function classifyComment(
  commentId: string,
  signal?: AbortSignal,
): Promise<ClassifyCommentResponse> {
  const id = requireNonEmptyId(
    commentId,
    "classifyComment",
    "Thiếu mã bình luận cần phân loại.",
  );
  return apiRequest(`/api/comments/${encodeURIComponent(id)}/classify`, {
    method: "POST",
    schema: ClassifyCommentResponseSchema,
    signal,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    malformedMessage:
      "Kết quả phân loại bình luận không đúng định dạng. Hãy thử lại sau.",
  });
}
