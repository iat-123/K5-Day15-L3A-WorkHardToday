"use client";

import {
  Banner,
  Button,
  HStack,
  Section,
  Stack,
  StatusDot,
  Text,
  TextArea,
} from "@astryxdesign/core";
import { Save, Send, Sparkles } from "lucide-react";
import { useRef, useState, type FocusEvent } from "react";

import {
  applyComposerLocalEdit,
  createComposerBuffer,
  evaluateComposerGate,
  markComposerGenerateStarted,
  markComposerSaveStarted,
  shouldTriggerBlurSave,
  syncComposerBufferFromServer,
  type ComposerActionTarget,
} from "@/ui/components/comments/comment-composer-state";
import { extractBlockedReasonsFromError } from "@/ui/components/comments/comment-error";
import { CommentErrorNotice } from "@/ui/components/comments/CommentErrorNotice";
import { PermissionMissingNotice } from "@/ui/components/comments/PermissionMissingNotice";
import {
  COMMENT_DRAFT_DOT_VARIANTS,
  COMMENT_DRAFT_STATUS_LABELS,
  COMMENT_REPLY_MAX_LENGTH,
  filterReplyWarnings,
  formatCommentAccessibleContext,
  isReconnectPageCode,
  type CommentCheck,
  type CommentItem,
} from "@/ui/schemas/comment.schema";
import type { ApiError } from "@/ui/services/api-error";

export interface CommentReplyComposerProps {
  comment: CommentItem;
  readOnlyReason: string | null;
  isGenerating: boolean;
  isSaving: boolean;
  isSending: boolean;
  isRowActionPending: boolean;
  checkResult: CommentCheck | null;
  draftError: ApiError | null;
  sendError: ApiError | null;
  onGenerateDraft: () => void;
  onSaveDraft: (text: string) => void;
  onSendReply: (text: string) => void;
  onTextEdited?: () => void;
}

function parseComposerAction(value: string | undefined): ComposerActionTarget | null {
  if (value === "generate" || value === "save" || value === "send") return value;
  return null;
}

/**
 * Editable AI/manual reply composer for a single comment.
 * Replies are sent only from the explicit "Duyệt & gửi trả lời" button.
 */
