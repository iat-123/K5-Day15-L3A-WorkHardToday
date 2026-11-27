import { z } from "zod";

import {
  CommentModerationSchema,
  ModerationActionSchema,
} from "@/ui/schemas/moderation.schema";

/**
 * Contracts for the "Bình luận" (Facebook comment inbox) screen.
 * Mirrors the real Python backend routes in `codebase/vpost_api.py` (`/api/comments`).
 */

// --- Safe external URLs -----------------------------------------------------

/**
 * Parses an external link only when it is a valid `http://` or `https://` URL
 * without embedded credentials. Rejects `javascript:`, `data:`, relative paths,
 * and malformed URLs so untrusted payloads cannot inject executable links.
 */
export function parseSafeHttpUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when `hostname` belongs to Facebook (`facebook.com`, `fb.com`, `fb.watch`, or subdomains). */
export function isFacebookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.com" ||
    host.endsWith(".fb.com") ||
    host === "fb.watch" ||
    host.endsWith(".fb.watch")
  );
}

/**
 * Returns a safe href for Facebook comment/post links (`http(s)` on a Facebook
 * host), or `null` when the value must be degraded to plain text.
 */
export function toSafeFacebookUrl(raw: string | null | undefined): string | null {
  const parsed = parseSafeHttpUrl(raw);
  if (!parsed || !isFacebookHost(parsed.hostname)) return null;
  return parsed.href;
}

const httpUrl = () =>
  z
    .url()
    .refine(
      (value) => parseSafeHttpUrl(value) !== null,
      "Đường dẫn phải bắt đầu bằng http:// hoặc https://",
    );

// --- Statuses ---------------------------------------------------------------

export const COMMENT_STATUSES = ["unreplied", "replied", "ignored"] as const;
export const CommentStatusSchema = z.enum(COMMENT_STATUSES);
export type CommentStatus = z.infer<typeof CommentStatusSchema>;

export const COMMENT_STATUS_LABELS: Record<CommentStatus, string> = {
  unreplied: "Chưa trả lời",
  replied: "Đã trả lời",
  ignored: "Bỏ qua",
};

export const COMMENT_STATUS_DOT_VARIANTS: Record<
  CommentStatus,
  "warning" | "success" | "neutral"
> = {
  unreplied: "warning",
  replied: "success",
  ignored: "neutral",
};

export const COMMENT_DRAFT_STATUSES = [
  "draft",
  "flagged",
  "sending",
  "sent",
  "failed",
] as const;
export const CommentDraftStatusSchema = z.enum(COMMENT_DRAFT_STATUSES);
export type CommentDraftStatus = z.infer<typeof CommentDraftStatusSchema>;

export const COMMENT_DRAFT_STATUS_LABELS: Record<CommentDraftStatus, string> = {
  draft: "Nháp AI",
  flagged: "Cần kiểm tra",
  sending: "Đang gửi",
  sent: "Đã gửi",
  failed: "Gửi lỗi",
};

export const COMMENT_DRAFT_DOT_VARIANTS: Record<
  CommentDraftStatus,
  "accent" | "warning" | "success" | "error"
> = {
  draft: "accent",
  flagged: "warning",
  sending: "accent",
  sent: "success",
  failed: "error",
};

// --- DTOs -------------------------------------------------------------------

export const CommentDraftReasonSchema = z.object({
  field: z.string(),
  issue: z.string(),
});
export type CommentDraftReason = z.infer<typeof CommentDraftReasonSchema>;

