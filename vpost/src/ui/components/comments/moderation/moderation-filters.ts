import { z } from "zod";

import {
  MODERATION_ACTIONS,
  ModerationActionSchema,
  type CommentModeration,
} from "@/ui/schemas/moderation.schema";

/**
 * Pure URL filter helpers for the `moderation` query param (`auto_hidden | would_hide | flagged`).
 * Designed so `vpost/src/ui/components/comments/comment-filters.ts` can adopt it in a few lines
 * during the integration step without rewriting filter parsing or URL serialization.
 */

export const MODERATION_FILTER_PARAM = "moderation";

export const MODERATION_FILTER_VALUES = MODERATION_ACTIONS;
export const ModerationFilterSchema = ModerationActionSchema;
export type ModerationFilter = z.infer<typeof ModerationFilterSchema>;

export const MODERATION_FILTER_LABELS: Record<ModerationFilter, string> = {
  auto_hidden: "Tự ẩn",
  would_hide: "Sẽ ẩn (chạy thử)",
  flagged: "Cần xem",
};

export const MODERATION_FILTER_ALL_LABEL = "Tất cả kiểm duyệt";

type ParamSource =
  | URLSearchParams
  | Readonly<Record<string, string | string[] | undefined>>;

function readParam(params: ParamSource, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const raw = params[key];
  if (typeof raw === "string") return raw;
  return Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null;
}

/**
 * Parses `?moderation=auto_hidden|would_hide|flagged`.
 * Absent or invalid values fall back to `null` (default: no moderation filter).
 */
export function parseModerationFilter(params: ParamSource): ModerationFilter | null {
  const raw = readParam(params, MODERATION_FILTER_PARAM)?.trim();
  if (!raw) return null;
  const parsed = ModerationFilterSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Returns a new `URLSearchParams` with `moderation` set when valid, or omitted
 * when `null`/absent/invalid (defaults are never written to the URL).
 */
export function applyModerationFilterParam(
  params: URLSearchParams,
  moderation: ModerationFilter | null | undefined,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  const parsed = moderation ? ModerationFilterSchema.safeParse(moderation) : null;
  if (parsed?.success) {
    next.set(MODERATION_FILTER_PARAM, parsed.data);
  } else {
    next.delete(MODERATION_FILTER_PARAM);
  }
  return next;
}

/**
 * Convenience URL composer that layers `?moderation=` onto an existing comments URL
 * (such as the return value of `buildCommentsUrl(filter, pathname)`), while also
 * dropping `cursor` so changing the moderation filter resets pagination.
 */
export function buildCommentsUrlWithModeration(
  baseUrl: string,
  moderation: ModerationFilter | null | undefined,
): string {
  const qIndex = baseUrl.indexOf("?");
  const pathname = qIndex >= 0 ? baseUrl.slice(0, qIndex) : baseUrl;
  const initialQuery = qIndex >= 0 ? baseUrl.slice(qIndex + 1) : "";
  const params = applyModerationFilterParam(new URLSearchParams(initialQuery), moderation);
  params.delete("cursor");
  const qs = params.toString();
  return qs.length > 0 ? `${pathname}?${qs}` : pathname;
}

/** Matches a comment's moderation metadata against an active moderation filter. */
export function matchesModerationFilter(
  moderation: CommentModeration | null | undefined,
  filter: ModerationFilter | null,
): boolean {
  if (filter === null) return true;
  return moderation?.action === filter;
}
