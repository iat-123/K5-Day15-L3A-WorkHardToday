"use client";

import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core";

import {
  MODERATION_FILTER_ALL_LABEL,
  MODERATION_FILTER_LABELS,
  MODERATION_FILTER_VALUES,
  type ModerationFilter,
} from "./moderation-filters";

const ALL_MODERATION_VALUE = "__all__";

export interface ModerationFilterCounts {
  readonly autoHidden?: number;
  readonly wouldHide?: number;
  readonly flagged?: number;
}

export interface ModerationFilterBarProps {
  /** Active moderation filter, or `null` for all comments. */
  readonly value: ModerationFilter | null;
  /** Called when the operator picks a moderation filter or returns to all. */
  readonly onChange: (next: ModerationFilter | null) => void;
  /** Optional counts from the comments list endpoint (`counts.autoHidden`, `counts.flagged`, etc.). */
  readonly counts?: ModerationFilterCounts;
}

function labelWithCount(filter: ModerationFilter, counts?: ModerationFilterCounts): string {
  const base = MODERATION_FILTER_LABELS[filter];
  if (!counts) return base;
  const count =
    filter === "auto_hidden"
      ? counts.autoHidden
      : filter === "would_hide"
        ? counts.wouldHide
        : counts.flagged;
  return typeof count === "number" ? `${base} (${count})` : base;
}

/**
 * Filter control for `moderation=auto_hidden|would_hide|flagged`.
 * Ready to mount into the comments header bar during integration.
 */
export function ModerationFilterBar({
  value,
  onChange,
  counts,
}: ModerationFilterBarProps) {
  return (
    <SegmentedControl
      label="Lọc theo trạng thái kiểm duyệt"
      size="sm"
      value={value ?? ALL_MODERATION_VALUE}
      onChange={(nextValue) => {
        if (nextValue === ALL_MODERATION_VALUE) {
          onChange(null);
          return;
        }
        if ((MODERATION_FILTER_VALUES as readonly string[]).includes(nextValue)) {
          onChange(nextValue as ModerationFilter);
        }
      }}
    >
      <SegmentedControlItem
        value={ALL_MODERATION_VALUE}
        label={MODERATION_FILTER_ALL_LABEL}
      />
      {MODERATION_FILTER_VALUES.map((filterValue) => (
        <SegmentedControlItem
          key={filterValue}
          value={filterValue}
          label={labelWithCount(filterValue, counts)}
        />
      ))}
    </SegmentedControl>
  );
}
