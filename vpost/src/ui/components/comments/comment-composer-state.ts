import {
  COMMENT_REPLY_MAX_LENGTH,
  type CommentDraftStatus,
  type CommentStatus,
} from "@/ui/schemas/comment.schema";

/**
 * Pure enable/disable matrix for the comment reply composer and row actions.
 * Kept React-free so every combination can be tested directly in node.
 */

export interface ComposerGateInput {
  readonly text: string;
  readonly commentStatus: CommentStatus;
  readonly canComment: boolean;
  readonly draftStatus: CommentDraftStatus | null;
  readonly blockReasons: readonly string[];
  readonly isGenerating: boolean;
  readonly isSaving: boolean;
  readonly isSending: boolean;
  readonly isRowActionPending: boolean;
  readonly readOnlyReason: string | null;
}

export interface ComposerGate {
  readonly charCount: number;
  readonly trimmedLength: number;
  readonly isOverMaxLength: boolean;
  readonly isSendingNow: boolean;
  readonly isAlreadyReplied: boolean;
  readonly isLocked: boolean;
  readonly canEdit: boolean;
  readonly editDisabledReason: string | null;
  readonly canGenerateDraft: boolean;
  readonly generateDisabledReason: string | null;
  readonly canSaveDraft: boolean;
  readonly saveDisabledReason: string | null;
  readonly canSendReply: boolean;
  readonly sendDisabledReason: string | null;
  readonly canIgnoreToggle: boolean;
  readonly canHideToggle: boolean;
  readonly rowActionDisabledReason: string | null;
}

export function evaluateComposerGate(input: ComposerGateInput): ComposerGate {
  const readOnly = input.readOnlyReason?.trim() || null;
  const charCount = input.text.length;
  const trimmedLength = input.text.trim().length;
  const isOverMaxLength = charCount > COMMENT_REPLY_MAX_LENGTH;
  const isSendingNow = input.isSending || input.draftStatus === "sending";
  const isAlreadyReplied = input.commentStatus === "replied" || input.draftStatus === "sent";
  const isLocked = isAlreadyReplied || isSendingNow;

  const isBusy = input.isGenerating || input.isSaving || isSendingNow || input.isRowActionPending;

  const canEdit = readOnly === null && !isLocked && !input.isGenerating && input.canComment;

  const editDisabledReason =
    readOnly ??
    (!input.canComment
      ? "Facebook không cho phép trả lời bình luận này."
      : isSendingNow
        ? "Đang gửi trả lời lên Facebook…"
        : isAlreadyReplied
          ? "Bình luận này đã được trả lời."
          : input.isGenerating
            ? "Đang tạo nháp AI…"
            : null);

  const canGenerateDraft =
    readOnly === null && input.canComment && !isLocked && !isBusy;

  const generateDisabledReason =
    readOnly ??
    (!input.canComment
      ? "Facebook không cho phép trả lời bình luận này."
      : isSendingNow
        ? "Đang gửi trả lời lên Facebook…"
        : isAlreadyReplied
          ? "Bình luận này đã được trả lời."
          : null);

  const canSaveDraft =
    canEdit && trimmedLength > 0 && !isOverMaxLength && !input.isSaving && !input.isRowActionPending;

  const saveDisabledReason =
    readOnly ??
    (!input.canComment
      ? "Facebook không cho phép trả lời bình luận này."
      : isLocked
        ? "Bản nháp đang gửi hoặc đã gửi, không thể chỉnh sửa."
        : input.isGenerating
          ? "Đang tạo nháp AI…"
          : input.isSaving
            ? "Đang lưu nháp…"
            : isOverMaxLength
              ? `Nội dung vượt quá ${COMMENT_REPLY_MAX_LENGTH.toLocaleString("vi-VN")} ký tự.`
              : trimmedLength === 0
                ? "Nhập nội dung để lưu nháp."
                : null);

  const canSendReply =
    readOnly === null &&
    input.canComment &&
    !isLocked &&
    !isBusy &&
    trimmedLength > 0 &&
    !isOverMaxLength &&
    input.blockReasons.length === 0;

  const sendDisabledReason =
    readOnly ??
    (!input.canComment
      ? "Facebook không cho phép trả lời bình luận này."
      : isSendingNow
        ? "Đang gửi trả lời lên Facebook…"
        : isAlreadyReplied
          ? "Bình luận này đã được trả lời."
          : input.isGenerating
            ? "Đang tạo nháp AI…"
            : input.isSaving
              ? "Đang lưu nháp…"
              : isOverMaxLength
                ? `Nội dung vượt quá ${COMMENT_REPLY_MAX_LENGTH.toLocaleString("vi-VN")} ký tự.`
                : input.blockReasons.length > 0
                  ? "Nội dung đang bị chặn kiểm tra — hãy sửa các lỗi bên trên trước khi gửi."
                  : trimmedLength === 0
                    ? "Nhập nội dung trả lời hoặc tạo nháp AI trước khi gửi lên Facebook."
                    : null);

  const canIgnoreToggle = readOnly === null && !isSendingNow && !input.isRowActionPending;
  const canHideToggle = readOnly === null && !isSendingNow && !input.isRowActionPending;
  const rowActionDisabledReason =
    readOnly ?? (isSendingNow ? "Đang gửi trả lời lên Facebook…" : null);

  return {
    charCount,
    trimmedLength,
    isOverMaxLength,
    isSendingNow,
    isAlreadyReplied,
    isLocked,
    canEdit,
    editDisabledReason,
    canGenerateDraft,
    generateDisabledReason,
    canSaveDraft,
    saveDisabledReason,
    canSendReply,
    sendDisabledReason,
    canIgnoreToggle,
    canHideToggle,
    rowActionDisabledReason,
  };
}

