import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BulkActionBarView,
  type BulkActionBarViewProps,
} from "@/ui/components/comments/moderation/BulkActionBar";
import { ModerationBadge } from "@/ui/components/comments/moderation/ModerationBadge";
import { ModerationFilterBar } from "@/ui/components/comments/moderation/ModerationFilterBar";
import {
  ModerationLogSkeleton,
  ModerationLogView,
  type ModerationLogViewProps,
} from "@/ui/components/comments/moderation/ModerationLog";
import {
  ModerationSettingsSkeleton,
  ModerationSettingsView,
  type ModerationSettingsViewProps,
} from "@/ui/components/comments/moderation/ModerationSettingsPanel";
import {
  DEFAULT_MODERATION_LOG_FILTER,
  type CommentModeration,
  type ModerationLogEntry,
  type ModerationSetting,
} from "@/ui/schemas/moderation.schema";
import { ApiError } from "@/ui/services/api-error";

const NOW_MS = new Date("2026-11-27T12:00:00.000Z").getTime();
const READ_ONLY_REASON = "Chế độ hỗ trợ chỉ được xem — không thay đổi được gì.";

function sampleSetting(overrides: Partial<ModerationSetting> = {}): ModerationSetting {
  return {
    pageId: "123",
    pageName: "Dịu Mây Boutique",
    channelId: "fb-123",
    enabled: true,
    mode: "dry_run",
    categories: ["spam", "pii"],
    threshold: 0.85,
    updatedBy: "operator",
    updatedAt: "2026-11-27T10:00:00.000Z",
    ...overrides,
  };
}

function sampleLogEntry(
  overrides: Partial<ModerationLogEntry> = {},
): ModerationLogEntry {
  return {
    id: "log-1",
    pageId: "123",
    commentId: "c1",
    action: "hide",
    actor: "auto",
    category: "spam",
    reason: "Trùng lặp >= 3 lần trong 24 giờ",
    result: "ok",
    errorCode: null,
    createdAt: "2026-11-27T11:00:00.000Z",
    ...overrides,
  };
}

function bulkProps(
  overrides: Partial<BulkActionBarViewProps> = {},
): BulkActionBarViewProps {
  return {
    selectedIds: [],
    readOnlyReason: null,
    isPending: false,
    activeAction: null,
    lastAction: null,
    lastResult: null,
    error: null,
    isDeleteDialogOpen: false,
    onClearSelection: () => {},
    onTriggerAction: () => {},
    onRequestDeleteConfirm: () => {},
    onCancelDeleteConfirm: () => {},
    onConfirmDelete: () => {},
    onDismissResult: () => {},
    ...overrides,
  };
}

function settingsProps(
  overrides: Partial<ModerationSettingsViewProps> = {},
): ModerationSettingsViewProps {
  return {
    isFirstLoad: false,
    showSkeleton: false,
    isError: false,
    error: null,
    items: [],
    readOnlyReason: null,
    savingPageId: null,
    saveErrorByPageId: {},
    savedMessageByPageId: {},
    onRetry: () => {},
    onSave: () => {},
    ...overrides,
  };
}

function logProps(
  overrides: Partial<ModerationLogViewProps> = {},
): ModerationLogViewProps {
  return {
    isFirstLoad: false,
    showSkeleton: false,
    isFetching: false,
    isError: false,
    error: null,
    items: [],
    filter: DEFAULT_MODERATION_LOG_FILTER,
    nowMs: NOW_MS,
    readOnlyReason: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    undoingCommentId: null,
    undoStatusMessage: null,
    undoErrorMessage: null,
    undoApiError: null,
    onFilterChange: () => {},
    onClearFilters: () => {},
    onRefresh: () => {},
    onLoadMore: () => {},
    onUndoHide: () => {},
    onDismissUndoStatus: () => {},
    onDismissUndoError: () => {},
    ...overrides,
  };
}

