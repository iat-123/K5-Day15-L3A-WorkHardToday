import {
  AUTO_HIDE_CATEGORIES,
  MODERATION_THRESHOLD_MAX,
  MODERATION_THRESHOLD_MIN,
  type AutoHideCategory,
  type ModerationMode,
  type ModerationSetting,
  type ModerationSettingUpdateInput,
} from "@/ui/schemas/moderation.schema";

/**
 * Pure draft state, validation, and policy helpers for `ModerationSettingsPanel`.
 */

const AUTO_HIDE_SET = new Set<string>(AUTO_HIDE_CATEGORIES);

export interface ModerationSettingDraft {
  readonly enabled: boolean;
  readonly mode: ModerationMode;
  readonly categories: readonly AutoHideCategory[];
  readonly threshold: number;
}

export function clampModerationThreshold(value: number): number {
  if (!Number.isFinite(value)) return MODERATION_THRESHOLD_MIN;
  const clamped = Math.min(
    MODERATION_THRESHOLD_MAX,
    Math.max(MODERATION_THRESHOLD_MIN, value),
  );
  return Math.round(clamped * 100) / 100;
}

/**
 * Keeps only v1 auto-hide categories (`spam | scam | abusive | pii`) in canonical order.
 *
 * PHASE2(complaint-autohide): `complaint` is explicitly stripped here and is never
 * selectable in v1 because the backend rejects it with 400 `COMPLAINT_AUTOHIDE_DISABLED`.
 */
export function sanitizeAutoHideCategories(
  categories: readonly string[],
): AutoHideCategory[] {
  const selected = new Set<string>();
  for (const raw of categories) {
    const trimmed = raw.trim();
    if (AUTO_HIDE_SET.has(trimmed)) {
      selected.add(trimmed);
    }
  }
  return AUTO_HIDE_CATEGORIES.filter((cat) => selected.has(cat));
}

export function isAutoHideCategorySelectable(category: string): category is AutoHideCategory {
  // PHASE2(complaint-autohide): `complaint` is not selectable in v1.
  return AUTO_HIDE_SET.has(category);
}

export function settingToDraft(setting: ModerationSetting): ModerationSettingDraft {
  return {
    enabled: setting.enabled,
    mode: setting.mode,
    categories: sanitizeAutoHideCategories(setting.categories),
    threshold: clampModerationThreshold(setting.threshold),
  };
}

export function isSettingDraftDirty(
  serverSetting: ModerationSetting,
  draft: ModerationSettingDraft,
): boolean {
  const baseline = settingToDraft(serverSetting);
  if (baseline.enabled !== draft.enabled) return true;
  if (baseline.mode !== draft.mode) return true;
  if (Math.abs(baseline.threshold - clampModerationThreshold(draft.threshold)) > 0.0001) {
    return true;
  }
  const nextCats = sanitizeAutoHideCategories(draft.categories);
  if (baseline.categories.length !== nextCats.length) return true;
  return baseline.categories.some((cat, index) => cat !== nextCats[index]);
}

export function buildSettingUpdatePayload(
  draft: ModerationSettingDraft,
): ModerationSettingUpdateInput {
  return {
    enabled: draft.enabled,
    mode: draft.mode,
    // PHASE2(complaint-autohide): guarantees `complaint` can never be sent in PUT.
    categories: sanitizeAutoHideCategories(draft.categories),
    threshold: clampModerationThreshold(draft.threshold),
  };
}

export interface SettingSaveGateInput {
  readonly isDirty: boolean;
  readonly isSaving: boolean;
  readonly readOnlyReason: string | null;
}

export interface SettingSaveGate {
  readonly canEdit: boolean;
  readonly canSave: boolean;
  readonly canReset: boolean;
  readonly editDisabledReason: string | null;
  readonly saveDisabledReason: string | null;
}

export function evaluateSettingSaveGate(input: SettingSaveGateInput): SettingSaveGate {
  const readOnly = input.readOnlyReason?.trim() || null;
  if (readOnly !== null) {
    return {
      canEdit: false,
      canSave: false,
      canReset: false,
      editDisabledReason: readOnly,
      saveDisabledReason: readOnly,
    };
  }
  if (input.isSaving) {
    return {
      canEdit: false,
      canSave: false,
      canReset: false,
      editDisabledReason: "Đang lưu cài đặt kiểm duyệt…",
      saveDisabledReason: "Đang lưu cài đặt kiểm duyệt…",
    };
  }
  return {
    canEdit: true,
    canSave: input.isDirty,
    canReset: input.isDirty,
    editDisabledReason: null,
    saveDisabledReason: input.isDirty ? null : "Chưa có thay đổi nào cần lưu.",
  };
}

export function formatModerationThreshold(value: number): string {
  const clamped = clampModerationThreshold(value);
  return `${Math.round(clamped * 100)}% (${clamped.toFixed(2)})`;
}