// --- Draft buffer & blur-to-save coordination -------------------------------

export type ComposerActionTarget = "generate" | "save" | "send";

/**
 * Pure draft buffer state tracking local edit revisions against server draft
 * updates so an in-flight blur-save or background refetch never clobbers newer
 * operator keystrokes.
 */
export interface ComposerBufferState {
  readonly text: string;
  readonly serverKey: string;
  readonly serverText: string;
  readonly editRevision: number;
  readonly syncedRevision: number;
  readonly inFlightSaveRevision: number | null;
  readonly inFlightSaveText: string | null;
  readonly acceptNextServerOverwrite: boolean;
}

export function createComposerBuffer(
  serverKey: string,
  serverText: string,
): ComposerBufferState {
  return {
    text: serverText,
    serverKey,
    serverText,
    editRevision: 0,
    syncedRevision: 0,
    inFlightSaveRevision: null,
    inFlightSaveText: null,
    acceptNextServerOverwrite: false,
  };
}

export function applyComposerLocalEdit(
  state: ComposerBufferState,
  nextText: string,
): ComposerBufferState {
  if (nextText === state.text) return state;
  return {
    ...state,
    text: nextText,
    editRevision: state.editRevision + 1,
    acceptNextServerOverwrite: false,
  };
}

export function markComposerSaveStarted(
  state: ComposerBufferState,
): ComposerBufferState {
  return {
    ...state,
    inFlightSaveRevision: state.editRevision,
    inFlightSaveText: state.text.trim(),
  };
}

export function markComposerGenerateStarted(
  state: ComposerBufferState,
): ComposerBufferState {
  return {
    ...state,
    inFlightSaveRevision: null,
    inFlightSaveText: null,
    acceptNextServerOverwrite: true,
  };
}

/**
 * Reconciles a new server draft snapshot with the local textarea buffer.
 * - Preserves local `text` whenever the operator typed newer edits while a save
 *   or background refetch was in-flight.
 * - Adopts `nextServerText` when the buffer is clean, when the operator asked
 *   for a fresh AI draft, or when the completed save matches the latest edit.
 */
export function syncComposerBufferFromServer(
  state: ComposerBufferState,
  nextServerKey: string,
  nextServerText: string,
): ComposerBufferState {
  if (nextServerKey === state.serverKey) return state;

  const trimmedServer = nextServerText.trim();
  const hasUnsavedLocalEdits = state.editRevision !== state.syncedRevision;
  const serverConfirmedInFlightSave =
    state.inFlightSaveRevision !== null &&
    state.inFlightSaveText !== null &&
    trimmedServer === state.inFlightSaveText;
  const saveMatchedLatestEdit =
    serverConfirmedInFlightSave &&
    state.inFlightSaveRevision === state.editRevision &&
    trimmedServer === state.text.trim();

  if (state.acceptNextServerOverwrite || !hasUnsavedLocalEdits || saveMatchedLatestEdit) {
    return {
      text: saveMatchedLatestEdit ? state.text : nextServerText,
      serverKey: nextServerKey,
      serverText: nextServerText,
      editRevision: state.editRevision,
      syncedRevision: state.editRevision,
      inFlightSaveRevision: null,
      inFlightSaveText: null,
      acceptNextServerOverwrite: false,
    };
  }

  return {
    ...state,
    serverKey: nextServerKey,
    serverText: nextServerText,
    syncedRevision:
      serverConfirmedInFlightSave && state.inFlightSaveRevision !== null
        ? state.inFlightSaveRevision
        : state.syncedRevision,
    inFlightSaveRevision: serverConfirmedInFlightSave ? null : state.inFlightSaveRevision,
    inFlightSaveText: serverConfirmedInFlightSave ? null : state.inFlightSaveText,
    acceptNextServerOverwrite: false,
  };
}

/**
 * Decides whether textarea `blur` should fire an automatic draft save.
 * Skips auto-save when focus moves to (or pointer-down targets) the row's
 * Send/Save/Generate buttons so an explicit click is never swallowed.
 */
export function shouldTriggerBlurSave(params: {
  readonly canSaveDraft: boolean;
  readonly text: string;
  readonly serverDraftText: string;
  readonly suppressBlurSave: boolean;
  readonly relatedAction: ComposerActionTarget | null;
}): boolean {
  if (!params.canSaveDraft) return false;
  if (params.suppressBlurSave) return false;
  if (params.relatedAction !== null) return false;
  if (params.text.trim() === params.serverDraftText.trim()) return false;
  return true;
}
