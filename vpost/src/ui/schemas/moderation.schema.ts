import { z } from "zod";

/**
 * Contracts for Facebook comment moderation in VPOST.
 * Mirrors the real Python backend routes in `codebase/moderation_api.py`:
 *  - `POST /api/comments/bulk`
 *  - `GET  /api/comments/moderation-settings`
 *  - `PUT  /api/comments/moderation-settings/{pageId}`
 *  - `GET  /api/comments/moderation-log`
 *  - `POST /api/comments/{id}/classify`
 */

// --- Constants --------------------------------------------------------------

export const BULK_SELECTION_MAX = 50;
export const MODERATION_THRESHOLD_MIN = 0.5;
export const MODERATION_THRESHOLD_MAX = 1.0;
export const MODERATION_THRESHOLD_DEFAULT = 0.85;
export const MODERATION_THRESHOLD_STEP = 0.05;
export const MODERATION_LOG_DEFAULT_LIMIT = 20;

// --- Enums & schemas --------------------------------------------------------

// PHASE2(complaint-autohide): In v1, `complaint` is never auto-hidden and is
// rejected by `PUT /api/comments/moderation-settings/{pageId}` with 400
// `COMPLAINT_AUTOHIDE_DISABLED`. Only these four categories are selectable.
export const AUTO_HIDE_CATEGORIES = ["spam", "scam", "abusive", "pii"] as const;
export const AutoHideCategorySchema = z.enum(AUTO_HIDE_CATEGORIES);
export type AutoHideCategory = z.infer<typeof AutoHideCategorySchema>;

export const MODERATION_CATEGORIES = [
  "spam",
  "scam",
  "abusive",
  "pii",
  "complaint",
  "neutral",
  "positive",
] as const;
export const ModerationCategorySchema = z.enum(MODERATION_CATEGORIES);
export type ModerationCategory = z.infer<typeof ModerationCategorySchema>;

export const MODERATION_SOURCES = ["rule", "ai"] as const;
export const ModerationSourceSchema = z.enum(MODERATION_SOURCES);
export type ModerationSource = z.infer<typeof ModerationSourceSchema>;

export const MODERATION_ACTIONS = ["auto_hidden", "would_hide", "flagged"] as const;
export const ModerationActionSchema = z.enum(MODERATION_ACTIONS);
export type ModerationAction = z.infer<typeof ModerationActionSchema>;

export const MODERATION_MODES = ["dry_run", "live"] as const;
export const ModerationModeSchema = z.enum(MODERATION_MODES);
export type ModerationMode = z.infer<typeof ModerationModeSchema>;

export const BULK_COMMENT_ACTIONS = [
  "hide",
  "unhide",
  "delete",
  "ignore",
  "unignore",
] as const;
export const BulkCommentActionSchema = z.enum(BULK_COMMENT_ACTIONS);
export type BulkCommentAction = z.infer<typeof BulkCommentActionSchema>;

export const MODERATION_LOG_ACTIONS = [
  "hide",
  "unhide",
  "delete",
  "ignore",
  "unignore",
  "would_hide",
] as const;
export const ModerationLogActionSchema = z.enum(MODERATION_LOG_ACTIONS);
export type ModerationLogAction = z.infer<typeof ModerationLogActionSchema>;

export const MODERATION_LOG_ACTORS = ["operator", "auto"] as const;
export const ModerationLogActorSchema = z.enum(MODERATION_LOG_ACTORS);
export type ModerationLogActor = z.infer<typeof ModerationLogActorSchema>;

export const MODERATION_LOG_RESULTS = ["ok", "failed", "skipped"] as const;
export const ModerationLogResultSchema = z.enum(MODERATION_LOG_RESULTS);
export type ModerationLogResult = z.infer<typeof ModerationLogResultSchema>;

// --- Vietnamese labels & metadata -------------------------------------------

export interface AutoHideCategoryMeta {
  readonly value: AutoHideCategory;
  readonly label: string;
  readonly description: string;
}

