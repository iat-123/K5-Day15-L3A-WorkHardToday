"use client";

import {
  Divider,
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  Skeleton,
  Stack,
  StackItem,
} from "@astryxdesign/core";

const SKELETON_ROWS = 4;

/**
 * First-load skeleton matching the shape of `CommentRow` (author header,
 * message lines, post context line, and reply composer area).
 */
export function CommentListSkeleton() {
  return (
    <Stack direction="vertical" gap={0} padding={0} aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <Stack key={row} direction="vertical" gap={0}>
          <Stack direction="vertical" gap={3} padding={4}>
            <HStack gap={3} align="center" justify="between" wrap="wrap">
              <HStack gap={2} align="center">
                <Skeleton width={140} height={18} index={row} />
                <Skeleton width={96} height={16} index={row} />
                <Skeleton width={110} height={16} index={row} />
              </HStack>
              <HStack gap={2} align="center">
                <Skeleton width={84} height={24} index={row} />
                <Skeleton width={96} height={24} index={row} />
              </HStack>
            </HStack>

            <Stack direction="vertical" gap={1.5}>
              <Skeleton width="90%" height={16} index={row} />
              <Skeleton width="65%" height={16} index={row} />
            </Stack>

            <HStack gap={2} align="center">
              <Skeleton width={72} height={20} index={row} />
              <Skeleton width="45%" height={14} index={row} />
            </HStack>

            <Skeleton width="100%" height={76} index={row} />

            <HStack gap={2} align="center">
              <Skeleton width={112} height={32} index={row} />
              <Skeleton width={92} height={32} index={row} />
              <Skeleton width={188} height={32} index={row} />
            </HStack>
          </Stack>
          {row < SKELETON_ROWS - 1 ? <Divider /> : null}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * Suspense fallback for `/comments` mirroring the real header, status tabs,
 * filter bar, and list rows so layout does not jump when search params resolve.
 */
export function CommentsFallback() {
  return (
    <Layout
      height="fill"
      aria-hidden="true"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <HStack gap={3} align="start" justify="between">
              <StackItem size="fill">
                <Stack direction="vertical" gap={1.5}>
                  <Skeleton width={140} height={28} />
                  <Skeleton width="60%" height={16} />
                </Stack>
              </StackItem>
              <HStack gap={2}>
                <Skeleton width={160} height={32} />
                <Skeleton width={92} height={32} />
              </HStack>
            </HStack>

            <HStack gap={3} align="center">
              <Skeleton width={120} height={32} />
              <Skeleton width={110} height={32} />
              <Skeleton width={90} height={32} />
              <Skeleton width={84} height={32} />
            </HStack>

            <HStack gap={3} align="center">
              <Skeleton width="100%" height={32} />
              <Skeleton width={220} height={32} />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <CommentListSkeleton />
        </LayoutContent>
      }
    />
  );
}
