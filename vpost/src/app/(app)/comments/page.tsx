import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getOperatorSession } from "@/app/_auth/session";
import { CommentsFallback } from "@/ui/components/comments/CommentListSkeleton";
import { CommentsScreen } from "@/ui/components/comments/CommentsScreen";

/**
 * "Bình luận" — Facebook comment inbox.
 * Server Component session guard wrapping the URL-driven client screen.
 */

export const metadata: Metadata = {
  title: "Bình luận — VPOST",
  robots: { index: false, follow: false },
};

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function CommentsPage() {
  const session = await getOperatorSession("page:/comments");

  if (!session) redirect("/signin?returnUrl=%2Fcomments");

  return (
    <Suspense fallback={<CommentsFallback />}>
      <CommentsScreen />
    </Suspense>
  );
}
