import { describe, expect, it } from "vitest";

import {
  extractBlockedReasonsFromError,
  presentCommentApiError,
} from "@/ui/components/comments/comment-error";
import { ApiError, CLIENT_ERROR_CODES } from "@/ui/services/api-error";
import { CommentBlockedError } from "@/ui/services/comment.api";

describe("presentCommentApiError", () => {
  it("classifies network, 5xx, and 429 (RATE_LIMITED / POSTING_TOO_FAST) as retryable with delay guidance", () => {
    const network = presentCommentApiError(
      new ApiError({
        code: CLIENT_ERROR_CODES.NETWORK,
        status: 0,
        userMessage: "Không kết nối được máy chủ.",
      }),
    );
    expect(network.canRetry).toBe(true);

    const server502 = presentCommentApiError(
      new ApiError({
        code: "UPSTREAM_ERROR",
        status: 502,
        userMessage: "Không kết nối được Facebook.",
      }),
    );
    expect(server502.canRetry).toBe(true);

    for (const code of ["RATE_LIMITED", "POSTING_TOO_FAST"]) {
      const rateLimited = presentCommentApiError(
        new ApiError({
          code,
          status: 429,
          userMessage: "Facebook tạm chặn bình luận do gửi quá nhanh.",
        }),
      );
      expect(rateLimited.kind).toBe("rate-limit");
      expect(rateLimited.canRetry).toBe(true);
      expect(rateLimited.hint).toContain("chờ một lát");
    }
  });

  it("classifies 401 / UNAUTHORIZED / TOKEN_EXPIRED as auth (non-retryable)", () => {
    for (const err of [
      new ApiError({ code: "UNAUTHORIZED", status: 401, userMessage: "Phiên hết hạn." }),
      new ApiError({ code: "TOKEN_EXPIRED", status: 401, userMessage: "Phiên hết hạn." }),
      new ApiError({ code: "SESSION_REVOKED", status: 401, userMessage: "Vui lòng đăng nhập lại." }),
    ]) {
      const view = presentCommentApiError(err);
      expect(view.kind).toBe("auth");
      expect(view.canRetry).toBe(false);
    }
  });

  it("classifies PERMISSION_MISSING, TOKEN_INVALID, and CHANNEL_NOT_CONFIGURED as reconnect (non-retryable)", () => {
    for (const code of ["PERMISSION_MISSING", "TOKEN_INVALID", "CHANNEL_NOT_CONFIGURED"]) {
      const view = presentCommentApiError(
        new ApiError({ code, status: 502, userMessage: "Cần kết nối lại Page." }),
      );
      expect(view.kind).toBe("reconnect");
      expect(view.canRetry).toBe(false);
    }
  });

  it("classifies non-retryable 4xx (400 / 403 / 404) with canRetry=false", () => {
    for (const err of [
      new ApiError({ code: "INVALID_INPUT", status: 400, userMessage: "Tham số không hợp lệ." }),
      new ApiError({ code: "FORBIDDEN", status: 403, userMessage: "Không có quyền." }),
      new ApiError({ code: "NOT_FOUND", status: 404, userMessage: "Không tìm thấy bình luận." }),
    ]) {
      const view = presentCommentApiError(err);
      expect(view.canRetry).toBe(false);
      expect(view.kind).not.toBe("auth");
      expect(view.kind).not.toBe("reconnect");
    }
  });

  it("extracts 422 BLOCKED reasons from structured array first, falling back to splitting userMessage", () => {
    const structured = new CommentBlockedError({
      status: 422,
      userMessage: "Nội dung bị chặn",
      reasons: ["giá 500k (sai giá; kiểm tra lại)", "có cụm cấm 'freeship'"],
    });
    expect(extractBlockedReasonsFromError(structured)).toEqual([
      "giá 500k (sai giá; kiểm tra lại)",
      "có cụm cấm 'freeship'",
    ]);

    const legacy = new ApiError({
      code: "BLOCKED",
      status: 422,
      userMessage: "lỗi 1; lỗi 2",
    });
    expect(extractBlockedReasonsFromError(legacy)).toEqual(["lỗi 1", "lỗi 2"]);

    const emptyReasons = new CommentBlockedError({
      status: 422,
      userMessage: "lỗi A; lỗi B",
      reasons: [],
    });
    expect(extractBlockedReasonsFromError(emptyReasons)).toEqual(["lỗi A", "lỗi B"]);

    const nonBlocked = new ApiError({
      code: "CONFLICT",
      status: 409,
      userMessage: "Đã trả lời",
    });
    expect(extractBlockedReasonsFromError(nonBlocked)).toEqual([]);
    expect(extractBlockedReasonsFromError(null)).toEqual([]);
  });
});
