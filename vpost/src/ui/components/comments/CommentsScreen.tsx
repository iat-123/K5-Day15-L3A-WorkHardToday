"use client";

import {
  Badge,
  Banner,
  Button,
  CheckboxInput,
  Dialog,
  DialogHeader,
  Divider,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Link,
  Selector,
  Stack,
  StackItem,
  Tab,
  TabList,
  Text,
  TextInput,
  Token,
  useAnnounce,
  useMediaQuery,
} from "@astryxdesign/core";
import { InternationalizationProvider, type Catalog } from "@astryxdesign/core/i18n";
import { History, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { presentCommentApiError } from "@/ui/components/comments/comment-error";
import {
  COMMENT_FILTER_TABS,
  COMMENT_TAB_LABELS,
  DEFAULT_COMMENT_FILTER,
  buildCommentFilterKey,
  buildCommentsUrl,
  hasActiveCommentFilters,
  parseCommentFilter,
  resolveCommentsEmptyKind,
  resolveNextTabFilter,
} from "@/ui/components/comments/comment-filters";
import {
  commentRowStateReducer,
  createConflictNotice,
  executePerRowMutation,
  getCommentRowState,
  isSendConflictError,
  nextLiveAnnouncement,
  type CommentRowStateMap,
  type ConflictNotice,
  type LiveAnnouncement,
} from "@/ui/components/comments/comment-row-state";
import { CommentErrorNotice } from "@/ui/components/comments/CommentErrorNotice";
import { CommentListSkeleton } from "@/ui/components/comments/CommentListSkeleton";
import { CommentRow } from "@/ui/components/comments/CommentRow";
import { formatBulkResultSummary } from "@/ui/components/comments/moderation/bulk-action-state";
import { BulkActionBar } from "@/ui/components/comments/moderation/BulkActionBar";
import { ModerationFilterBar } from "@/ui/components/comments/moderation/ModerationFilterBar";
import { ModerationLog } from "@/ui/components/comments/moderation/ModerationLog";
import { ModerationSettingsPanel } from "@/ui/components/comments/moderation/ModerationSettingsPanel";
import type { PageSelectionStatus } from "@/ui/components/comments/moderation/selection-model";
import { useCommentSelection } from "@/ui/components/comments/moderation/useCommentSelection";
import { PermissionMissingNotice } from "@/ui/components/comments/PermissionMissingNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { toApiError } from "@/ui/components/feedback/present-api-error";
import { ReadOnlyNotice } from "@/ui/components/feedback/ReadOnlyNotice";
import { useChannels } from "@/ui/hooks/useChannels";
import {
  useCommentsList,
  useGenerateCommentDraft,
  useIgnoreComment,
  useSaveCommentDraft,
  useSendCommentReply,
  useSetCommentHidden,
  useSyncComments,
  useUnignoreComment,
} from "@/ui/hooks/useComments";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useNowMs } from "@/ui/hooks/useNowMs";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import { ASTRYX_LOCALE, ASTRYX_VI } from "@/ui/i18n/astryx-vi";
import {
  formatCommentAccessibleContext,
  formatSyncSummary,
  isModerationFailedCode,
  isReconnectPageCode,
  totalCommentCount,
  type CommentCounts,
  type CommentFilter,
  type CommentFilterStatus,
  type CommentItem,
  type CommentSyncResponse,
} from "@/ui/schemas/comment.schema";

const SEARCH_DEBOUNCE_MS = 300;
const ALL_CHANNELS_VALUE = "__all__";
const EMPTY_COUNTS: CommentCounts = {
  unreplied: 0,
  replied: 0,
  ignored: 0,
  autoHidden: 0,
  flagged: 0,
};

export type CommentsModerationPanel = "settings" | "log" | null;

/**
 * Local Vietnamese override for Astryx `Token`'s remove button (`@astryx.token.remove`),
 * kept inside `comments/` so shared `vpost/src/ui/i18n/astryx-vi.ts` stays untouched.
 */
const COMMENTS_ASTRYX_VI: Catalog = {
  ...ASTRYX_VI,
  "@astryx.token.remove": { defaultMessage: "Bỏ {label}" },
};

/**
 * Removable `postJobId` filter token with Vietnamese aria-label on its remove button.
 */
export function PostJobFilterToken({
  postJobId,
  onRemove,
}: {
  postJobId: string;
  onRemove: () => void;
}) {
  return (
    <InternationalizationProvider
      locale={ASTRYX_LOCALE}
      messages={{ [ASTRYX_LOCALE]: COMMENTS_ASTRYX_VI }}
    >
      <Token label={`Bài đăng: ${postJobId}`} size="sm" onRemove={onRemove} />
    </InternationalizationProvider>
  );
}

/**
 * Screen-level 409 CONFLICT alert that persists even after cache invalidation
 * removes the already-replied comment from the default `"unreplied"` tab.
 */
