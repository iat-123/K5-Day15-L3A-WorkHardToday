import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMENT_FILTER,
  buildCommentsUrl,
} from "@/ui/components/comments/comment-filters";
import { EMPTY_COMMENT_ROW_STATE } from "@/ui/components/comments/comment-row-state";
import { CommentErrorNotice } from "@/ui/components/comments/CommentErrorNotice";
import {
  CommentListSkeleton,
  CommentsFallback,
} from "@/ui/components/comments/CommentListSkeleton";
import { CommentRow } from "@/ui/components/comments/CommentRow";
import {
  CommentsConflictBanner,
  CommentsListBody,
  CommentsLiveStatusBanner,
  CommentsModerationDialog,
  CommentsScreenHeader,
  CommentsSyncNotices,
  PostJobFilterToken,
  type CommentsListBodyProps,
} from "@/ui/components/comments/CommentsScreen";
import { BulkActionBarView } from "@/ui/components/comments/moderation/BulkActionBar";
import { ModerationLogView } from "@/ui/components/comments/moderation/ModerationLog";
import { ModerationSettingsView } from "@/ui/components/comments/moderation/ModerationSettingsPanel";
import { getPageSelectionStatus } from "@/ui/components/comments/moderation/selection-model";
import { PermissionMissingNotice } from "@/ui/components/comments/PermissionMissingNotice";
import { JobLogTable } from "@/ui/components/jobs/JobLogTable";
import { NAV_ICONS } from "@/ui/components/shell/AppSideNav";
import { NAV_SECTIONS } from "@/ui/components/shell/nav-items";
import {
  formatSyncSummary,
  type CommentCounts,
  type CommentItem,
} from "@/ui/schemas/comment.schema";
import { DEFAULT_MODERATION_LOG_FILTER } from "@/ui/schemas/moderation.schema";
import type { PostJobLogEntry } from "@/ui/schemas/post-batch.schema";
import { ApiError } from "@/ui/services/api-error";
import { CommentBlockedError } from "@/ui/services/comment.api";

const NOW_MS = new Date("2026-11-27T12:00:00.000Z").getTime();

function sampleCounts(overrides: Partial<CommentCounts> = {}): CommentCounts {
  return {
    unreplied: 0,
    replied: 0,
    ignored: 0,
    autoHidden: 0,
    flagged: 0,
    ...overrides,
  };
}

function sampleComment(overrides: Partial<CommentItem> = {}): CommentItem {
  return {
    id: "c1",
    channelId: "fb-123",
    channelName: "WorkHardToday",
    pageId: "123",
    postJobId: "job-1",
    productCode: "G1",
    postCaption: "Đầm Voan Hoa G1 màu đen, size S-L, giá 890.000đ",
    postUrl: "https://www.facebook.com/123_1001",
    fromName: "Minh Thư",
    message: "Mẫu này giá bao nhiêu và còn size M không shop?",
    createdAt: "2026-11-27T10:00:00.000Z",
    permalinkUrl: "https://www.facebook.com/123_1001?comment_id=c1",
    isHidden: false,
    canComment: true,
    status: "unreplied",
    pageReplies: [],
    draft: null,
    moderation: null,
    ...overrides,
  };
}

function bodyProps(overrides: Partial<CommentsListBodyProps> = {}): CommentsListBodyProps {
  return {
    isFirstLoad: false,
    showSkeleton: false,
    isError: false,
    error: null,
    items: [],
    counts: sampleCounts(),
    filter: DEFAULT_COMMENT_FILTER,
    nowMs: NOW_MS,
    readOnlyReason: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    isSyncing: false,
    rowStateById: {},
    onRetry: () => {},
    onSync: () => {},
    onClearFilters: () => {},
    onSwitchStatus: () => {},
    onLoadMore: () => {},
    onGenerateDraft: () => {},
    onSaveDraft: () => {},
    onSendReply: () => {},
    onIgnore: () => {},
    onUnignore: () => {},
    onToggleHide: () => {},
    ...overrides,
  };
}

