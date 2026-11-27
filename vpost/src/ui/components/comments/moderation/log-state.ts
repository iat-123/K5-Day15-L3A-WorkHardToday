import type {
  ModerationLogEntry,
  ModerationLogFilter,
} from "@/ui/schemas/moderation.schema";

/**
 * Pure helpers for `ModerationLog` filtering, empty-state classification,
 * and undo ("Hiện lại") eligibility.
 */

export function hasActiveModerationLogFilters(filter: ModerationLogFilter): boolean {
  return filter.pageId !== null || filter.action !== null || filter.actor !== null;
}

export function resolveModerationLogEmptyKind(
  filter: ModerationLogFilter,
): "first-run" | "no-result" {
  return hasActiveModerationLogFilters(filter) ? "no-result" : "first-run";
}

/**
 * Only successful `hide` entries can be undone via "Hiện lại" (bulk unhide).
 * `would_hide` never hid on Facebook, failed hides did not change Facebook state,
 * and `delete` cannot be undone.
 */
export function canUndoModerationLogEntry(entry: ModerationLogEntry): boolean {
  return entry.action === "hide" && entry.result === "ok";
}

export interface UndoLogEntryGate {
  readonly isEligible: boolean;
  readonly canUndo: boolean;
  readonly disabledReason: string | null;
}

export function evaluateUndoLogEntryGate(input: {
  readonly entry: ModerationLogEntry;
  readonly isUndoing: boolean;
  readonly readOnlyReason: string | null;
}): UndoLogEntryGate {
  const isEligible = canUndoModerationLogEntry(input.entry);
  if (!isEligible) {
    return { isEligible: false, canUndo: false, disabledReason: null };
  }
  const readOnly = input.readOnlyReason?.trim() || null;
  if (readOnly !== null) {
    return { isEligible: true, canUndo: false, disabledReason: readOnly };
  }
  if (input.isUndoing) {
    return {
      isEligible: true,
      canUndo: false,
      disabledReason: "Đang hiện lại bình luận trên Facebook…",
    };
  }
  return { isEligible: true, canUndo: true, disabledReason: null };
}