describe("ModerationBadge & ModerationFilterBar rendering", () => {
  it("renders the three moderation badges and hides when moderation/action is absent", () => {
    const autoHidden: CommentModeration = {
      category: "spam",
      confidence: 1.0,
      reasons: ["follow chéo"],
      source: "rule",
      action: "auto_hidden",
      at: "2026-11-27T10:00:00.000Z",
    };
    const wouldHide: CommentModeration = {
      ...autoHidden,
      category: "scam",
      action: "would_hide",
    };
    const flagged: CommentModeration = {
      ...autoHidden,
      category: "complaint",
      reasons: ["hàng lỗi"],
      action: "flagged",
    };

    expect(renderToStaticMarkup(<ModerationBadge moderation={autoHidden} />)).toContain(
      "Tự ẩn · Spam",
    );
    expect(renderToStaticMarkup(<ModerationBadge moderation={wouldHide} />)).toContain(
      "Sẽ ẩn (chạy thử)",
    );
    expect(
      renderToStaticMarkup(<ModerationBadge moderation={flagged} showDetails />),
    ).toContain("Cần xem");
    expect(
      renderToStaticMarkup(<ModerationBadge moderation={flagged} showDetails />),
    ).toContain("hàng lỗi");

    expect(renderToStaticMarkup(<ModerationBadge moderation={null} />)).toBe("");
    expect(
      renderToStaticMarkup(<ModerationBadge moderation={{ ...autoHidden, action: null }} />),
    ).toBe("");
  });

  it("renders ModerationFilterBar with counts", () => {
    const html = renderToStaticMarkup(
      <ModerationFilterBar
        value="flagged"
        onChange={() => {}}
        counts={{ autoHidden: 4, flagged: 2 }}
      />,
    );
    expect(html).toContain("Tất cả kiểm duyệt");
    expect(html).toContain("Tự ẩn (4)");
    expect(html).toContain("Sẽ ẩn (chạy thử)");
    expect(html).toContain("Cần xem (2)");
  });
});

describe("BulkActionBarView rendering", () => {
  it("renders selected count, all 4 actions, pending state, and polite live region", () => {
    const selectedHtml = renderToStaticMarkup(
      <BulkActionBarView
        {...bulkProps({
          selectedIds: ["c1", "c2", "c3"],
          pageSelection: {
            checkboxValue: "indeterminate",
            totalOnPage: 10,
            selectedOnPageCount: 3,
            onToggleAllOnPage: () => {},
          },
        })}
      />,
    );
    expect(selectedHtml).toContain("Chọn tất cả trên trang này");
    expect(selectedHtml).toContain("Đã chọn 3 bình luận");
    expect(selectedHtml).toContain("Ẩn");
    expect(selectedHtml).toContain("Hiện lại");
    expect(selectedHtml).toContain("Bỏ qua");
    expect(selectedHtml).toContain("Xoá");
    expect(selectedHtml).toContain('aria-live="polite"');
    expect(selectedHtml).not.toContain('role="alertdialog"');

    const pendingHtml = renderToStaticMarkup(
      <BulkActionBarView
        {...bulkProps({
          selectedIds: ["c1", "c2"],
          isPending: true,
          activeAction: "hide",
        })}
      />,
    );
    expect(pendingHtml).toContain("Đang ẩn…");
  });

  it("renders the exact confirmation dialog message when delete confirmation is open", () => {
    const dialogHtml = renderToStaticMarkup(
      <BulkActionBarView
        {...bulkProps({
          selectedIds: ["c1", "c2", "c3"],
          isDeleteDialogOpen: true,
        })}
      />,
    );
    expect(dialogHtml).toContain('role="alertdialog"');
    expect(dialogHtml).toContain(
      "Xoá vĩnh viễn 3 bình luận trên Facebook? Không hoàn tác được.",
    );
    expect(dialogHtml).toContain("Xoá vĩnh viễn 3 bình luận");
    expect(dialogHtml).toContain("Huỷ");
  });

  it("renders per-item failures with reasons, rate-limit notProcessed notice, and API error state", () => {
    const resultHtml = renderToStaticMarkup(
      <BulkActionBarView
        {...bulkProps({
          selectedIds: ["c2", "c3", "c4"],
          lastAction: "hide",
          lastResult: {
            tenantId: "00000000-0000-4000-8000-000000000001",
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
          },
          error: new ApiError({
            code: "UPSTREAM_ERROR",
            status: 502,
            userMessage: "Kết nối Facebook tạm gián đoạn.",
          }),
        })}
      />,
    );
    expect(resultHtml).toContain('aria-live="polite"');
    expect(resultHtml).toContain(
      "Đã ẩn 1 bình luận, 1 bình luận thất bại, 2 bình luận chưa xử lý do Facebook giới hạn tần suất.",
    );
    expect(resultHtml).toContain("RATE_LIMITED");
    expect(resultHtml).toContain("Facebook đang giới hạn tần suất gọi API");
    expect(resultHtml).toContain("còn 2 bình luận chưa được xử lý");
    expect(resultHtml).toContain("c3");
    expect(resultHtml).toContain("c4");
    expect(resultHtml).toContain('role="alert"');
    expect(resultHtml).toContain("UPSTREAM_ERROR");
  });

  it("disables all bulk write buttons with read-only notice and never renders delete dialog in read-only mode", () => {
    const readOnlyHtml = renderToStaticMarkup(
      <BulkActionBarView
        {...bulkProps({
          selectedIds: ["c1", "c2"],
          readOnlyReason: READ_ONLY_REASON,
          isDeleteDialogOpen: true,
        })}
      />,
    );
    expect(readOnlyHtml).toContain(READ_ONLY_REASON);
    expect(readOnlyHtml).toContain('aria-disabled="true"');
    expect(readOnlyHtml).not.toContain('role="alertdialog"');
  });
});