describe("CommentsListBody states", () => {
  it("renders skeleton on first load when delayed flag is on", () => {
    const html = renderToStaticMarkup(
      <CommentsListBody {...bodyProps({ isFirstLoad: true, showSkeleton: true })} />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("Chưa có bình luận");

    const fallbackHtml = renderToStaticMarkup(<CommentsFallback />);
    expect(fallbackHtml).toContain('aria-hidden="true"');

    const skeletonHtml = renderToStaticMarkup(<CommentListSkeleton />);
    expect(skeletonHtml).toContain('aria-hidden="true"');
  });

  it("keeps rows rendered on background refresh (no skeleton)", () => {
    const html = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          isFirstLoad: false,
          showSkeleton: false,
          items: [sampleComment()],
          counts: sampleCounts({ unreplied: 1 }),
        })}
      />,
    );
    expect(html).toContain("Minh Thư");
    expect(html).toContain('data-row="comment"');
  });

  it("renders first-run, no-result, and all-done empty states distinctly", () => {
    const firstRun = renderToStaticMarkup(<CommentsListBody {...bodyProps()} />);
    expect(firstRun).toContain('data-empty-kind="first-run"');
    expect(firstRun).toContain("Chưa có bình luận — bấm Đồng bộ");
    expect(firstRun).toContain("Đồng bộ bình luận");

    const noResult = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          filter: { ...DEFAULT_COMMENT_FILTER, q: "không tồn tại" },
        })}
      />,
    );
    expect(noResult).toContain('data-empty-kind="no-result"');
    expect(noResult).toContain("Xoá bộ lọc");

    const allDone = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          counts: sampleCounts({ replied: 3 }),
        })}
      />,
    );
    expect(allDone).toContain('data-empty-kind="done"');
    expect(allDone).toContain("Đã trả lời hết");
    expect(allDone).toContain("Xem 3 bình luận đã trả lời");
  });

  it("shows /channels reconnect notice without retry for PERMISSION_MISSING, TOKEN_INVALID, and CHANNEL_NOT_CONFIGURED on list, stale-list, and sync errors", () => {
    for (const code of ["PERMISSION_MISSING", "TOKEN_INVALID", "CHANNEL_NOT_CONFIGURED"]) {
      const emptyErrHtml = renderToStaticMarkup(
        <CommentsListBody
          {...bodyProps({
            isError: true,
            error: new ApiError({
              code,
              status: 502,
              userMessage: "Vui lòng kết nối lại Page trong mục Kênh.",
            }),
          })}
        />,
      );
      expect(emptyErrHtml).toContain('role="alert"');
      expect(emptyErrHtml).toContain('href="/channels"');
      expect(emptyErrHtml).toContain("Kết nối lại Page ở mục Kênh");
      expect(emptyErrHtml).not.toContain("Thử lại");

      const staleErrHtml = renderToStaticMarkup(
        <CommentsListBody
          {...bodyProps({
            isError: true,
            items: [sampleComment()],
            counts: sampleCounts({ unreplied: 1 }),
            error: new ApiError({
              code,
              status: 502,
              userMessage: "Vui lòng kết nối lại Page trong mục Kênh.",
            }),
          })}
        />,
      );
      expect(staleErrHtml).toContain('role="alert"');
      expect(staleErrHtml).toContain('href="/channels"');
      expect(staleErrHtml).not.toContain("Thử lại");
    }

    const syncNoticeHtml = renderToStaticMarkup(
      <PermissionMissingNotice
        errors={[
          {
            postJobId: "job-1",
            code: "PERMISSION_MISSING",
            message: "Thiếu quyền đọc bình luận",
          },
        ]}
      />,
    );
    expect(syncNoticeHtml).toContain('href="/channels"');
    expect(syncNoticeHtml).not.toContain("Thử lại");
  });

  it("renders stale-list error banner with role='alert', retry only on retryable errors (network/5xx/429), /signin on 401, and no retry on 400/403", () => {
    const baseStale = {
      isError: true,
      items: [sampleComment()],
      counts: sampleCounts({ unreplied: 1 }),
    };

    // 502 retryable
    const stale502 = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          ...baseStale,
          error: new ApiError({
            code: "UPSTREAM_ERROR",
            status: 502,
            userMessage: "Không kết nối được Facebook.",
          }),
        })}
      />,
    );
    expect(stale502).toContain('role="alert"');
    expect(stale502).toContain("Thử lại");

    // 429 retryable with delay copy
    const stale429 = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          ...baseStale,
          error: new ApiError({
            code: "RATE_LIMITED",
            status: 429,
            userMessage: "Quá nhiều yêu cầu tới Facebook.",
          }),
        })}
      />,
    );
    expect(stale429).toContain('role="alert"');
    expect(stale429).toContain("chờ một lát");
    expect(stale429).toContain("Thử lại");

    // 401 auth -> /signin link, no retry
    const stale401 = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          ...baseStale,
          error: new ApiError({
            code: "UNAUTHORIZED",
            status: 401,
            userMessage: "Phiên đã hết hạn.",
          }),
        })}
      />,
    );
    expect(stale401).toContain('role="alert"');
    expect(stale401).toContain('href="/signin"');
    expect(stale401).toContain("Đăng nhập lại");
    expect(stale401).not.toContain("Thử lại");

    // 400 / 403 non-retryable -> role="alert", no retry button or retry copy
    for (const err of [
      new ApiError({ code: "INVALID_INPUT", status: 400, userMessage: "Bộ lọc không hợp lệ." }),
      new ApiError({ code: "FORBIDDEN", status: 403, userMessage: "Bạn không có quyền xem." }),
    ]) {
      const html = renderToStaticMarkup(
        <CommentsListBody {...bodyProps({ ...baseStale, error: err })} />,
      );
      expect(html).toContain('role="alert"');
      expect(html).not.toContain("Thử lại");
    }
  });

  it("renders 429 retry with delay message and 401 /signin recovery on list, sendError, draftError, and rowActionError", () => {
    const empty429 = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          isError: true,
          error: new ApiError({
            code: "POSTING_TOO_FAST",
            status: 429,
            userMessage: "Facebook tạm chặn bình luận do gửi quá nhanh.",
          }),
        })}
      />,
    );
    expect(empty429).toContain('role="alert"');
    expect(empty429).toContain("chờ một lát");
    expect(empty429).toContain("Thử lại");

    const authErr = new ApiError({
      code: "UNAUTHORIZED",
      status: 401,
      userMessage: "Phiên đăng nhập đã hết hạn.",
    });

    const rowAuthHtml = renderToStaticMarkup(
      <CommentRow
        comment={sampleComment()}
        nowMs={NOW_MS}
        readOnlyReason={null}
        isGenerating={false}
        isSaving={false}
        isSending={false}
        isTogglingIgnore={false}
        isTogglingHide={false}
        checkResult={null}
        draftError={authErr}
        sendError={authErr}
        rowActionError={authErr}
        onGenerateDraft={() => {}}
        onSaveDraft={() => {}}
        onSendReply={() => {}}
        onIgnore={() => {}}
        onUnignore={() => {}}
        onToggleHide={() => {}}
      />,
    );
    // All three error surfaces (draftError, sendError, rowActionError) render /signin without retry
    expect((rowAuthHtml.match(/href="\/signin"/g) ?? []).length).toBe(3);
    expect(rowAuthHtml).not.toContain("Thử lại");

    // Read-only / omitted onRetry suppresses retry even on retryable 502 error
    const readOnlySyncErr = renderToStaticMarkup(
      <CommentErrorNotice
        error={new ApiError({ code: "UPSTREAM_ERROR", status: 502, userMessage: "Lỗi máy chủ." })}
        onRetry={undefined}
      />,
    );
    expect(readOnlySyncErr).toContain('role="alert"');
    expect(readOnlySyncErr).not.toContain("Thử lại");
  });

  it("keeps the screen-level 409 CONFLICT alert visible after the already-replied row leaves the unreplied list", () => {
    const conflictHtml = renderToStaticMarkup(
      <>
        <CommentsConflictBanner
          notice={{
            seq: 1,
            commentId: "c1",
            title: "Bình luận này đã được trả lời",
            description: "Bình luận này đã được trả lời hoặc đang gửi",
          }}
          onDismiss={() => {}}
        />
        <CommentsListBody
          {...bodyProps({
            items: [],
            counts: sampleCounts({ replied: 1 }),
          })}
        />
      </>,
    );
    expect(conflictHtml).toContain('role="alert"');
    expect(conflictHtml).toContain("Bình luận này đã được trả lời");
    expect(conflictHtml).toContain("Đã trả lời hết");
  });

  it("renders independent per-row pending, error, and success states for two rows simultaneously", () => {
    const rowA = sampleComment({ id: "c1", fromName: "Minh Thư", message: "Còn size M không?" });
    const rowB = sampleComment({ id: "c2", fromName: "Lan Anh", message: "Giá bao nhiêu ạ?" });

    const html = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          items: [rowA, rowB],
          counts: sampleCounts({ unreplied: 2 }),
          rowStateById: {
            c1: {
              ...EMPTY_COMMENT_ROW_STATE,
              isSending: true,
            },
            c2: {
              ...EMPTY_COMMENT_ROW_STATE,
              sendError: new ApiError({
                code: "UPSTREAM_ERROR",
                status: 502,
                userMessage: "Facebook tạm gián đoạn cho dòng 2.",
              }),
              successMessage: "Đã lưu nháp trả lời.",
              successSeq: 1,
            },
          },
        })}
      />,
    );

    expect(html).toContain("Đang gửi lên Facebook…");
    expect(html).toContain("Facebook tạm gián đoạn cho dòng 2.");
    expect(html).toContain("Đã lưu nháp trả lời.");
  });
});