export function CommentsConflictBanner({
  notice,
  onDismiss,
}: {
  notice: ConflictNotice | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  return (
    <Stack direction="vertical" paddingInline={4} paddingBlock={2}>
      <Banner
        key={notice.seq}
        role="alert"
        status="warning"
        title={notice.title}
        description={notice.description}
        isDismissable
        onDismiss={onDismiss}
      />
    </Stack>
  );
}

/**
 * Visual confirmation banner keyed by announcement sequence so identical repeated
 * results remount cleanly (screen-reader re-announcement goes through `useAnnounce`).
 */
export function CommentsLiveStatusBanner({
  announcement,
  onDismiss,
}: {
  announcement: LiveAnnouncement | null;
  onDismiss: () => void;
}) {
  if (!announcement) return null;
  return (
    <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
      <Banner
        key={announcement.seq}
        role="note"
        status="info"
        title={announcement.message}
        isDismissable
        onDismiss={onDismiss}
      />
    </Stack>
  );
}

/**
 * Presentational header for the "Bình luận" screen:
 * title, sync/refresh actions, settings & moderation log triggers, status tabs,
 * moderation filter bar (with counts), and search/channel filters.
 */
export interface CommentsScreenHeaderProps {
  readonly filter: CommentFilter;
  readonly counts: CommentCounts;
  readonly hasCounts: boolean;
  readonly hasFilters: boolean;
  readonly isNarrow: boolean;
  readonly isSyncing: boolean;
  readonly isFetching: boolean;
  readonly readOnlyReason: string | null;
  readonly searchDraft: string;
  readonly channelOptions: readonly { value: string; label: string }[];
  readonly activeModerationPanel: CommentsModerationPanel;
  readonly onSearchDraftChange: (value: string) => void;
  readonly onFilterChange: (next: CommentFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSync: () => void;
  readonly onRefresh: () => void;
  readonly onOpenModerationPanel: (panel: Exclude<CommentsModerationPanel, null>) => void;
}

export function CommentsScreenHeader({
  filter,
  counts,
  hasCounts,
  hasFilters,
  isNarrow,
  isSyncing,
  isFetching,
  readOnlyReason,
  searchDraft,
  channelOptions,
  activeModerationPanel,
  onSearchDraftChange,
  onFilterChange,
  onClearFilters,
  onSync,
  onRefresh,
  onOpenModerationPanel,
}: CommentsScreenHeaderProps) {
  const totalCount = totalCommentCount(counts);

  const tabCount = (tab: CommentFilterStatus): number => {
    if (tab === "all") return totalCount;
    return counts[tab];
  };

  const searchInput = (
    <TextInput
      label="Tìm kiếm bình luận"
      isLabelHidden
      value={searchDraft}
      onChange={onSearchDraftChange}
      placeholder="Tìm nội dung bình luận, tên khách, mã SP…"
      startIcon={Search}
      hasClear
      size="sm"
      width="100%"
    />
  );

  const channelSelector = (
    <Selector
      label="Lọc theo kênh"
      isLabelHidden
      options={[...channelOptions]}
      value={filter.channelId ?? ALL_CHANNELS_VALUE}
      onChange={(nextValue) =>
        onFilterChange({
          ...filter,
          channelId: nextValue === ALL_CHANNELS_VALUE ? null : nextValue,
        })
      }
      size="sm"
      width={isNarrow ? "100%" : 240}
    />
  );

  return (
    <LayoutHeader hasDivider>
      <Stack direction="vertical" gap={3} padding={4}>
        <HStack gap={3} align="start" justify="between" wrap="wrap">
          <StackItem size="fill">
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Bình luận</Heading>
              <Text type="supporting">
                Bình luận khách hàng trên các bài Facebook đã đăng từ VPOST. AI chỉ tạo bản nháp —
                mọi câu trả lời đều cần bạn duyệt trước khi gửi lên Facebook.
              </Text>
            </Stack>
          </StackItem>

          <HStack gap={2} align="center" wrap="wrap">
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<RefreshCw aria-hidden="true" />}
              label={isSyncing ? "Đang đồng bộ…" : "Đồng bộ bình luận"}
              isLoading={isSyncing}
              isDisabled={isSyncing || readOnlyReason !== null}
              tooltip={readOnlyReason ?? undefined}
              onClick={onSync}
            />

            <Button
              type="button"
              variant="secondary"
              size="sm"
              label={isFetching ? "Đang tải…" : "Làm mới"}
              isDisabled={isFetching}
              onClick={onRefresh}
            />

            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<ShieldCheck aria-hidden="true" />}
              label="Cài đặt tự kiểm duyệt"
              aria-haspopup="dialog"
              aria-expanded={activeModerationPanel === "settings"}
              onClick={() => onOpenModerationPanel("settings")}
            />

            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<History aria-hidden="true" />}
              label="Nhật ký kiểm duyệt"
              aria-haspopup="dialog"
              aria-expanded={activeModerationPanel === "log"}
              onClick={() => onOpenModerationPanel("log")}
            />
          </HStack>
        </HStack>

        <ReadOnlyNotice reason={readOnlyReason} />

        {/* Status tabs and moderation filter bar side by side (wraps cleanly on narrow screens) */}
        <HStack gap={3} align="center" justify="between" wrap="wrap">
          <TabList
            value={filter.status}
            onChange={(value: string) => {
              const nextFilter = resolveNextTabFilter(filter, value);
              if (nextFilter) onFilterChange(nextFilter);
            }}
            aria-label="Lọc bình luận theo trạng thái"
          >
            {COMMENT_FILTER_TABS.map((tab) => {
              const count = tabCount(tab);
              return (
                <Tab
                  key={tab}
                  value={tab}
                  label={COMMENT_TAB_LABELS[tab]}
                  endContent={
                    hasCounts ? (
                      <Badge
                        label={count}
                        variant={tab === "unreplied" && count > 0 ? "warning" : "neutral"}
                      />
                    ) : undefined
                  }
                />
              );
            })}
          </TabList>

          <ModerationFilterBar
            value={filter.moderation}
            onChange={(nextModeration) =>
              onFilterChange({ ...filter, moderation: nextModeration })
            }
            counts={
              hasCounts
                ? {
                    autoHidden: counts.autoHidden,
                    flagged: counts.flagged,
                  }
                : undefined
            }
          />
        </HStack>

        {/* Search & channel filters */}
        {isNarrow ? (
          <Stack direction="vertical" gap={2}>
            {searchInput}
            {channelSelector}
          </Stack>
        ) : (
          <HStack gap={3} align="center">
            <StackItem size="fill">{searchInput}</StackItem>
            {channelSelector}
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
        )}

        {/* Active postJobId chip (e.g. opened from JobLogTable "Xem bình luận") */}
        {filter.postJobId || (isNarrow && hasFilters) ? (
          <HStack gap={2} align="center" wrap="wrap">
            {filter.postJobId ? (
              <PostJobFilterToken
                postJobId={filter.postJobId}
                onRemove={() => onFilterChange({ ...filter, postJobId: null })}
              />
            ) : null}
            {isNarrow && hasFilters ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                label="Xoá bộ lọc"
                onClick={onClearFilters}
              />
            ) : null}
          </HStack>
        ) : null}
      </Stack>
    </LayoutHeader>
  );
}

