import {
  BULK_SELECTION_MAX,
  type BulkCommentsResponse,
} from "@/ui/schemas/moderation.schema";

/**
 * Pure comment bulk-selection state machine.
 * Enforces unique non-empty IDs, max 50 selection cap, page select-all,
 * filter-change reset, and keeping failed / unprocessed items selected after a bulk run.
 */

export interface CommentSelectionState {
  readonly selectedIds: readonly string[];
  readonly filterKey: string;
  /** True when the last add/select-all hit `BULK_SELECTION_MAX`. */
  readonly cappedAtMax: boolean;
}

export interface PageSelectionStatus {
  readonly totalOnPage: number;
  readonly selectedOnPageCount: number;
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  readonly checkboxValue: boolean | "indeterminate";
}

function cleanId(raw: string): string {
  return raw.trim();
}

function uniqueCleanIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = cleanId(raw);
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function createInitialSelectionState(filterKey = ""): CommentSelectionState {
  return {
    selectedIds: [],
    filterKey,
    cappedAtMax: false,
  };
}

export function selectComment(
  state: CommentSelectionState,
  commentId: string,
  maxSelection = BULK_SELECTION_MAX,
): CommentSelectionState {
  const id = cleanId(commentId);
  if (id.length === 0) return state;
  if (state.selectedIds.includes(id)) return state;
  if (state.selectedIds.length >= maxSelection) {
    return state.cappedAtMax ? state : { ...state, cappedAtMax: true };
  }
  return {
    ...state,
    selectedIds: [...state.selectedIds, id],
    cappedAtMax: false,
  };
}

export function deselectComment(
  state: CommentSelectionState,
  commentId: string,
): CommentSelectionState {
  const id = cleanId(commentId);
  if (id.length === 0 || !state.selectedIds.includes(id)) return state;
  return {
    ...state,
    selectedIds: state.selectedIds.filter((existing) => existing !== id),
    cappedAtMax: false,
  };
}

export function toggleCommentSelection(
  state: CommentSelectionState,
  commentId: string,
  maxSelection = BULK_SELECTION_MAX,
): CommentSelectionState {
  const id = cleanId(commentId);
  if (id.length === 0) return state;
  return state.selectedIds.includes(id)
    ? deselectComment(state, id)
    : selectComment(state, id, maxSelection);
}

/**
 * Selects all unique IDs on the current page up to `maxSelection` (50).
 * Sets `cappedAtMax` when at least one unselected page ID could not fit.
 */
export function selectAllOnPage(
  state: CommentSelectionState,
  pageIds: readonly string[],
  maxSelection = BULK_SELECTION_MAX,
): CommentSelectionState {
  const cleanedPageIds = uniqueCleanIds(pageIds);
  if (cleanedPageIds.length === 0) return state;

  const existing = new Set(state.selectedIds);
  const next = [...state.selectedIds];
  let capped = false;

  for (const id of cleanedPageIds) {
    if (existing.has(id)) continue;
    if (next.length >= maxSelection) {
      capped = true;
      break;
    }
    existing.add(id);
    next.push(id);
  }

  if (next.length === state.selectedIds.length && capped === state.cappedAtMax) {
    return state;
  }

  return {
    ...state,
    selectedIds: next,
    cappedAtMax: capped,
  };
}

export function deselectAllOnPage(
  state: CommentSelectionState,
  pageIds: readonly string[],
): CommentSelectionState {
  const pageSet = new Set(uniqueCleanIds(pageIds));
  if (pageSet.size === 0 || state.selectedIds.length === 0) return state;

  const next = state.selectedIds.filter((id) => !pageSet.has(id));
  if (next.length === state.selectedIds.length && !state.cappedAtMax) return state;

  return {
    ...state,
    selectedIds: next,
    cappedAtMax: false,
  };
}

/**
 * Toggles all IDs on the current page: deselects them if every page item is
 * already selected; otherwise selects up to the max cap.
 */
export function toggleAllOnPage(
  state: CommentSelectionState,
  pageIds: readonly string[],
  maxSelection = BULK_SELECTION_MAX,
): CommentSelectionState {
  const status = getPageSelectionStatus(state.selectedIds, pageIds);
  if (status.totalOnPage === 0) return state;
  return status.allSelected
    ? deselectAllOnPage(state, pageIds)
    : selectAllOnPage(state, pageIds, maxSelection);
}

export function clearSelection(state: CommentSelectionState): CommentSelectionState {
  if (state.selectedIds.length === 0 && !state.cappedAtMax) return state;
  return {
    ...state,
    selectedIds: [],
    cappedAtMax: false,
  };
}

/** Clears selection whenever the active filter key changes. */
export function reconcileSelectionFilter(
  state: CommentSelectionState,
  nextFilterKey: string,
): CommentSelectionState {
  if (state.filterKey === nextFilterKey) return state;
  return {
    selectedIds: [],
    filterKey: nextFilterKey,
    cappedAtMax: false,
  };
}

/**
 * Updates selection after a bulk run finishes:
 * - Removes items that succeeded (`ok: true`)
 * - Keeps items that failed (`ok: false`) selected
 * - Keeps items left in `notProcessed` (rate-limited stop) selected for retry
 */
export function applyBulkRunResult(
  state: CommentSelectionState,
  result: Pick<BulkCommentsResponse, "results" | "notProcessed">,
  maxSelection = BULK_SELECTION_MAX,
): CommentSelectionState {
  const succeeded = new Set<string>();
  const failedIds: string[] = [];

  for (const item of result.results) {
    const id = cleanId(item.id);
    if (id.length === 0) continue;
    if (item.ok) {
      succeeded.add(id);
    } else {
      failedIds.push(id);
    }
  }

  const remaining: string[] = [];
  const seen = new Set<string>();

  const appendIfEligible = (raw: string) => {
    const id = cleanId(raw);
    if (id.length === 0 || succeeded.has(id) || seen.has(id)) return;
    if (remaining.length >= maxSelection) return;
    seen.add(id);
    remaining.push(id);
  };

  // Preserve operator's original selection order first, then ensure any failed
  // or unprocessed IDs from the server response remain selected.
  for (const id of state.selectedIds) appendIfEligible(id);
  for (const id of failedIds) appendIfEligible(id);
  for (const id of result.notProcessed) appendIfEligible(id);

  return {
    ...state,
    selectedIds: remaining,
    cappedAtMax: false,
  };
}

export function getPageSelectionStatus(
  selectedIds: readonly string[],
  pageIds: readonly string[],
): PageSelectionStatus {
  const uniquePage = uniqueCleanIds(pageIds);
  const totalOnPage = uniquePage.length;
  if (totalOnPage === 0) {
    return {
      totalOnPage: 0,
      selectedOnPageCount: 0,
      allSelected: false,
      someSelected: false,
      checkboxValue: false,
    };
  }

  const selectedSet = new Set(selectedIds);
  let selectedOnPageCount = 0;
  for (const id of uniquePage) {
    if (selectedSet.has(id)) selectedOnPageCount += 1;
  }

  const allSelected = selectedOnPageCount === totalOnPage;
  const someSelected = selectedOnPageCount > 0 && !allSelected;
  const checkboxValue: boolean | "indeterminate" = allSelected
    ? true
    : someSelected
      ? "indeterminate"
      : false;

  return {
    totalOnPage,
    selectedOnPageCount,
    allSelected,
    someSelected,
    checkboxValue,
  };
}
