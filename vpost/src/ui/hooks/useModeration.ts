"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import {
  MODERATION_LOG_DEFAULT_LIMIT,
  type BulkCommentsResponse,
  type ClassifyCommentResponse,
  type ModerationLogFilter,
  type ModerationLogResponse,
  type ModerationSettingsListResponse,
  type ModerationSettingUpdateInput,
  type ModerationSettingUpdateResponse,
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
  type RunBulkCommentActionParams,
} from "@/ui/services/moderation.api";

export { moderationKeys };

function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return ApiError.is(error) && error.isRetryable ? failureCount < 2 : false;
}

function retryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 5_000);
}

/** Invalidates comments list + counts and all moderation queries (settings + log) for a tenant. */
export function invalidateCommentsAndModeration(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  tenantKey: string,
): void {
  void queryClient.invalidateQueries({ queryKey: commentKeys.all(tenantKey) });
  void queryClient.invalidateQueries({ queryKey: moderationKeys.all(tenantKey) });
}

/**
 * Bulk moderation action mutation (`POST /api/comments/bulk`).
 * Never auto-retried; invalidates comment list, counts, and moderation queries on settle.
 */
export function useBulkCommentsAction() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<BulkCommentsResponse, ApiError, RunBulkCommentActionParams>({
    mutationFn: (params) => runBulkCommentAction(params),
    retry: false,
    onSettled: () => invalidateCommentsAndModeration(queryClient, tenantKey),
  });
}

/** Fetches per-Page auto-moderation settings (`GET /api/comments/moderation-settings`). */
export function useModerationSettings() {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<ModerationSettingsListResponse, ApiError>({
    queryKey: moderationKeys.settings(tenantKey),
    queryFn: ({ signal }) => listModerationSettings(signal),
    enabled: isResolved,
    retry: shouldRetryQuery,
    retryDelay,
    staleTime: 15_000,
  });
}

export interface UpdateModerationSettingVariables {
  readonly pageId: string;
  readonly input: ModerationSettingUpdateInput;
}

/** Updates one connected Page's auto-moderation setting (`PUT /api/comments/moderation-settings/{pageId}`). */
export function useUpdateModerationSetting() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<ModerationSettingUpdateResponse, ApiError, UpdateModerationSettingVariables>({
    mutationFn: ({ pageId, input }) => updateModerationSetting(pageId, input),
    retry: false,
    onSuccess: (data) => {
      queryClient.setQueryData<ModerationSettingsListResponse>(
        moderationKeys.settings(tenantKey),
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map((item) =>
              item.pageId === data.setting.pageId ? data.setting : item,
            ),
          };
        },
      );
    },
    onSettled: () => invalidateCommentsAndModeration(queryClient, tenantKey),
  });
}

/**
 * Cursor-paged moderation audit log (`GET /api/comments/moderation-log`).
 * Changing any filter changes the query key so pagination resets automatically.
 */
export function useModerationLog(
  filter: ModerationLogFilter,
  limit = MODERATION_LOG_DEFAULT_LIMIT,
) {
  const { tenantKey, isResolved } = useActiveTenant();

  return useInfiniteQuery<ModerationLogResponse, ApiError>({
    queryKey: moderationKeys.log(tenantKey, filter),
    queryFn: ({ pageParam, signal }) =>
      listModerationLog(
        {
          pageId: filter.pageId,
          action: filter.action,
          actor: filter.actor,
          cursor: typeof pageParam === "string" ? pageParam : null,
          limit,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isResolved,
    retry: shouldRetryQuery,
    retryDelay,
    staleTime: 10_000,
  });
}

/**
 * Undoes a hide log entry by calling bulk unhide (`POST /api/comments/bulk` with `action: "unhide"`).
 * Invalidates both the comments inbox and moderation log on settle.
 */
export function useUndoModerationHide() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<BulkCommentsResponse, ApiError, { commentId: string }>({
    mutationFn: ({ commentId }) =>
      runBulkCommentAction({ ids: [commentId], action: "unhide" }),
    retry: false,
    onSettled: () => invalidateCommentsAndModeration(queryClient, tenantKey),
  });
}

/** Re-runs classification for a single comment without taking any moderation action. */
export function useClassifyComment() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<ClassifyCommentResponse, ApiError, { commentId: string }>({
    mutationFn: ({ commentId }) => classifyComment(commentId),
    retry: false,
    onSettled: () => invalidateCommentsAndModeration(queryClient, tenantKey),
  });
}