/**
 * Fullscreen Astryx Dialog overlay for per-Page auto-moderation settings and the
 * moderation audit log (mirrors `ProductInspectorDrawer` so the header stays
 * fixed and the body scrolls cleanly at every viewport width).
 */
export interface CommentsModerationDialogProps {
  readonly activePanel: CommentsModerationPanel;
  readonly onClose: () => void;
  readonly readOnlyReason: string | null;
  readonly pageNameById?: Readonly<Record<string, string | undefined>>;
  readonly settingsContent?: ReactNode;
  readonly logContent?: ReactNode;
}

export function CommentsModerationDialog({
  activePanel,
  onClose,
  readOnlyReason,
  pageNameById,
  settingsContent,
  logContent,
}: CommentsModerationDialogProps) {
  if (activePanel === null) return null;

  const isSettings = activePanel === "settings";

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      purpose={isSettings ? "form" : "info"}
      variant="fullscreen"
    >
      <Layout
        height="fill"
        header={
          <DialogHeader
            title={isSettings ? "Cài đặt tự kiểm duyệt" : "Nhật ký kiểm duyệt"}
            subtitle={
              isSettings
                ? "Bật hoặc tắt tự ẩn bình luận vi phạm theo từng Fanpage Facebook."
                : "Lịch sử mọi thao tác kiểm duyệt tự động và thủ công, hỗ trợ hoàn tác Hiện lại."
            }
            onOpenChange={(open) => {
              if (!open) onClose();
            }}
          />
        }
        content={
          <LayoutContent padding={4} isScrollable>
            {isSettings
              ? (settingsContent ?? <ModerationSettingsPanel readOnlyReason={readOnlyReason} />)
              : (logContent ?? (
                  <ModerationLog pageNameById={pageNameById} readOnlyReason={readOnlyReason} />
                ))}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

/**
 * Screen-level sync banners: polite summary, 409 conflict alert, sync API error,
 * Page reconnect notices, non-blocking `MODERATION_FAILED` warning, and other
 * per-post sync errors.
 */
export interface CommentsSyncNoticesProps {
  readonly liveStatus: LiveAnnouncement | null;
  readonly conflictNotice: ConflictNotice | null;
  readonly syncError: unknown;
  readonly lastSyncResult: CommentSyncResponse | null;
  readonly isModerationWarningDismissed?: boolean;
  readonly readOnlyReason: string | null;
  readonly onDismissLiveStatus: () => void;
  readonly onDismissConflict: () => void;
  readonly onDismissModerationWarning?: () => void;
  readonly onRetrySync: () => void;
}

export function CommentsSyncNotices({
  liveStatus,
  conflictNotice,
  syncError,
  lastSyncResult,
  isModerationWarningDismissed = false,
  readOnlyReason,
  onDismissLiveStatus,
  onDismissConflict,
  onDismissModerationWarning,
  onRetrySync,
}: CommentsSyncNoticesProps) {
  const errors = lastSyncResult?.errors ?? [];
  const syncPermissionErrors = errors.filter((e) => isReconnectPageCode(e.code));
  const syncModerationErrors = errors.filter((e) => isModerationFailedCode(e.code));
  const syncOtherErrors = errors.filter(
    (e) => !isReconnectPageCode(e.code) && !isModerationFailedCode(e.code),
  );

  return (
    <>
      <CommentsLiveStatusBanner announcement={liveStatus} onDismiss={onDismissLiveStatus} />

      <CommentsConflictBanner notice={conflictNotice} onDismiss={onDismissConflict} />

      {syncError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={2}>
          <CommentErrorNotice
            error={syncError}
            onRetry={readOnlyReason ? undefined : onRetrySync}
          />
        </Stack>
      ) : null}

      {syncPermissionErrors.length > 0 ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={2}>
          <PermissionMissingNotice errors={syncPermissionErrors} />
        </Stack>
      ) : null}

      {/* Non-blocking warning when sync succeeded but auto-moderation encountered errors */}
      {syncModerationErrors.length > 0 && !isModerationWarningDismissed ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={2}>
          <Banner
            role="status"
            aria-live="polite"
            status="warning"
            title="Tự kiểm duyệt gặp lỗi — bình luận vẫn đã được đồng bộ"
            description="Bình luận mới đã được cập nhật vào hộp thư. Các bình luận gặp lỗi tự kiểm duyệt vẫn giữ nguyên hoặc được gắn cờ để bạn kiểm tra thủ công."
            isDismissable={Boolean(onDismissModerationWarning)}
            onDismiss={onDismissModerationWarning}
            defaultIsExpanded
          >
            <Stack as="ul" role="list" direction="vertical" gap={1}>
              {syncModerationErrors.map((err, idx) => (
                <Stack
                  as="li"
                  key={`${err.postJobId}-${err.code}-${idx}`}
                  direction="vertical"
                  gap={0.5}
                >
                  <Text type="supporting">{err.message}</Text>
                  <Text type="code" color="secondary">
                    Mã: {err.code}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </Banner>
        </Stack>
      ) : null}

      {syncOtherErrors.length > 0 ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={2}>
          <Banner
            role="alert"
            status="warning"
            title={`Có ${syncOtherErrors.length} bài không đồng bộ được`}
            description="Các bài còn lại vẫn được cập nhật bình thường."
            defaultIsExpanded
          >
            <Stack as="ul" role="list" direction="vertical" gap={1}>
              {syncOtherErrors.map((err) => (
                <Stack
                  as="li"
                  key={`${err.postJobId}-${err.code}`}
                  direction="vertical"
                  gap={0.5}
                >
                  <Text type="supporting">
                    Bài {err.postJobId}: {err.message}
                  </Text>
                  <Text type="code" color="secondary">
                    Mã: {err.code}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </Banner>
        </Stack>
      ) : null}
    </>
  );
}

/**
 * "Bình luận" — Facebook comment inbox.
 * URL-driven filters, explicit on-demand sync, bulk & automatic moderation,
 * AI reply drafts, and manual approval before sending any reply to Facebook.
 */
export function CommentsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isNarrow = useMediaQuery("(max-width: 1024px)");
  const nowMs = useNowMs(60_000);
  const readOnlyReason = useReadOnlyReason();
  const announce = useAnnounce();

  const filter = useMemo(
    () => parseCommentFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const commentsQuery = useCommentsList(filter);
  const channelsQuery = useChannels();
  const syncMutation = useSyncComments();
  const generateDraftMutation = useGenerateCommentDraft();
  const saveDraftMutation = useSaveCommentDraft();
  const sendReplyMutation = useSendCommentReply();
  const ignoreMutation = useIgnoreComment();
  const unignoreMutation = useUnignoreComment();
  const hideMutation = useSetCommentHidden();

  const [liveStatus, setLiveStatus] = useState<LiveAnnouncement | null>(null);
  const [conflictNotice, setConflictNotice] = useState<ConflictNotice | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<CommentSyncResponse | null>(null);
  const [moderationWarningDismissed, setModerationWarningDismissed] = useState(false);
  const [activeModerationPanel, setActiveModerationPanel] =
    useState<CommentsModerationPanel>(null);
  const [rowStateById, dispatchRowState] = useReducer(commentRowStateReducer, {});
  const inFlightRef = useRef<Set<string>>(new Set());

  const announcePolite = useCallback(
    (message: string) => {
      setLiveStatus((prev) => nextLiveAnnouncement(prev, message));
      announce(message, "polite");
    },
    [announce],
  );

  const replaceFilter = useCallback(
    (next: CommentFilter) => {
      router.replace(buildCommentsUrl(next, pathname), { scroll: false });
    },
    [pathname, router],
  );

  // Search box: local while typing, synced to URL after debounce.
  const [searchDraft, setSearchDraft] = useState(filter.q ?? "");
  const lastAppliedQuery = useRef(filter.q ?? "");

  useEffect(() => {
    const fromUrl = filter.q ?? "";
    if (fromUrl !== lastAppliedQuery.current) {
      lastAppliedQuery.current = fromUrl;
      setSearchDraft(fromUrl);
    }
  }, [filter.q]);

  useEffect(() => {
    const trimmed = searchDraft.trim();
    if (trimmed === (filter.q ?? "")) return;
    const timer = setTimeout(() => {
      lastAppliedQuery.current = trimmed;
      replaceFilter({ ...filter, q: trimmed.length > 0 ? trimmed : null });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, filter, replaceFilter]);

  const items = useMemo(
    () => commentsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [commentsQuery.data],
  );
  const counts = commentsQuery.data?.pages[0]?.counts ?? EMPTY_COUNTS;

  // Bulk row selection: clears synchronously whenever any URL filter changes.
  const pageIds = useMemo(() => items.map((item) => item.id), [items]);
  const filterKey = useMemo(() => buildCommentFilterKey(filter), [filter]);
  const selection = useCommentSelection({ pageIds, filterKey });

  const commentLabelsById = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const item of items) {
      labels[item.id] = formatCommentAccessibleContext(item);
    }
    return labels;
  }, [items]);

  const pageNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const channel of channelsQuery.data?.channels ?? []) {
      const name = channel.name.trim();
      if (channel.externalId && name.length > 0) {
        map[channel.externalId] = name;
      }
    }
    return map;
  }, [channelsQuery.data?.channels]);

  // Background refresh keeps existing rows on screen (no skeleton).
  const isFirstLoad = commentsQuery.isPending && commentsQuery.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);
  const hasFilters = hasActiveCommentFilters(filter);

  const channelOptions = useMemo(() => {
    const list = channelsQuery.data?.channels ?? [];
    const facebookChannels = list.filter((channel) => channel.platform === "facebook");
    const mapped = facebookChannels.map((channel) => ({
      value: channel.channelId,
      label: channel.name.trim().length > 0 ? channel.name : channel.channelId,
    }));
    if (filter.channelId && !mapped.some((opt) => opt.value === filter.channelId)) {
      mapped.push({ value: filter.channelId, label: filter.channelId });
    }
    return [{ value: ALL_CHANNELS_VALUE, label: "Tất cả kênh" }, ...mapped];
  }, [channelsQuery.data?.channels, filter.channelId]);

  function handleSync() {
    if (readOnlyReason) return;
    syncMutation.reset();
    setLastSyncResult(null);
    setModerationWarningDismissed(false);
    setLiveStatus(null);
    setConflictNotice(null);
    syncMutation.mutate(
      {
        channelId: filter.channelId ?? undefined,
        postJobId: filter.postJobId ?? undefined,
      },
      {
        onSuccess: (result) => {
          setLastSyncResult(result);
          announcePolite(formatSyncSummary(result));
        },
      },
    );
  }

  function clearFilters() {
    lastAppliedQuery.current = "";
    setSearchDraft("");
    replaceFilter(DEFAULT_COMMENT_FILTER);
  }

  function handleGenerateDraft(commentId: string) {
    void executePerRowMutation({
      commentId,
      action: "generate",
      inFlightKeys: inFlightRef.current,
      onStart: () => dispatchRowState({ type: "generate_start", commentId }),
      run: () => generateDraftMutation.mutateAsync({ commentId }),
      onSuccess: (res) => {
        const message =
          res.comment.draft?.status === "flagged"
            ? "AI đã đánh dấu bình luận cần nhân viên kiểm tra."
            : "Đã tạo nháp trả lời AI.";
        dispatchRowState({ type: "generate_success", commentId, message });
        announcePolite(message);
      },
      onError: (err) => {
        dispatchRowState({ type: "generate_error", commentId, error: toApiError(err) });
      },
    });
  }

  function handleSaveDraft(commentId: string, text: string) {
    void executePerRowMutation({
      commentId,
      action: "save",
      inFlightKeys: inFlightRef.current,
      onStart: () => dispatchRowState({ type: "save_start", commentId }),
      run: () => saveDraftMutation.mutateAsync({ commentId, text }),
      onSuccess: (res) => {
        const message =
          res.check.block.length > 0
            ? "Đã lưu nháp — nội dung có mục bị chặn cần chỉnh sửa."
            : "Đã lưu nháp trả lời.";
        dispatchRowState({ type: "save_success", commentId, check: res.check, message });
        announcePolite(message);
      },
      onError: (err) => {
        dispatchRowState({ type: "save_error", commentId, error: toApiError(err) });
      },
    });
  }

  function handleSendReply(commentId: string, text: string) {
    const canComment = items.find((item) => item.id === commentId)?.canComment ?? true;
    void executePerRowMutation({
      commentId,
      action: "send",
      inFlightKeys: inFlightRef.current,
      onStart: () => {
        setConflictNotice((prev) => (prev?.commentId === commentId ? null : prev));
        dispatchRowState({ type: "send_start", commentId });
      },
      run: () => sendReplyMutation.mutateAsync({ commentId, text }),
      onSuccess: () => {
        const message = "Đã gửi trả lời lên Facebook.";
        dispatchRowState({ type: "send_success", commentId, message });
        announcePolite(message);
      },
      onError: (err) => {
        const apiError = toApiError(err);
        dispatchRowState({ type: "send_error", commentId, error: apiError });
        // `useSendCommentReply` already invalidates list + counts in `onSettled`.
        // Persist a screen-level alert for 409 CONFLICT so the warning survives
        // after the row leaves `"unreplied"`.
        if (isSendConflictError(apiError)) {
          setConflictNotice((prev) =>
            createConflictNotice(prev, { commentId, canComment, error: apiError }),
          );
        }
      },
    });
  }

  function handleTextEdited(commentId: string) {
    dispatchRowState({ type: "text_edited", commentId });
  }

  function handleIgnore(commentId: string) {
    void executePerRowMutation({
      commentId,
      action: "ignore",
      inFlightKeys: inFlightRef.current,
      onStart: () => dispatchRowState({ type: "ignore_start", commentId }),
      run: () => ignoreMutation.mutateAsync({ commentId }),
      onSuccess: () => {
        const message = "Đã chuyển bình luận sang Bỏ qua.";
        dispatchRowState({ type: "ignore_success", commentId, message });
        announcePolite(message);
      },
      onError: (err) => {
        dispatchRowState({ type: "ignore_error", commentId, error: toApiError(err) });
      },
    });
  }

  function handleUnignore(commentId: string) {
    void executePerRowMutation({
      commentId,
      action: "ignore",
      inFlightKeys: inFlightRef.current,
      onStart: () => dispatchRowState({ type: "ignore_start", commentId }),
      run: () => unignoreMutation.mutateAsync({ commentId }),
      onSuccess: () => {
        const message = "Đã khôi phục bình luận.";
        dispatchRowState({ type: "ignore_success", commentId, message });
        announcePolite(message);
      },
      onError: (err) => {
        dispatchRowState({ type: "ignore_error", commentId, error: toApiError(err) });
      },
    });
  }

  function handleToggleHide(commentId: string, hidden: boolean) {
    void executePerRowMutation({
      commentId,
      action: "hide",
      inFlightKeys: inFlightRef.current,
      onStart: () => dispatchRowState({ type: "hide_start", commentId }),
      run: () => hideMutation.mutateAsync({ commentId, hidden }),
      onSuccess: () => {
        const message = hidden
          ? "Đã ẩn bình luận trên Facebook."
          : "Đã hiện lại bình luận trên Facebook.";
        dispatchRowState({ type: "hide_success", commentId, message });
        announcePolite(message);
      },
      onError: (err) => {
        dispatchRowState({ type: "hide_error", commentId, error: toApiError(err) });
      },
    });
  }

  const bulkActionBar =
    selection.selectedCount > 0 ? (
      <BulkActionBar
        selectedIds={selection.selectedIds}
        maxSelection={selection.maxSelection}
        cappedAtMax={selection.cappedAtMax}
        commentLabelsById={commentLabelsById}
        readOnlyReason={readOnlyReason}
        onClearSelection={selection.clear}
        onBulkResult={(res, action) => {
          selection.applyBulkResult(res);
          if (res.failed === 0 && res.notProcessed.length === 0) {
            announcePolite(formatBulkResultSummary(action, res));
          }
        }}
      />
    ) : null;

  return (
    <>
      <Layout
        height="fill"
        header={
          <CommentsScreenHeader
            filter={filter}
            counts={counts}
            hasCounts={Boolean(commentsQuery.data)}
            hasFilters={hasFilters}
            isNarrow={isNarrow}
            isSyncing={syncMutation.isPending}
            isFetching={commentsQuery.isFetching}
            readOnlyReason={readOnlyReason}
            searchDraft={searchDraft}
            channelOptions={channelOptions}
            activeModerationPanel={activeModerationPanel}
            onSearchDraftChange={setSearchDraft}
            onFilterChange={replaceFilter}
            onClearFilters={clearFilters}
            onSync={handleSync}
            onRefresh={() => void commentsQuery.refetch()}
            onOpenModerationPanel={(panel) => setActiveModerationPanel(panel)}
          />
        }
        content={
          <LayoutContent padding={0} isScrollable>
            <Stack direction="vertical" gap={0}>
              <CommentsSyncNotices
                liveStatus={liveStatus}
                conflictNotice={conflictNotice}
                syncError={syncMutation.isError ? syncMutation.error : null}
                lastSyncResult={lastSyncResult}
                isModerationWarningDismissed={moderationWarningDismissed}
                readOnlyReason={readOnlyReason}
                onDismissLiveStatus={() => setLiveStatus(null)}
                onDismissConflict={() => setConflictNotice(null)}
                onDismissModerationWarning={() => setModerationWarningDismissed(true)}
                onRetrySync={handleSync}
              />

              <CommentsListBody
                isFirstLoad={isFirstLoad}
                showSkeleton={showSkeleton}
                isError={commentsQuery.isError}
                error={commentsQuery.error}
                items={items}
                counts={counts}
                filter={filter}
                nowMs={nowMs}
                readOnlyReason={readOnlyReason}
                hasNextPage={Boolean(commentsQuery.hasNextPage)}
                isFetchingNextPage={commentsQuery.isFetchingNextPage}
                isSyncing={syncMutation.isPending}
                rowStateById={rowStateById}
                selection={{
                  selectedIds: selection.selectedIds,
                  isSelected: selection.isSelected,
                  isAtMax: selection.isAtMax,
                  maxSelection: selection.maxSelection,
                  pageStatus: selection.pageStatus,
                  onToggle: selection.toggle,
                  onToggleAllOnPage: selection.toggleAllOnPage,
                  bulkActionBar,
                }}
                onRetry={() => void commentsQuery.refetch()}
                onSync={handleSync}
                onClearFilters={clearFilters}
                onSwitchStatus={(status) => replaceFilter({ ...filter, status })}
                onLoadMore={() => void commentsQuery.fetchNextPage()}
                onGenerateDraft={handleGenerateDraft}
                onSaveDraft={handleSaveDraft}
                onSendReply={handleSendReply}
                onTextEdited={handleTextEdited}
                onIgnore={handleIgnore}
                onUnignore={handleUnignore}
                onToggleHide={handleToggleHide}
              />
            </Stack>
          </LayoutContent>
        }
      />

      <CommentsModerationDialog
        activePanel={activeModerationPanel}
        onClose={() => setActiveModerationPanel(null)}
        readOnlyReason={readOnlyReason}
        pageNameById={pageNameById}
      />
    </>
  );
}

