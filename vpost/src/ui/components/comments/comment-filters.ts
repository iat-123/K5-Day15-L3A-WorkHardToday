import {
  MODERATION_FILTER_PARAM,
  ModerationFilterSchema,
  parseModerationFilter,
} from "@/ui/components/comments/moderation/moderation-filters";
import {
  COMMENT_FILTER_STATUSES,
  CommentFilterStatusSchema,
  totalCommentCount,
  type CommentCounts,
  type CommentFilter,
  type CommentFilterStatus,
} from "@/ui/schemas/comment.schema";

/**
 * URL filter rules for `/comments`. One parser, one URL builder; defaults are
 * omitted from the URL and invalid values fall back to defaults.
 */

export const COMMENT_FILTER_TABS = COMMENT_FILTER_STATUSES;

export const DEFAULT_COMMENT_STATUS: CommentFilterStatus = "unreplied";

export const DEFAULT_COMMENT_FILTER: CommentFilter = {
  status: DEFAULT_COMMENT_STATUS,
  moderation: null,
  channelId: null,
  postJobId: null,
  q: null,
};

export const COMMENT_TAB_LABELS: Record<CommentFilterStatus, string> = {
  unreplied: "Chưa trả lời",
  replied: "Đã trả lời",
  ignored: "Bỏ qua",
  all: "Tất cả",
};

function readParam(
  params: URLSearchParams | Readonly<Record<string, string | string[] | undefined>>,
  key: string,
): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const raw = params[key];
  if (typeof raw === "string") return raw;
  return Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null;
}

function cleanOptional(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Validates a raw tab value via `CommentFilterStatusSchema` without unsafe casts. */
export function resolveNextTabFilter(
  current: CommentFilter,
  value: string,
): CommentFilter | null {
  const parsed = CommentFilterStatusSchema.safeParse(value);
  if (!parsed.success) return null;
  return { ...current, status: parsed.data };
}

/** Parses `?status=&moderation=&channelId=&postJobId=&q=`; invalid values fall back to defaults. */
export function parseCommentFilter(
  params: URLSearchParams | Readonly<Record<string, string | string[] | undefined>>,
): CommentFilter {
  const parsedStatus = CommentFilterStatusSchema.safeParse(readParam(params, "status")?.trim());
  return {
    status: parsedStatus.success ? parsedStatus.data : DEFAULT_COMMENT_STATUS,
    moderation: parseModerationFilter(params),
    channelId: cleanOptional(readParam(params, "channelId")),
    postJobId: cleanOptional(readParam(params, "postJobId")),
    q: cleanOptional(readParam(params, "q")),
  };
}

/**
 * Single query-string builder for `/comments`.
 * Defaults are never written; `cursor` is omitted so filter changes reset pagination.
 */
export function buildCommentSearchParams(filter: CommentFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.status !== DEFAULT_COMMENT_STATUS) {
    params.set("status", filter.status);
  }
  const parsedModeration = filter.moderation
    ? ModerationFilterSchema.safeParse(filter.moderation)
    : null;
  if (parsedModeration?.success) {
    params.set(MODERATION_FILTER_PARAM, parsedModeration.data);
  }
  const channelId = cleanOptional(filter.channelId);
  if (channelId) params.set("channelId", channelId);
  const postJobId = cleanOptional(filter.postJobId);
  if (postJobId) params.set("postJobId", postJobId);
  const q = cleanOptional(filter.q);
  if (q) params.set("q", q);
  return params;
}

/** Builds the canonical `/comments` URL for a filter state. */
export function buildCommentsUrl(filter: CommentFilter, pathname = "/comments"): string {
  const query = buildCommentSearchParams(filter).toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}

/** Canonical filter signature used to reset bulk selection whenever any filter changes. */
export function buildCommentFilterKey(filter: CommentFilter): string {
  return buildCommentSearchParams(filter).toString();
}

/** True when any non-status filter is narrowing the list. */
export function hasNarrowingCommentFilters(filter: CommentFilter): boolean {
  return (
    filter.moderation !== null ||
    filter.channelId !== null ||
    filter.postJobId !== null ||
    filter.q !== null
  );
}

/** True when the filter differs from the default inbox view. */
export function hasActiveCommentFilters(filter: CommentFilter): boolean {
  return filter.status !== DEFAULT_COMMENT_STATUS || hasNarrowingCommentFilters(filter);
}

/** Distinguishes first-run, all-done, and filter no-result empty states. */
export function resolveCommentsEmptyKind(input: {
  counts: CommentCounts;
  filter: CommentFilter;
}): "first-run" | "done" | "no-result" {
  const total = totalCommentCount(input.counts);
  if (total === 0) {
    return hasNarrowingCommentFilters(input.filter) ? "no-result" : "first-run";
  }
  if (
    input.filter.status === "unreplied" &&
    input.counts.unreplied === 0 &&
    !input.filter.q &&
    input.filter.moderation === null
  ) {
    return "done";
  }
  return "no-result";
}
