"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import {
  COMMENT_DEFAULT_LIMIT,
  type CommentFilter,
  type CommentListResponse,
  type CommentMutationResponse,
  type CommentPatchDraftResponse,
  type CommentSyncResponse,
} from "@/ui/schemas/comment.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  commentKeys,
  generateCommentDraft,
  ignoreComment,
  listComments,
  saveCommentDraft,
  sendCommentReply,
  setCommentHidden,
  syncComments,
  unignoreComment,
  type SyncCommentsParams,
} from "@/ui/services/comment.api";
import { moderationKeys } from "@/ui/services/moderation.api";

export { commentKeys };

function useInvalidateComments() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return () => {
    void queryClient.invalidateQueries({ queryKey: commentKeys.all(tenantKey) });
  };
}

/**
 * Cursor-paged customer comment list. Changing any filter changes the query key,
 * which resets the cursor to the first page automatically.
 */
export function useCommentsList(filter: CommentFilter) {
  const { tenantKey, isResolved } = useActiveTenant();

  return useInfiniteQuery<CommentListResponse, ApiError>({
    queryKey: commentKeys.list(tenantKey, filter),
    queryFn: ({ pageParam, signal }) =>
      listComments(
        {
          status: filter.status === "all" ? null : filter.status,
          moderation: filter.moderation,
          channelId: filter.channelId,
          postJobId: filter.postJobId,
          q: filter.q,
          cursor: typeof pageParam === "string" ? pageParam : null,
          limit: COMMENT_DEFAULT_LIMIT,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isResolved,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 10_000,
  });
}

export function useSyncComments() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<CommentSyncResponse, ApiError, SyncCommentsParams | undefined>({
    mutationFn: (params) => syncComments(params ?? {}),
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: commentKeys.all(tenantKey) });
      void queryClient.invalidateQueries({ queryKey: moderationKeys.all(tenantKey) });
    },
  });
}

export function useGenerateCommentDraft() {
  const invalidate = useInvalidateComments();

  return useMutation<CommentMutationResponse, ApiError, { commentId: string }>({
    mutationFn: ({ commentId }) => generateCommentDraft(commentId),
    retry: false,
    onSettled: invalidate,
  });
}

export function useSaveCommentDraft() {
  const invalidate = useInvalidateComments();

  return useMutation<CommentPatchDraftResponse, ApiError, { commentId: string; text: string }>({
    mutationFn: (params) => saveCommentDraft(params),
    retry: false,
    onSettled: invalidate,
  });
}

/** Sends a reply to Facebook. Never auto-retried; invalidates list + counts even on 409/error. */
export function useSendCommentReply() {
  const invalidate = useInvalidateComments();

  return useMutation<CommentMutationResponse, ApiError, { commentId: string; text: string }>({
    mutationFn: (params) => sendCommentReply(params),
    retry: false,
    onSettled: invalidate,
  });
}

export function useIgnoreComment() {
  const invalidate = useInvalidateComments();

  return useMutation<CommentMutationResponse, ApiError, { commentId: string }>({
    mutationFn: ({ commentId }) => ignoreComment(commentId),
    retry: false,
    onSettled: invalidate,
  });
}

export function useUnignoreComment() {
  const invalidate = useInvalidateComments();

  return useMutation<CommentMutationResponse, ApiError, { commentId: string }>({
    mutationFn: ({ commentId }) => unignoreComment(commentId),
    retry: false,
    onSettled: invalidate,
  });
}

export function useSetCommentHidden() {
  const invalidate = useInvalidateComments();

  return useMutation<CommentMutationResponse, ApiError, { commentId: string; hidden: boolean }>({
    mutationFn: (params) => setCommentHidden(params),
    retry: false,
    onSettled: invalidate,
  });
}
