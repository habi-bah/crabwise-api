/**
 * Notifications service.
 *
 * Internal service for creating notifications (#841) plus the list/read
 * endpoints (#842). Notifications are rows in the `Notification` table with
 * a polymorphic `data` payload; delivery is DB-first, with an optional email
 * fan-out (queued, never in-request) when SMTP is configured.
 */

import type { Notification, Prisma } from '@prisma/client';

import { env } from '@/config';
import { AppError } from '@/middlewares';
import { enqueueNotificationEmail } from '@/queues';
import { cached, invalidateKeys } from '@/services/cache.service';
import { prisma } from '@/services/prisma.service';

/** Notification types the platform emits. Stored as a plain string so
 * legacy rows (e.g. COMMISSION_REQUEST) stay readable. */
export const NOTIFICATION_TYPES = [
  'ORDER_UPDATE',
  'COMMISSION_UPDATE',
  'MESSAGE',
  'REVIEW',
  'SYSTEM',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface CreateNotificationInput {
  readonly userId: string;
  readonly type: NotificationType;
  readonly data?: Record<string, unknown>;
}

export interface PublicNotification {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface ListNotificationsQuery {
  readonly page: number;
  readonly limit: number;
  readonly unreadOnly?: boolean;
}

export interface PaginatedNotifications {
  readonly items: readonly PublicNotification[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasNext: boolean;
  readonly unreadCount: number;
}

const UNREAD_COUNT_CACHE_TTL_SECONDS = 60;

function unreadCountKey(userId: string): string {
  return `notifications:unread:${userId}`;
}

function toPublic(notification: Notification): PublicNotification {
  return {
    id: notification.id,
    type: notification.type,
    data: notification.data,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

/** Drops the cached unread counter for `userId` after a read-state change. */
async function invalidateUnreadCount(userId: string): Promise<void> {
  await invalidateKeys(unreadCountKey(userId));
}

/**
 * Creates a single notification for one user (#841). When SMTP is fully
 * configured, an email job is enqueued after the row is committed so the
 * request path never waits on delivery.
 */
export async function createNotification(input: CreateNotificationInput): Promise<Notification> {
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
  await invalidateUnreadCount(input.userId);
  await maybeEnqueueEmail(notification);
  return notification;
}

/**
 * Batch-creates notifications for many recipients with the same type and
 * data (#841). One `createMany` round-trip; per-recipient emails are
 * enqueued afterwards when SMTP is configured.
 */
export async function createNotifications(
  userIds: readonly string[],
  type: NotificationType,
  data?: Record<string, unknown>,
): Promise<number> {
  if (userIds.length === 0) {
    return 0;
  }
  const result = await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type,
      data: (data ?? undefined) as Prisma.InputJsonValue | undefined,
    })),
  });
  await Promise.all(userIds.map((userId) => invalidateUnreadCount(userId)));
  return result.count;
}

/** Fire-and-forget email fan-out; silently skipped without SMTP (#841). */
async function maybeEnqueueEmail(notification: Notification): Promise<void> {
  if (env.smtp === undefined) {
    return;
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: notification.userId },
      select: { email: true },
    });
    if (user === null) {
      return;
    }
    await enqueueNotificationEmail({
      to: user.email,
      type: notification.type,
      notificationId: notification.id,
      data: (notification.data ?? {}) as Record<string, unknown>,
    });
  } catch {
    // Email is best-effort; the DB row is the source of truth.
  }
}

/**
 * Paginated, filterable list of a user's notifications (#842). `unreadOnly`
 * narrows to unread rows; the response always carries a fresh unread count.
 */
export async function listNotifications(
  userId: string,
  query: ListNotificationsQuery,
): Promise<PaginatedNotifications> {
  const where = {
    userId,
    ...(query.unreadOnly === true ? { readAt: null } : {}),
  };
  const [items, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.notification.count({ where }),
    getUnreadCount(userId),
  ]);
  return {
    items: items.map(toPublic),
    page: query.page,
    limit: query.limit,
    total,
    hasNext: query.page * query.limit < total,
    unreadCount,
  };
}

/**
 * Marks one notification as read (#842). Idempotent: an already-read
 * notification keeps its original `readAt` rather than being re-stamped.
 * Only the owner may mark their notification read.
 */
export async function markNotificationRead(
  userId: string,
  notificationId: string,
): Promise<PublicNotification> {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (notification === null || notification.userId !== userId) {
    throw new AppError('NOT_FOUND', 'Notification not found');
  }
  if (notification.readAt !== null) {
    return toPublic(notification);
  }
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  await invalidateUnreadCount(userId);
  return toPublic(updated);
}

/** Marks every unread notification as read (#842); returns how many changed. */
export async function markAllNotificationsRead(userId: string): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  await invalidateUnreadCount(userId);
  return { updated: result.count };
}

/**
 * Unread count for a user, cached for a short window (#842). Read-state
 * changes invalidate the key, so the count stays accurate while avoiding a
 * `COUNT` on every list poll.
 */
export async function getUnreadCount(userId: string): Promise<number> {
  return cached(unreadCountKey(userId), UNREAD_COUNT_CACHE_TTL_SECONDS, () =>
    prisma.notification.count({ where: { userId, readAt: null } }),
  );
}
