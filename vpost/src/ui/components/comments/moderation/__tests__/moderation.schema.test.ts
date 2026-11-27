import { describe, expect, it } from "vitest";

import {
  AUTO_HIDE_CATEGORIES,
  AutoHideCategorySchema,
  BulkCommentsInputSchema,
  BulkCommentsResponseSchema,
  ClassifyCommentResponseSchema,
  CommentModerationSchema,
  ModerationLogResponseSchema,
  ModerationSettingsListResponseSchema,
  ModerationSettingUpdateInputSchema,
  ModerationSettingUpdateResponseSchema,
} from "@/ui/schemas/moderation.schema";

/**
 * Real payloads mirrored directly from `tests/test_moderation_api.py` (source of truth).
 */
const TENANT_ID = "00000000-0000-4000-8000-000000000001";

const REAL_SETTINGS_LIST_PAYLOAD = {
  tenantId: TENANT_ID,
  items: [
    {
      pageId: "123",
      pageName: "Dịu Mây Boutique",
      channelId: "fb-123",
      enabled: false,
      mode: "dry_run",
      categories: [],
      threshold: 0.85,
      updatedBy: null,
      updatedAt: null,
    },
    {
      pageId: "456",
      pageName: "Phố Nhỏ Studio",
      channelId: "fb-456",
      enabled: true,
      mode: "live",
      categories: ["spam", "scam", "abusive", "pii"],
      threshold: 0.9,
      updatedBy: "operator",
      updatedAt: "2026-11-27T12:00:00.000Z",
    },
  ],
};

const REAL_SETTINGS_PUT_PAYLOAD = {
  tenantId: TENANT_ID,
  setting: {
    pageId: "123",
    pageName: "Dịu Mây Boutique",
    channelId: "fb-123",
    enabled: true,
    mode: "live",
    categories: ["spam", "scam", "abusive", "pii"],
    threshold: 0.9,
    updatedBy: "operator",
    updatedAt: "2026-11-27T12:05:00.000Z",
  },
};

const REAL_BULK_OK_PAYLOAD = {
  tenantId: TENANT_ID,
  results: [
    { id: "c1", ok: true },
    { id: "c2", ok: true },
  ],
  processed: 2,
  failed: 0,
  notProcessed: [],
};

const REAL_BULK_MIXED_PAYLOAD = {
  tenantId: TENANT_ID,
  results: [
    { id: "c_ok", ok: true },
    {
      id: "does_not_exist",
      ok: false,
      code: "NOT_FOUND",
      message: "Không tìm thấy bình luận này.",
    },
    {
      id: "c_page",
      ok: false,
      code: "FORBIDDEN",
      message: "Không thể thực hiện thao tác kiểm duyệt lên bình luận của chính Fanpage.",
    },
  ],
  processed: 1,
  failed: 2,
  notProcessed: [],
};

const REAL_BULK_RATE_LIMIT_PAYLOAD = {
  tenantId: TENANT_ID,
  results: [
    { id: "c1", ok: true },
    {
      id: "c2",
      ok: false,
      code: "RATE_LIMITED",
      message: "Facebook đang giới hạn tần suất gọi API",
    },
  ],
  processed: 1,
  failed: 1,
  notProcessed: ["c3", "c4"],
};

const REAL_CLASSIFY_RULE_PAYLOAD = {
  tenantId: TENANT_ID,
  commentId: "c_pii",
  moderation: {
    category: "pii",
    confidence: 1.0,
    reasons: ["phát hiện số điện thoại hoặc email cá nhân"],
    source: "rule",
    action: null,
    at: "2026-11-27T12:10:00.000Z",
  },
};

const REAL_CLASSIFY_AI_FALLBACK_PAYLOAD = {
  tenantId: TENANT_ID,
  commentId: "c_norm",
  moderation: {
    category: "neutral",
    confidence: 0.0,
    reasons: ["không phân loại được"],
    source: "ai",
    action: null,
    at: "2026-11-27T12:11:00.000Z",
  },
};

const REAL_LOG_PAGED_PAYLOAD = {
  tenantId: TENANT_ID,
  items: [
    {
      id: "l5",
      pageId: "456",
      commentId: "c5",
      action: "ignore",
      actor: "operator",
      category: null,
      reason: "người vận hành bỏ qua",
      result: "ok",
      errorCode: null,
      createdAt: "2026-11-27T11:00:00.000Z",
    },
    {
      id: "l4",
      pageId: "123",
      commentId: "c4",
      action: "would_hide",
      actor: "auto",
      category: "abusive",
      reason: "từ ngữ xúc phạm",
      result: "ok",
      errorCode: null,
      createdAt: "2026-11-27T10:00:00.000Z",
    },
    {
      id: "l3",
      pageId: "",
      commentId: "missing_id",
      action: "hide",
      actor: "operator",
      category: null,
      reason: "Không tìm thấy bình luận này.",
      result: "failed",
      errorCode: "NOT_FOUND",
      createdAt: "2026-11-27T09:00:00.000Z",
    },
  ],
  nextCursor: "3",
  limit: 20,
};

