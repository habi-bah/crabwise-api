import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, redisMock, envMock, enqueueEmailMock } = vi.hoisted(() => {
  const notification = {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  };
  const user = { findUnique: vi.fn() };
  return {
    prismaMock: { notification, user },
    redisMock: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
    envMock: {
      smtp: undefined as { host: string; port: number; user?: string; pass?: string } | undefined,
    },
    enqueueEmailMock: vi.fn(),
  };
});

vi.mock('@/config', () => ({ env: envMock }));
vi.mock('@/services/prisma.service', () => ({ prisma: prismaMock }));
vi.mock('./redis.service', () => ({ tryGetRedisClient: () => redisMock }));
vi.mock('@/queues', () => ({ enqueueNotificationEmail: enqueueEmailMock }));

import {
  createNotification,
  createNotifications,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications.service';

const USER_ID = 'user-1';

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    userId: USER_ID,
    type: 'ORDER_UPDATE',
    data: { orderId: 'order-1' },
    readAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.smtp = undefined;
  redisMock.del.mockResolvedValue(0);
  enqueueEmailMock.mockResolvedValue(undefined);
});

describe('createNotification (#841)', () => {
  it('creates a notification row and invalidates the unread-count cache', async () => {
    prismaMock.notification.create.mockResolvedValue(makeNotification());

    const result = await createNotification({
      userId: USER_ID,
      type: 'ORDER_UPDATE',
      data: { orderId: 'order-1' },
    });

    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, type: 'ORDER_UPDATE', data: { orderId: 'order-1' } },
    });
    expect(result.id).toBe('notif-1');
    expect(redisMock.del).toHaveBeenCalledWith(`notifications:unread:${USER_ID}`);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it('enqueues an email when SMTP is configured', async () => {
    envMock.smtp = { host: 'smtp.test', port: 587 };
    // Echo the input, as the real row would.
    prismaMock.notification.create.mockImplementation(({ data }: { data: object }) => ({
      ...makeNotification(),
      ...data,
    }));
    prismaMock.user.findUnique.mockResolvedValue({ email: 'a@b.co' });

    await createNotification({ userId: USER_ID, type: 'SYSTEM', data: { message: 'hi' } });

    expect(enqueueEmailMock).toHaveBeenCalledWith({
      to: 'a@b.co',
      type: 'SYSTEM',
      notificationId: 'notif-1',
      data: { message: 'hi' },
    });
  });

  it('still persists the notification when the recipient email lookup fails', async () => {
    envMock.smtp = { host: 'smtp.test', port: 587 };
    prismaMock.notification.create.mockResolvedValue(makeNotification());
    prismaMock.user.findUnique.mockRejectedValue(new Error('db down'));

    await expect(createNotification({ userId: USER_ID, type: 'SYSTEM' })).resolves.toMatchObject({
      id: 'notif-1',
    });
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});

describe('createNotifications batch (#841)', () => {
  it('creates one row per recipient in a single round-trip', async () => {
    prismaMock.notification.createMany.mockResolvedValue({ count: 2 });

    const count = await createNotifications(['u1', 'u2'], 'COMMISSION_UPDATE', {
      commissionId: 'c1',
    });

    expect(count).toBe(2);
    expect(prismaMock.notification.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u1', type: 'COMMISSION_UPDATE', data: { commissionId: 'c1' } },
        { userId: 'u2', type: 'COMMISSION_UPDATE', data: { commissionId: 'c1' } },
      ],
    });
    expect(redisMock.del).toHaveBeenCalledTimes(2);
  });

  it('short-circuits for an empty recipient list', async () => {
    const count = await createNotifications([], 'SYSTEM');
    expect(count).toBe(0);
    expect(prismaMock.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('listNotifications (#842)', () => {
  it('paginates newest-first and reports unread count', async () => {
    prismaMock.notification.findMany.mockResolvedValue([makeNotification()]);
    prismaMock.notification.count.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');

    const page = await listNotifications(USER_ID, { page: 1, limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(7);
    expect(page.hasNext).toBe(false);
    expect(page.unreadCount).toBe(3);
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('applies the unreadOnly filter', async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);
    prismaMock.notification.count.mockResolvedValue(0);
    redisMock.get.mockResolvedValue('0');

    await listNotifications(USER_ID, { page: 1, limit: 20, unreadOnly: true });

    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, readAt: null } }),
    );
  });
});

describe('markNotificationRead (#842)', () => {
  it('stamps readAt and invalidates the unread cache', async () => {
    prismaMock.notification.findUnique.mockResolvedValue(makeNotification());
    prismaMock.notification.update.mockResolvedValue(
      makeNotification({ readAt: new Date('2026-10-02T00:00:00.000Z') }),
    );

    const result = await markNotificationRead(USER_ID, 'notif-1');

    expect(result.readAt).not.toBeNull();
    expect(redisMock.del).toHaveBeenCalledWith(`notifications:unread:${USER_ID}`);
  });

  it('is idempotent — an already-read notification keeps its timestamp', async () => {
    const readAt = new Date('2026-10-02T00:00:00.000Z');
    prismaMock.notification.findUnique.mockResolvedValue(makeNotification({ readAt }));

    const result = await markNotificationRead(USER_ID, 'notif-1');

    expect(result.readAt).toEqual(readAt);
    expect(prismaMock.notification.update).not.toHaveBeenCalled();
  });

  it("rejects another user's notification with NOT_FOUND", async () => {
    prismaMock.notification.findUnique.mockResolvedValue(makeNotification({ userId: 'other' }));

    await expect(markNotificationRead(USER_ID, 'notif-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('markAllNotificationsRead (#842)', () => {
  it('bulk-updates unread rows and invalidates the cache', async () => {
    prismaMock.notification.updateMany.mockResolvedValue({ count: 4 });

    const result = await markAllNotificationsRead(USER_ID);

    expect(result.updated).toBe(4);
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(redisMock.del).toHaveBeenCalledWith(`notifications:unread:${USER_ID}`);
  });
});

describe('getUnreadCount (#842)', () => {
  it('serves the count from cache when present', async () => {
    redisMock.get.mockResolvedValue('5');

    await expect(getUnreadCount(USER_ID)).resolves.toBe(5);
    expect(prismaMock.notification.count).not.toHaveBeenCalled();
  });

  it('falls back to a COUNT query and caches the result', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');
    prismaMock.notification.count.mockResolvedValue(9);

    await expect(getUnreadCount(USER_ID)).resolves.toBe(9);
    expect(redisMock.set).toHaveBeenCalledWith(`notifications:unread:${USER_ID}`, '9', 'EX', 60);
  });
});
