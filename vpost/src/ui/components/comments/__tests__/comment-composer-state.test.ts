import { describe, expect, it } from "vitest";

import {
  applyComposerLocalEdit,
  createComposerBuffer,
  evaluateComposerGate,
  markComposerGenerateStarted,
  markComposerSaveStarted,
  shouldTriggerBlurSave,
  syncComposerBufferFromServer,
  type ComposerGateInput,
} from "@/ui/components/comments/comment-composer-state";

function baseInput(overrides: Partial<ComposerGateInput> = {}): ComposerGateInput {
  return {
    text: "Dạ Đầm Voan Hoa G1 giá 890.000đ còn màu đen size M ạ!",
    commentStatus: "unreplied",
    canComment: true,
    draftStatus: "draft",
    blockReasons: [],
    isGenerating: false,
    isSaving: false,
    isSending: false,
    isRowActionPending: false,
    readOnlyReason: null,
    ...overrides,
  };
}

describe("evaluateComposerGate enable/disable matrix", () => {
  it("enables edit, generate, save, send, ignore, and hide in the ready state", () => {
    const gate = evaluateComposerGate(baseInput());
    expect(gate.canEdit).toBe(true);
    expect(gate.canGenerateDraft).toBe(true);
    expect(gate.canSaveDraft).toBe(true);
    expect(gate.canSendReply).toBe(true);
    expect(gate.canIgnoreToggle).toBe(true);
    expect(gate.canHideToggle).toBe(true);
    expect(gate.sendDisabledReason).toBeNull();
  });

  it("disables save and send when text is empty or whitespace, while keeping generate enabled", () => {
    for (const empty of ["", "   \n\t  "]) {
      const gate = evaluateComposerGate(baseInput({ text: empty, draftStatus: null }));
      expect(gate.canSendReply).toBe(false);
      expect(gate.canSaveDraft).toBe(false);
      expect(gate.canGenerateDraft).toBe(true);
      expect(gate.sendDisabledReason).toContain("Nhập nội dung");
    }
  });

  it("disables send when check.block / 422 reasons exist, while keeping edit and save enabled", () => {
    const gate = evaluateComposerGate(
      baseInput({ blockReasons: ["giá 500k không khớp giá bán 890.000đ"] }),
    );
    expect(gate.canSendReply).toBe(false);
    expect(gate.canEdit).toBe(true);
    expect(gate.canSaveDraft).toBe(true);
    expect(gate.sendDisabledReason).toContain("bị chặn");
  });

  it("disables save and send when length exceeds 2000 characters", () => {
    const gate = evaluateComposerGate(baseInput({ text: "a".repeat(2001) }));
    expect(gate.isOverMaxLength).toBe(true);
    expect(gate.canSendReply).toBe(false);
    expect(gate.canSaveDraft).toBe(false);
    expect(gate.sendDisabledReason).toContain("2.000");
  });

  it("locks all actions while sending (client flag or server draft status='sending')", () => {
    for (const patch of [{ isSending: true }, { draftStatus: "sending" as const }]) {
      const gate = evaluateComposerGate(baseInput(patch));
      expect(gate.isSendingNow).toBe(true);
      expect(gate.isLocked).toBe(true);
      expect(gate.canEdit).toBe(false);
      expect(gate.canGenerateDraft).toBe(false);
      expect(gate.canSaveDraft).toBe(false);
      expect(gate.canSendReply).toBe(false);
      expect(gate.canIgnoreToggle).toBe(false);
      expect(gate.canHideToggle).toBe(false);
    }
  });

  it("locks reply controls when comment is already replied or draft is sent", () => {
    for (const patch of [
      { commentStatus: "replied" as const },
      { draftStatus: "sent" as const },
    ]) {
      const gate = evaluateComposerGate(baseInput(patch));
      expect(gate.isAlreadyReplied).toBe(true);
      expect(gate.canEdit).toBe(false);
      expect(gate.canGenerateDraft).toBe(false);
      expect(gate.canSaveDraft).toBe(false);
      expect(gate.canSendReply).toBe(false);
      expect(gate.canHideToggle).toBe(true);
    }
  });

  it("disables reply controls when Facebook canComment is false", () => {
    const gate = evaluateComposerGate(baseInput({ canComment: false }));
    expect(gate.canEdit).toBe(false);
    expect(gate.canGenerateDraft).toBe(false);
    expect(gate.canSaveDraft).toBe(false);
    expect(gate.canSendReply).toBe(false);
    expect(gate.sendDisabledReason).toContain("Facebook không cho phép");
  });

  it("allows editing and retrying when draft is flagged or failed", () => {
    for (const status of ["flagged", "failed"] as const) {
      const gate = evaluateComposerGate(baseInput({ draftStatus: status }));
      expect(gate.canEdit).toBe(true);
      expect(gate.canGenerateDraft).toBe(true);
      expect(gate.canSaveDraft).toBe(true);
      expect(gate.canSendReply).toBe(true);
    }
  });

  it("disables every write action with the reason in read-only mode", () => {
    const reason = "Chế độ hỗ trợ chỉ được xem.";
    const gate = evaluateComposerGate(baseInput({ readOnlyReason: reason }));
    expect(gate.canEdit).toBe(false);
    expect(gate.canGenerateDraft).toBe(false);
    expect(gate.canSaveDraft).toBe(false);
    expect(gate.canSendReply).toBe(false);
    expect(gate.canIgnoreToggle).toBe(false);
    expect(gate.canHideToggle).toBe(false);
    expect(gate.sendDisabledReason).toBe(reason);
    expect(gate.generateDisabledReason).toBe(reason);
    expect(gate.rowActionDisabledReason).toBe(reason);
  });

  it("prevents sending while AI draft is generating or saving", () => {
    expect(evaluateComposerGate(baseInput({ isGenerating: true })).canSendReply).toBe(false);
    expect(evaluateComposerGate(baseInput({ isSaving: true })).canSendReply).toBe(false);
    expect(evaluateComposerGate(baseInput({ isRowActionPending: true })).canSendReply).toBe(false);
  });

  it("computes editDisabledReason prioritizing readOnly, !canComment, sending, replied, and generating over empty-draft save reason", () => {
    const generatingEmpty = evaluateComposerGate(
      baseInput({ text: "", draftStatus: null, isGenerating: true }),
    );
    expect(generatingEmpty.canEdit).toBe(false);
    expect(generatingEmpty.editDisabledReason).toBe("Đang tạo nháp AI…");
    expect(generatingEmpty.editDisabledReason).not.toContain("Nhập nội dung để lưu nháp");

    expect(
      evaluateComposerGate(baseInput({ readOnlyReason: "Chỉ xem.", isGenerating: true }))
        .editDisabledReason,
    ).toBe("Chỉ xem.");
    expect(evaluateComposerGate(baseInput({ canComment: false })).editDisabledReason).toContain(
      "Facebook không cho phép",
    );
    expect(evaluateComposerGate(baseInput({ isSending: true })).editDisabledReason).toContain(
      "Đang gửi",
    );
    expect(evaluateComposerGate(baseInput({ commentStatus: "replied" })).editDisabledReason).toContain(
      "đã được trả lời",
    );
    expect(evaluateComposerGate(baseInput()).editDisabledReason).toBeNull();
  });
});

