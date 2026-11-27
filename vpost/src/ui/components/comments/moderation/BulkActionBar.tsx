"use client";

import {
  AlertDialog,
  Banner,
  Button,
  Card,
  CheckboxInput,
  HStack,
  Stack,
  StackItem,
  Text,
  Token,
} from "@astryxdesign/core";
import { Eye, EyeOff, Slash, Trash2, X } from "lucide-react";
import { useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { useBulkCommentsAction } from "@/ui/hooks/useModeration";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import {
  BULK_SELECTION_MAX,
  type BulkCommentAction,
  type BulkCommentsResponse,
} from "@/ui/schemas/moderation.schema";
import type { RunBulkCommentActionParams } from "@/ui/services/moderation.api";

import {
  BULK_DELETE_CONFIRM_DESCRIPTION,
  buildConfirmedBulkDeleteRequest,
  buildNonDeleteBulkRequest,
  describeBulkItemFailure,
  evaluateBulkActionGate,
  extractFailedBulkItems,
  formatBulkDeleteConfirmTitle,
  formatBulkResultSummary,
  formatNotProcessedNotice,
  hasRateLimitStop,
} from "./bulk-action-state";

export interface BulkPageSelectionControl {
  readonly checkboxValue: boolean | "indeterminate";
  readonly totalOnPage: number;
  readonly selectedOnPageCount: number;
  readonly onToggleAllOnPage: () => void;
}

export interface BulkActionBarViewProps {
  readonly selectedIds: readonly string[];
  readonly maxSelection?: number;
  readonly cappedAtMax?: boolean;
  readonly pageSelection?: BulkPageSelectionControl;
  readonly readOnlyReason: string | null;
  readonly isPending: boolean;
  readonly activeAction: BulkCommentAction | null;
  readonly lastAction: BulkCommentAction | null;
  readonly lastResult: BulkCommentsResponse | null;
  readonly error: unknown;
  readonly isDeleteDialogOpen: boolean;
  readonly commentLabelsById?: Readonly<Record<string, string | undefined>>;
  readonly onClearSelection: () => void;
  readonly onTriggerAction: (action: Exclude<BulkCommentAction, "delete">) => void;
  readonly onRequestDeleteConfirm: () => void;
  readonly onCancelDeleteConfirm: () => void;
  readonly onConfirmDelete: () => void;
  readonly onDismissResult: () => void;
  readonly onRetryError?: () => void;
}

/**
 * Presentational bulk moderation toolbar covering selection count, actions
 * (`Ẩn`, `Hiện lại`, `Bỏ qua`, `Xoá`), mandatory delete confirmation dialog,
 * polite live-region summary, per-item failure list, rate-limit `notProcessed`
 * stop notice, and read-only disabled state.
 */
export function BulkActionBarView({
  selectedIds,
  maxSelection = BULK_SELECTION_MAX,
  cappedAtMax = false,
  pageSelection,
  readOnlyReason,
  isPending,
  activeAction,
  lastAction,
  lastResult,
  error,
  isDeleteDialogOpen,
  commentLabelsById,
  onClearSelection,
  onTriggerAction,
  onRequestDeleteConfirm,
  onCancelDeleteConfirm,
  onConfirmDelete,
  onDismissResult,
  onRetryError,
}: BulkActionBarViewProps) {
  const selectedCount = selectedIds.length;
  const gate = evaluateBulkActionGate({
    selectedCount,
    isPending,
    readOnlyReason,
  });

  const failedItems = lastResult ? extractFailedBulkItems(lastResult) : [];
  const rateLimited = lastResult ? hasRateLimitStop(lastResult) : false;
  const notProcessed = lastResult?.notProcessed ?? [];
  const summaryText =
    lastResult && lastAction ? formatBulkResultSummary(lastAction, lastResult) : null;

  const showToolbar = selectedCount > 0 || pageSelection !== undefined;

  return (
    <Stack direction="vertical" gap={2} data-moderation="bulk-action-bar">
      {showToolbar ? (
        <Card elevation={selectedCount > 0 ? "med" : "none"} padding={3}>
          <Stack direction="vertical" gap={2}>
            <HStack gap={3} align="center" justify="between" wrap="wrap">
              <HStack gap={3} align="center" wrap="wrap">
                {pageSelection ? (
                  <CheckboxInput
                    label="Chọn tất cả trên trang này"
                    size="sm"
                    value={pageSelection.checkboxValue}
                    isDisabled={pageSelection.totalOnPage === 0 || isPending}
                    disabledMessage={
                      isPending
                        ? "Đang xử lý thao tác hàng loạt…"
                        : pageSelection.totalOnPage === 0
                          ? "Không có bình luận nào trên trang hiện tại."
                          : undefined
                    }
                    onChange={() => pageSelection.onToggleAllOnPage()}
                  />
                ) : null}

                {selectedCount > 0 ? (
                  <HStack gap={2} align="center" wrap="wrap">
                    <Token
                      label={`Đã chọn ${selectedCount} bình luận`}
                      color="blue"
                      size="sm"
                    />
                    {cappedAtMax || selectedCount >= maxSelection ? (
                      <Text type="supporting" color="secondary">
                        Tối đa {maxSelection} bình luận mỗi lượt.
                      </Text>
                    ) : null}
                  </HStack>
                ) : (
                  <Text type="supporting" color="secondary">
                    Chọn bình luận để thao tác hàng loạt (tối đa {maxSelection}).
                  </Text>
                )}
              </HStack>

              {selectedCount > 0 ? (
                <HStack gap={2} align="center" wrap="wrap">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<EyeOff aria-hidden="true" />}
                    label={
                      isPending && activeAction === "hide" ? "Đang ẩn…" : "Ẩn"
                    }
                    isLoading={isPending && activeAction === "hide"}
                    isDisabled={!gate.canAct}
                    tooltip={gate.disabledReason ?? undefined}
                    onClick={() => onTriggerAction("hide")}
                  />

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Eye aria-hidden="true" />}
                    label={
                      isPending && activeAction === "unhide"
                        ? "Đang hiện lại…"
                        : "Hiện lại"
                    }
                    isLoading={isPending && activeAction === "unhide"}
                    isDisabled={!gate.canAct}
                    tooltip={gate.disabledReason ?? undefined}
                    onClick={() => onTriggerAction("unhide")}
                  />

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Slash aria-hidden="true" />}
                    label={
                      isPending && activeAction === "ignore"
                        ? "Đang bỏ qua…"
                        : "Bỏ qua"
                    }
                    isLoading={isPending && activeAction === "ignore"}
                    isDisabled={!gate.canAct}
                    tooltip={gate.disabledReason ?? undefined}
                    onClick={() => onTriggerAction("ignore")}
                  />

                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    icon={<Trash2 aria-hidden="true" />}
                    label={
                      isPending && activeAction === "delete" ? "Đang xoá…" : "Xoá"
                    }
                    isLoading={isPending && activeAction === "delete"}
                    isDisabled={!gate.canDelete}
                    tooltip={gate.disabledReason ?? undefined}
                    onClick={onRequestDeleteConfirm}
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={<X aria-hidden="true" />}
                    label="Bỏ chọn"
                    isDisabled={isPending}
                    onClick={onClearSelection}
                  />
                </HStack>
              ) : null}
            </HStack>

            {selectedCount > 0 ? <ReadOnlyNotice reason={readOnlyReason} /> : null}
          </Stack>
        </Card>
      ) : null}

      {/* Top-level bulk API failure */}
      {error ? (
        <ApiErrorNotice
          error={error}
          shouldFocus={false}
          onRetry={onRetryError}
        />
      ) : null}

      {/* Polite live region for bulk action outcome, failures, and rate-limit stop */}
      <Stack role="status" aria-live="polite" direction="vertical" gap={2}>
        {summaryText && lastResult ? (
          <Banner
            status={failedItems.length > 0 || rateLimited ? "warning" : "success"}
            title={summaryText}
            description={
              failedItems.length > 0 && notProcessed.length === 0
                ? "Các bình luận thất bại vẫn được giữ chọn để bạn kiểm tra lại."
                : undefined
            }
            isDismissable
            onDismiss={onDismissResult}
            defaultIsExpanded={failedItems.length > 0}
          >
            {failedItems.length > 0 ? (
              <Stack direction="vertical" gap={2}>
                <Text type="label">
                  Danh sách bình luận thất bại ({failedItems.length})
                </Text>
                <Stack as="ul" role="list" direction="vertical" gap={1.5}>
                  {failedItems.map((item) => {
                    const customLabel = commentLabelsById?.[item.id];
                    return (
                      <Stack
                        as="li"
                        key={item.id}
                        direction="vertical"
                        gap={0.5}
                      >
                        <HStack gap={2} align="center" wrap="wrap">
                          <Text type="code">{item.id}</Text>
                          {customLabel ? (
                            <Text type="supporting" color="secondary">
                              {customLabel}
                            </Text>
                          ) : null}
                          {item.code ? (
                            <Token label={item.code} color="red" size="sm" />
                          ) : null}
                        </HStack>
                        <Text type="supporting">
                          {describeBulkItemFailure(item)}
                        </Text>
                      </Stack>
                    );
                  })}
                </Stack>
              </Stack>
            ) : null}
          </Banner>
        ) : null}

        {notProcessed.length > 0 ? (
          <Banner
            status="warning"
            title={`Dừng sớm — còn ${notProcessed.length} bình luận chưa được xử lý`}
            description={formatNotProcessedNotice(notProcessed.length)}
            defaultIsExpanded
          >
            <Stack direction="vertical" gap={1}>
              <Text type="supporting" color="secondary">
                Các mã bình luận chưa xử lý:
              </Text>
              <HStack gap={1.5} wrap="wrap">
                {notProcessed.map((id) => (
                  <StackItem key={id}>
                    <Token label={id} color="orange" size="sm" />
                  </StackItem>
                ))}
              </HStack>
            </Stack>
          </Banner>
        ) : null}
      </Stack>

      {/* Mandatory confirmation dialog before permanent Facebook delete */}
      {isDeleteDialogOpen && selectedCount > 0 && readOnlyReason === null ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open && !isPending) {
              onCancelDeleteConfirm();
            }
          }}
          title={formatBulkDeleteConfirmTitle(selectedCount)}
          description={BULK_DELETE_CONFIRM_DESCRIPTION}
          cancelLabel="Huỷ"
          actionLabel={`Xoá vĩnh viễn ${selectedCount} bình luận`}
          actionVariant="destructive"
          isActionLoading={isPending && activeAction === "delete"}
          onAction={onConfirmDelete}
        />
      ) : null}
    </Stack>
  );
}

