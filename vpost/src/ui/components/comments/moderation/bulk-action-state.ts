import {
  BULK_SELECTION_MAX,
  type BulkCommentAction,
  type BulkCommentResultItem,
  type BulkCommentsResponse,
} from "@/ui/schemas/moderation.schema";
import type { RunBulkCommentActionParams } from "@/ui/services/moderation.api";

/**
 * Pure state, gating, confirm-before-delete guard, and Vietnamese copy helpers
 * for `BulkActionBar`. Kept React-free so every safety rule is directly unit-tested.
 */

export interface BulkActionGateInput {
  readonly selectedCount: number;
  readonly isPending: boolean;
  readonly readOnlyReason: string | null;
}

export interface BulkActionGate {
  readonly canAct: boolean;
  readonly canDelete: boolean;
  readonly disabledReason: string | null;
}

export function evaluateBulkActionGate(input: BulkActionGateInput): BulkActionGate {
  const readOnly = input.readOnlyReason?.trim() || null;
  if (readOnly !== null) {
    return { canAct: false, canDelete: false, disabledReason: readOnly };
  }
  if (input.isPending) {
    return {
      canAct: false,
      canDelete: false,
      disabledReason: "Đang xử lý thao tác hàng loạt…",
    };
  }
  if (input.selectedCount <= 0) {
    return {
      canAct: false,
      canDelete: false,
      disabledReason: "Chọn ít nhất một bình luận để thao tác.",
    };
  }
  if (input.selectedCount > BULK_SELECTION_MAX) {
    return {
      canAct: false,
      canDelete: false,
      disabledReason: `Mỗi lượt chỉ xử lý tối đa ${BULK_SELECTION_MAX} bình luận.`,
    };
  }
  return { canAct: true, canDelete: true, disabledReason: null };
}

/** Exact confirmation title required before permanently deleting comments on Facebook. */
export function formatBulkDeleteConfirmTitle(count: number): string {
  return `Xoá vĩnh viễn ${count} bình luận trên Facebook? Không hoàn tác được.`;
}

export const BULK_DELETE_CONFIRM_DESCRIPTION =
  "Các bình luận đã chọn sẽ bị xoá vĩnh viễn trên Facebook và không thể khôi phục. Hệ thống vẫn lưu bản ghi trong nhật ký kiểm duyệt để đối soát.";

/**
 * Builds the request payload for a non-delete bulk action.
 * Never allows `"delete"` — delete must go through `buildConfirmedBulkDeleteRequest`.
 */
export function buildNonDeleteBulkRequest(
  ids: readonly string[],
  action: Exclude<BulkCommentAction, "delete">,
): RunBulkCommentActionParams | null {
  if (ids.length === 0 || ids.length > BULK_SELECTION_MAX) return null;
  return { ids: [...ids], action };
}

/**
 * Builds the request payload for bulk delete ONLY when the confirm dialog
 * has explicitly confirmed (`confirmed === true`). Returns `null` otherwise so
 * no request can be dispatched without confirmation.
 */
export function buildConfirmedBulkDeleteRequest(
  ids: readonly string[],
  confirmed: boolean,
): RunBulkCommentActionParams | null {
  if (!confirmed || ids.length === 0 || ids.length > BULK_SELECTION_MAX) {
    return null;
  }
  return { ids: [...ids], action: "delete", confirm: true };
}

const ACTION_PAST_VERBS: Record<BulkCommentAction, string> = {
  hide: "Đã ẩn",
  unhide: "Đã hiện lại",
  delete: "Đã xoá",
  ignore: "Đã bỏ qua",
  unignore: "Đã khôi phục",
};

/** Formats a polite live-region summary for a completed bulk run. */
export function formatBulkResultSummary(
  action: BulkCommentAction,
  response: Pick<BulkCommentsResponse, "processed" | "failed" | "notProcessed">,
): string {
  const verb = ACTION_PAST_VERBS[action];
  const parts: string[] = [`${verb} ${response.processed} bình luận`];

  if (response.failed > 0) {
    parts.push(`${response.failed} bình luận thất bại`);
  }
  if (response.notProcessed.length > 0) {
    parts.push(
      `${response.notProcessed.length} bình luận chưa xử lý do Facebook giới hạn tần suất`,
    );
  }
  return `${parts.join(", ")}.`;
}

export function extractFailedBulkItems(
  response: Pick<BulkCommentsResponse, "results">,
): readonly BulkCommentResultItem[] {
  return response.results.filter((item) => !item.ok);
}

export function hasRateLimitStop(
  response: Pick<BulkCommentsResponse, "results" | "notProcessed">,
): boolean {
  return (
    response.notProcessed.length > 0 ||
    response.results.some((item) => !item.ok && item.code === "RATE_LIMITED")
  );
}

/** Fallback Vietnamese failure reason when an item has an error code without a message. */
export function describeBulkItemFailure(item: BulkCommentResultItem): string {
  const msg = item.message?.trim();
  if (msg && msg.length > 0) return msg;
  switch (item.code) {
    case "NOT_FOUND":
      return "Không tìm thấy bình luận hoặc bình luận đã bị xoá.";
    case "FORBIDDEN":
      return "Không thể thao tác kiểm duyệt trên bình luận của chính Fanpage.";
    case "RATE_LIMITED":
      return "Facebook đang giới hạn tần suất gọi API — hãy đợi vài phút rồi thử lại.";
    case "PERMISSION_MISSING":
      return "Page thiếu quyền pages_manage_engagement — hãy kết nối lại Page ở mục Kênh.";
    case "TOKEN_INVALID":
      return "Token Facebook đã hết hạn — hãy kết nối lại Page ở mục Kênh.";
    default:
      return "Thao tác thất bại trên Facebook.";
  }
}

export function formatNotProcessedNotice(count: number): string {
  return `Facebook đang giới hạn tần suất nên hệ thống đã dừng sớm. ${count} bình luận còn lại chưa được xử lý và vẫn được giữ chọn để bạn thử lại sau ít phút.`;
}
