import { describe, expect, it } from "vitest";

import { REQUIRED_TOKEN_SCOPES } from "@/ui/schemas/channel.schema";
import {
  COMMENT_AUTHOR_FALLBACK,
  CommentListResponseSchema,
  CommentMutationResponseSchema,
  CommentPatchDraftResponseSchema,
  CommentSchema,
  CommentSyncResponseSchema,
  displayCommentAuthor,
  filterReplyWarnings,
  formatCommentAccessibleContext,
  formatSyncSummary,
  isModerationFailedCode,
  parseBlockedReasons,
  parseSafeHttpUrl,
  toSafeFacebookUrl,
  totalCommentCount,
} from "@/ui/schemas/comment.schema";

/**
 * Payloads mirrored directly from `tests/test_vpost_comments.py` (source of truth).
 */
const REAL_LIST_PAYLOAD = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  items: [
    {
      id: "c2",
      channelId: "fb-123",
      channelName: "WorkHardToday",
      pageId: "123",
      postJobId: "job-1",
      productCode: "G1",
      postCaption: "Đầm Voan Hoa G1 màu đen, size S-L, giá 890.000đ",
      postUrl: "https://www.facebook.com/123_1001",
      fromName: "",
      message: "Còn màu đen không shop?",
      createdAt: "2026-11-27T10:00:00.000Z",
      permalinkUrl: "https://fb.com/c2",
      isHidden: false,
      canComment: true,
      status: "unreplied",
      pageReplies: [],
      draft: null,
      moderation: null,
    },
    {
      id: "c1",
      channelId: "fb-123",
      channelName: "WorkHardToday",
      pageId: "123",
      postJobId: "job-1",
      productCode: "G1",
      postCaption: "Đầm Voan Hoa G1 màu đen, size S-L, giá 890.000đ",
      postUrl: "https://www.facebook.com/123_1001",
      fromName: "Minh Thư",
      message: "Giá bao nhiêu ạ?",
      createdAt: "2026-11-27T09:00:00.000Z",
      permalinkUrl: "https://fb.com/c1",
      isHidden: false,
      canComment: true,
      status: "replied",
      pageReplies: [
        {
          id: "p_reply_1",
          message: "Dạ váy G1 giá 890.000đ còn size M ạ",
          createdAt: "2026-11-27T11:00:00.000Z",
        },
      ],
      draft: {
        id: "d-1",
        status: "sent",
        text: "Dạ váy G1 giá 890.000đ còn size M ạ",
        aiText: "Dạ váy G1 giá 890.000đ còn size M ạ",
        reasons: [],
        warnings: [],
        errorCode: null,
        userMessage: "Đã gửi trả lời lên Facebook",
        updatedAt: "2026-11-27T11:00:00.000Z",
      },
      moderation: {
        category: "complaint",
        confidence: 0.92,
        reasons: ["giao hàng chậm"],
        source: "ai",
        action: "flagged",
        at: "2026-11-27T10:30:00.000Z",
      },
    },
  ],
  nextCursor: "2",
  limit: 20,
  counts: { unreplied: 1, replied: 1, ignored: 0, autoHidden: 0, flagged: 1 },
};

const REAL_SYNC_PAYLOAD = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  syncedPosts: 1,
  newComments: 1,
  updatedComments: 0,
  errors: [
    {
      postJobId: "job-bad",
      code: "PERMISSION_MISSING",
      message:
        "Page thiếu quyền đọc hoặc trả lời bình luận — vui lòng kết nối lại Page trong mục Kênh.",
    },
  ],
  moderation: {
    autoHidden: 0,
    wouldHide: 1,
    flagged: 1,
    skipped: 1,
  },
};

const REAL_PATCH_PAYLOAD = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  comment: {
    ...REAL_LIST_PAYLOAD.items[0],
    draft: {
      id: "d-edit",
      status: "draft",
      text: "Giảm còn 500k freeship hàng Zara nhé!",
      aiText: "Dạ Đầm Voan Hoa G1 giá 890.000đ, hiện còn màu đen size S, M, L bạn nhé!",
      reasons: [],
      warnings: ["độ dài 36 ký tự (nên 150–1.500)"],
      errorCode: null,
      userMessage: null,
      updatedAt: "2026-11-27T12:00:00.000Z",
    },
  },
  check: {
    block: ["giá 500k không khớp giá bán 890.000đ", "có cụm cấm 'freeship'"],
    warn: ["độ dài 36 ký tự (nên 150–1.500)", "4 emoji (page cho tối đa 3)"],
  },
};

const REAL_FLAGGED_PAYLOAD = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  comment: {
    ...REAL_LIST_PAYLOAD.items[0],
    permalinkUrl: null,
    postUrl: null,
    draft: {
      id: "d-flag",
      status: "flagged",
      text: "",
      aiText: "",
      reasons: [{ field: "order", issue: "khách hỏi tình trạng giao hàng và đổi trả" }],
      warnings: [],
      errorCode: null,
      userMessage: null,
      updatedAt: "2026-11-27T12:05:00.000Z",
    },
  },
};

