"use client";

import {
  Badge,
  Banner,
  Button,
  HStack,
  Heading,
  Selector,
  Skeleton,
  Stack,
  StatusDot,
  Table,
  Text,
  Token,
  pixel,
  proportional,
  type TableColumn,
} from "@astryxdesign/core";
import { Eye, History, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useModerationLog, useUndoModerationHide } from "@/ui/hooks/useModeration";
import { useNowMs } from "@/ui/hooks/useNowMs";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import {
  formatCommentAbsoluteTime,
  formatCommentRelativeTime,
} from "@/ui/schemas/comment.schema";
import {
  DEFAULT_MODERATION_LOG_FILTER,
  MODERATION_CATEGORY_LABELS,
  MODERATION_LOG_ACTIONS,
  MODERATION_LOG_ACTION_LABELS,
  MODERATION_LOG_ACTORS,
  MODERATION_LOG_ACTOR_LABELS,
  MODERATION_LOG_DEFAULT_LIMIT,
  MODERATION_LOG_RESULT_DOT_VARIANTS,
  MODERATION_LOG_RESULT_LABELS,
  type ModerationLogAction,
  type ModerationLogActor,
  type ModerationLogEntry,
  type ModerationLogFilter,
} from "@/ui/schemas/moderation.schema";

import { describeBulkItemFailure } from "./bulk-action-state";
import {
  evaluateUndoLogEntryGate,
  hasActiveModerationLogFilters,
  resolveModerationLogEmptyKind,
} from "./log-state";

const ALL_VALUE = "__all__";
const SKELETON_ROWS = 5;

const ACTION_FILTER_OPTIONS = [
  { value: ALL_VALUE, label: "Tất cả hành động" },
  ...MODERATION_LOG_ACTIONS.map((action) => ({
    value: action,
    label: MODERATION_LOG_ACTION_LABELS[action],
  })),
];

const ACTOR_FILTER_OPTIONS = [
  { value: ALL_VALUE, label: "Tất cả nguồn" },
  ...MODERATION_LOG_ACTORS.map((actor) => ({
    value: actor,
    label: MODERATION_LOG_ACTOR_LABELS[actor],
  })),
];

const ACTION_BADGE_VARIANTS: Record<
  ModerationLogAction,
  "error" | "info" | "warning" | "neutral" | "success"
> = {
  hide: "warning",
  unhide: "success",
  delete: "error",
  ignore: "neutral",
  unignore: "info",
  would_hide: "info",
};

interface ModerationLogTableRow extends Record<string, unknown> {
  readonly id: string;
  readonly entry: ModerationLogEntry;
}

export function ModerationLogSkeleton() {
  return (
    <Stack direction="vertical" gap={2} aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <HStack key={row} gap={3} align="center" paddingBlock={2}>
          <Skeleton width={120} height={16} index={row} />
          <Skeleton width={88} height={22} index={row} />
          <Skeleton width={80} height={16} index={row} />
          <Skeleton width={140} height={16} index={row} />
          <Skeleton width="35%" height={16} index={row} />
          <Skeleton width={88} height={28} index={row} />
        </HStack>
      ))}
    </Stack>
  );
}

export interface ModerationLogViewProps {
  readonly isFirstLoad: boolean;
  readonly showSkeleton: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly items: readonly ModerationLogEntry[];
  readonly filter: ModerationLogFilter;
  readonly nowMs: number;
  readonly readOnlyReason: string | null;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly undoingCommentId: string | null;
  readonly undoStatusMessage: string | null;
  readonly undoErrorMessage: string | null;
  readonly undoApiError: unknown;
  readonly pageNameById?: Readonly<Record<string, string | undefined>>;
  readonly onFilterChange: (next: ModerationLogFilter) => void;
  readonly onClearFilters: () => void;
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
  readonly onUndoHide: (commentId: string) => void;
  readonly onDismissUndoStatus: () => void;
  readonly onDismissUndoError: () => void;
}

/**
 * Presentational moderation audit log view covering filters (`action`, `actor`),
 * loading skeleton, empty states, API error, paged table with headers, and
 * undo ("Hiện lại") via bulk unhide.
 */
