"use client";

import { useCallback, useMemo, useState } from "react";

import {
  BULK_SELECTION_MAX,
  type BulkCommentsResponse,
} from "@/ui/schemas/moderation.schema";

import {
  applyBulkRunResult,
  clearSelection,
  createInitialSelectionState,
  deselectAllOnPage,
  deselectComment,
  getPageSelectionStatus,
  reconcileSelectionFilter,
  selectAllOnPage,
  selectComment,
  toggleAllOnPage,
  toggleCommentSelection,
  type CommentSelectionState,
  type PageSelectionStatus,
} from "./selection-model";

export interface UseCommentSelectionOptions {
  /** IDs currently rendered on the active page (for select-all / indeterminate state). */
  readonly pageIds: readonly string[];
  /**
   * Serialized filter signature (e.g. `buildCommentsUrl(filter)` or `searchParams.toString()`).
   * Whenever this string changes, selection clears synchronously.
   */
  readonly filterKey: string;
  /** Maximum selectable comments per bulk run (defaults to 50). */
  readonly maxSelection?: number;
}

export interface UseCommentSelectionResult {
  readonly selectedIds: readonly string[];
  readonly selectedSet: ReadonlySet<string>;
  readonly selectedCount: number;
  readonly maxSelection: number;
  readonly isAtMax: boolean;
  readonly cappedAtMax: boolean;
  readonly pageStatus: PageSelectionStatus;
  readonly isSelected: (commentId: string) => boolean;
  readonly select: (commentId: string) => void;
  readonly deselect: (commentId: string) => void;
  readonly toggle: (commentId: string) => void;
  readonly selectAllOnPage: () => void;
  readonly deselectAllOnPage: () => void;
  readonly toggleAllOnPage: () => void;
  readonly clear: () => void;
  readonly applyBulkResult: (
    result: Pick<BulkCommentsResponse, "results" | "notProcessed">,
  ) => void;
}

/**
 * Stateful hook wrapping the pure `selection-model` transitions.
 * Synchronously clears selection on filter change without an effect cascade.
 */
export function useCommentSelection({
  pageIds,
  filterKey,
  maxSelection = BULK_SELECTION_MAX,
}: UseCommentSelectionOptions): UseCommentSelectionResult {
  const [state, setState] = useState<CommentSelectionState>(() =>
    createInitialSelectionState(filterKey),
  );

  // Synchronous render-time reset when the filter key changes (React 19 pattern).
  let currentState = state;
  if (state.filterKey !== filterKey) {
    const next = reconcileSelectionFilter(state, filterKey);
    setState(next);
    currentState = next;
  }

  const selectedSet = useMemo(
    () => new Set(currentState.selectedIds),
    [currentState.selectedIds],
  );

  const pageStatus = useMemo(
    () => getPageSelectionStatus(currentState.selectedIds, pageIds),
    [currentState.selectedIds, pageIds],
  );

  const isSelected = useCallback(
    (commentId: string) => selectedSet.has(commentId.trim()),
    [selectedSet],
  );

  const select = useCallback(
    (commentId: string) => {
      setState((prev) => selectComment(prev, commentId, maxSelection));
    },
    [maxSelection],
  );

  const deselect = useCallback((commentId: string) => {
    setState((prev) => deselectComment(prev, commentId));
  }, []);

  const toggle = useCallback(
    (commentId: string) => {
      setState((prev) => toggleCommentSelection(prev, commentId, maxSelection));
    },
    [maxSelection],
  );

  const handleSelectAllOnPage = useCallback(() => {
    setState((prev) => selectAllOnPage(prev, pageIds, maxSelection));
  }, [pageIds, maxSelection]);

  const handleDeselectAllOnPage = useCallback(() => {
    setState((prev) => deselectAllOnPage(prev, pageIds));
  }, [pageIds]);

  const handleToggleAllOnPage = useCallback(() => {
    setState((prev) => toggleAllOnPage(prev, pageIds, maxSelection));
  }, [pageIds, maxSelection]);

  const clear = useCallback(() => {
    setState((prev) => clearSelection(prev));
  }, []);

  const applyBulkResult = useCallback(
    (result: Pick<BulkCommentsResponse, "results" | "notProcessed">) => {
      setState((prev) => applyBulkRunResult(prev, result, maxSelection));
    },
    [maxSelection],
  );

  return {
    selectedIds: currentState.selectedIds,
    selectedSet,
    selectedCount: currentState.selectedIds.length,
    maxSelection,
    isAtMax: currentState.selectedIds.length >= maxSelection,
    cappedAtMax: currentState.cappedAtMax,
    pageStatus,
    isSelected,
    select,
    deselect,
    toggle,
    selectAllOnPage: handleSelectAllOnPage,
    deselectAllOnPage: handleDeselectAllOnPage,
    toggleAllOnPage: handleToggleAllOnPage,
    clear,
    applyBulkResult,
  };
}
