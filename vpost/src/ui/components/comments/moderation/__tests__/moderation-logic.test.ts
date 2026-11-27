import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_COMMENT_FILTER } from "@/ui/components/comments/comment-filters";
import {
  buildConfirmedBulkDeleteRequest,
  buildNonDeleteBulkRequest,
  evaluateBulkActionGate,
  formatBulkDeleteConfirmTitle,
  formatBulkResultSummary,
  formatNotProcessedNotice,
} from "@/ui/components/comments/moderation/bulk-action-state";
import {
  canUndoModerationLogEntry,
  evaluateUndoLogEntryGate,
  resolveModerationLogEmptyKind,
} from "@/ui/components/comments/moderation/log-state";
import {
  buildSettingUpdatePayload,
  clampModerationThreshold,
  evaluateSettingSaveGate,
  isAutoHideCategorySelectable,
  isSettingDraftDirty,
  sanitizeAutoHideCategories,
  settingToDraft,
} from "@/ui/components/comments/moderation/settings-state";
import { invalidateCommentsAndModeration } from "@/ui/hooks/useModeration";
import {
  DEFAULT_MODERATION_LOG_FILTER,
  type ModerationLogEntry,
  type ModerationSetting,
} from "@/ui/schemas/moderation.schema";
import { ApiError } from "@/ui/services/api-error";
import { commentKeys } from "@/ui/services/comment.api";
import {
  classifyComment,
  listModerationLog,
  listModerationSettings,
  moderationKeys,
  runBulkCommentAction,
  updateModerationSetting,
} from "@/ui/services/moderation.api";

const READ_ONLY_REASON = "Chế độ hỗ trợ chỉ được xem.";

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirm-before-delete guard", () => {
  it("formats the exact Vietnamese confirmation prompt with count", () => {
    expect(formatBulkDeleteConfirmTitle(1)).toBe(
      "Xoá vĩnh viễn 1 bình luận trên Facebook? Không hoàn tác được.",
    );
    expect(formatBulkDeleteConfirmTitle(7)).toBe(
      "Xoá vĩnh viễn 7 bình luận trên Facebook? Không hoàn tác được.",
    );
  });

  it("refuses to build a delete request unless confirmed === true", () => {
    expect(buildConfirmedBulkDeleteRequest(["c1", "c2"], false)).toBeNull();
    expect(buildConfirmedBulkDeleteRequest([], true)).toBeNull();
    expect(buildConfirmedBulkDeleteRequest(["c1", "c2"], true)).toEqual({
      ids: ["c1", "c2"],
      action: "delete",
      confirm: true,
    });
  });

  it("omits confirm for non-delete bulk actions", () => {
    expect(buildNonDeleteBulkRequest(["c1"], "hide")).toEqual({
      ids: ["c1"],
      action: "hide",
    });
    expect(buildNonDeleteBulkRequest([], "hide")).toBeNull();
  });

  it("blocks POST /api/comments/bulk delete without confirm: true before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      runBulkCommentAction({ ids: ["c1"], action: "delete" }),
    ).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
      status: 400,
    });

    await expect(
      runBulkCommentAction({ ids: ["c1"], action: "delete", confirm: false }),
    ).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
      status: 400,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends confirm: true ONLY when explicitly confirmed for delete and omits it for hide", async () => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        mockJsonResponse({
          tenantId: "00000000-0000-4000-8000-000000000001",
          results: [{ id: "c1", ok: true }],
          processed: 1,
          failed: 0,
          notProcessed: [],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await runBulkCommentAction({ ids: ["c1", "c1"], action: "delete", confirm: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [deleteUrl, deleteInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(deleteUrl).toBe("/api/comments/bulk");
    expect(JSON.parse(String(deleteInit.body))).toEqual({
      ids: ["c1"],
      action: "delete",
      confirm: true,
    });

    await runBulkCommentAction({ ids: ["c1"], action: "hide" });
    const [, hideInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(hideInit.body))).toEqual({
      ids: ["c1"],
      action: "hide",
    });
  });

  it("formats polite summaries for full success, partial failure, and rate-limited notProcessed", () => {
    expect(
      formatBulkResultSummary("hide", { processed: 3, failed: 0, notProcessed: [] }),
    ).toBe("Đã ẩn 3 bình luận.");
    expect(
      formatBulkResultSummary("delete", { processed: 1, failed: 2, notProcessed: [] }),
    ).toBe("Đã xoá 1 bình luận, 2 bình luận thất bại.");
    expect(
      formatBulkResultSummary("hide", {
        processed: 1,
        failed: 1,
        notProcessed: ["c3", "c4"],
      }),
    ).toBe(
      "Đã ẩn 1 bình luận, 1 bình luận thất bại, 2 bình luận chưa xử lý do Facebook giới hạn tần suất.",
    );
    expect(formatNotProcessedNotice(2)).toContain("2 bình luận còn lại chưa được xử lý");
  });
});