export const AUTO_HIDE_CATEGORY_META: readonly AutoHideCategoryMeta[] = [
  {
    value: "spam",
    label: "Spam / quảng cáo",
    description:
      "Bình luận lặp lại nhiều lần trên cùng Page trong 24 giờ, quảng cáo ké, rủ inbox hoặc kéo tương tác chéo.",
  },
  {
    value: "scam",
    label: "Lừa đảo / liên kết lạ",
    description:
      "Đường dẫn ngoài danh sách tin cậy, link rút gọn, mời nhận quà hoặc trúng thưởng giả mạo.",
  },
  {
    value: "abusive",
    label: "Xúc phạm / thô tục",
    description:
      "Ngôn từ chửi bới, xúc phạm, quấy rối hoặc thù ghét (gồm cả viết tắt, teencode và tiếng Việt không dấu).",
  },
  {
    value: "pii",
    label: "Lộ thông tin cá nhân (PII)",
    description:
      "Bình luận công khai số điện thoại, địa chỉ hoặc email cá nhân — tự ẩn để bảo vệ dữ liệu khách hàng.",
  },
] as const;

// PHASE2(complaint-autohide): Shown strictly as an informational row in v1.
export const COMPLAINT_POLICY_INFO = {
  category: "complaint" as const,
  label: "Khiếu nại của khách hàng",
  badgeLabel: "Chỉ đánh dấu, không tự ẩn",
  description:
    "Phản ánh về hàng lỗi, giao chậm, giá bán hoặc chất lượng dịch vụ luôn chỉ đánh dấu, không tự ẩn — bình luận sẽ được gắn nhãn “Cần xem” để nhân viên xử lý trực tiếp.",
} as const;

export const MODERATION_CATEGORY_LABELS: Record<ModerationCategory, string> = {
  spam: "Spam",
  scam: "Lừa đảo",
  abusive: "Xúc phạm",
  pii: "Thông tin cá nhân",
  complaint: "Khiếu nại",
  neutral: "Trung tính",
  positive: "Tích cực",
};

export const MODERATION_SOURCE_LABELS: Record<ModerationSource, string> = {
  rule: "Luật xác định",
  ai: "Phân loại AI",
};

export const MODERATION_MODE_LABELS: Record<ModerationMode, string> = {
  dry_run: "Chạy thử",
  live: "Chạy thật",
};

export const BULK_ACTION_LABELS: Record<BulkCommentAction, string> = {
  hide: "Ẩn",
  unhide: "Hiện lại",
  delete: "Xoá",
  ignore: "Bỏ qua",
  unignore: "Khôi phục",
};

export const MODERATION_LOG_ACTION_LABELS: Record<ModerationLogAction, string> = {
  hide: "Ẩn",
  unhide: "Hiện lại",
  delete: "Xoá",
  ignore: "Bỏ qua",
  unignore: "Khôi phục",
  would_hide: "Sẽ ẩn (chạy thử)",
};

export const MODERATION_LOG_ACTOR_LABELS: Record<ModerationLogActor, string> = {
  operator: "Nhân viên",
  auto: "Tự động",
};

export const MODERATION_LOG_RESULT_LABELS: Record<ModerationLogResult, string> = {
  ok: "Thành công",
  failed: "Thất bại",
  skipped: "Đã bỏ qua",
};

export const MODERATION_LOG_RESULT_DOT_VARIANTS: Record<
  ModerationLogResult,
  "success" | "error" | "neutral"
> = {
  ok: "success",
  failed: "error",
  skipped: "neutral",
};

// --- DTO schemas ------------------------------------------------------------

/** Moderation metadata attached to a comment (`POST /api/comments/{id}/classify` or comment row). */
export const CommentModerationSchema = z.object({
  category: ModerationCategorySchema,
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  source: ModerationSourceSchema,
  action: ModerationActionSchema.nullable(),
  at: z.iso.datetime({ offset: true }).nullable(),
});
export type CommentModeration = z.infer<typeof CommentModerationSchema>;

