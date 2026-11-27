import {
  Button,
  Divider,
  HStack,
  Link,
  Section,
  Stack,
  StackItem,
  StatusDot,
  Text,
  Token,
  VisuallyHidden,
} from "@astryxdesign/core";
import { Eye, EyeOff, RotateCcw, Slash } from "lucide-react";
import type { ReactNode } from "react";

import { evaluateComposerGate } from "@/ui/components/comments/comment-composer-state";
import { CommentErrorNotice } from "@/ui/components/comments/CommentErrorNotice";
import { CommentReplyComposer } from "@/ui/components/comments/CommentReplyComposer";
import { ModerationBadge } from "@/ui/components/comments/moderation/ModerationBadge";
import {
  COMMENT_STATUS_DOT_VARIANTS,
  COMMENT_STATUS_LABELS,
  displayCommentAuthor,
  formatCommentAbsoluteTime,
  formatCommentAccessibleContext,
  formatCommentRelativeTime,
  toSafeFacebookUrl,
  type CommentCheck,
  type CommentItem,
} from "@/ui/schemas/comment.schema";
import {
  MODERATION_CATEGORY_LABELS,
  MODERATION_SOURCE_LABELS,
} from "@/ui/schemas/moderation.schema";
import type { ApiError } from "@/ui/services/api-error";

const CAPTION_EXCERPT_LIMIT = 160;

function excerptCaption(caption: string): string {
  const cleaned = caption.replace(/\s+/g, " ").trim();
  if (cleaned.length <= CAPTION_EXCERPT_LIMIT) return cleaned;
  return `${cleaned.slice(0, CAPTION_EXCERPT_LIMIT).trimEnd()}…`;
}

export interface CommentRowProps {
  comment: CommentItem;
  nowMs: number;
  readOnlyReason: string | null;
  /** Optional leading slot (e.g. a future selection checkbox for bulk actions). */
  leadingSlot?: ReactNode;
  showDivider?: boolean;
  isGenerating: boolean;
  isSaving: boolean;
  isSending: boolean;
  isTogglingIgnore: boolean;
  isTogglingHide: boolean;
  checkResult: CommentCheck | null;
  draftError: ApiError | null;
  sendError: ApiError | null;
  rowActionError: ApiError | null;
  successMessage?: string | null;
  onGenerateDraft: () => void;
  onSaveDraft: (text: string) => void;
  onSendReply: (text: string) => void;
  onTextEdited?: () => void;
  onIgnore: () => void;
  onUnignore: () => void;
  onToggleHide: (hidden: boolean) => void;
}

/**
 * Single customer comment row inside the inbox list.
 * Structured as a real list item (`<li>`) with an optional `leadingSlot` so a
 * later task can add row selection without rewriting the row.
 */