describe("complaint v1 policy (PHASE2(complaint-autohide)) & settings-state", () => {
  const sampleSetting: ModerationSetting = {
    pageId: "123",
    pageName: "Dịu Mây Boutique",
    channelId: "fb-123",
    enabled: false,
    mode: "dry_run",
    categories: ["spam"],
    threshold: 0.85,
    updatedBy: null,
    updatedAt: null,
  };

  it("never allows complaint as a selectable auto-hide category and strips it from payloads", () => {
    expect(isAutoHideCategorySelectable("complaint")).toBe(false);
    expect(isAutoHideCategorySelectable("spam")).toBe(true);
    expect(isAutoHideCategorySelectable("scam")).toBe(true);
    expect(isAutoHideCategorySelectable("abusive")).toBe(true);
    expect(isAutoHideCategorySelectable("pii")).toBe(true);

    expect(sanitizeAutoHideCategories(["pii", "complaint", "spam", "unknown"])).toEqual([
      "spam",
      "pii",
    ]);

    const payload = buildSettingUpdatePayload({
      enabled: true,
      mode: "live",
      categories: sanitizeAutoHideCategories(["spam", "complaint"]),
      threshold: 0.9,
    });
    expect(payload.categories).toEqual(["spam"]);
    expect(payload).not.toHaveProperty("acknowledgeComplaintRisk");
  });

  it("rejects complaint client-side in updateModerationSetting without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      updateModerationSetting("123", {
        enabled: true,
        mode: "live",
        categories: ["complaint" as never],
        threshold: 0.85,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clamps threshold to 0.5..1.0 and detects dirty changes accurately", () => {
    expect(clampModerationThreshold(0.2)).toBe(0.5);
    expect(clampModerationThreshold(1.5)).toBe(1.0);
    expect(clampModerationThreshold(0.85)).toBe(0.85);

    const draft = settingToDraft(sampleSetting);
    expect(isSettingDraftDirty(sampleSetting, draft)).toBe(false);
    expect(isSettingDraftDirty(sampleSetting, { ...draft, enabled: true })).toBe(true);
    expect(isSettingDraftDirty(sampleSetting, { ...draft, threshold: 0.9 })).toBe(true);
    expect(
      isSettingDraftDirty(sampleSetting, { ...draft, categories: ["spam", "pii"] }),
    ).toBe(true);
  });
});