describe("ModerationSettingsView rendering", () => {
  it("renders skeleton, empty (no connected pages), and error states", () => {
    const loadingHtml = renderToStaticMarkup(
      <ModerationSettingsView
        {...settingsProps({ isFirstLoad: true, showSkeleton: true })}
      />,
    );
    expect(loadingHtml).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<ModerationSettingsSkeleton />)).toContain(
      'aria-hidden="true"',
    );

    const emptyHtml = renderToStaticMarkup(<ModerationSettingsView {...settingsProps()} />);
    expect(emptyHtml).toContain('data-empty-kind="first-run"');
    expect(emptyHtml).toContain("Chưa có Fanpage Facebook nào được kết nối");
    expect(emptyHtml).toContain('href="/channels"');

    const errorHtml = renderToStaticMarkup(
      <ModerationSettingsView
        {...settingsProps({
          isError: true,
          error: new ApiError({
            code: "UPSTREAM_ERROR",
            status: 502,
            userMessage: "Không tải được cài đặt kiểm duyệt.",
          }),
        })}
      />,
    );
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Thử lại");
  });

  it("renders per-Page controls, dry-run explanation, 4 selectable categories, non-selectable complaint row, pending/error/read-only states", () => {
    const populatedHtml = renderToStaticMarkup(
      <ModerationSettingsView
        {...settingsProps({
          items: [sampleSetting()],
          savingPageId: "123",
          saveErrorByPageId: {
            "123": new ApiError({
              code: "INVALID_INPUT",
              status: 400,
              userMessage: "Ngưỡng không hợp lệ.",
            }),
          },
          savedMessageByPageId: {
            "123": "Đã lưu cài đặt kiểm duyệt cho Dịu Mây Boutique.",
          },
        })}
      />,
    );

    expect(populatedHtml).toContain("Dịu Mây Boutique");
    expect(populatedHtml).toContain("Chạy thử");
    expect(populatedHtml).toContain("Chạy thật");
    expect(populatedHtml).toContain("Chế độ Chạy thử không tác động lên Facebook");
    expect(populatedHtml).toContain("Spam / quảng cáo");
    expect(populatedHtml).toContain("Lừa đảo / liên kết lạ");
    expect(populatedHtml).toContain("Xúc phạm / thô tục");
    expect(populatedHtml).toContain("Lộ thông tin cá nhân (PII)");
    expect(populatedHtml).toContain("Ngưỡng độ tin cậy tối thiểu");
    expect(populatedHtml).toContain("85% (0.85)");
    expect(populatedHtml).toContain("Đang lưu cài đặt…");
    expect(populatedHtml).toContain("INVALID_INPUT");
    expect(populatedHtml).toContain("Đã lưu cài đặt kiểm duyệt cho Dịu Mây Boutique.");

    // Complaint is rendered strictly as an informational row — never as a checkbox option
    expect(populatedHtml).toContain('data-moderation-policy="complaint-flag-only"');
    expect(populatedHtml).toContain("Chỉ đánh dấu, không tự ẩn");
    expect(populatedHtml).toContain("chỉ đánh dấu, không tự ẩn");
    expect(populatedHtml).not.toContain('value="complaint"');

    const readOnlyHtml = renderToStaticMarkup(
      <ModerationSettingsView
        {...settingsProps({
          items: [sampleSetting()],
          readOnlyReason: READ_ONLY_REASON,
        })}
      />,
    );
    expect(readOnlyHtml).toContain(READ_ONLY_REASON);
    expect(readOnlyHtml).toContain('aria-disabled="true"');
  });
});