describe("blur-to-save and in-flight edit protection", () => {
  it("skips blur-to-save when focus or pointer targets Send, Save, or Generate buttons", () => {
    expect(
      shouldTriggerBlurSave({
        canSaveDraft: true,
        text: "Bản sửa mới nhất",
        serverDraftText: "Bản cũ",
        suppressBlurSave: false,
        relatedAction: "send",
      }),
    ).toBe(false);

    expect(
      shouldTriggerBlurSave({
        canSaveDraft: true,
        text: "Bản sửa mới nhất",
        serverDraftText: "Bản cũ",
        suppressBlurSave: false,
        relatedAction: "save",
      }),
    ).toBe(false);

    expect(
      shouldTriggerBlurSave({
        canSaveDraft: true,
        text: "Bản sửa mới nhất",
        serverDraftText: "Bản cũ",
        suppressBlurSave: false,
        relatedAction: "generate",
      }),
    ).toBe(false);

    // Safari/WebKit fallback when relatedTarget is null on button mousedown/pointerdown.
    expect(
      shouldTriggerBlurSave({
        canSaveDraft: true,
        text: "Bản sửa mới nhất",
        serverDraftText: "Bản cũ",
        suppressBlurSave: true,
        relatedAction: null,
      }),
    ).toBe(false);

    // Blurring to unrelated element with changed text DOES auto-save.
    expect(
      shouldTriggerBlurSave({
        canSaveDraft: true,
        text: "Bản sửa mới nhất",
        serverDraftText: "Bản cũ",
        suppressBlurSave: false,
        relatedAction: null,
      }),
    ).toBe(true);

    // No-op when trimmed text matches server draft.
    expect(
      shouldTriggerBlurSave({
        canSaveDraft: true,
        text: "  Bản cũ  ",
        serverDraftText: "Bản cũ",
        suppressBlurSave: false,
        relatedAction: null,
      }),
    ).toBe(false);
  });

  it("preserves newer in-flight local edits when a blur-save resolves so Send uses the latest text", () => {
    let buf = createComposerBuffer("c1:d1:t1:A", "A");
    buf = applyComposerLocalEdit(buf, "AB");
    buf = markComposerSaveStarted(buf);
    // Operator continues typing while PATCH /draft for "AB" is still in flight.
    buf = applyComposerLocalEdit(buf, "ABC mới nhất");

    // PATCH + list refetch returns "AB" with a newer updatedAt.
    buf = syncComposerBufferFromServer(buf, "c1:d1:t2:AB", "AB");
    expect(buf.text).toBe("ABC mới nhất");
    expect(buf.editRevision).not.toBe(buf.syncedRevision);

    // Even another background refetch must not clobber the latest local text.
    buf = syncComposerBufferFromServer(buf, "c1:d1:t3:AB", "AB");
    expect(buf.text).toBe("ABC mới nhất");
  });

  it("keeps local edits dirty when an in-flight save fails and a background refetch arrives", () => {
    let buf = createComposerBuffer("c1:d1:t1:A", "A");
    buf = applyComposerLocalEdit(buf, "AB");
    buf = markComposerSaveStarted(buf);

    // Save failed; refetch returns old server text "A" with new timestamp.
    buf = syncComposerBufferFromServer(buf, "c1:d1:t2:A", "A");
    expect(buf.text).toBe("AB");
    expect(buf.editRevision).not.toBe(buf.syncedRevision);
  });

  it("adopts server draft text when buffer is clean or after explicit AI draft generation", () => {
    let buf = createComposerBuffer("c1:none::", "");
    buf = syncComposerBufferFromServer(buf, "c1:d1:t1:Nháp AI 1", "Nháp AI 1");
    expect(buf.text).toBe("Nháp AI 1");

    // Operator edits manually, then clicks "Tạo nháp AI" explicitly.
    buf = applyComposerLocalEdit(buf, "Sửa nháp tay");
    buf = markComposerGenerateStarted(buf);
    buf = syncComposerBufferFromServer(buf, "c1:d2:t2:Nháp AI 2", "Nháp AI 2");
    expect(buf.text).toBe("Nháp AI 2");
    expect(buf.editRevision).toBe(buf.syncedRevision);
  });
});