describe("comment.schema", () => {
  it("parses real GET /api/comments payload from test_vpost_comments.py including moderation fields and counts", () => {
    const parsed = CommentListResponseSchema.safeParse(REAL_LIST_PAYLOAD);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.items).toHaveLength(2);
    expect(parsed.data.items[0].draft).toBeNull();
    expect(parsed.data.items[0].moderation).toBeNull();
    expect(parsed.data.items[1].pageReplies[0].id).toBe("p_reply_1");
    expect(parsed.data.items[1].moderation).toEqual({
      category: "complaint",
      confidence: 0.92,
      reasons: ["giao hàng chậm"],
      source: "ai",
      action: "flagged",
      at: "2026-11-27T10:30:00.000Z",
    });
    expect(parsed.data.counts).toEqual({
      unreplied: 1,
      replied: 1,
      ignored: 0,
      autoHidden: 0,
      flagged: 1,
    });
    // Moderation buckets are orthogonal facets, not extra status buckets
    expect(totalCommentCount(parsed.data.counts)).toBe(2);
  });

  it("parses real POST /api/comments/sync payload with moderation summary, PERMISSION_MISSING, and MODERATION_FAILED", () => {
    const parsed = CommentSyncResponseSchema.safeParse(REAL_SYNC_PAYLOAD);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.errors[0].code).toBe("PERMISSION_MISSING");
    expect(parsed.data.moderation).toEqual({
      autoHidden: 0,
      wouldHide: 1,
      flagged: 1,
      skipped: 1,
    });

    const withModFailure = CommentSyncResponseSchema.safeParse({
      ...REAL_SYNC_PAYLOAD,
      errors: [
        {
          postJobId: "auto-moderation",
          code: "MODERATION_FAILED",
          message:
            "Tự kiểm duyệt gặp lỗi ở 1 bình luận — các bình luận lỗi đã được gắn cờ để kiểm tra thủ công.",
        },
      ],
    });
    expect(withModFailure.success).toBe(true);
    expect(isModerationFailedCode("MODERATION_FAILED")).toBe(true);
    expect(isModerationFailedCode("PERMISSION_MISSING")).toBe(false);
  });

  it("parses real PATCH /api/comments/{id}/draft payload with block and warn arrays", () => {
    const parsed = CommentPatchDraftResponseSchema.safeParse(REAL_PATCH_PAYLOAD);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.check.block).toHaveLength(2);
    expect(parsed.data.comment.draft?.errorCode).toBeNull();
    expect(parsed.data.comment.draft?.userMessage).toBeNull();
  });

  it("parses flagged draft and nullable permalinkUrl / postUrl / draft fields", () => {
    const parsed = CommentMutationResponseSchema.safeParse(REAL_FLAGGED_PAYLOAD);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.comment.permalinkUrl).toBeNull();
    expect(parsed.data.comment.postUrl).toBeNull();
    expect(parsed.data.comment.draft?.status).toBe("flagged");
    expect(parsed.data.comment.draft?.reasons[0].field).toBe("order");
  });

  it("handles missing optional, null, and empty fromName with Vietnamese fallback", () => {
    const withoutFrom = { ...REAL_LIST_PAYLOAD.items[0] } as Record<string, unknown>;
    delete withoutFrom.fromName;

    const pMissing = CommentSchema.safeParse(withoutFrom);
    const pNull = CommentSchema.safeParse({ ...REAL_LIST_PAYLOAD.items[0], fromName: null });
    const pEmpty = CommentSchema.safeParse({ ...REAL_LIST_PAYLOAD.items[0], fromName: "   " });

    expect(pMissing.success).toBe(true);
    expect(pNull.success).toBe(true);
    expect(pEmpty.success).toBe(true);

    if (pMissing.success) expect(displayCommentAuthor(pMissing.data.fromName)).toBe(COMMENT_AUTHOR_FALLBACK);
    if (pNull.success) expect(displayCommentAuthor(pNull.data.fromName)).toBe(COMMENT_AUTHOR_FALLBACK);
    if (pEmpty.success) expect(displayCommentAuthor(pEmpty.data.fromName)).toBe(COMMENT_AUTHOR_FALLBACK);
    expect(displayCommentAuthor("  Lan Anh  ")).toBe("Lan Anh");
  });

  it("rejects unknown comment status and unknown draft status", () => {
    const badStatus = CommentSchema.safeParse({
      ...REAL_LIST_PAYLOAD.items[0],
      status: "pending",
    });
    expect(badStatus.success).toBe(false);

    const badDraftStatus = CommentSchema.safeParse({
      ...REAL_LIST_PAYLOAD.items[1],
      draft: {
        ...REAL_LIST_PAYLOAD.items[1].draft,
        status: "queued",
      },
    });
    expect(badDraftStatus.success).toBe(false);
  });

  it("drops caption-length warnings starting with 'độ dài' while keeping real warnings", () => {
    expect(
      filterReplyWarnings([
        "độ dài 36 ký tự (nên 150–1.500)",
        "  Độ dài 12 ký tự (nên 150–1.500)",
        "4 emoji (page cho tối đa 3)",
        "tồn kho: chỉ còn 2 sản phẩm size M",
        "   ",
      ]),
    ).toEqual(["4 emoji (page cho tối đa 3)", "tồn kho: chỉ còn 2 sản phẩm size M"]);
  });

  it("uses 422 BLOCKED reasons array when present, falls back to splitting message, and formats sync summaries with moderation counts", () => {
    // Prefers structured reasons array (preserving semicolons inside individual reasons)
    expect(
      parseBlockedReasons("legacy; message", [
        "giá 500k (không khớp 890.000đ; kiểm tra lại)",
        "có cụm cấm 'freeship'",
      ]),
    ).toEqual(["giá 500k (không khớp 890.000đ; kiểm tra lại)", "có cụm cấm 'freeship'"]);

    // Falls back to splitting message when reasons is omitted or empty
    expect(
      parseBlockedReasons("giá 500k không khớp giá bán 890.000đ; có cụm cấm 'freeship'; "),
    ).toEqual(["giá 500k không khớp giá bán 890.000đ", "có cụm cấm 'freeship'"]);
    expect(parseBlockedReasons("lỗi A; lỗi B", [])).toEqual(["lỗi A", "lỗi B"]);

    expect(
      formatSyncSummary({ syncedPosts: 3, newComments: 5, updatedComments: 0 }),
    ).toBe("Đã cập nhật 3 bài, 5 bình luận mới");
    expect(
      formatSyncSummary({ syncedPosts: 2, newComments: 1, updatedComments: 4 }),
    ).toBe("Đã cập nhật 2 bài, 1 bình luận mới (4 cập nhật)");
    expect(
      formatSyncSummary({
        syncedPosts: 2,
        newComments: 4,
        updatedComments: 0,
        moderation: { autoHidden: 0, wouldHide: 0, flagged: 0, skipped: 2 },
      }),
    ).toBe("Đã cập nhật 2 bài, 4 bình luận mới");
    expect(
      formatSyncSummary({
        syncedPosts: 2,
        newComments: 5,
        updatedComments: 1,
        moderation: { autoHidden: 2, wouldHide: 1, flagged: 3, skipped: 1 },
      }),
    ).toBe(
      "Đã cập nhật 2 bài, 5 bình luận mới (1 cập nhật) · Kiểm duyệt tự động: tự ẩn 2, sẽ ẩn (chạy thử) 1, cần xem 3",
    );
  });

  it("includes both comment Graph scopes in REQUIRED_TOKEN_SCOPES", () => {
    expect(REQUIRED_TOKEN_SCOPES).toContain("pages_read_user_content");
    expect(REQUIRED_TOKEN_SCOPES).toContain("pages_manage_engagement");
  });

  it("rejects javascript:, data:, relative, and credentialed URLs on permalinkUrl and postUrl", () => {
    const unsafeUrls = [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "/relative/path",
      "posts/123",
      "vbscript:msgbox(1)",
      "https://user:pass@www.facebook.com/123",
    ];

    for (const bad of unsafeUrls) {
      expect(
        CommentSchema.safeParse({ ...REAL_LIST_PAYLOAD.items[0], permalinkUrl: bad }).success,
        `permalinkUrl=${bad}`,
      ).toBe(false);
      expect(
        CommentSchema.safeParse({ ...REAL_LIST_PAYLOAD.items[0], postUrl: bad }).success,
        `postUrl=${bad}`,
      ).toBe(false);
      expect(parseSafeHttpUrl(bad)).toBeNull();
      expect(toSafeFacebookUrl(bad)).toBeNull();
    }
  });

  it("accepts valid http(s) Facebook URLs and rejects non-Facebook hosts in toSafeFacebookUrl", () => {
    const validFacebookUrls = [
      "https://www.facebook.com/123_1001?comment_id=c1",
      "https://facebook.com/123_1001",
      "https://m.facebook.com/story.php?id=1",
      "https://fb.com/c2",
      "http://www.facebook.com/123_1001",
    ];
    for (const good of validFacebookUrls) {
      expect(
        CommentSchema.safeParse({
          ...REAL_LIST_PAYLOAD.items[0],
          permalinkUrl: good,
          postUrl: good,
        }).success,
      ).toBe(true);
      expect(toSafeFacebookUrl(good)).toBe(new URL(good).href);
    }

    for (const nonFb of [
      "https://evil.example.com/phish",
      "https://evilfacebook.com/123",
      "https://facebook.com.evil.com/123",
    ]) {
      expect(toSafeFacebookUrl(nonFb)).toBeNull();
    }
  });

  it("formats unique accessible row context from author and comment excerpt", () => {
    expect(
      formatCommentAccessibleContext({ fromName: "Minh Thư", message: "Giá bao nhiêu ạ?" }),
    ).toBe("Minh Thư: “Giá bao nhiêu ạ?”");
    expect(
      formatCommentAccessibleContext({ fromName: "", message: "   " }),
    ).toBe(COMMENT_AUTHOR_FALLBACK);
    expect(
      formatCommentAccessibleContext({
        fromName: "Lan Anh",
        message: "Mẫu váy hoa này còn màu đen size M giao gấp trong ngày ở Hà Nội không ạ?",
      }),
    ).toContain("…");
  });
});
