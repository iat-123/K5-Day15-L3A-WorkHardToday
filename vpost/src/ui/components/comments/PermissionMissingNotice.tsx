import { Banner, Link, Stack, Text } from "@astryxdesign/core";

import type { CommentSyncError } from "@/ui/schemas/comment.schema";

/**
 * Permission/token error callout pointing operators to `/channels` to reconnect
 * the Facebook Page with the comment scopes. Intentionally omits a retry button
 * because retrying before reconnecting the Page cannot succeed.
 */
export function PermissionMissingNotice({
  title = "Page thiếu quyền đọc hoặc trả lời bình luận",
  description = "Token Facebook hiện tại chưa có quyền pages_read_user_content hoặc pages_manage_engagement. Kết nối lại Page trong mục Kênh rồi thử lại.",
  errors,
}: {
  title?: string;
  description?: string;
  errors?: readonly CommentSyncError[];
}) {
  const hasDetails = Boolean(errors && errors.length > 0);

  return (
    <Banner
      role="alert"
      status="error"
      title={title}
      description={description}
      defaultIsExpanded={hasDetails}
      endContent={
        <Link href="/channels" isStandalone>
          Kết nối lại Page ở mục Kênh
        </Link>
      }
    >
      {hasDetails ? (
        <Stack as="ul" role="list" direction="vertical" gap={1}>
          {errors?.map((item) => (
            <Stack as="li" key={`${item.postJobId}-${item.code}`} direction="vertical" gap={0.5}>
              <Text type="supporting">
                Bài {item.postJobId}: {item.message}
              </Text>
              <Text type="code" color="secondary">
                Mã: {item.code}
              </Text>
            </Stack>
          ))}
        </Stack>
      ) : null}
    </Banner>
  );
}
