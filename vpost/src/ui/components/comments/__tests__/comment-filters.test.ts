import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMENT_FILTER,
  buildCommentFilterKey,
  buildCommentSearchParams,
  buildCommentsUrl,
  parseCommentFilter,
  resolveCommentsEmptyKind,
  resolveNextTabFilter,
} from "@/ui/components/comments/comment-filters";
import {
  createInitialSelectionState,
  reconcileSelectionFilter,
  selectAllOnPage,
} from "@/ui/components/comments/moderation/selection-model";

describe("comment-filters URL builder and parser", () => {
  it("falls back to defaults on empty or invalid params including invalid moderation", () => {
    expect(parseCommentFilter(new URLSearchParams(""))).toEqual(DEFAULT_COMMENT_FILTER);
    expect(
      parseCommentFilter(
        new URLSearchParams("status=bogus&moderation=bogus&channelId=%20&q="),
      ),
    ).toEqual(DEFAULT_COMMENT_FILTER);
    expect(
      parseCommentFilter({ status: ["bad"], moderation: ["unknown"], postJobId: "   " }),
    ).toEqual(DEFAULT_COMMENT_FILTER);
  });

  it("parses valid status, moderation, channelId, postJobId and q", () => {
    expect(
      parseCommentFilter(
        new URLSearchParams(
          "status=replied&moderation=flagged&channelId=fb-123&postJobId=job-1&q=v%C3%A1y+hoa",
        ),
      ),
    ).toEqual({
      status: "replied",
      moderation: "flagged",
      channelId: "fb-123",
      postJobId: "job-1",
      q: "váy hoa",
    });

    expect(parseCommentFilter(new URLSearchParams("status=all&moderation=auto_hidden"))).toEqual({
      status: "all",
      moderation: "auto_hidden",
      channelId: null,
      postJobId: null,
      q: null,
    });

    expect(parseCommentFilter(new URLSearchParams("moderation=would_hide"))).toEqual({
      status: "unreplied",
      moderation: "would_hide",
      channelId: null,
      postJobId: null,
      q: null,
    });
  });

  it("omits defaults and never writes cursor to the URL through the single URL builder", () => {
    expect(buildCommentSearchParams(DEFAULT_COMMENT_FILTER).toString()).toBe("");
    expect(buildCommentsUrl(DEFAULT_COMMENT_FILTER)).toBe("/comments");

    const url = buildCommentsUrl({
      status: "unreplied",
      moderation: null,
      channelId: "fb-123",
      postJobId: "job-1",
      q: "size M",
    });
    expect(url).toBe("/comments?channelId=fb-123&postJobId=job-1&q=size+M");
    expect(url).not.toContain("status=");
    expect(url).not.toContain("moderation=");
    expect(url).not.toContain("cursor=");
  });

  it("writes non-default status and moderation values cleanly", () => {
    expect(
      buildCommentsUrl({ ...DEFAULT_COMMENT_FILTER, status: "replied" }),
    ).toBe("/comments?status=replied");
    expect(
      buildCommentsUrl({ ...DEFAULT_COMMENT_FILTER, status: "ignored" }),
    ).toBe("/comments?status=ignored");
    expect(
      buildCommentsUrl({ ...DEFAULT_COMMENT_FILTER, status: "all" }),
    ).toBe("/comments?status=all");
    expect(
      buildCommentsUrl({ ...DEFAULT_COMMENT_FILTER, moderation: "auto_hidden" }),
    ).toBe("/comments?moderation=auto_hidden");
    expect(
      buildCommentsUrl({ ...DEFAULT_COMMENT_FILTER, status: "replied", moderation: "flagged" }),
    ).toBe("/comments?status=replied&moderation=flagged");
  });

  it("changes filterKey on any filter change so selection clears cleanly", () => {
    const initialKey = buildCommentFilterKey(DEFAULT_COMMENT_FILTER);
    let sel = createInitialSelectionState(initialKey);
    sel = selectAllOnPage(sel, ["c1", "c2"]);
    expect(sel.selectedIds).toEqual(["c1", "c2"]);

    const modKey = buildCommentFilterKey({
      ...DEFAULT_COMMENT_FILTER,
      moderation: "auto_hidden",
    });
    expect(modKey).not.toBe(initialKey);
    const cleared = reconcileSelectionFilter(sel, modKey);
    expect(cleared.selectedIds).toEqual([]);
  });

  it("distinguishes first-run, all-done, and no-result empty states including moderation filters", () => {
    expect(
      resolveCommentsEmptyKind({
        counts: { unreplied: 0, replied: 0, ignored: 0, autoHidden: 0, flagged: 0 },
        filter: DEFAULT_COMMENT_FILTER,
      }),
    ).toBe("first-run");

    expect(
      resolveCommentsEmptyKind({
        counts: { unreplied: 0, replied: 0, ignored: 0, autoHidden: 0, flagged: 0 },
        filter: { ...DEFAULT_COMMENT_FILTER, q: "áo dài" },
      }),
    ).toBe("no-result");

    expect(
      resolveCommentsEmptyKind({
        counts: { unreplied: 0, replied: 0, ignored: 0, autoHidden: 0, flagged: 0 },
        filter: { ...DEFAULT_COMMENT_FILTER, moderation: "auto_hidden" },
      }),
    ).toBe("no-result");

    expect(
      resolveCommentsEmptyKind({
        counts: { unreplied: 0, replied: 4, ignored: 1, autoHidden: 0, flagged: 0 },
        filter: DEFAULT_COMMENT_FILTER,
      }),
    ).toBe("done");

    expect(
      resolveCommentsEmptyKind({
        counts: { unreplied: 0, replied: 4, ignored: 1, autoHidden: 0, flagged: 1 },
        filter: { ...DEFAULT_COMMENT_FILTER, moderation: "flagged" },
      }),
    ).toBe("no-result");

    expect(
      resolveCommentsEmptyKind({
        counts: { unreplied: 0, replied: 4, ignored: 0, autoHidden: 0, flagged: 0 },
        filter: { ...DEFAULT_COMMENT_FILTER, status: "ignored" },
      }),
    ).toBe("no-result");

    expect(
      resolveCommentsEmptyKind({
        counts: { unreplied: 0, replied: 2, ignored: 0, autoHidden: 0, flagged: 0 },
        filter: { ...DEFAULT_COMMENT_FILTER, q: "váy" },
      }),
    ).toBe("no-result");
  });

  it("validates tab status changes through CommentFilterStatusSchema and ignores invalid values", () => {
    const base = { ...DEFAULT_COMMENT_FILTER, channelId: "fb-1" };
    expect(resolveNextTabFilter(base, "replied")).toEqual({ ...base, status: "replied" });
    expect(resolveNextTabFilter(base, "ignored")).toEqual({ ...base, status: "ignored" });
    expect(resolveNextTabFilter(base, "all")).toEqual({ ...base, status: "all" });
    expect(resolveNextTabFilter(base, "unreplied")).toEqual({ ...base, status: "unreplied" });
    expect(resolveNextTabFilter(base, "bogus")).toBeNull();
    expect(resolveNextTabFilter(base, "")).toBeNull();
  });
});