describe("read-only disabled gates & log undo eligibility", () => {
  it("disables bulk actions with reason in read-only sessions", () => {
    const ro = evaluateBulkActionGate({
      selectedCount: 3,
      isPending: false,
      readOnlyReason: READ_ONLY_REASON,
    });
    expect(ro.canAct).toBe(false);
    expect(ro.canDelete).toBe(false);
    expect(ro.disabledReason).toBe(READ_ONLY_REASON);

    const active = evaluateBulkActionGate({
      selectedCount: 3,
      isPending: false,
      readOnlyReason: null,
    });
    expect(active.canAct).toBe(true);
    expect(active.canDelete).toBe(true);
  });

  it("disables settings edit/save/reset with reason in read-only sessions", () => {
    const ro = evaluateSettingSaveGate({
      isDirty: true,
      isSaving: false,
      readOnlyReason: READ_ONLY_REASON,
    });
    expect(ro.canEdit).toBe(false);
    expect(ro.canSave).toBe(false);
    expect(ro.canReset).toBe(false);
    expect(ro.editDisabledReason).toBe(READ_ONLY_REASON);
    expect(ro.saveDisabledReason).toBe(READ_ONLY_REASON);
  });

  it("allows undo only for successful hide log entries and disables in read-only sessions", () => {
    const baseEntry: ModerationLogEntry = {
      id: "l1",
      pageId: "123",
      commentId: "c1",
      action: "hide",
      actor: "auto",
      category: "spam",
      reason: "spam lặp",
      result: "ok",
      errorCode: null,
      createdAt: "2026-11-27T10:00:00.000Z",
    };

    expect(canUndoModerationLogEntry(baseEntry)).toBe(true);
    expect(canUndoModerationLogEntry({ ...baseEntry, result: "failed" })).toBe(false);
    expect(canUndoModerationLogEntry({ ...baseEntry, action: "would_hide" })).toBe(false);
    expect(canUndoModerationLogEntry({ ...baseEntry, action: "delete" })).toBe(false);

    const roGate = evaluateUndoLogEntryGate({
      entry: baseEntry,
      isUndoing: false,
      readOnlyReason: READ_ONLY_REASON,
    });
    expect(roGate.isEligible).toBe(true);
    expect(roGate.canUndo).toBe(false);
    expect(roGate.disabledReason).toBe(READ_ONLY_REASON);

    expect(resolveModerationLogEmptyKind(DEFAULT_MODERATION_LOG_FILTER)).toBe("first-run");
    expect(
      resolveModerationLogEmptyKind({
        ...DEFAULT_MODERATION_LOG_FILTER,
        action: "hide",
      }),
    ).toBe("no-result");
  });

  it("calls real GET settings, GET log with query params, and POST classify endpoints", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockJsonResponse({
          tenantId: "00000000-0000-4000-8000-000000000001",
          items: [],
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          tenantId: "00000000-0000-4000-8000-000000000001",
          items: [],
          nextCursor: null,
          limit: 20,
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          tenantId: "00000000-0000-4000-8000-000000000001",
          commentId: "c1",
          moderation: {
            category: "spam",
            confidence: 1.0,
            reasons: ["follow chéo"],
            source: "rule",
            action: null,
            at: "2026-11-27T12:00:00.000Z",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await listModerationSettings();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/comments/moderation-settings");

    await listModerationLog({ action: "hide", actor: "auto", cursor: "20", limit: 20 });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      "/api/comments/moderation-log?action=hide&actor=auto&cursor=20&limit=20",
    );

    const classified = await classifyComment("c1");
    expect(fetchSpy.mock.calls[2]?.[0]).toBe("/api/comments/c1/classify");
    expect(classified.moderation.category).toBe("spam");
  });

  it("invalidates comment list, counts, moderation settings, and moderation log queries together", () => {
    const queryClient = new QueryClient();
    const tenantKey = "tenant-1";
    const listKey = commentKeys.list(tenantKey, DEFAULT_COMMENT_FILTER);
    const modListKey = commentKeys.list(tenantKey, {
      ...DEFAULT_COMMENT_FILTER,
      moderation: "auto_hidden",
    });
    const settingsKey = moderationKeys.settings(tenantKey);
    const logKey = moderationKeys.log(tenantKey, DEFAULT_MODERATION_LOG_FILTER);
    const otherTenantKey = commentKeys.list("tenant-2", DEFAULT_COMMENT_FILTER);

    queryClient.setQueryData(listKey, { pages: [] });
    queryClient.setQueryData(modListKey, { pages: [] });
    queryClient.setQueryData(settingsKey, { items: [] });
    queryClient.setQueryData(logKey, { pages: [] });
    queryClient.setQueryData(otherTenantKey, { pages: [] });

    invalidateCommentsAndModeration(queryClient, tenantKey);

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(modListKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(settingsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(logKey)?.isInvalidated).toBe(true);
    // Tenant isolation preserved
    expect(queryClient.getQueryState(otherTenantKey)?.isInvalidated).toBe(false);
  });
});