export const CommentDraftSchema = z.object({
  id: z.string().min(1),
  status: CommentDraftStatusSchema,
  text: z.string(),
  aiText: z.string(),
  reasons: z.array(CommentDraftReasonSchema),
  warnings: z.array(z.string()),
  errorCode: z.string().nullable(),
  userMessage: z.string().nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type CommentDraft = z.infer<typeof CommentDraftSchema>;

export const CommentPageReplySchema = z.object({
  id: z.string().min(1),
  message: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type CommentPageReply = z.infer<typeof CommentPageReplySchema>;

export const CommentSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string(),
  pageId: z.string(),
  postJobId: z.string(),
  productCode: z.string(),
  postCaption: z.string(),
  postUrl: httpUrl().nullable(),
  // Real API returns "" when Graph omits `from`; schema also tolerates null/absent.
  fromName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  message: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  permalinkUrl: httpUrl().nullable(),
  isHidden: z.boolean(),
  canComment: z.boolean(),
  status: CommentStatusSchema,
  pageReplies: z.array(CommentPageReplySchema),
  draft: CommentDraftSchema.nullable(),
  moderation: CommentModerationSchema.nullable()
    .optional()
    .transform((value) => value ?? null),
});
export type CommentItem = z.infer<typeof CommentSchema>;

export const CommentCountsSchema = z.object({
  unreplied: z.number().int().min(0),
  replied: z.number().int().min(0),
  ignored: z.number().int().min(0),
  autoHidden: z.number().int().min(0).default(0),
  flagged: z.number().int().min(0).default(0),
});
export type CommentCounts = z.infer<typeof CommentCountsSchema>;

export const CommentListResponseSchema = z.object({
  tenantId: z.string().min(1),
  items: z.array(CommentSchema),
  nextCursor: z.string().nullable(),
  limit: z.number().int().min(1),
  counts: CommentCountsSchema,
});
export type CommentListResponse = z.infer<typeof CommentListResponseSchema>;

export const CommentSyncErrorSchema = z.object({
  postJobId: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});
export type CommentSyncError = z.infer<typeof CommentSyncErrorSchema>;

export const CommentSyncModerationSummarySchema = z.object({
  autoHidden: z.number().int().min(0),
  wouldHide: z.number().int().min(0),
  flagged: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type CommentSyncModerationSummary = z.infer<typeof CommentSyncModerationSummarySchema>;

export const CommentSyncResponseSchema = z.object({
  tenantId: z.string().min(1),
  syncedPosts: z.number().int().min(0),
  newComments: z.number().int().min(0),
  updatedComments: z.number().int().min(0),
  errors: z.array(CommentSyncErrorSchema),
  moderation: CommentSyncModerationSummarySchema.optional(),
});
export type CommentSyncResponse = z.infer<typeof CommentSyncResponseSchema>;

/** 422 BLOCKED error envelope from `POST /api/comments/{id}/reply`. */
export const CommentBlockedErrorBodySchema = z.object({
  code: z.literal("BLOCKED"),
  message: z.string().min(1),
  reasons: z.array(z.string()).optional(),
});
export type CommentBlockedErrorBody = z.infer<typeof CommentBlockedErrorBodySchema>;

export const CommentMutationResponseSchema = z.object({
  tenantId: z.string().min(1),
  comment: CommentSchema,
});
export type CommentMutationResponse = z.infer<typeof CommentMutationResponseSchema>;

export const CommentCheckSchema = z.object({
  block: z.array(z.string()),
  warn: z.array(z.string()),
});
export type CommentCheck = z.infer<typeof CommentCheckSchema>;

export const CommentPatchDraftResponseSchema = z.object({
  tenantId: z.string().min(1),
  comment: CommentSchema,
  check: CommentCheckSchema,
});
export type CommentPatchDraftResponse = z.infer<typeof CommentPatchDraftResponseSchema>;

// --- Filter contract --------------------------------------------------------

export const COMMENT_FILTER_STATUSES = ["unreplied", "replied", "ignored", "all"] as const;
export const CommentFilterStatusSchema = z.enum(COMMENT_FILTER_STATUSES);
export type CommentFilterStatus = z.infer<typeof CommentFilterStatusSchema>;

export const CommentFilterSchema = z.object({
  status: CommentFilterStatusSchema,
  moderation: ModerationActionSchema.nullable(),
  channelId: z.string().min(1).nullable(),
  postJobId: z.string().min(1).nullable(),
  q: z.string().min(1).nullable(),
});
export type CommentFilter = z.infer<typeof CommentFilterSchema>;

// --- Constants & formatting helpers -----------------------------------------

export const COMMENT_DEFAULT_LIMIT = 20;
export const COMMENT_REPLY_MAX_LENGTH = 2000;
export const COMMENT_AUTHOR_FALLBACK = "Khách hàng Facebook";

/** Fallback customer name when Facebook omits `from` or returns a blank string. */
export function displayCommentAuthor(fromName: string | null | undefined): string {
  const trimmed = typeof fromName === "string" ? fromName.trim() : "";
  return trimmed.length > 0 ? trimmed : COMMENT_AUTHOR_FALLBACK;
}

const ACCESSIBLE_EXCERPT_LIMIT = 40;

/**
 * Row-identifying Vietnamese context ("Minh Thư: “Giá bao nhiêu ạ?”") appended
 * to per-row accessible names so screen readers distinguish controls across rows
 * even when two comments share the same author or fallback name.
 */
export function formatCommentAccessibleContext(
  comment: Pick<CommentItem, "fromName" | "message">,
): string {
  const author = displayCommentAuthor(comment.fromName);
  const cleaned = comment.message.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return author;
  const excerpt =
    cleaned.length <= ACCESSIBLE_EXCERPT_LIMIT
      ? cleaned
      : `${cleaned.slice(0, ACCESSIBLE_EXCERPT_LIMIT).trimEnd()}…`;
  return `${author}: “${excerpt}”`;
}

/**
 * Backend `verify_post` emits a caption-length warning ("độ dài …") that does
 * not apply to short comment replies; drop it before rendering.
 */
export function filterReplyWarnings(warnings: readonly string[]): string[] {
  return warnings
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.toLowerCase().startsWith("độ dài"));
}

/**
 * Extracts blocked reasons from a 422 BLOCKED response: uses the structured
 * `reasons` array when present and non-empty, falling back to splitting the
 * `; `-joined message.
 */
export function parseBlockedReasons(
  message: string,
  reasons?: readonly string[] | null,
): string[] {
  if (Array.isArray(reasons)) {
    const cleaned = reasons
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter((part) => part.length > 0);
    if (cleaned.length > 0) return cleaned;
  }
  return message
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Polite summary for a finished comment sync, including auto-moderation counts when active. */
export function formatSyncSummary(
  result: Pick<CommentSyncResponse, "syncedPosts" | "newComments" | "updatedComments"> & {
    moderation?: CommentSyncModerationSummary | null;
  },
): string {
  const base = `Đã cập nhật ${result.syncedPosts} bài, ${result.newComments} bình luận mới`;
  const withUpdated =
    result.updatedComments > 0 ? `${base} (${result.updatedComments} cập nhật)` : base;

  const mod = result.moderation;
  if (!mod) return withUpdated;

  const modParts: string[] = [];
  if (mod.autoHidden > 0) modParts.push(`tự ẩn ${mod.autoHidden}`);
  if (mod.wouldHide > 0) modParts.push(`sẽ ẩn (chạy thử) ${mod.wouldHide}`);
  if (mod.flagged > 0) modParts.push(`cần xem ${mod.flagged}`);

  return modParts.length > 0
    ? `${withUpdated} · Kiểm duyệt tự động: ${modParts.join(", ")}`
    : withUpdated;
}

/** True when a sync error represents a non-blocking auto-moderation failure. */
export function isModerationFailedCode(code: string | null | undefined): boolean {
  return code === "MODERATION_FAILED";
}

/** Total customer comments across all three status buckets. */
export function totalCommentCount(counts: CommentCounts): number {
  return counts.unreplied + counts.replied + counts.ignored;
}

/** Error codes that require reconnecting the Facebook Page in `/channels`. */
export function isPermissionMissingCode(code: string | null | undefined): boolean {
  return code === "PERMISSION_MISSING";
}

export function isReconnectPageCode(code: string | null | undefined): boolean {
  return (
    code === "PERMISSION_MISSING" ||
    code === "TOKEN_INVALID" ||
    code === "CHANNEL_NOT_CONFIGURED"
  );
}

/** Absolute local timestamp in Vietnamese format. */
export function formatCommentAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/**
 * Relative timestamp in Vietnamese against an explicit `nowMs`.
 * Returns `""` when `nowMs <= 0` so SSR stays deterministic.
 */
export function formatCommentRelativeTime(iso: string, nowMs: number): string {
  if (nowMs <= 0) return "";
  const timeMs = new Date(iso).getTime();
  if (Number.isNaN(timeMs)) return "";

  const diffSeconds = Math.floor((nowMs - timeMs) / 1_000);
  if (diffSeconds < 60) return "Vừa xong";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} phút trước`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} ngày trước`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} tháng trước`;
}