describe("CommentRow & CommentReplyComposer security and accessibility", () => {
  it("renders permalinkUrl and postUrl as links only for valid Facebook http(s) URLs and as plain text for javascript:, data:, relative, and non-Facebook URLs", () => {
    const validHtml = renderToStaticMarkup(
      <CommentRow
        comment={sampleComment({
          permalinkUrl: "https://www.facebook.com/123_1001?comment_id=c1",
          postUrl: "https://fb.com/123_1001",
        })}
        nowMs={NOW_MS}
        readOnlyReason={null}
        isGenerating={false}
        isSaving={false}
        isSending={false}
        isTogglingIgnore={false}
        isTogglingHide={false}
        checkResult={null}
        draftError={null}
        sendError={null}
        rowActionError={null}
        onGenerateDraft={() => {}}
        onSaveDraft={() => {}}
        onSendReply={() => {}}
        onIgnore={() => {}}
        onUnignore={() => {}}
        onToggleHide={() => {}}
      />,
    );
    expect(validHtml).toContain('href="https://www.facebook.com/123_1001?comment_id=c1"');
    expect(validHtml).toContain('href="https://fb.com/123_1001"');

    const unsafeCases = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/relative/comment/1",
      "https://evil.example.com/phish",
    ];

    for (const unsafeUrl of unsafeCases) {
      const html = renderToStaticMarkup(
        <CommentRow
          comment={sampleComment({
            permalinkUrl: unsafeUrl,
            postUrl: unsafeUrl,
          })}
          nowMs={NOW_MS}
          readOnlyReason={null}
          isGenerating={false}
          isSaving={false}
          isSending={false}
          isTogglingIgnore={false}
          isTogglingHide={false}
          checkResult={null}
          draftError={null}
          sendError={null}
          rowActionError={null}
          onGenerateDraft={() => {}}
          onSaveDraft={() => {}}
          onSendReply={() => {}}
          onIgnore={() => {}}
          onUnignore={() => {}}
          onToggleHide={() => {}}
        />,
      );
      expect(html, `unsafe=${unsafeUrl}`).not.toContain("<a ");
      expect(html, `unsafe=${unsafeUrl}`).not.toContain("href=");
      // Plain text (escaped) still rendered
      expect(html, `unsafe=${unsafeUrl}`).toContain(
        unsafeUrl.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      );
    }
  });

  it("renders fallback author, relative + absolute time, permalink, hidden badge, replies, and optional leadingSlot", () => {
    const comment = sampleComment({
      fromName: null,
      isHidden: true,
      pageReplies: [
        {
          id: "rep-1",
          message: "Dạ mẫu G1 giá 890.000đ còn size M ạ!",
          createdAt: "2026-11-27T11:30:00.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <CommentRow
        comment={comment}
        nowMs={NOW_MS}
        readOnlyReason={null}
        leadingSlot={<span data-testid="bulk-slot">checkbox-slot</span>}
        isGenerating={false}
        isSaving={false}
        isSending={false}
        isTogglingIgnore={false}
        isTogglingHide={false}
        checkResult={null}
        draftError={null}
        sendError={null}
        rowActionError={null}
        onGenerateDraft={() => {}}
        onSaveDraft={() => {}}
        onSendReply={() => {}}
        onIgnore={() => {}}
        onUnignore={() => {}}
        onToggleHide={() => {}}
      />,
    );

    expect(html).toContain("Khách hàng Facebook");
    expect(html).toContain("2 giờ trước");
    expect(html).toContain('dateTime="2026-11-27T10:00:00.000Z"');
    expect(html).toContain("Xem trên Facebook");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Đã ẩn");
    expect(html).toContain("Hiện lại");
    expect(html).toContain("G1");
    expect(html).toContain("Dạ mẫu G1 giá 890.000đ còn size M ạ!");
    expect(html).toContain("checkbox-slot");
    expect(html).toContain("Nội dung trả lời");
    expect(html).toContain("Duyệt &amp; gửi trả lời (Gửi lên Facebook)");
  });

  it("renders flagged AI callout and extra warnings banner with polite role='status' instead of role='alert'", () => {
    const flagged = sampleComment({
      draft: {
        id: "d-1",
        status: "flagged",
        text: "Giảm còn 500k freeship",
        aiText: "",
        reasons: [{ field: "order", issue: "khách hỏi tình trạng giao hàng" }],
        warnings: ["độ dài 22 ký tự (nên 150–1.500)", "4 emoji (page cho tối đa 3)"],
        errorCode: null,
        userMessage: null,
        updatedAt: "2026-11-27T11:00:00.000Z",
      },
    });

    const html = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          items: [flagged],
          counts: sampleCounts({ unreplied: 1 }),
          rowStateById: {
            c1: {
              ...EMPTY_COMMENT_ROW_STATE,
              checkResult: {
                block: ["giá 500k không khớp giá bán 890.000đ"],
                warn: ["độ dài 22 ký tự (nên 150–1.500)", "4 emoji (page cho tối đa 3)"],
              },
            },
          },
        })}
      />,
    );

    expect(html).toContain("AI đánh dấu cần nhân viên kiểm tra");
    expect(html).toContain("order: khách hỏi tình trạng giao hàng");
    expect(html).toContain("Lưu ý thêm");
    expect(html).toContain("4 emoji (page cho tối đa 3)");
    expect(html).not.toContain("độ dài 22 ký tự");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("aria-describedby=");
    // Neither flagged callout nor "Lưu ý thêm" warning banner should emit role="alert"
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('role="status"');
  });

  it("hides flagged AI manual-reply callout once a comment is marked replied", () => {
    const repliedWithFlaggedDraft = sampleComment({
      status: "replied",
      draft: {
        id: "d-flag",
        status: "flagged",
        text: "",
        aiText: "",
        reasons: [{ field: "order", issue: "khách hỏi giao hàng" }],
        warnings: [],
        errorCode: null,
        userMessage: null,
        updatedAt: "2026-11-27T11:00:00.000Z",
      },
    });

    const html = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          items: [repliedWithFlaggedDraft],
          counts: sampleCounts({ replied: 1 }),
        })}
      />,
    );
    expect(html).not.toContain("AI đánh dấu cần nhân viên kiểm tra");
    expect(html).not.toContain("tự soạn câu trả lời");
    expect(html).toContain("Bình luận này đã có câu trả lời trên Facebook.");
  });

  it("marks StatusDot aria-hidden='true' beside visible comment and draft status text", () => {
    const html = renderToStaticMarkup(
      <CommentRow
        comment={sampleComment({
          draft: {
            id: "d-1",
            status: "draft",
            text: "Dạ giá 890.000đ ạ",
            aiText: "Dạ giá 890.000đ ạ",
            reasons: [],
            warnings: [],
            errorCode: null,
            userMessage: null,
            updatedAt: "2026-11-27T11:00:00.000Z",
          },
        })}
        nowMs={NOW_MS}
        readOnlyReason={null}
        isGenerating={false}
        isSaving={false}
        isSending={false}
        isTogglingIgnore={false}
        isTogglingHide={false}
        checkResult={null}
        draftError={null}
        sendError={null}
        rowActionError={null}
        onGenerateDraft={() => {}}
        onSaveDraft={() => {}}
        onSendReply={() => {}}
        onIgnore={() => {}}
        onUnignore={() => {}}
        onToggleHide={() => {}}
      />,
    );

    const statusDots = html.match(/<span[^>]*data-variant="[^"]*"[^>]*>/g) ?? [];
    expect(statusDots.length).toBe(2);
    for (const dot of statusDots) {
      expect(dot).toContain('aria-hidden="true"');
    }
    expect(html).toContain("Chưa trả lời");
    expect(html).toContain("Trạng thái nháp: Nháp AI");
  });

  it("does not show empty-draft save hint on textarea while AI draft is generating", () => {
    const html = renderToStaticMarkup(
      <CommentRow
        comment={sampleComment({ draft: null })}
        nowMs={NOW_MS}
        readOnlyReason={null}
        isGenerating={true}
        isSaving={false}
        isSending={false}
        isTogglingIgnore={false}
        isTogglingHide={false}
        checkResult={null}
        draftError={null}
        sendError={null}
        rowActionError={null}
        onGenerateDraft={() => {}}
        onSaveDraft={() => {}}
        onSendReply={() => {}}
        onIgnore={() => {}}
        onUnignore={() => {}}
        onToggleHide={() => {}}
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Đang tạo nháp AI…");
    expect(html).not.toContain("Nhập nội dung để lưu nháp.");
  });

  it("assigns unique Vietnamese accessible names per row across multiple comments including same-author rows", () => {
    const row1 = sampleComment({
      id: "c1",
      fromName: "Minh Thư",
      message: "Còn size M màu đen không shop?",
    });
    const row2 = sampleComment({
      id: "c2",
      fromName: "Minh Thư",
      message: "Ship về Đà Nẵng mấy ngày ạ?",
    });

    const html = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          items: [row1, row2],
          counts: sampleCounts({ unreplied: 2 }),
        })}
      />,
    );

    // Textareas have distinct Vietnamese aria-labels identifying each row
    expect(html).toContain('aria-label="Nội dung trả lời cho Minh Thư: “Còn size M màu đen không shop?”"');
    expect(html).toContain('aria-label="Nội dung trả lời cho Minh Thư: “Ship về Đà Nẵng mấy ngày ạ?”"');

    // Action buttons have distinct Vietnamese aria-labels identifying each row
    expect(html).toContain('aria-label="Bỏ qua bình luận của Minh Thư: “Còn size M màu đen không shop?”"');
    expect(html).toContain('aria-label="Bỏ qua bình luận của Minh Thư: “Ship về Đà Nẵng mấy ngày ạ?”"');
    expect(html).toContain('aria-label="Ẩn bình luận — Minh Thư: “Còn size M màu đen không shop?”"');
    expect(html).toContain('aria-label="Ẩn bình luận — Minh Thư: “Ship về Đà Nẵng mấy ngày ạ?”"');
    expect(html).toContain(
      'aria-label="Duyệt &amp; gửi trả lời (Gửi lên Facebook) cho Minh Thư: “Còn size M màu đen không shop?”"',
    );
    expect(html).toContain(
      'aria-label="Duyệt &amp; gửi trả lời (Gửi lên Facebook) cho Minh Thư: “Ship về Đà Nẵng mấy ngày ạ?”"',
    );

    // Links carry visually hidden row context
    expect(html).toContain("— bình luận của Minh Thư: “Còn size M màu đen không shop?”");
    expect(html).toContain("— bình luận của Minh Thư: “Ship về Đà Nẵng mấy ngày ạ?”");
  });

  it("renders removable PostJobFilterToken with Vietnamese aria-label instead of English Remove", () => {
    const html = renderToStaticMarkup(
      <PostJobFilterToken postJobId="job-42" onRemove={() => {}} />,
    );
    expect(html).toContain('aria-label="Bỏ Bài đăng: job-42"');
    expect(html).not.toContain("Remove ");
  });

  it("renders CommentsLiveStatusBanner with non-alert role='note' for repeated announcements", () => {
    const html = renderToStaticMarkup(
      <CommentsLiveStatusBanner
        announcement={{ seq: 2, message: "Đã lưu nháp trả lời." }}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain('role="note"');
    expect(html).toContain("Đã lưu nháp trả lời.");
  });

  it('omits redundant "use client" directive from hook-free CommentRow and PermissionMissingNotice', () => {
    const commentRowSrc = readFileSync(
      join(process.cwd(), "src/ui/components/comments/CommentRow.tsx"),
      "utf8",
    );
    const permSrc = readFileSync(
      join(process.cwd(), "src/ui/components/comments/PermissionMissingNotice.tsx"),
      "utf8",
    );
    const skeletonSrc = readFileSync(
      join(process.cwd(), "src/ui/components/comments/CommentListSkeleton.tsx"),
      "utf8",
    );
    expect(commentRowSrc.trimStart().startsWith('"use client"')).toBe(false);
    expect(permSrc.trimStart().startsWith('"use client"')).toBe(false);
    expect(skeletonSrc.trimStart().startsWith('"use client"')).toBe(true);
  });
});

