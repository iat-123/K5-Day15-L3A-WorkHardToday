import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_COMMENT_FILTER } from "@/ui/components/comments/comment-filters";
import { ApiError } from "@/ui/services/api-error";
import {
  COMMENT_HIDE_TIMEOUT_MS,
  COMMENT_SEND_TIMEOUT_MS,
  CommentBlockedError,
  commentKeys,
  listComments,
  sendCommentReply,
  setCommentHidden,
} from "@/ui/services/comment.api";

const SAMPLE_MUTATION_RESPONSE = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  comment: {
    id: "c1",
    channelId: "fb-123",
    channelName: "WorkHardToday",
    pageId: "123",
    postJobId: "job-1",
    productCode: "G1",
    postCaption: "Đầm Voan Hoa G1",
    postUrl: "https://www.facebook.com/123_1001",
    fromName: "Minh Thư",
    message: "Giá bao nhiêu ạ?",
    createdAt: "2026-11-27T10:00:00.000Z",
    permalinkUrl: "https://www.facebook.com/123_1001?comment_id=c1",
    isHidden: false,
    canComment: true,
    status: "replied",
    pageReplies: [],
    draft: null,
    moderation: null,
  },
};

describe("comment.api timeouts, moderation query param, and 422 BLOCKED reasons", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses timeoutMs >= 45_000 for sendCommentReply and setCommentHidden", async () => {
    expect(COMMENT_SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    expect(COMMENT_HIDE_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);

    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify(SAMPLE_MUTATION_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendCommentReply({ commentId: "c1", text: "Dạ váy G1 giá 890.000đ ạ!" });
    expect(timeoutSpy).toHaveBeenLastCalledWith(COMMENT_SEND_TIMEOUT_MS);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "/api/comments/c1/reply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Dạ váy G1 giá 890.000đ ạ!" }),
      }),
    );

    await setCommentHidden({ commentId: "c1", hidden: true });
    expect(timeoutSpy).toHaveBeenLastCalledWith(COMMENT_HIDE_TIMEOUT_MS);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "/api/comments/c1/hide",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ hidden: true }),
      }),
    );
  });

  it("passes moderation filter to GET /api/comments and includes it in commentKeys.list", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          tenantId: "00000000-0000-4000-8000-000000000001",
          items: [],
          nextCursor: null,
          limit: 20,
          counts: { unreplied: 0, replied: 0, ignored: 0, autoHidden: 2, flagged: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await listComments({ status: "unreplied", moderation: "auto_hidden", limit: 20 });
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "/api/comments?status=unreplied&moderation=auto_hidden&limit=20",
      expect.objectContaining({ method: "GET" }),
    );

    const keyDefault = commentKeys.list("t1", DEFAULT_COMMENT_FILTER);
    const keyFlagged = commentKeys.list("t1", {
      ...DEFAULT_COMMENT_FILTER,
      moderation: "flagged",
    });
    expect(keyDefault).not.toEqual(keyFlagged);
    expect(keyFlagged).toContain("flagged");
  });

  it("preserves structured reasons array from 422 BLOCKED and falls back to splitting message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "BLOCKED",
          message: "Nội dung bị chặn tổng hợp",
          reasons: [
            "giá 500k (không khớp 890.000đ; vui lòng kiểm tra)",
            "có cụm cấm 'freeship'",
          ],
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );

    let caughtWithArray: unknown;
    try {
      await sendCommentReply({ commentId: "c1", text: "Giảm còn 500k freeship" });
    } catch (err) {
      caughtWithArray = err;
    }
    expect(caughtWithArray).toBeInstanceOf(ApiError);
    expect(caughtWithArray).toBeInstanceOf(CommentBlockedError);
    expect((caughtWithArray as CommentBlockedError).reasons).toEqual([
      "giá 500k (không khớp 890.000đ; vui lòng kiểm tra)",
      "có cụm cấm 'freeship'",
    ]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "BLOCKED",
          message: "sai giá bán; có cụm cấm 'freeship'",
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );

    let caughtFallback: unknown;
    try {
      await sendCommentReply({ commentId: "c1", text: "Giảm còn 500k freeship" });
    } catch (err) {
      caughtFallback = err;
    }
    expect(caughtFallback).toBeInstanceOf(CommentBlockedError);
    expect((caughtFallback as CommentBlockedError).reasons).toEqual([
      "sai giá bán",
      "có cụm cấm 'freeship'",
    ]);
  });
});