export interface CommentsListSelectionProps {
  readonly selectedIds: readonly string[];
  readonly isSelected: (commentId: string) => boolean;
  readonly isAtMax: boolean;
  readonly maxSelection: number;
  readonly pageStatus: PageSelectionStatus;
  readonly onToggle: (commentId: string) => void;
  readonly onToggleAllOnPage: () => void;
  /** Rendered above the list strictly when `selectedIds.length > 0`. */
  readonly bulkActionBar?: ReactNode;
}

export interface CommentsListBodyProps {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isError: boolean;
  error: unknown;
  items: readonly CommentItem[];
  counts: CommentCounts;
  filter: CommentFilter;
  nowMs: number;
  readOnlyReason: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isSyncing: boolean;
  rowStateById: CommentRowStateMap;
  selection?: CommentsListSelectionProps;
  onRetry: () => void;
  onSync: () => void;
  onClearFilters: () => void;
  onSwitchStatus: (status: CommentFilterStatus) => void;
  onLoadMore: () => void;
  onGenerateDraft: (commentId: string) => void;
  onSaveDraft: (commentId: string, text: string) => void;
  onSendReply: (commentId: string, text: string) => void;
  onTextEdited?: (commentId: string) => void;
  onIgnore: (commentId: string) => void;
  onUnignore: (commentId: string) => void;
  onToggleHide: (commentId: string, hidden: boolean) => void;
}