export function CommentRow({
  comment,
  nowMs,
  readOnlyReason,
  leadingSlot,
  showDivider = false,
  isGenerating,
  isSaving,
  isSending,
  isTogglingIgnore,
  isTogglingHide,
  checkResult,
  draftError,
  sendError,
  rowActionError,
  successMessage = null,
  onGenerateDraft,
  onSaveDraft,
  onSendReply,
  onTextEdited,
  onIgnore,
  onUnignore,
  onToggleHide,
}: CommentRowProps) {
  const author = displayCommentAuthor(comment.fromName);
  const rowContext = formatCommentAccessibleContext(comment);
  const absoluteTime = formatCommentAbsoluteTime(comment.createdAt);
  const relativeTime = formatCommentRelativeTime(comment.createdAt, nowMs);
  const captionExcerpt = excerptCaption(comment.postCaption);
  const isRowActionPending = isTogglingIgnore || isTogglingHide;

  const safePermalinkUrl = toSafeFacebookUrl(comment.permalinkUrl);
  const rawPermalinkText = comment.permalinkUrl?.trim() ?? "";
  const safePostUrl = toSafeFacebookUrl(comment.postUrl);
  const rawPostUrlText = comment.postUrl?.trim() ?? "";

  const gate = evaluateComposerGate({
    text: comment.draft?.text ?? "",
    commentStatus: comment.status,
    canComment: comment.canComment,
    draftStatus: comment.draft?.status ?? null,
    blockReasons: [],
    isGenerating,
    isSaving,
    isSending,
    isRowActionPending,
    readOnlyReason,
  });

  const isIgnored = comment.status === "ignored";
  const hideActionLabel = comment.isHidden ? "Hiện lại" : "Ẩn bình luận";
  const moderationReasons = comment.moderation?.action
    ? comment.moderation.reasons
        .map((reason) => reason.trim())
        .filter((reason) => reason.length > 0)
    : [];

  return (
    <Stack
      as="li"
      data-row="comment"
      aria-label={`Bình luận của ${rowContext}`}
      direction="vertical"
      gap={0}
      padding={0}
    >
      <Stack direction="vertical" gap={3} padding={4}>
        <HStack gap={3} align="start">
          {leadingSlot ? leadingSlot : null}

          <StackItem size="fill">
            <Stack direction="vertical" gap={3}>
              {/* Author, timestamp, status, and row-level actions */}
              <HStack gap={3} align="start" justify="between" wrap="wrap">
                <Stack direction="vertical" gap={1}>
                  <HStack gap={2} align="center" wrap="wrap">
                    <Text>{author}</Text>

                    <HStack gap={1} align="center">
                      <StatusDot
                        variant={COMMENT_STATUS_DOT_VARIANTS[comment.status]}
                        label={COMMENT_STATUS_LABELS[comment.status]}
                        aria-hidden="true"
                      />
                      <Text type="supporting">{COMMENT_STATUS_LABELS[comment.status]}</Text>
                    </HStack>

                    {comment.isHidden ? (
                      <Token label="Đã ẩn" color="gray" size="sm" />
                    ) : null}

                    <ModerationBadge moderation={comment.moderation} />

                    <Text type="supporting" color="secondary">
                      <time dateTime={comment.createdAt} title={absoluteTime}>
                        {relativeTime ? `${relativeTime} · ${absoluteTime}` : absoluteTime}
                      </time>
                    </Text>
                  </HStack>

                  <HStack gap={2} align="center" wrap="wrap">
                    <Text type="supporting" color="secondary">
                      {comment.channelName}
                    </Text>

                    {comment.productCode ? (
                      <Token label={comment.productCode} size="sm" />
                    ) : null}

                    {safePermalinkUrl ? (
                      <Link
                        href={safePermalinkUrl}
                        isExternalLink
                        newTabLabel="(mở ở tab mới)"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Xem trên Facebook
                        <VisuallyHidden> — bình luận của {rowContext}</VisuallyHidden>
                      </Link>
                    ) : rawPermalinkText.length > 0 ? (
                      <Text type="supporting" color="secondary">
                        {rawPermalinkText}
                      </Text>
                    ) : null}
                  </HStack>
                </Stack>

                <HStack gap={2} align="center" wrap="wrap">
                  {isIgnored ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      icon={<RotateCcw aria-hidden="true" />}
                      label={`${isTogglingIgnore ? "Đang khôi phục" : "Khôi phục"} bình luận của ${rowContext}`}
                      isLoading={isTogglingIgnore}
                      isDisabled={!gate.canIgnoreToggle}
                      tooltip={gate.rowActionDisabledReason ?? undefined}
                      onClick={onUnignore}
                    >
                      {isTogglingIgnore ? "Đang khôi phục…" : "Khôi phục"}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={<Slash aria-hidden="true" />}
                      label={`${isTogglingIgnore ? "Đang bỏ qua" : "Bỏ qua"} bình luận của ${rowContext}`}
                      isLoading={isTogglingIgnore}
                      isDisabled={!gate.canIgnoreToggle}
                      tooltip={gate.rowActionDisabledReason ?? undefined}
                      onClick={onIgnore}
                    >
                      {isTogglingIgnore ? "Đang bỏ qua…" : "Bỏ qua"}
                    </Button>
                  )}

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={
                      comment.isHidden ? (
                        <Eye aria-hidden="true" />
                      ) : (
                        <EyeOff aria-hidden="true" />
                      )
                    }
                    label={`${isTogglingHide ? "Đang cập nhật" : hideActionLabel} — ${rowContext}`}
                    isLoading={isTogglingHide}
                    isDisabled={!gate.canHideToggle}
                    tooltip={gate.rowActionDisabledReason ?? undefined}
                    onClick={() => onToggleHide(!comment.isHidden)}
                  >
                    {isTogglingHide ? "Đang cập nhật…" : hideActionLabel}
                  </Button>
                </HStack>
              </HStack>

              {/* Customer comment body */}
              {comment.message.trim().length > 0 ? (
                <Text>{comment.message}</Text>
              ) : (
                <Text type="supporting" color="secondary">
                  (Bình luận không có nội dung chữ — xem ảnh hoặc nhãn dán trên Facebook)
                </Text>
              )}

              {/* Automated moderation details (category, source, confidence, reasons) */}
              {comment.moderation?.action && moderationReasons.length > 0 ? (
                <Text
                  type="supporting"
                  color="secondary"
                  data-moderation-details={comment.moderation.action}
                >
                  Kiểm duyệt ({MODERATION_CATEGORY_LABELS[comment.moderation.category]} ·{" "}
                  {MODERATION_SOURCE_LABELS[comment.moderation.source]}{" "}
                  {Math.round(comment.moderation.confidence * 100)}%):{" "}
                  {moderationReasons.join("; ")}
                </Text>
              ) : null}

              {/* Post context excerpt */}
              {captionExcerpt || rawPostUrlText.length > 0 ? (
                <HStack gap={2} align="center" wrap="wrap">
                  {captionExcerpt ? (
                    <Text type="supporting" color="secondary">
                      Bài viết: {captionExcerpt}
                    </Text>
                  ) : null}
                  {safePostUrl ? (
                    <Link
                      href={safePostUrl}
                      isExternalLink
                      newTabLabel="(mở ở tab mới)"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Mở bài viết
                      <VisuallyHidden>
                        {" "}
                        — {comment.productCode ? `sản phẩm ${comment.productCode}, ` : ""}bình luận của{" "}
                        {rowContext}
                      </VisuallyHidden>
                    </Link>
                  ) : rawPostUrlText.length > 0 ? (
                    <Text type="supporting" color="secondary">
                      {rawPostUrlText}
                    </Text>
                  ) : null}
                </HStack>
              ) : null}

              {/* Per-row action success feedback */}
              {successMessage ? (
                <Text type="supporting" color="secondary" role="status" aria-live="polite">
                  {successMessage}
                </Text>
              ) : null}

              {/* Row-level action error (hide / ignore) */}
              {rowActionError ? (
                <CommentErrorNotice
                  error={rowActionError}
                  shouldFocus={false}
                  titleOverride="Không cập nhật được bình luận"
                />
              ) : null}

              {/* Existing Page replies */}
              {comment.pageReplies.length > 0 ? (
                <Section variant="section" padding={3} dividers={["start"]}>
                  <Stack direction="vertical" gap={2}>
                    <Text type="supporting" color="secondary">
                      Trả lời của Page ({comment.pageReplies.length})
                    </Text>
                    <Stack as="ul" role="list" direction="vertical" gap={2}>
                      {comment.pageReplies.map((reply) => {
                        const replyAbs = formatCommentAbsoluteTime(reply.createdAt);
                        const replyRel = formatCommentRelativeTime(reply.createdAt, nowMs);
                        return (
                          <Stack as="li" key={reply.id} direction="vertical" gap={0.5}>
                            <Text>{reply.message}</Text>
                            <Text type="supporting" color="secondary">
                              <time dateTime={reply.createdAt} title={replyAbs}>
                                {replyRel ? `${replyRel} · ${replyAbs}` : replyAbs}
                              </time>
                            </Text>
                          </Stack>
                        );
                      })}
                    </Stack>
                  </Stack>
                </Section>
              ) : null}

              {/* Reply composer */}
              {!isIgnored ? (
                <CommentReplyComposer
                  comment={comment}
                  readOnlyReason={readOnlyReason}
                  isGenerating={isGenerating}
                  isSaving={isSaving}
                  isSending={isSending}
                  isRowActionPending={isRowActionPending}
                  checkResult={checkResult}
                  draftError={draftError}
                  sendError={sendError}
                  onGenerateDraft={onGenerateDraft}
                  onSaveDraft={onSaveDraft}
                  onSendReply={onSendReply}
                  onTextEdited={onTextEdited}
                />
              ) : null}
            </Stack>
          </StackItem>
        </HStack>
      </Stack>
      {showDivider ? <Divider /> : null}
    </Stack>
  );
}