describe("Navigation and JobLogTable integration", () => {
  it('places "Bình luận" (/comments) under "Theo dõi" with a nav icon', () => {
    const monitoring = NAV_SECTIONS.find((section) => section.title === "Theo dõi");
    expect(monitoring?.items).toContainEqual({ href: "/comments", label: "Bình luận" });
    expect(NAV_ICONS["/comments"]).toBeDefined();
  });

  it('renders "Xem bình luận" link via buildCommentsUrl only on published rows with a non-empty publishedPostId', () => {
    const baseJob: PostJobLogEntry = {
      postJobId: "job-pub-1",
      batchId: "batch-1",
      productCode: "G1",
      productOrigin: "sheet",
      color: "Đen",
      channelId: "fb-123",
      format: "image_post",
      status: "published",
      attemptCount: 1,
      lastErrorCode: null,
      userMessage: "Đã đăng thành công.",
      publishedPostId: "123_1001",
      publishedUrl: "https://www.facebook.com/123_1001",
      publishedAt: "2026-11-27T09:00:00.000Z",
      scheduledAt: null,
      createdAt: "2026-11-27T08:00:00.000Z",
      updatedAt: "2026-11-27T09:00:00.000Z",
      canRetry: false,
    };

    const expectedHref = buildCommentsUrl({
      ...DEFAULT_COMMENT_FILTER,
      postJobId: baseJob.postJobId,
    });
    const publishedHtml = renderToStaticMarkup(
      <JobLogTable items={[baseJob]} onRetry={() => {}} retryingJobId={null} />,
    );
    expect(publishedHtml).toContain("Xem bình luận");
    expect(publishedHtml).toContain(`href="${expectedHref}"`);

    // Published row WITHOUT publishedPostId must NOT render the comments link
    const publishedWithoutPostIdHtml = renderToStaticMarkup(
      <JobLogTable
        items={[{ ...baseJob, postJobId: "job-no-fb-id", publishedPostId: null }]}
        onRetry={() => {}}
        retryingJobId={null}
      />,
    );
    expect(publishedWithoutPostIdHtml).not.toContain("Xem bình luận");
    expect(publishedWithoutPostIdHtml).not.toContain("/comments?postJobId=");

    // Published row with whitespace publishedPostId must NOT render the comments link
    const publishedBlankPostIdHtml = renderToStaticMarkup(
      <JobLogTable
        items={[{ ...baseJob, postJobId: "job-blank-fb-id", publishedPostId: "   " }]}
        onRetry={() => {}}
        retryingJobId={null}
      />,
    );
    expect(publishedBlankPostIdHtml).not.toContain("Xem bình luận");

    // Failed row must NOT render the comments link
    const failedHtml = renderToStaticMarkup(
      <JobLogTable
        items={[{ ...baseJob, postJobId: "job-fail-1", status: "failed", canRetry: true }]}
        onRetry={() => {}}
        retryingJobId={null}
      />,
    );
    expect(failedHtml).not.toContain("Xem bình luận");
    expect(failedHtml).not.toContain("/comments?postJobId=");
  });
});