export function ModerationLogView({
  isFirstLoad,
  showSkeleton,
  isFetching,
  isError,
  error,
  items,
  filter,
  nowMs,
  readOnlyReason,
  hasNextPage,
  isFetchingNextPage,
  undoingCommentId,
  undoStatusMessage,
  undoErrorMessage,
  undoApiError,
  pageNameById,
  onFilterChange,
  onClearFilters,
  onRefresh,
  onLoadMore,
  onUndoHide,
  onDismissUndoStatus,
  onDismissUndoError,
}: ModerationLogViewProps) {
  const hasFilters = hasActiveModerationLogFilters(filter);

  const tableData: ModerationLogTableRow[] = useMemo(
    () => items.map((entry) => ({ id: entry.id, entry })),
    [items],
  );

  const columns: TableColumn<ModerationLogTableRow>[] = useMemo(
    () => [
      {
        key: "createdAt",
        header: "Thời gian",
        width: pixel(150),
        renderCell: (row) => {
          const abs = formatCommentAbsoluteTime(row.entry.createdAt);
          const rel = formatCommentRelativeTime(row.entry.createdAt, nowMs);
          return (
            <Text type="supporting" color="secondary">
              <time dateTime={row.entry.createdAt} title={abs}>
                {rel ? `${rel} · ${abs}` : abs}
              </time>
            </Text>
          );
        },
      },
      {
        key: "action",
        header: "Hành động",
        width: pixel(135),
        renderCell: (row) => (
          <Badge
            variant={ACTION_BADGE_VARIANTS[row.entry.action]}
            label={MODERATION_LOG_ACTION_LABELS[row.entry.action]}
          />
        ),
      },
      {
        key: "actor",
        header: "Nguồn",
        width: pixel(105),
        renderCell: (row) => (
          <Text type="supporting">
            {MODERATION_LOG_ACTOR_LABELS[row.entry.actor]}
          </Text>
        ),
      },
      {
        key: "target",
        header: "Bình luận / Page",
        width: pixel(180),
        renderCell: (row) => {
          const pageDisplay =
            (row.entry.pageId && pageNameById?.[row.entry.pageId]) ||
            row.entry.pageId ||
            "—";
          return (
            <Stack direction="vertical" gap={0.5}>
              <Text type="code">{row.entry.commentId}</Text>
              <Text type="supporting" color="secondary">
                {pageDisplay}
              </Text>
            </Stack>
          );
        },
      },
      {
        key: "reason",
        header: "Phân loại & lý do",
        width: proportional(1),
        renderCell: (row) => (
          <Stack direction="vertical" gap={1}>
            <HStack gap={1.5} align="center" wrap="wrap">
              {row.entry.category ? (
                <Token
                  label={MODERATION_CATEGORY_LABELS[row.entry.category]}
                  size="sm"
                />
              ) : null}
              {row.entry.errorCode ? (
                <Token label={row.entry.errorCode} color="red" size="sm" />
              ) : null}
            </HStack>
            <Text type="supporting">
              {row.entry.reason?.trim() ? row.entry.reason : "—"}
            </Text>
          </Stack>
        ),
      },
      {
        key: "result",
        header: "Kết quả",
        width: pixel(120),
        renderCell: (row) => (
          <HStack gap={1.5} align="center">
            <StatusDot
              variant={MODERATION_LOG_RESULT_DOT_VARIANTS[row.entry.result]}
              label={MODERATION_LOG_RESULT_LABELS[row.entry.result]}
            />
            <Text type="supporting">
              {MODERATION_LOG_RESULT_LABELS[row.entry.result]}
            </Text>
          </HStack>
        ),
      },
      {
        key: "undo",
        header: "Hoàn tác",
        width: pixel(135),
        renderCell: (row) => {
          const isUndoing = undoingCommentId === row.entry.commentId;
          const undoGate = evaluateUndoLogEntryGate({
            entry: row.entry,
            isUndoing,
            readOnlyReason,
          });
          if (!undoGate.isEligible) {
            return (
              <Text type="supporting" color="secondary">
                —
              </Text>
            );
          }
          return (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<Eye aria-hidden="true" />}
              label={isUndoing ? "Đang hiện lại…" : "Hiện lại"}
              isLoading={isUndoing}
              isDisabled={!undoGate.canUndo}
              tooltip={undoGate.disabledReason ?? undefined}
              onClick={() => onUndoHide(row.entry.commentId)}
            />
          );
        },
      },
    ],
    [nowMs, onUndoHide, pageNameById, readOnlyReason, undoingCommentId],
  );

  return (
    <Stack direction="vertical" gap={4} data-moderation="log-panel">
      {/* Header & refresh */}
      <HStack gap={3} align="start" justify="between" wrap="wrap">
        <Stack direction="vertical" gap={0.5}>
          <HStack gap={2} align="center">
            <History aria-hidden="true" />
            <Heading level={2}>Nhật ký kiểm duyệt</Heading>
          </HStack>
          <Text type="supporting" color="secondary">
            Ghi nhận mọi thao tác kiểm duyệt tự động và thủ công. Bạn có thể bấm “Hiện lại”
            cho các bình luận đã ẩn.
          </Text>
        </Stack>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<RefreshCw aria-hidden="true" />}
          label={isFetching ? "Đang tải…" : "Làm mới"}
          isDisabled={isFetching}
          onClick={onRefresh}
        />
      </HStack>

      <ReadOnlyNotice reason={readOnlyReason} />

      {/* Action & actor filters */}
      <HStack gap={3} align="end" wrap="wrap">
        <Selector
          label="Lọc theo hành động"
          options={ACTION_FILTER_OPTIONS}
          value={filter.action ?? ALL_VALUE}
          size="sm"
          width={210}
          onChange={(nextValue) =>
            onFilterChange({
              ...filter,
              action:
                nextValue === ALL_VALUE
                  ? null
                  : (nextValue as ModerationLogAction),
            })
          }
        />

        <Selector
          label="Lọc theo nguồn thực hiện"
          options={ACTOR_FILTER_OPTIONS}
          value={filter.actor ?? ALL_VALUE}
          size="sm"
          width={190}
          onChange={(nextValue) =>
            onFilterChange({
              ...filter,
              actor:
                nextValue === ALL_VALUE
                  ? null
                  : (nextValue as ModerationLogActor),
            })
          }
        />

        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            label="Xoá bộ lọc"
            onClick={onClearFilters}
          />
        ) : null}
      </HStack>

      {/* Polite live region for undo outcome */}
      <Stack role="status" aria-live="polite" direction="vertical" gap={2}>
        {undoStatusMessage ? (
          <Banner
            status="success"
            title={undoStatusMessage}
            isDismissable
            onDismiss={onDismissUndoStatus}
          />
        ) : null}
      </Stack>

      {/* Undo errors */}
      {undoErrorMessage ? (
        <Banner
          role="alert"
          status="error"
          title="Không thể hiện lại bình luận"
          description={undoErrorMessage}
          isDismissable
          onDismiss={onDismissUndoError}
        />
      ) : null}
      {undoApiError ? (
        <ApiErrorNotice error={undoApiError} shouldFocus={false} />
      ) : null}

      {/* Body states */}
      {isFirstLoad ? (
        showSkeleton ? (
          <ModerationLogSkeleton />
        ) : null
      ) : isError && items.length === 0 ? (
        <ApiErrorNotice error={error} onRetry={onRefresh} />
      ) : items.length === 0 ? (
        resolveModerationLogEmptyKind(filter) === "no-result" ? (
          <EmptyState
            kind="no-result"
            title="Không có bản ghi nào khớp bộ lọc"
            description="Thử bỏ lọc hành động hoặc nguồn thực hiện để xem toàn bộ nhật ký kiểm duyệt."
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                label="Xoá bộ lọc"
                onClick={onClearFilters}
              />
            }
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có nhật ký kiểm duyệt"
            description="Khi bạn dùng thao tác hàng loạt hoặc bật tự kiểm duyệt cho Fanpage, mọi hành động sẽ được ghi lại tại đây."
          />
        )
      ) : (
        <Stack direction="vertical" gap={3}>
          {isError ? (
            <ApiErrorNotice error={error} shouldFocus={false} onRetry={onRefresh} />
          ) : null}

          <Table
            data={tableData}
            columns={columns}
            idKey="id"
            density="balanced"
            dividers="rows"
            verticalAlign="top"
          />

          {hasNextPage ? (
            <HStack justify="center" paddingBlock={2}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                label={isFetchingNextPage ? "Đang tải thêm…" : "Tải thêm nhật ký"}
                isLoading={isFetchingNextPage}
                isDisabled={isFetchingNextPage}
                onClick={onLoadMore}
              />
            </HStack>
          ) : null}
        </Stack>
      )}
    </Stack>
  );
}