export function CommentReplyComposer({
  comment,
  readOnlyReason,
  isGenerating,
  isSaving,
  isSending,
  isRowActionPending,
  checkResult,
  draftError,
  sendError,
  onGenerateDraft,
  onSaveDraft,
  onSendReply,
  onTextEdited,
}: CommentReplyComposerProps) {
  const rowContext = formatCommentAccessibleContext(comment);
  const serverDraftText = comment.draft?.text ?? "";
  const serverDraftKey = `${comment.id}:${comment.draft?.id ?? "none"}:${comment.draft?.updatedAt ?? ""}:${serverDraftText}`;

  const [buffer, setBuffer] = useState(() =>
    createComposerBuffer(serverDraftKey, serverDraftText),
  );
  const actionsRowRef = useRef<HTMLDivElement | null>(null);
  const suppressBlurSaveRef = useRef(false);

  // Reconcile server draft updates without clobbering newer in-flight local edits.
  const syncedBuffer = syncComposerBufferFromServer(buffer, serverDraftKey, serverDraftText);
  if (syncedBuffer !== buffer) {
    setBuffer(syncedBuffer);
  }
  const text = syncedBuffer.text;

  const blockedFromSend = extractBlockedReasonsFromError(sendError);
  const blockReasons =
    blockedFromSend.length > 0 ? blockedFromSend : (checkResult?.block ?? []);

  const warnings = filterReplyWarnings(
    checkResult ? checkResult.warn : (comment.draft?.warnings ?? []),
  );

  const gate = evaluateComposerGate({
    text,
    commentStatus: comment.status,
    canComment: comment.canComment,
    draftStatus: comment.draft?.status ?? null,
    blockReasons,
    isGenerating,
    isSaving,
    isSending,
    isRowActionPending,
    readOnlyReason,
  });

  const isConflictSend = sendError?.status === 409 && sendError.code === "CONFLICT";
  const isPersistedFailure = comment.draft?.status === "failed" && !sendError;
  const isPersistedPermissionFailure = Boolean(
    isPersistedFailure && isReconnectPageCode(comment.draft?.errorCode),
  );
  const isPersistedRateLimitFailure = Boolean(
    isPersistedFailure &&
      (comment.draft?.errorCode === "RATE_LIMITED" ||
        comment.draft?.errorCode === "POSTING_TOO_FAST"),
  );

  function resolveRelatedAction(target: EventTarget | null): ComposerActionTarget | null {
    if (typeof Element === "undefined" || !(target instanceof Element)) return null;
    const actionEl = target.closest<HTMLElement>("[data-composer-action]");
    if (!actionEl || !actionsRowRef.current?.contains(actionEl)) return null;
    return parseComposerAction(actionEl.dataset.composerAction);
  }

  function handleTextChange(nextValue: string) {
    setBuffer((prev) => applyComposerLocalEdit(prev, nextValue));
    onTextEdited?.();
  }

  function triggerSaveDraft(latestText: string) {
    setBuffer((prev) => markComposerSaveStarted(prev));
    onSaveDraft(latestText);
  }

  function handleBlur(event: FocusEvent<HTMLTextAreaElement>) {
    const suppressBlurSave = suppressBlurSaveRef.current;
    suppressBlurSaveRef.current = false;
    const relatedAction = resolveRelatedAction(event.relatedTarget);

    if (
      !shouldTriggerBlurSave({
        canSaveDraft: gate.canSaveDraft,
        text,
        serverDraftText,
        suppressBlurSave,
        relatedAction,
      })
    ) {
      return;
    }
    triggerSaveDraft(text);
  }

  function markActionPointerDown() {
    suppressBlurSaveRef.current = true;
  }

  function handleGenerateClick() {
    suppressBlurSaveRef.current = false;
    setBuffer((prev) => markComposerGenerateStarted(prev));
    onGenerateDraft();
  }

  function handleSaveClick() {
    suppressBlurSaveRef.current = false;
    triggerSaveDraft(text);
  }

  function handleSendClick() {
    suppressBlurSaveRef.current = false;
    onSendReply(text);
  }

  const textAreaStatus =
    blockReasons.length > 0
      ? { type: "error" as const, message: `Nội dung bị chặn: ${blockReasons.join(" · ")}` }
      : gate.isOverMaxLength
        ? {
            type: "error" as const,
            message: `Nội dung vượt quá ${COMMENT_REPLY_MAX_LENGTH.toLocaleString("vi-VN")} ký tự.`,
          }
        : warnings.length > 0
          ? { type: "warning" as const, message: warnings.join(" · ") }
          : undefined;

  const isDraftSending = gate.isSendingNow;
  const draftStatus = isDraftSending ? "sending" : (comment.draft?.status ?? null);

  return (
    <Section variant="muted" padding={3}>
      <Stack direction="vertical" gap={3}>
        {/* Draft status indicator */}
        {draftStatus ? (
          <HStack gap={2} align="center" wrap="wrap">
            <StatusDot
              variant={COMMENT_DRAFT_DOT_VARIANTS[draftStatus]}
              label={COMMENT_DRAFT_STATUS_LABELS[draftStatus]}
              isPulsing={draftStatus === "sending"}
              aria-hidden="true"
            />
            <Text type="supporting">
              Trạng thái nháp: {COMMENT_DRAFT_STATUS_LABELS[draftStatus]}
            </Text>
          </HStack>
        ) : null}

        {/* Flagged reasons callout from AI (hidden once comment is already replied; polite status, never alert) */}
        {!gate.isAlreadyReplied &&
        comment.draft?.status === "flagged" &&
        comment.draft.reasons.length > 0 ? (
          <Banner
            role="status"
            aria-live="polite"
            status="warning"
            title="AI đánh dấu cần nhân viên kiểm tra"
            description="AI không tự viết trả lời cho bình luận này. Xem lý do bên dưới rồi tự soạn câu trả lời nếu phù hợp."
            defaultIsExpanded
          >
            <Stack as="ul" role="list" direction="vertical" gap={1}>
              {comment.draft.reasons.map((reason, idx) => (
                <Stack as="li" key={`${reason.field}-${idx}`} direction="vertical" gap={0}>
                  <Text type="supporting">
                    {reason.field}: {reason.issue}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </Banner>
        ) : null}

        {/* Send conflict (409) */}
        {isConflictSend ? (
          <Banner
            role="alert"
            status="warning"
            title={
              comment.canComment
                ? "Bình luận này đã được trả lời"
                : "Không thể trả lời bình luận này"
            }
            description={
              sendError?.userMessage ??
              "Bình luận này đã được trả lời. Danh sách đang được làm mới."
            }
          />
        ) : null}

        {/* Non-422, non-409 send error (permission / 401 / 429 / 502 / network) */}
        {sendError && !isConflictSend && blockedFromSend.length === 0 ? (
          <CommentErrorNotice
            error={sendError}
            shouldFocus={false}
            titleOverride="Gửi trả lời lên Facebook thất bại"
          />
        ) : null}

        {/* Persisted failed state from an earlier attempt */}
        {isPersistedPermissionFailure ? (
          <PermissionMissingNotice
            description={comment.draft?.userMessage ?? undefined}
          />
        ) : isPersistedFailure ? (
          <Banner
            role="alert"
            status="error"
            title={
              isPersistedRateLimitFailure
                ? "Lần gửi trước bị Facebook giới hạn tần suất"
                : "Lần gửi trước thất bại"
            }
            description={
              isPersistedRateLimitFailure
                ? `${comment.draft?.userMessage ?? "Facebook tạm chặn bình luận do gửi quá nhanh."} Vui lòng chờ một lát rồi kiểm tra và gửi lại.`
                : (comment.draft?.userMessage ??
                  "Gửi trả lời lên Facebook không thành công. Kiểm tra nội dung rồi thử gửi lại.")
            }
            defaultIsExpanded={Boolean(comment.draft?.errorCode)}
          >
            {comment.draft?.errorCode ? (
              <Text type="code" color="secondary">
                Mã lỗi: {comment.draft.errorCode}
              </Text>
            ) : null}
          </Banner>
        ) : null}

        {/* Draft generation / save API error */}
        {draftError ? (
          <CommentErrorNotice error={draftError} shouldFocus={false} />
        ) : null}

        {/* Cannot comment notice */}
        {!comment.canComment ? (
          <Text type="supporting" color="secondary">
            Facebook đã khoá trả lời trên bình luận này.
          </Text>
        ) : null}

        {/* Editable reply box (hidden once already replied) */}
        {!gate.isAlreadyReplied ? (
          <>
            <TextArea
              label="Nội dung trả lời"
              aria-label={`Nội dung trả lời cho ${rowContext}`}
              value={text}
              onChange={handleTextChange}
              onBlur={handleBlur}
              rows={3}
              maxLength={COMMENT_REPLY_MAX_LENGTH}
              placeholder="Bấm “Tạo nháp AI” hoặc tự nhập câu trả lời cho khách…"
              isDisabled={!gate.canEdit}
              disabledMessage={gate.editDisabledReason ?? undefined}
              isLoading={isGenerating || isSaving}
              status={textAreaStatus}
              statusVariant="detached"
              width="100%"
            />

            {/* Keep warnings visible even while blocking errors occupy the field status (polite status, never alert) */}
            {blockReasons.length > 0 && warnings.length > 0 ? (
              <Banner
                role="status"
                aria-live="polite"
                status="warning"
                title="Lưu ý thêm"
                description={warnings.join(" · ")}
              />
            ) : null}

            <HStack ref={actionsRowRef} gap={2} align="center" wrap="wrap">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-composer-action="generate"
                icon={<Sparkles aria-hidden="true" />}
                label={`${isGenerating ? "Đang tạo nháp AI" : "Tạo nháp AI"} cho ${rowContext}`}
                isLoading={isGenerating}
                isDisabled={!gate.canGenerateDraft}
                tooltip={gate.generateDisabledReason ?? undefined}
                onPointerDown={markActionPointerDown}
                onMouseDown={markActionPointerDown}
                onClick={handleGenerateClick}
              >
                {isGenerating ? "Đang tạo nháp AI…" : "Tạo nháp AI"}
              </Button>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-composer-action="save"
                icon={<Save aria-hidden="true" />}
                label={`${isSaving ? "Đang lưu nháp" : "Lưu nháp"} cho ${rowContext}`}
                isLoading={isSaving}
                isDisabled={!gate.canSaveDraft}
                tooltip={gate.saveDisabledReason ?? undefined}
                onPointerDown={markActionPointerDown}
                onMouseDown={markActionPointerDown}
                onClick={handleSaveClick}
              >
                {isSaving ? "Đang lưu nháp…" : "Lưu nháp"}
              </Button>

              <Button
                type="button"
                variant="primary"
                size="sm"
                data-composer-action="send"
                icon={<Send aria-hidden="true" />}
                label={`${
                  gate.isSendingNow
                    ? "Đang gửi lên Facebook"
                    : "Duyệt & gửi trả lời (Gửi lên Facebook)"
                } cho ${rowContext}`}
                isLoading={gate.isSendingNow}
                isDisabled={!gate.canSendReply}
                tooltip={gate.sendDisabledReason ?? undefined}
                onPointerDown={markActionPointerDown}
                onMouseDown={markActionPointerDown}
                onClick={handleSendClick}
              >
                {gate.isSendingNow
                  ? "Đang gửi lên Facebook…"
                  : "Duyệt & gửi trả lời (Gửi lên Facebook)"}
              </Button>
            </HStack>
          </>
        ) : (
          <Text type="supporting" color="secondary">
            Bình luận này đã có câu trả lời trên Facebook.
          </Text>
        )}
      </Stack>
    </Section>
  );
}
