import { Banner, Link } from "@astryxdesign/core";

import { presentCommentApiError } from "@/ui/components/comments/comment-error";
import { PermissionMissingNotice } from "@/ui/components/comments/PermissionMissingNotice";
import { ErrorState } from "@/ui/components/feedback/ErrorState";

/**
 * Comments-screen error surface wrapping shared `ErrorState` with local handling for:
 * - Page permission/token errors (`PERMISSION_MISSING`, `TOKEN_INVALID`, `CHANNEL_NOT_CONFIGURED`)
 * - HTTP `401` sign-in recovery (`/signin`)
 * - HTTP `429` (`RATE_LIMITED` / `POSTING_TOO_FAST`) wait-then-retry guidance
 */
export function CommentErrorNotice({
  error,
  onRetry,
  shouldFocus = true,
  source,
  titleOverride,
}: {
  error: unknown;
  /** Rendered only when `presentCommentApiError(error).canRetry` is true (network, 5xx, 429). */
  onRetry?: () => void;
  shouldFocus?: boolean;
  source?: string;
  /** Optional contextual title for generic/server errors (auth/rate-limit keep their diagnosis title). */
  titleOverride?: string;
}) {
  const view = presentCommentApiError(error);

  if (view.kind === "reconnect") {
    return <PermissionMissingNotice description={view.apiError.userMessage} />;
  }

  const baseTitle =
    titleOverride && view.kind !== "auth" && view.kind !== "rate-limit" && view.kind !== "select-tenant"
      ? titleOverride
      : view.title;
  const sourceName = source?.trim() ?? "";
  const title = sourceName.length > 0 ? `${sourceName} — ${baseTitle}` : baseTitle;
  const description = view.hint ? `${view.description} ${view.hint}` : view.description;

  if (view.kind === "select-tenant") {
    return (
      <Banner
        role="status"
        status="info"
        title={title}
        description={description}
      />
    );
  }

  return (
    <ErrorState
      title={title}
      description={description}
      details={view.details}
      referenceCode={view.apiError.code}
      shouldFocus={shouldFocus}
      onRetry={view.canRetry && onRetry ? onRetry : undefined}
      secondaryAction={
        view.kind === "auth" ? (
          <Link href="/signin" isStandalone>
            Đăng nhập lại
          </Link>
        ) : undefined
      }
    />
  );
}