export interface ModerationLogProps {
  /** Optional initial or fixed Page ID filter. */
  readonly pageId?: string | null;
  /** Optional Page ID → display name lookup for the table. */
  readonly pageNameById?: Readonly<Record<string, string | undefined>>;
  /** Page size per cursor request (defaults to 20). */
  readonly limit?: number;
  /** Optional override for read-only reason (defaults to `useReadOnlyReason()`). */
  readonly readOnlyReason?: string | null;
}

/**
 * Connected paged moderation audit log with action/actor filters and
 * one-click "Hiện lại" undo via bulk unhide (`POST /api/comments/bulk`).
 */
export function ModerationLog({
  pageId = null,
  pageNameById,
  limit = MODERATION_LOG_DEFAULT_LIMIT,
  readOnlyReason: readOnlyReasonProp,
}: ModerationLogProps = {}) {
  const hookReadOnlyReason = useReadOnlyReason();
  const readOnlyReason =
    readOnlyReasonProp !== undefined ? readOnlyReasonProp : hookReadOnlyReason;
  const nowMs = useNowMs(60_000);

  const [filterState, setFilterState] = useState<
    Pick<ModerationLogFilter, "action" | "actor">
  >({
    action: DEFAULT_MODERATION_LOG_FILTER.action,
    actor: DEFAULT_MODERATION_LOG_FILTER.actor,
  });

  const filter: ModerationLogFilter = useMemo(
    () => ({
      pageId: pageId?.trim() || null,
      action: filterState.action,
      actor: filterState.actor,
    }),
    [pageId, filterState.action, filterState.actor],
  );

  const logQuery = useModerationLog(filter, limit);
  const undoMutation = useUndoModerationHide();

  const [undoStatusMessage, setUndoStatusMessage] = useState<string | null>(null);
  const [undoErrorMessage, setUndoErrorMessage] = useState<string | null>(null);

  const items = useMemo(
    () => logQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [logQuery.data],
  );
  const isFirstLoad = logQuery.isPending && logQuery.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  function handleUndoHide(commentId: string) {
    if (readOnlyReason !== null || undoMutation.isPending) return;
    setUndoStatusMessage(null);
    setUndoErrorMessage(null);
    undoMutation.reset();

    undoMutation.mutate(
      { commentId },
      {
        onSuccess: (response) => {
          const item = response.results.find((entry) => entry.id === commentId);
          if (item && !item.ok) {
            setUndoErrorMessage(
              `Bình luận ${commentId}: ${describeBulkItemFailure(item)}`,
            );
            return;
          }
          if (response.processed > 0) {
            setUndoStatusMessage(
              `Đã hiện lại bình luận ${commentId} trên Facebook.`,
            );
          } else {
            setUndoErrorMessage(
              `Không thể hiện lại bình luận ${commentId}. Hãy thử lại sau.`,
            );
          }
        },
      },
    );
  }

  return (
    <ModerationLogView
      isFirstLoad={isFirstLoad}
      showSkeleton={showSkeleton}
      isFetching={logQuery.isFetching}
      isError={logQuery.isError}
      error={logQuery.error}
      items={items}
      filter={filter}
      nowMs={nowMs}
      readOnlyReason={readOnlyReason}
      hasNextPage={Boolean(logQuery.hasNextPage)}
      isFetchingNextPage={logQuery.isFetchingNextPage}
      undoingCommentId={
        undoMutation.isPending
          ? (undoMutation.variables?.commentId ?? null)
          : null
      }
      undoStatusMessage={undoStatusMessage}
      undoErrorMessage={undoErrorMessage}
      undoApiError={undoMutation.error}
      pageNameById={pageNameById}
      onFilterChange={(next) =>
        setFilterState({ action: next.action, actor: next.actor })
      }
      onClearFilters={() => setFilterState({ action: null, actor: null })}
      onRefresh={() => void logQuery.refetch()}
      onLoadMore={() => void logQuery.fetchNextPage()}
      onUndoHide={handleUndoHide}
      onDismissUndoStatus={() => setUndoStatusMessage(null)}
      onDismissUndoError={() => setUndoErrorMessage(null)}
    />
  );
}
