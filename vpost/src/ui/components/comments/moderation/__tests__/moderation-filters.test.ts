import { describe, expect, it } from "vitest";

import {
  MODERATION_FILTER_VALUES,
  applyModerationFilterParam,
  buildCommentsUrlWithModeration,
  matchesModerationFilter,
  parseModerationFilter,
} from "@/ui/components/comments/moderation/moderation-filters";
import type { CommentModeration } from "@/ui/schemas/moderation.schema";

describe("moderation-filters", () => {
  it("parses valid moderation query values and falls back to null on absent or invalid values", () => {
    for (const value of MODERATION_FILTER_VALUES) {
      expect(parseModerationFilter(new URLSearchParams(`moderation=${value}`))).toBe(value);
      expect(parseModerationFilter({ moderation: ` ${value} ` })).toBe(value);
    }

    expect(parseModerationFilter(new URLSearchParams(""))).toBeNull();
    expect(parseModerationFilter(new URLSearchParams("moderation=bogus"))).toBeNull();
    expect(parseModerationFilter({ moderation: ["flagged", "auto_hidden"] })).toBe("flagged");
    expect(parseModerationFilter({ moderation: "" })).toBeNull();
  });

  it("writes non-default moderation filter to URL params and omits null/default", () => {
    const base = new URLSearchParams("status=replied&q=size");
    const withAuto = applyModerationFilterParam(base, "auto_hidden");
    expect(withAuto.toString()).toBe("status=replied&q=size&moderation=auto_hidden");
    // Does not mutate input
    expect(base.has("moderation")).toBe(false);

    const cleared = applyModerationFilterParam(withAuto, null);
    expect(cleared.toString()).toBe("status=replied&q=size");
  });

  it("composes onto comments URLs and drops cursor so pagination resets on filter change", () => {
    expect(buildCommentsUrlWithModeration("/comments", null)).toBe("/comments");
    expect(buildCommentsUrlWithModeration("/comments", "would_hide")).toBe(
      "/comments?moderation=would_hide",
    );
    expect(
      buildCommentsUrlWithModeration("/comments?status=all&cursor=20&q=spam", "flagged"),
    ).toBe("/comments?status=all&q=spam&moderation=flagged");
    expect(
      buildCommentsUrlWithModeration("/comments?moderation=flagged&cursor=40", null),
    ).toBe("/comments");
  });

  it("matches CommentModeration objects against the active moderation filter", () => {
    const sample: CommentModeration = {
      category: "spam",
      confidence: 1.0,
      reasons: ["lặp lại"],
      source: "rule",
      action: "auto_hidden",
      at: "2026-11-27T10:00:00.000Z",
    };

    expect(matchesModerationFilter(null, null)).toBe(true);
    expect(matchesModerationFilter(sample, null)).toBe(true);
    expect(matchesModerationFilter(sample, "auto_hidden")).toBe(true);
    expect(matchesModerationFilter(sample, "flagged")).toBe(false);
    expect(matchesModerationFilter(null, "flagged")).toBe(false);
  });
});