/**
 * Presentational body covering every required state (skeleton, error,
 * permission error, first-run empty, no-result empty, all-done empty,
 * stale-refetch error, and populated comment list).
 */
export function CommentsListBody({
  isFirstLoad,
  showSkeleton,
  isError,
  error,
  items,
  counts,
  filter,
  nowMs,
  readOnlyReason,
  hasNextPage,
  isFetchingNextPage,
  isSyncing,
  rowStateById,
  selection,
  onRetry,
  onSync,
  onClearFilters,
  onSwitchStatus,
  onLoadMore,
  onGenerateDraft,
  onSaveDraft,
  onSendReply,
  onTextEdited,
  onIgnore,
  onUnignore,
  onToggleHide,
}: CommentsListBodyProps) {
  // First load: skeleton delayed 300ms so fast responses do not flash.
  if (isFirstLoad) return showSkeleton ? <CommentListSkeleton /> : null;

  // Error with nothing loaded.
  if (isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <CommentErrorNotice error={error} onRetry={onRetry} />
      </Stack>
    );
  }

  // Empty states: first-run, all-done, or no-result for active filters.
  if (items.length === 0) {
    const emptyKind = resolveCommentsEmptyKind({ counts, filter });

    if (emptyKind === "first-run") {
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            kind="first-run"
            title="Chưa có bình luận — bấm Đồng bộ"
            description="Chưa có bình luận khách hàng nào được đồng bộ từ Facebook. Bấm “Đồng bộ bình luận” để tải bình luận trên các bài VPOST đã đăng trong 14 ngày gần nhất."
            action={
              <Button
                type="button"
                variant="primary"
                size="sm"
                label={isSyncing ? "Đang đồng bộ…" : "Đồng bộ bình luận"}
                isLoading={isSyncing}
                isDisabled={isSyncing || readOnlyReason !== null}
                tooltip={readOnlyReason ?? undefined}
                onClick={onSync}
              />
            }
          />
        </Stack>
      );
    }

    if (emptyKind === "done") {
      return (
        <Stack direction="vertical" padding={4}>
          <EmptyState
            kind="done"
            title="Đã trả lời hết"
            description="Không còn bình luận nào đang chờ trả lời. Bạn có thể xem lại các bình luận đã trả lời hoặc đồng bộ để kiểm tra bình luận mới."
            action={
              <HStack gap={2} wrap="wrap">
                {counts.replied > 0 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    label={`Xem ${counts.replied} bình luận đã trả lời`}
                    onClick={() => onSwitchStatus("replied")}
                  />
                ) : null}
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  label={isSyncing ? "Đang đồng bộ…" : "Đồng bộ bình luận"}
                  isLoading={isSyncing}
                  isDisabled={isSyncing || readOnlyReason !== null}
                  tooltip={readOnlyReason ?? undefined}
                  onClick={onSync}
                />
              </HStack>
            }
          />
        </Stack>
      );
    }

    return (
      <Stack direction="vertical" padding={4}>
        <EmptyState
          kind="no-result"
          title="Không có bình luận nào khớp bộ lọc"
          description="Không tìm thấy bình luận phù hợp với trạng thái, kiểm duyệt, kênh hoặc từ khoá đang chọn. Dữ liệu vẫn còn nguyên — xoá bộ lọc để xem lại."
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
      </Stack>
    );
  }

  // Populated list (with stale alert if a background refresh or pagination failed).
  const staleErrorView = isError ? presentCommentApiError(error) : null;

  return (
    <Stack direction="vertical" gap={0}>
      {staleErrorView ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
          {staleErrorView.kind === "reconnect" ? (
            <PermissionMissingNotice description={staleErrorView.apiError.userMessage} />
          ) : (
            <Banner
              role="alert"
              status="warning"
              title="Danh sách bên dưới có thể đã cũ — chưa làm mới được"
              description={
                staleErrorView.kind === "auth"
                  ? staleErrorView.description
                  : staleErrorView.kind === "rate-limit"
                    ? `${staleErrorView.description} ${staleErrorView.hint ?? ""}`.trim()
                    : staleErrorView.canRetry
                      ? `${staleErrorView.description} Bấm Thử lại để cập nhật bình luận mới nhất.`
                      : staleErrorView.hint
                        ? `${staleErrorView.description} ${staleErrorView.hint}`
                        : staleErrorView.description
              }
              endContent={
                staleErrorView.kind === "auth" ? (
                  <Link href="/signin" isStandalone>
                    Đăng nhập lại
                  </Link>
                ) : staleErrorView.canRetry ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    label="Thử lại"
                    onClick={onRetry}
                  />
                ) : undefined
              }
            />
          )}
        </Stack>
      ) : null}

      {/* Bulk action bar mounted above the list strictly when at least one comment is selected */}
      {selection && selection.selectedIds.length > 0 && selection.bulkActionBar ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={2}>
          {selection.bulkActionBar}
        </Stack>
      ) : null}

      {/* Select-all header row for the current page */}
      {selection ? (
        <Stack direction="vertical" gap={0}>
          <HStack gap={3} align="center" justify="between" paddingInline={4} paddingBlock={2} wrap="wrap">
            <CheckboxInput
              label="Chọn tất cả trên trang này"
              size="sm"
              value={selection.pageStatus.checkboxValue}
              isDisabled={readOnlyReason !== null || selection.pageStatus.totalOnPage === 0}
              disabledMessage={readOnlyReason ?? undefined}
              onChange={() => selection.onToggleAllOnPage()}
            />
            <Text type="supporting" color="secondary">
              {selection.selectedIds.length > 0
                ? `Đã chọn ${selection.selectedIds.length}/${selection.maxSelection} bình luận`
                : `${selection.pageStatus.totalOnPage} bình luận trên trang này`}
            </Text>
          </HStack>
          <Divider />
        </Stack>
      ) : null}

      <Stack as="ul" role="list" direction="vertical" gap={0} padding={0}>
        {items.map((comment, idx) => {
          const rowState = getCommentRowState(rowStateById, comment.id);
          const isRowSelected = selection ? selection.isSelected(comment.id) : false;
          const rowContext = formatCommentAccessibleContext(comment);
          return (
            <CommentRow
              key={comment.id}
              comment={comment}
              nowMs={nowMs}
              readOnlyReason={readOnlyReason}
              leadingSlot={
                selection ? (
                  <CheckboxInput
                    label={`Chọn bình luận của ${rowContext}`}
                    isLabelHidden
                    size="sm"
                    value={isRowSelected}
                    isDisabled={
                      readOnlyReason !== null || (!isRowSelected && selection.isAtMax)
                    }
                    disabledMessage={
                      readOnlyReason ??
                      `Đã đạt giới hạn ${selection.maxSelection} bình luận mỗi lượt.`
                    }
                    onChange={() => selection.onToggle(comment.id)}
                  />
                ) : undefined
              }
              showDivider={idx < items.length - 1}
              isGenerating={rowState.isGenerating}
              isSaving={rowState.isSaving}
              isSending={rowState.isSending}
              isTogglingIgnore={rowState.isTogglingIgnore}
              isTogglingHide={rowState.isTogglingHide}
              checkResult={rowState.checkResult}
              draftError={rowState.draftError}
              sendError={rowState.sendError}
              rowActionError={rowState.rowActionError}
              successMessage={rowState.successMessage}
              onGenerateDraft={() => onGenerateDraft(comment.id)}
              onSaveDraft={(text) => onSaveDraft(comment.id, text)}
              onSendReply={(text) => onSendReply(comment.id, text)}
              onTextEdited={onTextEdited ? () => onTextEdited(comment.id) : undefined}
              onIgnore={() => onIgnore(comment.id)}
              onUnignore={() => onUnignore(comment.id)}
              onToggleHide={(hidden) => onToggleHide(comment.id, hidden)}
            />
          );
        })}
      </Stack>

      <HStack gap={3} padding={4} align="center" justify="center">
        <Text type="supporting" role="status" aria-live="polite">
          Đang hiển thị {items.length.toLocaleString("vi-VN")} bình luận
          {hasNextPage ? " (còn bình luận cũ hơn)" : ""}.
        </Text>
        {hasNextPage ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            label={isFetchingNextPage ? "Đang tải thêm…" : "Tải thêm"}
            isLoading={isFetchingNextPage}
            isDisabled={isFetchingNextPage}
            onClick={onLoadMore}
          />
        ) : null}
      </HStack>
    </Stack>
  );
}