export interface BulkActionBarProps {
  /** Currently selected comment IDs (max 50). */
  readonly selectedIds: readonly string[];
  readonly maxSelection?: number;
  readonly cappedAtMax?: boolean;
  /** Optional "Chọn tất cả trên trang này" control embedded in the bar. */
  readonly pageSelection?: BulkPageSelectionControl;
  readonly onClearSelection: () => void;
  /** Invoked after a bulk run succeeds so the caller can keep failed/unprocessed items selected. */
  readonly onBulkResult?: (
    response: BulkCommentsResponse,
    action: BulkCommentAction,
  ) => void;
  readonly commentLabelsById?: Readonly<Record<string, string | undefined>>;
  /** Optional override for read-only reason (defaults to `useReadOnlyReason()`). */
  readonly readOnlyReason?: string | null;
  /** Optional custom mutation runner (defaults to `useBulkCommentsAction`). */
  readonly onExecute?: (
    params: RunBulkCommentActionParams,
  ) => Promise<BulkCommentsResponse>;
}

/**
 * Connected bulk moderation bar ready to mount into `CommentsScreen`.
 * Sends `confirm: true` ONLY from the delete confirmation dialog's `onAction`.
 */
export function BulkActionBar({
  selectedIds,
  maxSelection = BULK_SELECTION_MAX,
  cappedAtMax = false,
  pageSelection,
  onClearSelection,
  onBulkResult,
  commentLabelsById,
  readOnlyReason: readOnlyReasonProp,
  onExecute,
}: BulkActionBarProps) {
  const hookReadOnlyReason = useReadOnlyReason();
  const readOnlyReason =
    readOnlyReasonProp !== undefined ? readOnlyReasonProp : hookReadOnlyReason;
  const bulkMutation = useBulkCommentsAction();

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<BulkCommentAction | null>(null);
  const [lastAction, setLastAction] = useState<BulkCommentAction | null>(null);
  const [lastResult, setLastResult] = useState<BulkCommentsResponse | null>(null);
  const [customPending, setCustomPending] = useState(false);
  const [customError, setCustomError] = useState<unknown>(null);

  const isPending = onExecute ? customPending : bulkMutation.isPending;
  const error = onExecute ? customError : bulkMutation.error;

  async function dispatch(payload: RunBulkCommentActionParams) {
    if (readOnlyReason !== null) return;
    setActiveAction(payload.action);
    setLastResult(null);
    setCustomError(null);
    if (!onExecute) {
      bulkMutation.reset();
    }

    try {
      if (onExecute) {
        setCustomPending(true);
      }
      const response = onExecute
        ? await onExecute(payload)
        : await bulkMutation.mutateAsync(payload);

      setLastAction(payload.action);
      setLastResult(response);
      onBulkResult?.(response, payload.action);
    } catch (caught) {
      if (onExecute) {
        setCustomError(caught);
      }
    } finally {
      setCustomPending(false);
      setActiveAction(null);
      if (payload.action === "delete") {
        setIsDeleteDialogOpen(false);
      }
    }
  }

  function handleNonDeleteAction(action: Exclude<BulkCommentAction, "delete">) {
    if (readOnlyReason !== null || isPending) return;
    const payload = buildNonDeleteBulkRequest(selectedIds, action);
    if (!payload) return;
    void dispatch(payload);
  }

  function handleRequestDeleteConfirm() {
    if (readOnlyReason !== null || isPending || selectedIds.length === 0) return;
    // Opening the confirmation dialog never fires any API request.
    setIsDeleteDialogOpen(true);
  }

  function handleConfirmDelete() {
    if (readOnlyReason !== null || isPending) return;
    const payload = buildConfirmedBulkDeleteRequest(selectedIds, true);
    if (!payload) return;
    void dispatch(payload);
  }

  const retryAction =
    lastAction && lastAction !== "delete" && !isPending && readOnlyReason === null
      ? () => handleNonDeleteAction(lastAction)
      : undefined;

  return (
    <BulkActionBarView
      selectedIds={selectedIds}
      maxSelection={maxSelection}
      cappedAtMax={cappedAtMax}
      pageSelection={pageSelection}
      readOnlyReason={readOnlyReason}
      isPending={isPending}
      activeAction={activeAction}
      lastAction={lastAction}
      lastResult={lastResult}
      error={error}
      isDeleteDialogOpen={isDeleteDialogOpen}
      commentLabelsById={commentLabelsById}
      onClearSelection={onClearSelection}
      onTriggerAction={handleNonDeleteAction}
      onRequestDeleteConfirm={handleRequestDeleteConfirm}
      onCancelDeleteConfirm={() => setIsDeleteDialogOpen(false)}
      onConfirmDelete={handleConfirmDelete}
      onDismissResult={() => setLastResult(null)}
      onRetryError={retryAction}
    />
  );
}
