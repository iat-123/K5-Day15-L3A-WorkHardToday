import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
} from "@/ui/components/comments/moderation/selection-model";
import { useCommentSelection } from "@/ui/components/comments/moderation/useCommentSelection";
import { BULK_SELECTION_MAX } from "@/ui/schemas/moderation.schema";

describe("selection-model (pure)", () => {
  it("selects, deselects, and toggles unique trimmed IDs", () => {
    let state = createInitialSelectionState("status=unreplied");
    state = selectComment(state, " c1 ");
    state = selectComment(state, "c1");
    state = selectComment(state, "   ");
    state = selectComment(state, "c2");
    expect(state.selectedIds).toEqual(["c1", "c2"]);

    state = deselectComment(state, "c1");
    expect(state.selectedIds).toEqual(["c2"]);

    state = toggleCommentSelection(state, "c2");
    expect(state.selectedIds).toEqual([]);

    state = toggleCommentSelection(state, "c3");
    expect(state.selectedIds).toEqual(["c3"]);
  });

  it("selects and deselects all items on the current page and reports indeterminate status", () => {
    const page1 = ["c1", "c2", "c3"];
    let state = createInitialSelectionState("status=unreplied");

    expect(getPageSelectionStatus(state.selectedIds, page1)).toEqual({
      totalOnPage: 3,
      selectedOnPageCount: 0,
      allSelected: false,
      someSelected: false,
      checkboxValue: false,
    });

    state = selectComment(state, "c2");
    expect(getPageSelectionStatus(state.selectedIds, page1).checkboxValue).toBe(
      "indeterminate",
    );

    state = selectAllOnPage(state, page1);
    expect(state.selectedIds).toEqual(["c2", "c1", "c3"]);
    expect(getPageSelectionStatus(state.selectedIds, page1).checkboxValue).toBe(true);

    // Toggle all when all selected deselects the current page while keeping other-page selections
    state = selectComment(state, "other-page-id");
    state = toggleAllOnPage(state, page1);
    expect(state.selectedIds).toEqual(["other-page-id"]);

    state = deselectAllOnPage(selectAllOnPage(state, page1), page1);
    expect(state.selectedIds).toEqual(["other-page-id"]);
  });

  it("enforces max 50 selection cap on single select and select-all", () => {
    const fiftyFiveIds = Array.from({ length: 55 }, (_, i) => `c${i + 1}`);
    let state = createInitialSelectionState("status=all");

    state = selectAllOnPage(state, fiftyFiveIds);
    expect(state.selectedIds).toHaveLength(BULK_SELECTION_MAX);
    expect(state.cappedAtMax).toBe(true);

    // Adding a 51st comment does not exceed max 50
    const next = selectComment(state, "c51");
    expect(next.selectedIds).toHaveLength(BULK_SELECTION_MAX);
    expect(next.selectedIds).not.toContain("c51");
    expect(next.cappedAtMax).toBe(true);

    // Deselecting clears the cap warning and lets a new item be selected
    const afterRemove = deselectComment(next, "c1");
    expect(afterRemove.selectedIds).toHaveLength(BULK_SELECTION_MAX - 1);
    expect(afterRemove.cappedAtMax).toBe(false);

    const afterAdd = selectComment(afterRemove, "c51");
    expect(afterAdd.selectedIds).toHaveLength(BULK_SELECTION_MAX);
    expect(afterAdd.selectedIds).toContain("c51");
  });

  it("clears selection whenever the filter changes and preserves it when unchanged", () => {
    let state = createInitialSelectionState("status=unreplied");
    state = selectAllOnPage(state, ["c1", "c2"]);

    const unchanged = reconcileSelectionFilter(state, "status=unreplied");
    expect(unchanged).toBe(state);
    expect(unchanged.selectedIds).toEqual(["c1", "c2"]);

    const changed = reconcileSelectionFilter(state, "status=replied&q=abc");
    expect(changed.selectedIds).toEqual([]);
    expect(changed.filterKey).toBe("status=replied&q=abc");
    expect(changed.cappedAtMax).toBe(false);

    expect(clearSelection(state).selectedIds).toEqual([]);
  });

  it("keeps failed items and rate-limited notProcessed items selected after a bulk run while clearing succeeded ones", () => {
    let state = createInitialSelectionState("status=unreplied");
    state = selectAllOnPage(state, ["c1", "c2", "c3", "c4"]);

    const afterMixed = applyBulkRunResult(state, {
      results: [
        { id: "c1", ok: true },
        { id: "c2", ok: false, code: "FORBIDDEN", message: "Page-own comment" },
        { id: "c3", ok: true },
        { id: "c4", ok: false, code: "NOT_FOUND", message: "Missing" },
      ],
      notProcessed: [],
    });
    expect(afterMixed.selectedIds).toEqual(["c2", "c4"]);

    const afterRateLimit = applyBulkRunResult(state, {
      results: [
        { id: "c1", ok: true },
        { id: "c2", ok: false, code: "RATE_LIMITED", message: "Rate limited" },
      ],
      notProcessed: ["c3", "c4"],
    });
    expect(afterRateLimit.selectedIds).toEqual(["c2", "c3", "c4"]);

    const afterAllOk = applyBulkRunResult(state, {
      results: [
        { id: "c1", ok: true },
        { id: "c2", ok: true },
        { id: "c3", ok: true },
        { id: "c4", ok: true },
      ],
      notProcessed: [],
    });
    expect(afterAllOk.selectedIds).toEqual([]);
  });
});

describe("useCommentSelection hook", () => {
  it("renders cleanly in React and exposes initial selection & page status", () => {
    function Probe({ pageIds, filterKey }: { pageIds: string[]; filterKey: string }) {
      const selection = useCommentSelection({ pageIds, filterKey });
      return createElement(
        "span",
        {
          "data-count": selection.selectedCount,
          "data-max": selection.maxSelection,
          "data-page-total": selection.pageStatus.totalOnPage,
          "data-all": String(selection.pageStatus.allSelected),
        },
        `${selection.selectedCount}/${selection.maxSelection}`,
      );
    }

    const html = renderToStaticMarkup(
      createElement(Probe, { pageIds: ["c1", "c2", "c3"], filterKey: "status=unreplied" }),
    );
    expect(html).toContain('data-count="0"');
    expect(html).toContain('data-max="50"');
    expect(html).toContain('data-page-total="3"');
    expect(html).toContain('data-all="false"');
  });
});
