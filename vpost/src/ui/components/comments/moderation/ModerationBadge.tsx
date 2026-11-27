"use client";

import { Badge, HStack, Text } from "@astryxdesign/core";
import { EyeOff, Flag, FlaskConical } from "lucide-react";

import {
  MODERATION_CATEGORY_LABELS,
  MODERATION_SOURCE_LABELS,
  type CommentModeration,
  type ModerationAction,
} from "@/ui/schemas/moderation.schema";

export interface ModerationBadgeProps {
  /** Moderation metadata on a comment (`auto_hidden`, `would_hide`, `flagged`, or `null`). */
  readonly moderation: CommentModeration | null | undefined;
  /** When true, renders the source, confidence, and classification reasons next to the badge. */
  readonly showDetails?: boolean;
}

const ACTION_BADGE_VARIANTS: Record<ModerationAction, "error" | "info" | "warning"> = {
  auto_hidden: "error",
  would_hide: "info",
  flagged: "warning",
};

/**
 * Formats the primary Vietnamese label for a comment's moderation badge:
 * - `auto_hidden` → `Tự ẩn · <category>`
 * - `would_hide`  → `Sẽ ẩn (chạy thử)`
 * - `flagged`     → `Cần xem`
 */
export function formatModerationBadgeLabel(
  moderation: Pick<CommentModeration, "action" | "category"> | null | undefined,
): string | null {
  if (!moderation || !moderation.action) return null;
  switch (moderation.action) {
    case "auto_hidden":
      return `Tự ẩn · ${MODERATION_CATEGORY_LABELS[moderation.category]}`;
    case "would_hide":
      return "Sẽ ẩn (chạy thử)";
    case "flagged":
      return "Cần xem";
  }
}

function actionIcon(action: ModerationAction) {
  switch (action) {
    case "auto_hidden":
      return <EyeOff aria-hidden="true" />;
    case "would_hide":
      return <FlaskConical aria-hidden="true" />;
    case "flagged":
      return <Flag aria-hidden="true" />;
  }
}

function formatModerationDetails(moderation: CommentModeration): string {
  const parts: string[] = [];
  if (moderation.action !== "auto_hidden") {
    parts.push(MODERATION_CATEGORY_LABELS[moderation.category]);
  }
  parts.push(
    `${MODERATION_SOURCE_LABELS[moderation.source]} (${Math.round(moderation.confidence * 100)}%)`,
  );
  const reasons = moderation.reasons
    .map((reason) => reason.trim())
    .filter((reason) => reason.length > 0);
  if (reasons.length > 0) {
    parts.push(reasons.join("; "));
  }
  return parts.join(" · ");
}

/**
 * Displays the automated moderation status badge on a comment row.
 * Renders nothing when the comment has no active moderation action.
 */
export function ModerationBadge({
  moderation,
  showDetails = false,
}: ModerationBadgeProps) {
  if (!moderation || !moderation.action) return null;

  const label = formatModerationBadgeLabel(moderation);
  if (!label) return null;

  const badge = (
    <Badge
      variant={ACTION_BADGE_VARIANTS[moderation.action]}
      icon={actionIcon(moderation.action)}
      label={label}
    />
  );

  if (!showDetails) {
    return badge;
  }

  return (
    <HStack gap={2} align="center" wrap="wrap" data-moderation-action={moderation.action}>
      {badge}
      <Text type="supporting" color="secondary">
        {formatModerationDetails(moderation)}
      </Text>
    </HStack>
  );
}