describe("moderation.schema", () => {
  it("parses GET /api/comments/moderation-settings and PUT responses from test_moderation_api.py", () => {
    const listParsed = ModerationSettingsListResponseSchema.safeParse(
      REAL_SETTINGS_LIST_PAYLOAD,
    );
    expect(listParsed.success).toBe(true);
    if (listParsed.success) {
      expect(listParsed.data.items).toHaveLength(2);
      expect(listParsed.data.items[0].updatedAt).toBeNull();
      expect(listParsed.data.items[1].categories).toEqual([
        "spam",
        "scam",
        "abusive",
        "pii",
      ]);
    }

    const putParsed = ModerationSettingUpdateResponseSchema.safeParse(
      REAL_SETTINGS_PUT_PAYLOAD,
    );
    expect(putParsed.success).toBe(true);
    if (putParsed.success) {
      expect(putParsed.data.setting.mode).toBe("live");
      expect(putParsed.data.setting.threshold).toBe(0.9);
    }
  });

  it("parses POST /api/comments/bulk payloads (all-ok, mixed failures, and RATE_LIMITED notProcessed)", () => {
    expect(BulkCommentsResponseSchema.safeParse(REAL_BULK_OK_PAYLOAD).success).toBe(true);

    const mixed = BulkCommentsResponseSchema.safeParse(REAL_BULK_MIXED_PAYLOAD);
    expect(mixed.success).toBe(true);
    if (mixed.success) {
      expect(mixed.data.processed).toBe(1);
      expect(mixed.data.failed).toBe(2);
      expect(mixed.data.results[1].code).toBe("NOT_FOUND");
      expect(mixed.data.results[2].code).toBe("FORBIDDEN");
    }

    const rateLimited = BulkCommentsResponseSchema.safeParse(
      REAL_BULK_RATE_LIMIT_PAYLOAD,
    );
    expect(rateLimited.success).toBe(true);
    if (rateLimited.success) {
      expect(rateLimited.data.notProcessed).toEqual(["c3", "c4"]);
      expect(rateLimited.data.results[1].code).toBe("RATE_LIMITED");
    }
  });

  it("parses POST /api/comments/{id}/classify payloads including null action and AI failure neutral fallback", () => {
    const ruleParsed = ClassifyCommentResponseSchema.safeParse(
      REAL_CLASSIFY_RULE_PAYLOAD,
    );
    expect(ruleParsed.success).toBe(true);
    if (ruleParsed.success) {
      expect(ruleParsed.data.moderation.action).toBeNull();
      expect(ruleParsed.data.moderation.source).toBe("rule");
    }

    const aiParsed = ClassifyCommentResponseSchema.safeParse(
      REAL_CLASSIFY_AI_FALLBACK_PAYLOAD,
    );
    expect(aiParsed.success).toBe(true);
    if (aiParsed.success) {
      expect(aiParsed.data.moderation.category).toBe("neutral");
      expect(aiParsed.data.moderation.reasons).toEqual(["không phân loại được"]);
    }

    const withAction = CommentModerationSchema.safeParse({
      category: "complaint",
      confidence: 1.0,
      reasons: ["hàng lỗi"],
      source: "rule",
      action: "flagged",
      at: "2026-11-27T12:12:00.000Z",
    });
    expect(withAction.success).toBe(true);
  });

  it("parses GET /api/comments/moderation-log payload including empty pageId for NOT_FOUND entries", () => {
    const parsed = ModerationLogResponseSchema.safeParse(REAL_LOG_PAGED_PAYLOAD);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items).toHaveLength(3);
      expect(parsed.data.items[2].pageId).toBe("");
      expect(parsed.data.items[2].errorCode).toBe("NOT_FOUND");
      expect(parsed.data.nextCursor).toBe("3");
    }

    const lastPage = ModerationLogResponseSchema.safeParse({
      ...REAL_LOG_PAGED_PAYLOAD,
      nextCursor: null,
    });
    expect(lastPage.success).toBe(true);
  });

  it("rejects complaint in auto-hide categories (v1 DECIDED policy) and out-of-range settings", () => {
    expect(AUTO_HIDE_CATEGORIES).toEqual(["spam", "scam", "abusive", "pii"]);
    expect(AutoHideCategorySchema.safeParse("complaint").success).toBe(false);
    expect(AutoHideCategorySchema.safeParse("neutral").success).toBe(false);
    expect(AutoHideCategorySchema.safeParse("positive").success).toBe(false);

    expect(
      ModerationSettingUpdateInputSchema.safeParse({
        enabled: true,
        mode: "live",
        categories: ["spam", "complaint"],
        threshold: 0.85,
      }).success,
    ).toBe(false);

    expect(
      ModerationSettingUpdateInputSchema.safeParse({
        enabled: true,
        mode: "dry_run",
        categories: ["spam"],
        threshold: 0.49,
      }).success,
    ).toBe(false);

    expect(
      ModerationSettingUpdateInputSchema.safeParse({
        enabled: true,
        mode: "dry_run",
        categories: ["spam"],
        threshold: 1.01,
      }).success,
    ).toBe(false);

    expect(
      ModerationSettingUpdateInputSchema.safeParse({
        enabled: true,
        mode: "auto",
        categories: ["spam"],
        threshold: 0.85,
      }).success,
    ).toBe(false);
  });

  it("rejects empty or >50 bulk input ids and unknown actions", () => {
    expect(BulkCommentsInputSchema.safeParse({ ids: [], action: "hide" }).success).toBe(
      false,
    );
    expect(
      BulkCommentsInputSchema.safeParse({
        ids: Array.from({ length: 51 }, (_, i) => `c${i}`),
        action: "hide",
      }).success,
    ).toBe(false);
    expect(
      BulkCommentsInputSchema.safeParse({ ids: ["c1"], action: "reply" }).success,
    ).toBe(false);
  });
});