export const ClassifyCommentResponseSchema = z.object({
  tenantId: z.string().min(1),
  commentId: z.string().min(1),
  moderation: CommentModerationSchema,
});
export type ClassifyCommentResponse = z.infer<typeof ClassifyCommentResponseSchema>;

export const BulkCommentResultItemSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  code: z.string().min(1).optional(),
  message: z.string().optional(),
});
export type BulkCommentResultItem = z.infer<typeof BulkCommentResultItemSchema>;

export const BulkCommentsResponseSchema = z.object({
  tenantId: z.string().min(1),
  results: z.array(BulkCommentResultItemSchema),
  processed: z.number().int().min(0),
  failed: z.number().int().min(0),
  notProcessed: z.array(z.string().min(1)),
});
export type BulkCommentsResponse = z.infer<typeof BulkCommentsResponseSchema>;

export const BulkCommentsInputSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(BULK_SELECTION_MAX),
  action: BulkCommentActionSchema,
  confirm: z.boolean().optional(),
});
export type BulkCommentsInput = z.infer<typeof BulkCommentsInputSchema>;

export const ModerationSettingSchema = z.object({
  pageId: z.string().min(1),
  pageName: z.string(),
  channelId: z.string().min(1),
  enabled: z.boolean(),
  mode: ModerationModeSchema,
  categories: z.array(AutoHideCategorySchema),
  threshold: z.number().min(MODERATION_THRESHOLD_MIN).max(MODERATION_THRESHOLD_MAX),
  updatedBy: z.string().nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ModerationSetting = z.infer<typeof ModerationSettingSchema>;

export const ModerationSettingsListResponseSchema = z.object({
  tenantId: z.string().min(1),
  items: z.array(ModerationSettingSchema),
});
export type ModerationSettingsListResponse = z.infer<typeof ModerationSettingsListResponseSchema>;

export const ModerationSettingUpdateInputSchema = z.object({
  enabled: z.boolean(),
  mode: ModerationModeSchema,
  categories: z.array(AutoHideCategorySchema),
  threshold: z
    .number()
    .finite()
    .min(MODERATION_THRESHOLD_MIN)
    .max(MODERATION_THRESHOLD_MAX),
});
export type ModerationSettingUpdateInput = z.infer<typeof ModerationSettingUpdateInputSchema>;

export const ModerationSettingUpdateResponseSchema = z.object({
  tenantId: z.string().min(1),
  setting: ModerationSettingSchema,
});
export type ModerationSettingUpdateResponse = z.infer<typeof ModerationSettingUpdateResponseSchema>;

export const ModerationLogEntrySchema = z.object({
  id: z.string().min(1),
  // Backend records pageId="" for NOT_FOUND bulk items.
  pageId: z.string(),
  commentId: z.string().min(1),
  action: ModerationLogActionSchema,
  actor: ModerationLogActorSchema,
  category: ModerationCategorySchema.nullable(),
  reason: z.string().nullable(),
  result: ModerationLogResultSchema,
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ModerationLogEntry = z.infer<typeof ModerationLogEntrySchema>;

export const ModerationLogResponseSchema = z.object({
  tenantId: z.string().min(1),
  items: z.array(ModerationLogEntrySchema),
  nextCursor: z.string().nullable(),
  limit: z.number().int().min(1).max(100),
});
export type ModerationLogResponse = z.infer<typeof ModerationLogResponseSchema>;

export const ModerationLogFilterSchema = z.object({
  pageId: z.string().min(1).nullable(),
  action: ModerationLogActionSchema.nullable(),
  actor: ModerationLogActorSchema.nullable(),
});
export type ModerationLogFilter = z.infer<typeof ModerationLogFilterSchema>;

export const DEFAULT_MODERATION_LOG_FILTER: ModerationLogFilter = {
  pageId: null,
  action: null,
  actor: null,
};
