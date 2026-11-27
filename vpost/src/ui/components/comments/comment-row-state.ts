import type { CommentCheck } from "@/ui/schemas/comment.schema";
import type { ApiError } from "@/ui/services/api-error";

/**
 * Per-row mutation state and live-region announcement helpers for `/comments`.
 *
 * Kept React-free so concurrent multi-row transitions, 409 conflicts, and
 * repeated identical live announcements can be verified directly in node tests.
 */

export type CommentRowActionKind = "generate" | "save" | "send" | "ignore" | "hide";

export interface CommentRowState {
  readonly isGenerating: boolean;
  readonly isSaving: boolean;
  readonly isSending: boolean;
  readonly isTogglingIgnore: boolean;
  readonly isTogglingHide: boolean;
  readonly checkResult: CommentCheck | null;
  readonly draftError: ApiError | null;
  readonly sendError: ApiError | null;
  readonly rowActionError: ApiError | null;
  readonly successMessage: string | null;
  readonly successSeq: number;
}

export const EMPTY_COMMENT_ROW_STATE: CommentRowState = {
  isGenerating: false,
  isSaving: false,
  isSending: false,
  isTogglingIgnore: false,
  isTogglingHide: false,
  checkResult: null,
  draftError: null,
  sendError: null,
  rowActionError: null,
  successMessage: null,
  successSeq: 0,
};

export type CommentRowStateMap = Readonly<Record<string, CommentRowState | undefined>>;

export function getCommentRowState(
  map: CommentRowStateMap,
  commentId: string,
): CommentRowState {
  return map[commentId] ?? EMPTY_COMMENT_ROW_STATE;
}

export type CommentRowStateAction =
  | { type: "generate_start"; commentId: string }
  | { type: "generate_success"; commentId: string; message: string }
  | { type: "generate_error"; commentId: string; error: ApiError }
  | { type: "save_start"; commentId: string }
  | { type: "save_success"; commentId: string; check: CommentCheck; message: string }
  | { type: "save_error"; commentId: string; error: ApiError }
  | { type: "send_start"; commentId: string }
  | { type: "send_success"; commentId: string; message: string }
  | { type: "send_error"; commentId: string; error: ApiError }
  | { type: "ignore_start"; commentId: string }
  | { type: "ignore_success"; commentId: string; message: string }
  | { type: "ignore_error"; commentId: string; error: ApiError }
  | { type: "hide_start"; commentId: string }
  | { type: "hide_success"; commentId: string; message: string }
  | { type: "hide_error"; commentId: string; error: ApiError }
  | { type: "text_edited"; commentId: string };

function updateRow(
  state: CommentRowStateMap,
  commentId: string,
  updater: (prev: CommentRowState) => CommentRowState,
): CommentRowStateMap {
  const prev = getCommentRowState(state, commentId);
  const next = updater(prev);
  if (next === prev) return state;
  return { ...state, [commentId]: next };
}

export function commentRowStateReducer(
  state: CommentRowStateMap,
  action: CommentRowStateAction,
): CommentRowStateMap {
  switch (action.type) {
    case "generate_start":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isGenerating: true,
        checkResult: null,
        draftError: null,
        sendError: null,
        successMessage: null,
      }));
    case "generate_success":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isGenerating: false,
        draftError: null,
        successMessage: action.message,
        successSeq: prev.successSeq + 1,
      }));
    case "generate_error":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isGenerating: false,
        draftError: action.error,
      }));

    case "save_start":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isSaving: true,
        draftError: null,
        sendError: null,
        successMessage: null,
      }));
    case "save_success":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isSaving: false,
        checkResult: action.check,
        draftError: null,
        successMessage: action.message,
        successSeq: prev.successSeq + 1,
      }));
    case "save_error":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isSaving: false,
        draftError: action.error,
      }));

    case "send_start":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isSending: true,
        sendError: null,
        successMessage: null,
      }));
    case "send_success":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isSending: false,
        checkResult: null,
        sendError: null,
        successMessage: action.message,
        successSeq: prev.successSeq + 1,
      }));
    case "send_error":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isSending: false,
        sendError: action.error,
      }));

    case "ignore_start":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isTogglingIgnore: true,
        rowActionError: null,
        successMessage: null,
      }));
    case "ignore_success":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isTogglingIgnore: false,
        rowActionError: null,
        successMessage: action.message,
        successSeq: prev.successSeq + 1,
      }));
    case "ignore_error":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isTogglingIgnore: false,
        rowActionError: action.error,
      }));

    case "hide_start":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isTogglingHide: true,
        rowActionError: null,
        successMessage: null,
      }));
    case "hide_success":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isTogglingHide: false,
        rowActionError: null,
        successMessage: action.message,
        successSeq: prev.successSeq + 1,
      }));
    case "hide_error":
      return updateRow(state, action.commentId, (prev) => ({
        ...prev,
        isTogglingHide: false,
        rowActionError: action.error,
      }));

    case "text_edited":
      return updateRow(state, action.commentId, (prev) => {
        if (!prev.checkResult && !prev.sendError && !prev.successMessage) return prev;
        return {
          ...prev,
          checkResult: null,
          sendError: null,
          successMessage: null,
        };
      });
  }
}

/**
 * Runs a single per-row async mutation safely without interfering with concurrent
 * actions on other rows. Same-(commentId, action) re-entry while in-flight is ignored.
 */
export async function executePerRowMutation<TResult>(params: {
  readonly commentId: string;
  readonly action: CommentRowActionKind;
  readonly inFlightKeys: Set<string>;
  readonly onStart: () => void;
  readonly run: () => Promise<TResult>;
  readonly onSuccess: (result: TResult) => void;
  readonly onError: (error: unknown) => void;
}): Promise<boolean> {
  const key = `${params.commentId}:${params.action}`;
  if (params.inFlightKeys.has(key)) return false;

  params.inFlightKeys.add(key);
  params.onStart();
  try {
    const result = await params.run();
    params.onSuccess(result);
    return true;
  } catch (error) {
    params.onError(error);
    return false;
  } finally {
    params.inFlightKeys.delete(key);
  }
}

// --- Screen-level live announcements & 409 conflict notice ------------------

export interface LiveAnnouncement {
  readonly seq: number;
  readonly message: string;
}

/**
 * Increments a monotonic `seq` even when `message` matches the previous text,
 * ensuring UI banners remount and screen readers re-announce identical results.
 */
export function nextLiveAnnouncement(
  prev: LiveAnnouncement | null,
  message: string,
): LiveAnnouncement {
  return { seq: (prev?.seq ?? 0) + 1, message };
}

export interface ConflictNotice {
  readonly seq: number;
  readonly commentId: string;
  readonly title: string;
  readonly description: string;
}

export function isSendConflictError(error: ApiError): boolean {
  return error.status === 409 && error.code === "CONFLICT";
}

export function createConflictNotice(
  prev: ConflictNotice | null,
  params: { readonly commentId: string; readonly canComment: boolean; readonly error: ApiError },
): ConflictNotice {
  return {
    seq: (prev?.seq ?? 0) + 1,
    commentId: params.commentId,
    title: params.canComment
      ? "Bình luận này đã được trả lời"
      : "Không thể trả lời bình luận này",
    description:
      params.error.userMessage ||
      "Bình luận này đã được trả lời. Danh sách đã được cập nhật.",
  };
}