describe("Moderation integration on Bình luận screen", () => {
  it("renders row selection checkboxes and mounts BulkActionBar strictly when at least one comment is selected", () => {
    const row1 = sampleComment({ id: "c1", fromName: "Minh Thư", message: "Còn size M không?" });
    const row2 = sampleComment({ id: "c2", fromName: "Lan Anh", message: "Giá bao nhiêu ạ?" });
    const pageIds = [row1.id, row2.id];

    // Zero selected: row checkboxes and select-all are visible, bulk action bar is NOT rendered
    const noneSelectedHtml = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          items: [row1, row2],
          counts: sampleCounts({ unreplied: 2 }),
          selection: {
            selectedIds: [],
            isSelected: () => false,
            isAtMax: false,
            maxSelection: 50,
            pageStatus: getPageSelectionStatus([], pageIds),
            onToggle: () => {},
            onToggleAllOnPage: () => {},
            bulkActionBar: null,
          },
        })}
      />,
    );
    expect(noneSelectedHtml).toContain("Chọn tất cả trên trang này");
    expect(noneSelectedHtml).toContain("Chọn bình luận của Minh Thư");
    expect(noneSelectedHtml).toContain("Chọn bình luận của Lan Anh");
    expect(noneSelectedHtml).not.toContain('data-moderation="bulk-action-bar"');
    expect(noneSelectedHtml).not.toContain("Bỏ chọn");

    // One selected: BulkActionBar appears above the list with actions, and delete dialog is closed by default
    const oneSelectedIds = ["c1"];
    const oneSelectedHtml = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          items: [row1, row2],
          counts: sampleCounts({ unreplied: 2 }),
          selection: {
            selectedIds: oneSelectedIds,
            isSelected: (id) => oneSelectedIds.includes(id),
            isAtMax: false,
            maxSelection: 50,
            pageStatus: getPageSelectionStatus(oneSelectedIds, pageIds),
            onToggle: () => {},
            onToggleAllOnPage: () => {},
            bulkActionBar: (
              <BulkActionBarView
                selectedIds={oneSelectedIds}
                readOnlyReason={null}
                isPending={false}
                activeAction={null}
                lastAction={null}
                lastResult={null}
                error={null}
                isDeleteDialogOpen={false}
                onClearSelection={() => {}}
                onTriggerAction={() => {}}
                onRequestDeleteConfirm={() => {}}
                onCancelDeleteConfirm={() => {}}
                onConfirmDelete={() => {}}
                onDismissResult={() => {}}
              />
            ),
          },
        })}
      />,
    );
    expect(oneSelectedHtml).toContain('data-moderation="bulk-action-bar"');
    expect(oneSelectedHtml).toContain("Đã chọn 1 bình luận");
    expect(oneSelectedHtml).toContain("Ẩn");
    expect(oneSelectedHtml).toContain("Hiện lại");
    expect(oneSelectedHtml).toContain("Bỏ qua");
    expect(oneSelectedHtml).toContain("Xoá");
    expect(oneSelectedHtml).toContain("Bỏ chọn");
    expect(oneSelectedHtml).not.toContain('role="alertdialog"');
    // BulkActionBar renders before the comment list <ul>
    expect(oneSelectedHtml.indexOf('data-moderation="bulk-action-bar"')).toBeLessThan(
      oneSelectedHtml.indexOf('<ul'),
    );

    // Read-only mode disables selection checkboxes and bulk actions with the reason
    const readOnlyReason = "Chế độ hỗ trợ chỉ được xem.";
    const readOnlyHtml = renderToStaticMarkup(
      <CommentsListBody
        {...bodyProps({
          items: [row1],
          counts: sampleCounts({ unreplied: 1 }),
          readOnlyReason,
          selection: {
            selectedIds: oneSelectedIds,
            isSelected: (id) => oneSelectedIds.includes(id),
            isAtMax: false,
            maxSelection: 50,
            pageStatus: getPageSelectionStatus(oneSelectedIds, [row1.id]),
            onToggle: () => {},
            onToggleAllOnPage: () => {},
            bulkActionBar: (
              <BulkActionBarView
                selectedIds={oneSelectedIds}
                readOnlyReason={readOnlyReason}
                isPending={false}
                activeAction={null}
                lastAction={null}
                lastResult={null}
                error={null}
                isDeleteDialogOpen={true}
                onClearSelection={() => {}}
                onTriggerAction={() => {}}
                onRequestDeleteConfirm={() => {}}
                onCancelDeleteConfirm={() => {}}
                onConfirmDelete={() => {}}
                onDismissResult={() => {}}
              />
            ),
          },
        })}
      />,
    );
    expect(readOnlyHtml).toContain(readOnlyReason);
    expect(readOnlyHtml).toContain('aria-disabled="true"');
    expect(readOnlyHtml).not.toContain('role="alertdialog"');
  });

  it("requires the confirmation AlertDialog before permanent bulk delete", () => {
    const closedHtml = renderToStaticMarkup(
      <BulkActionBarView
        selectedIds={["c1", "c2"]}
        readOnlyReason={null}
        isPending={false}
        activeAction={null}
        lastAction={null}
        lastResult={null}
        error={null}
        isDeleteDialogOpen={false}
        onClearSelection={() => {}}
        onTriggerAction={() => {}}
        onRequestDeleteConfirm={() => {}}
        onCancelDeleteConfirm={() => {}}
        onConfirmDelete={() => {}}
        onDismissResult={() => {}}
      />,
    );
    expect(closedHtml).not.toContain('role="alertdialog"');

    const openHtml = renderToStaticMarkup(
      <BulkActionBarView
        selectedIds={["c1", "c2"]}
        readOnlyReason={null}
        isPending={false}
        activeAction={null}
        lastAction={null}
        lastResult={null}
        error={null}
        isDeleteDialogOpen={true}
        onClearSelection={() => {}}
        onTriggerAction={() => {}}
        onRequestDeleteConfirm={() => {}}
        onCancelDeleteConfirm={() => {}}
        onConfirmDelete={() => {}}
        onDismissResult={() => {}}
      />,
    );
    expect(openHtml).toContain('role="alertdialog"');
    expect(openHtml).toContain(
      "Xoá vĩnh viễn 2 bình luận trên Facebook? Không hoàn tác được.",
    );
    expect(openHtml).toContain("Xoá vĩnh viễn 2 bình luận");
  });

  it("renders ModerationBadge and moderation details per moderation action inside CommentRow", () => {
    const renderRow = (moderation: CommentItem["moderation"], isHidden = false) =>
      renderToStaticMarkup(
        <CommentRow
          comment={sampleComment({ moderation, isHidden })}
          nowMs={NOW_MS}
          readOnlyReason={null}
          isGenerating={false}
          isSaving={false}
          isSending={false}
          isTogglingIgnore={false}
          isTogglingHide={false}
          checkResult={null}
          draftError={null}
          sendError={null}
          rowActionError={null}
          onGenerateDraft={() => {}}
          onSaveDraft={() => {}}
          onSendReply={() => {}}
          onIgnore={() => {}}
          onUnignore={() => {}}
          onToggleHide={() => {}}
        />,
      );

    const autoHiddenHtml = renderRow(
      {
        category: "spam",
        confidence: 1.0,
        reasons: ["chứa cụm từ spam"],
        source: "rule",
        action: "auto_hidden",
        at: "2026-11-27T10:30:00.000Z",
      },
      true,
    );
    expect(autoHiddenHtml).toContain("Đã ẩn");
    expect(autoHiddenHtml).toContain("Tự ẩn · Spam");
    expect(autoHiddenHtml).toContain("chứa cụm từ spam");

    const wouldHideHtml = renderRow({
      category: "pii",
      confidence: 1.0,
      reasons: ["phát hiện số điện thoại"],
      source: "rule",
      action: "would_hide",
      at: "2026-11-27T10:30:00.000Z",
    });
    expect(wouldHideHtml).toContain("Sẽ ẩn (chạy thử)");
    expect(wouldHideHtml).toContain("phát hiện số điện thoại");

    const flaggedHtml = renderRow({
      category: "complaint",
      confidence: 0.92,
      reasons: ["giao hàng chậm"],
      source: "ai",
      action: "flagged",
      at: "2026-11-27T10:30:00.000Z",
    });
    expect(flaggedHtml).toContain("Cần xem");
    expect(flaggedHtml).toContain("giao hàng chậm");

    const noneHtml = renderRow(null);
    expect(noneHtml).not.toContain("Tự ẩn ·");
    expect(noneHtml).not.toContain("Sẽ ẩn (chạy thử)");
    expect(noneHtml).not.toContain("Cần xem");
    expect(noneHtml).not.toContain("data-moderation-details");
  });

  it("renders moderation filter bar with counts next to status tabs and header triggers for settings and moderation log", () => {
    const headerHtml = renderToStaticMarkup(
      <CommentsScreenHeader
        filter={{ ...DEFAULT_COMMENT_FILTER, moderation: "auto_hidden" }}
        counts={sampleCounts({ unreplied: 4, replied: 2, ignored: 1, autoHidden: 3, flagged: 5 })}
        hasCounts={true}
        hasFilters={true}
        isNarrow={false}
        isSyncing={false}
        isFetching={false}
        readOnlyReason={null}
        searchDraft=""
        channelOptions={[{ value: "__all__", label: "Tất cả kênh" }]}
        activeModerationPanel={null}
        onSearchDraftChange={() => {}}
        onFilterChange={() => {}}
        onClearFilters={() => {}}
        onSync={() => {}}
        onRefresh={() => {}}
        onOpenModerationPanel={() => {}}
      />,
    );

    expect(headerHtml).toContain("<h1");
    expect(headerHtml).toContain("Bình luận");
    // Moderation filter bar mounted with live counts
    expect(headerHtml).toContain("Tất cả kiểm duyệt");
    expect(headerHtml).toContain("Tự ẩn (3)");
    expect(headerHtml).toContain("Sẽ ẩn (chạy thử)");
    expect(headerHtml).toContain("Cần xem (5)");
    // Header buttons making settings panel and moderation log reachable
    expect(headerHtml).toContain("Cài đặt tự kiểm duyệt");
    expect(headerHtml).toContain("Nhật ký kiểm duyệt");
    expect(headerHtml).toContain('aria-haspopup="dialog"');

    // URL builder reflects active moderation filter and omits default
    expect(
      buildCommentsUrl({ ...DEFAULT_COMMENT_FILTER, moderation: "auto_hidden" }),
    ).toBe("/comments?moderation=auto_hidden");
    expect(buildCommentsUrl(DEFAULT_COMMENT_FILTER)).toBe("/comments");

    // Closed dialog renders nothing; settings & log panels mount cleanly inside Astryx Dialog
    expect(
      renderToStaticMarkup(
        <CommentsModerationDialog
          activePanel={null}
          onClose={() => {}}
          readOnlyReason={null}
        />,
      ),
    ).toBe("");

    const settingsDialogHtml = renderToStaticMarkup(
      <CommentsModerationDialog
        activePanel="settings"
        onClose={() => {}}
        readOnlyReason={null}
        settingsContent={
          <ModerationSettingsView
            isFirstLoad={false}
            showSkeleton={false}
            isError={false}
            error={null}
            items={[
              {
                pageId: "123",
                pageName: "WorkHardToday",
                channelId: "fb-123",
                enabled: true,
                mode: "dry_run",
                categories: ["spam", "pii"],
                threshold: 0.85,
                updatedBy: "operator",
                updatedAt: "2026-11-27T10:00:00.000Z",
              },
            ]}
            readOnlyReason={null}
            savingPageId={null}
            saveErrorByPageId={{}}
            savedMessageByPageId={{}}
            onRetry={() => {}}
            onSave={() => {}}
          />
        }
      />,
    );
    expect(settingsDialogHtml).toContain("<dialog");
    expect(settingsDialogHtml).toContain("Cài đặt tự kiểm duyệt");
    expect(settingsDialogHtml).toContain("WorkHardToday");
    expect(settingsDialogHtml).toContain("Chỉ đánh dấu, không tự ẩn");

    const logDialogHtml = renderToStaticMarkup(
      <CommentsModerationDialog
        activePanel="log"
        onClose={() => {}}
        readOnlyReason={null}
        logContent={
          <ModerationLogView
            isFirstLoad={false}
            showSkeleton={false}
            isFetching={false}
            isError={false}
            error={null}
            items={[
              {
                id: "log-1",
                pageId: "123",
                commentId: "c1",
                action: "hide",
                actor: "auto",
                category: "spam",
                reason: "chứa cụm từ spam",
                result: "ok",
                errorCode: null,
                createdAt: "2026-11-27T11:00:00.000Z",
              },
            ]}
            filter={DEFAULT_MODERATION_LOG_FILTER}
            nowMs={NOW_MS}
            readOnlyReason={null}
            hasNextPage={false}
            isFetchingNextPage={false}
            undoingCommentId={null}
            undoStatusMessage={null}
            undoErrorMessage={null}
            undoApiError={null}
            pageNameById={{ "123": "WorkHardToday" }}
            onFilterChange={() => {}}
            onClearFilters={() => {}}
            onRefresh={() => {}}
            onLoadMore={() => {}}
            onUndoHide={() => {}}
            onDismissUndoStatus={() => {}}
            onDismissUndoError={() => {}}
          />
        }
      />,
    );
    expect(logDialogHtml).toContain("<dialog");
    expect(logDialogHtml).toContain("Nhật ký kiểm duyệt");
    expect(logDialogHtml).toContain("WorkHardToday");
    expect(logDialogHtml).toContain("Hiện lại");
  });

  it("renders sync summary with moderation counts and a non-blocking warning for MODERATION_FAILED", () => {
    const syncResult = {
      tenantId: "00000000-0000-4000-8000-000000000001",
      syncedPosts: 2,
      newComments: 5,
      updatedComments: 0,
      moderation: { autoHidden: 2, wouldHide: 1, flagged: 1, skipped: 1 },
      errors: [
        {
          postJobId: "auto-moderation",
          code: "MODERATION_FAILED",
          message:
            "Tự kiểm duyệt gặp lỗi ở 1 bình luận — các bình luận lỗi đã được gắn cờ để kiểm tra thủ công.",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <CommentsSyncNotices
        liveStatus={{ seq: 1, message: formatSyncSummary(syncResult) }}
        conflictNotice={null}
        syncError={null}
        lastSyncResult={syncResult}
        readOnlyReason={null}
        onDismissLiveStatus={() => {}}
        onDismissConflict={() => {}}
        onDismissModerationWarning={() => {}}
        onRetrySync={() => {}}
      />,
    );

    expect(html).toContain(
      "Đã cập nhật 2 bài, 5 bình luận mới · Kiểm duyệt tự động: tự ẩn 2, sẽ ẩn (chạy thử) 1, cần xem 1",
    );
    expect(html).toContain("Tự kiểm duyệt gặp lỗi — bình luận vẫn đã được đồng bộ");
    expect(html).toContain("Mã: MODERATION_FAILED");
    expect(html).toContain("Tự kiểm duyệt gặp lỗi ở 1 bình luận");
    // Non-blocking warning: uses polite status, not blocking alert or "bài không đồng bộ được"
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("bài không đồng bộ được");
    expect(html).not.toContain('role="alert"');
  });

  it("renders 422 BLOCKED reasons from the structured reasons array and falls back to splitting userMessage", () => {
    const blockedWithArray = new CommentBlockedError({
      status: 422,
      userMessage: "Thông báo tổng hợp",
      reasons: ["giá 500k (sai so với 890.000đ; kiểm tra lại)", "có cụm cấm 'freeship'"],
    });

    const arrayHtml = renderToStaticMarkup(
      <CommentRow
        comment={sampleComment({
          draft: {
            id: "d-1",
            status: "draft",
            text: "Giảm còn 500k freeship",
            aiText: "",
            reasons: [],
            warnings: [],
            errorCode: null,
            userMessage: null,
            updatedAt: "2026-11-27T11:00:00.000Z",
          },
        })}
        nowMs={NOW_MS}
        readOnlyReason={null}
        isGenerating={false}
        isSaving={false}
        isSending={false}
        isTogglingIgnore={false}
        isTogglingHide={false}
        checkResult={null}
        draftError={null}
        sendError={blockedWithArray}
        rowActionError={null}
        onGenerateDraft={() => {}}
        onSaveDraft={() => {}}
        onSendReply={() => {}}
        onIgnore={() => {}}
        onUnignore={() => {}}
        onToggleHide={() => {}}
      />,
    );
    expect(arrayHtml).toContain("Nội dung bị chặn:");
    expect(arrayHtml).toContain("giá 500k (sai so với 890.000đ; kiểm tra lại)");
    expect(arrayHtml).toContain("có cụm cấm &#x27;freeship&#x27;");
    expect(arrayHtml).not.toContain("Thông báo tổng hợp");
    expect(arrayHtml).toContain('aria-invalid="true"');
    expect(arrayHtml).toContain("aria-describedby=");

    const legacyBlocked = new ApiError({
      code: "BLOCKED",
      status: 422,
      userMessage: "Lý do 1; Lý do 2",
    });
    const fallbackHtml = renderToStaticMarkup(
      <CommentRow
        comment={sampleComment()}
        nowMs={NOW_MS}
        readOnlyReason={null}
        isGenerating={false}
        isSaving={false}
        isSending={false}
        isTogglingIgnore={false}
        isTogglingHide={false}
        checkResult={null}
        draftError={null}
        sendError={legacyBlocked}
        rowActionError={null}
        onGenerateDraft={() => {}}
        onSaveDraft={() => {}}
        onSendReply={() => {}}
        onIgnore={() => {}}
        onUnignore={() => {}}
        onToggleHide={() => {}}
      />,
    );
    expect(fallbackHtml).toContain("Nội dung bị chặn: Lý do 1 · Lý do 2");
  });
});
