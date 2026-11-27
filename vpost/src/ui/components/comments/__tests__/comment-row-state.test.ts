import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  commentRowStateReducer,
  createConflictNotice,
  executePerRowMutation,
  getCommentRowState,
  isSendConflictError,
  nextLiveAnnouncement,
  type CommentRowStateAction,
  type CommentRowStateMap,
} from "@/ui/components/comments/comment-row-state";
import { toApiError } from "@/ui/components/feedback/present-api-error";
import { ApiError } from "@/ui/services/api-error";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("per-row mutation state concurrency", () => {
  it("tracks pending, error, and success independently across two concurrent comment rows", async () => {
    let state: CommentRowStateMap = {};
    const dispatch = (action: CommentRowStateAction) => {
      state = commentRowStateReducer(state, action);
    };
    const inFlight = new Set<string>();

    const rowASend = createDeferred<string>();
    const rowBSend = createDeferred<string>();

    // Start sending on row A
    const pA = executePerRowMutation({
      commentId: "c1",
      action: "send",
      inFlightKeys: inFlight,
      onStart: () => dispatch({ type: "send_start", commentId: "c1" }),
      run: () => rowASend.promise,
      onSuccess: (msg) => dispatch({ type: "send_success", commentId: "c1", message: msg }),
      onError: (err) => dispatch({ type: "send_error", commentId: "c1", error: toApiError(err) }),
    });

    // Duplicate click on row A while still in-flight is ignored
    const dupRun = vi.fn(async () => "dup");
    const dupAccepted = await executePerRowMutation({
      commentId: "c1",
      action: "send",
      inFlightKeys: inFlight,
      onStart: () => {},
      run: dupRun,
      onSuccess: () => {},
      onError: () => {},
    });
    expect(dupAccepted).toBe(false);
    expect(dupRun).not.toHaveBeenCalled();

    // Concurrently start sending on row B before row A settles
    const pB = executePerRowMutation({
      commentId: "c2",
      action: "send",
      inFlightKeys: inFlight,
      onStart: () => dispatch({ type: "send_start", commentId: "c2" }),
      run: () => rowBSend.promise,
      onSuccess: (msg) => dispatch({ type: "send_success", commentId: "c2", message: msg }),
      onError: (err) => dispatch({ type: "send_error", commentId: "c2", error: toApiError(err) }),
    });

    // Both rows are pending simultaneously
    expect(getCommentRowState(state, "c1").isSending).toBe(true);
    expect(getCommentRowState(state, "c2").isSending).toBe(true);

    // Row B fails with 422 BLOCKED while row A is STILL in flight
    const errB = new ApiError({
      code: "BLOCKED",
      status: 422,
      userMessage: "có cụm cấm 'freeship'",
    });
    rowBSend.reject(errB);
    await pB;

    expect(getCommentRowState(state, "c2").isSending).toBe(false);
    expect(getCommentRowState(state, "c2").sendError?.code).toBe("BLOCKED");
    // Row A must remain untouched and still pending
    expect(getCommentRowState(state, "c1").isSending).toBe(true);
    expect(getCommentRowState(state, "c1").sendError).toBeNull();

    // Now row A succeeds — row B's error must remain intact
    rowASend.resolve("Đã gửi trả lời lên Facebook.");
    await pA;

    expect(getCommentRowState(state, "c1").isSending).toBe(false);
    expect(getCommentRowState(state, "c1").sendError).toBeNull();
    expect(getCommentRowState(state, "c1").successMessage).toBe("Đã gửi trả lời lên Facebook.");
    expect(getCommentRowState(state, "c1").successSeq).toBe(1);

    expect(getCommentRowState(state, "c2").isSending).toBe(false);
    expect(getCommentRowState(state, "c2").sendError?.code).toBe("BLOCKED");
    expect(getCommentRowState(state, "c2").successMessage).toBeNull();

    // Editing row A clears only row A's success/check/error, leaving row B intact
    dispatch({ type: "text_edited", commentId: "c1" });
    expect(getCommentRowState(state, "c1").successMessage).toBeNull();
    expect(getCommentRowState(state, "c2").sendError?.code).toBe("BLOCKED");
  });

  it("tracks concurrent save/generate/hide actions across two rows without losing checkResult", async () => {
    let state: CommentRowStateMap = {};
    const dispatch = (action: CommentRowStateAction) => {
      state = commentRowStateReducer(state, action);
    };
    const inFlight = new Set<string>();

    const saveA = createDeferred<{ block: string[]; warn: string[] }>();
    const saveB = createDeferred<{ block: string[]; warn: string[] }>();

    const pA = executePerRowMutation({
      commentId: "c1",
      action: "save",
      inFlightKeys: inFlight,
      onStart: () => dispatch({ type: "save_start", commentId: "c1" }),
      run: () => saveA.promise,
      onSuccess: (check) =>
        dispatch({ type: "save_success", commentId: "c1", check, message: "Đã lưu nháp trả lời." }),
      onError: (err) => dispatch({ type: "save_error", commentId: "c1", error: toApiError(err) }),
    });
    const pB = executePerRowMutation({
      commentId: "c2",
      action: "save",
      inFlightKeys: inFlight,
      onStart: () => dispatch({ type: "save_start", commentId: "c2" }),
      run: () => saveB.promise,
      onSuccess: (check) =>
        dispatch({ type: "save_success", commentId: "c2", check, message: "Đã lưu nháp trả lời." }),
      onError: (err) => dispatch({ type: "save_error", commentId: "c2", error: toApiError(err) }),
    });

    expect(getCommentRowState(state, "c1").isSaving).toBe(true);
    expect(getCommentRowState(state, "c2").isSaving).toBe(true);

    saveB.resolve({ block: [], warn: ["4 emoji"] });
    await pB;
    expect(getCommentRowState(state, "c1").isSaving).toBe(true);
    expect(getCommentRowState(state, "c2").checkResult?.warn).toEqual(["4 emoji"]);

    saveA.resolve({ block: ["giá sai"], warn: [] });
    await pA;
    expect(getCommentRowState(state, "c1").checkResult?.block).toEqual(["giá sai"]);
    expect(getCommentRowState(state, "c2").checkResult?.warn).toEqual(["4 emoji"]);
  });

  it("increments sequence on repeated identical live status announcements so screen readers re-announce them", () => {
    const first = nextLiveAnnouncement(null, "Đã lưu nháp trả lời.");
    const second = nextLiveAnnouncement(first, "Đã lưu nháp trả lời.");

    expect(first).toEqual({ seq: 1, message: "Đã lưu nháp trả lời." });
    expect(second).toEqual({ seq: 2, message: "Đã lưu nháp trả lời." });
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it("records a screen-level 409 CONFLICT notice without triggering a duplicate refetch", () => {
    const conflictErr = new ApiError({
      code: "CONFLICT",
      status: 409,
      userMessage: "Bình luận này đã được trả lời hoặc đang gửi",
    });
    expect(isSendConflictError(conflictErr)).toBe(true);

    const notice1 = createConflictNotice(null, {
      commentId: "c1",
      canComment: true,
      error: conflictErr,
    });
    expect(notice1).toEqual({
      seq: 1,
      commentId: "c1",
      title: "Bình luận này đã được trả lời",
      description: "Bình luận này đã được trả lời hoặc đang gửi",
    });

    const notice2 = createConflictNotice(notice1, {
      commentId: "c2",
      canComment: false,
      error: conflictErr,
    });
    expect(notice2.seq).toBe(2);
    expect(notice2.title).toBe("Không thể trả lời bình luận này");

    // Verify CommentsScreen does not call commentsQuery.refetch() on 409 (single invalidation in useSendCommentReply.onSettled)
    const screenSource = readFileSync(
      join(process.cwd(), "src/ui/components/comments/CommentsScreen.tsx"),
      "utf8",
    );
    const sendHandler = screenSource
      .slice(
        screenSource.indexOf("function handleSendReply"),
        screenSource.indexOf("function handleTextEdited"),
      )
      .replace(/\/\/.*$/gm, "");
    expect(sendHandler).not.toContain("refetch(");
    expect(sendHandler).toContain("isSendConflictError");
  });
});