describe("ModerationLogView rendering", () => {
  it("renders skeleton, first-run empty, no-result empty, and API error states", () => {
    const loadingHtml = renderToStaticMarkup(
      <ModerationLogView {...logProps({ isFirstLoad: true, showSkeleton: true })} />,
    );
    expect(loadingHtml).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<ModerationLogSkeleton />)).toContain(
      'aria-hidden="true"',
    );

    const firstRunHtml = renderToStaticMarkup(<ModerationLogView {...logProps()} />);
    expect(firstRunHtml).toContain('data-empty-kind="first-run"');
    expect(firstRunHtml).toContain("Chưa có nhật ký kiểm duyệt");

    const noResultHtml = renderToStaticMarkup(
      <ModerationLogView
        {...logProps({
          filter: { ...DEFAULT_MODERATION_LOG_FILTER, action: "delete", actor: "operator" },
        })}
      />,
    );
    expect(noResultHtml).toContain('data-empty-kind="no-result"');
    expect(noResultHtml).toContain("Xoá bộ lọc");

    const errorHtml = renderToStaticMarkup(
      <ModerationLogView
        {...logProps({
          isError: true,
          error: new ApiError({
            code: "INTERNAL",
            status: 500,
            userMessage: "Không tải được nhật ký.",
          }),
        })}
      />,
    );
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Thử lại");
  });

  it("renders paged table, undo button only for ok hide rows, pending/error/success undo states, and read-only disabled state", () => {
    const entries: ModerationLogEntry[] = [
      sampleLogEntry({ id: "l-hide-ok", commentId: "c1", action: "hide", result: "ok" }),
      sampleLogEntry({
        id: "l-dry",
        commentId: "c2",
        action: "would_hide",
        actor: "auto",
        result: "ok",
      }),
      sampleLogEntry({
        id: "l-del",
        commentId: "c3",
        action: "delete",
        actor: "operator",
        result: "ok",
      }),
      sampleLogEntry({
        id: "l-hide-fail",
        commentId: "c4",
        action: "hide",
        result: "failed",
        errorCode: "RATE_LIMITED",
      }),
    ];

    const populatedHtml = renderToStaticMarkup(
      <ModerationLogView
        {...logProps({
          items: entries,
          hasNextPage: true,
          pageNameById: { "123": "Dịu Mây Boutique" },
          undoStatusMessage: "Đã hiện lại bình luận c1 trên Facebook.",
          undoErrorMessage: "Bình luận c4: Không tìm thấy bình luận.",
        })}
      />,
    );
    expect(populatedHtml).toContain("<table");
    expect(populatedHtml).toContain("Dịu Mây Boutique");
    expect(populatedHtml).toContain("Tải thêm nhật ký");
    expect(populatedHtml).toContain("Đã hiện lại bình luận c1 trên Facebook.");
    expect(populatedHtml).toContain("Không thể hiện lại bình luận");
    expect(populatedHtml).toContain("RATE_LIMITED");
    // Exactly one "Hiện lại" undo button inside the log table body (for l-hide-ok only)
    const tbodyMatch = populatedHtml.match(/<tbody[\s\S]*?<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    const undoMatches = tbodyMatch?.[0].match(/>Hiện lại</g) ?? [];
    expect(undoMatches).toHaveLength(1);

    const pendingUndoHtml = renderToStaticMarkup(
      <ModerationLogView
        {...logProps({
          items: [entries[0]],
          undoingCommentId: "c1",
          hasNextPage: true,
          isFetchingNextPage: true,
        })}
      />,
    );
    expect(pendingUndoHtml).toContain("Đang hiện lại…");
    expect(pendingUndoHtml).toContain("Đang tải thêm…");

    const readOnlyHtml = renderToStaticMarkup(
      <ModerationLogView
        {...logProps({
          items: [entries[0]],
          readOnlyReason: READ_ONLY_REASON,
        })}
      />,
    );
    expect(readOnlyHtml).toContain(READ_ONLY_REASON);
    expect(readOnlyHtml).toContain('aria-disabled="true"');
  });
});
