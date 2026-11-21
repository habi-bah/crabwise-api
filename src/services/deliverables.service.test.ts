import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = 'client-1';
const ARTIST_ID = 'artist-1';
const COMMISSION_ID = 'commission-1';
const UNRELATED_USER_ID = 'user-unrelated';

const { prismaMock, txMock } = vi.hoisted(() => {
  const tx = {
    commission: { findUnique: vi.fn(), update: vi.fn() },
    deliverable: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    commissionEvent: { create: vi.fn() },
    commissionDispute: { findFirst: vi.fn() },
    notification: { create: vi.fn() },
    media: { findMany: vi.fn() },
  };
  return {
    txMock: tx,
    prismaMock: {
      // Typed loosely so `tx` isn't referenced in its own annotation.
      $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
      commission: {
        findUnique: vi.fn(),
      },
    },
  };
});

vi.mock('@/services', () => ({ prisma: prismaMock }));

import { AppError } from '@/middlewares';

import {
  DELIVERABLE_MAX_MEDIA,
  reviewDeliverable,
  submitDeliverable,
  verifyDeliverableAccess,
} from './deliverables.service';

const DELIVERABLE_ID = 'deliverable-1';

function makeCommission(status = 'IN_PROGRESS') {
  return {
    id: COMMISSION_ID,
    clientId: CLIENT_ID,
    artistId: ARTIST_ID,
    status,
  };
}

function makeDeliverable(status = 'SUBMITTED', type = 'FINAL') {
  return {
    id: DELIVERABLE_ID,
    commissionId: COMMISSION_ID,
    type,
    status,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txMock.commission.findUnique.mockResolvedValue(makeCommission());
  txMock.commission.update.mockImplementation(async ({ data }: { data: { status: string } }) =>
    makeCommission(data.status),
  );
  txMock.deliverable.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'deliverable-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
      media: [],
    }),
  );
  txMock.commissionEvent.create.mockResolvedValue({ id: 'event-1' });
  txMock.notification.create.mockResolvedValue({ id: 'notification-1' });
  txMock.media.findMany.mockResolvedValue([{ id: 'media-1' }]);
  txMock.deliverable.findFirst.mockResolvedValue(null);
  txMock.deliverable.findUnique.mockResolvedValue(makeDeliverable());
  txMock.deliverable.update.mockImplementation(async ({ data }: { data: { status: string } }) =>
    makeDeliverable(data.status),
  );
  txMock.deliverable.count.mockResolvedValue(0);
  // No open dispute unless a test asks for one.
  txMock.commissionDispute.findFirst.mockResolvedValue(null);
  prismaMock.commission.findUnique.mockResolvedValue(makeCommission());
});

describe('verifyDeliverableAccess (#99)', () => {
  it('allows the client to read deliverables', async () => {
    await expect(verifyDeliverableAccess(COMMISSION_ID, CLIENT_ID)).resolves.toBeUndefined();
  });

  it('allows the artist to read deliverables', async () => {
    await expect(verifyDeliverableAccess(COMMISSION_ID, ARTIST_ID)).resolves.toBeUndefined();
  });

  it('allows an admin to read deliverables', async () => {
    await expect(verifyDeliverableAccess(COMMISSION_ID, UNRELATED_USER_ID, true)).resolves.toBeUndefined();
  });

  it('rejects unrelated users from reading deliverables', async () => {
    prismaMock.commission.findUnique.mockResolvedValue(makeCommission());

    await expect(verifyDeliverableAccess(COMMISSION_ID, UNRELATED_USER_ID)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('throws NOT_FOUND if the commission does not exist during access verification', async () => {
    prismaMock.commission.findUnique.mockResolvedValue(null);

    await expect(verifyDeliverableAccess(COMMISSION_ID, UNRELATED_USER_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('submitDeliverable (#784)', () => {
  it('reuses a WIP with an equivalent note and the same ordered attachments', async () => {
    const media = [
      { deliverableId: DELIVERABLE_ID, mediaId: 'media-1', sort: 0 },
      { deliverableId: DELIVERABLE_ID, mediaId: 'media-2', sort: 1 },
    ];
    txMock.media.findMany.mockResolvedValue([{ id: 'media-1' }, { id: 'media-2' }]);
    txMock.deliverable.create.mockResolvedValueOnce({
      ...makeDeliverable('SUBMITTED', 'WIP'),
      note: 'Sketch',
      media,
    });
    const first = await submitDeliverable(COMMISSION_ID, ARTIST_ID, {
      type: 'WIP',
      note: '  Sketch  ',
      mediaIds: ['media-1', 'media-2', 'media-1'],
    });
    txMock.deliverable.findFirst.mockResolvedValueOnce(first.deliverable);

    await expect(
      submitDeliverable(COMMISSION_ID, ARTIST_ID, {
        type: 'WIP',
        note: 'Sketch',
        mediaIds: ['media-1', 'media-2'],
      }),
    ).resolves.toEqual(first);
    expect(txMock.deliverable.findFirst).toHaveBeenNthCalledWith(2, {
      where: { commissionId: COMMISSION_ID, status: { not: 'UPLOADED' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { media: { orderBy: { sort: 'asc' } } },
    });
    expect(txMock.deliverable.create).toHaveBeenCalledTimes(1);
    expect(txMock.deliverable.create.mock.calls[0]?.[0].data.media.create).toEqual(
      media.map(({ mediaId, sort }) => ({ mediaId, sort })),
    );
    expect(txMock.notification.create).toHaveBeenCalledTimes(1);
    expect(txMock.commission.update).not.toHaveBeenCalled();
    expect(txMock.commissionEvent.create).not.toHaveBeenCalled();
  });

  it('reuses the final submission after delivery and rejects different content', async () => {
    const first = await submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'FINAL' });
    txMock.commission.findUnique.mockResolvedValue(makeCommission('DELIVERED'));
    txMock.deliverable.findFirst
      .mockResolvedValueOnce(first.deliverable)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(first.deliverable);

    await expect(
      submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'FINAL', note: '  ' }),
    ).resolves.toEqual(first);
    await expect(
      submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'FINAL', note: 'Replacement' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(txMock.deliverable.create).toHaveBeenCalledTimes(1);
    expect(txMock.commission.update).toHaveBeenCalledTimes(1);
    expect(txMock.commissionEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.notification.create).toHaveBeenCalledTimes(1);
    expect(first.commissionStatus).toBe('DELIVERED');
  });

  it('treats reordered media as a new WIP version', async () => {
    txMock.deliverable.findFirst.mockResolvedValueOnce({
      ...makeDeliverable('SUBMITTED', 'WIP'),
      media: [
        { mediaId: 'media-1', sort: 0 },
        { mediaId: 'media-2', sort: 1 },
      ],
    });
    txMock.media.findMany.mockResolvedValue([{ id: 'media-1' }, { id: 'media-2' }]);
    txMock.deliverable.create.mockResolvedValueOnce({
      ...makeDeliverable('SUBMITTED', 'WIP'),
      id: 'new-version',
      media: [],
    });

    const result = await submitDeliverable(COMMISSION_ID, ARTIST_ID, {
      type: 'WIP',
      mediaIds: ['media-2', 'media-1'],
    });

    expect(result.deliverable.id).toBe('new-version');
    expect(txMock.deliverable.create.mock.calls[0]?.[0].data.media.create).toEqual([
      { mediaId: 'media-2', sort: 0 },
      { mediaId: 'media-1', sort: 1 },
    ]);
  });

  it('creates a new version with the same content after a revision request', async () => {
    const input = { type: 'FINAL' } as const;
    const first = await submitDeliverable(COMMISSION_ID, ARTIST_ID, input);
    txMock.commission.findUnique.mockResolvedValue(makeCommission('DELIVERED'));
    txMock.deliverable.findUnique.mockResolvedValueOnce(first.deliverable);

    const review = await reviewDeliverable(COMMISSION_ID, first.deliverable.id, CLIENT_ID, {
      decision: 'REQUEST_CHANGES',
      note: 'Please revise',
    });
    expect(review.revisionCount).toBe(1);
    expect(review.commissionStatus).toBe('IN_PROGRESS');

    txMock.commission.findUnique.mockResolvedValue(makeCommission(review.commissionStatus));
    txMock.deliverable.findFirst.mockResolvedValueOnce(review.deliverable);
    txMock.deliverable.create.mockResolvedValueOnce({ ...first.deliverable, id: 'revised' });

    const second = await submitDeliverable(COMMISSION_ID, ARTIST_ID, input);
    expect(second.deliverable.id).toBe('revised');
    expect(second.commissionStatus).toBe('DELIVERED');
    expect(txMock.deliverable.create).toHaveBeenCalledTimes(2);
  });

  it('allows a fresh WIP when an older version was rejected after the latest submission', async () => {
    const latest = { ...makeDeliverable('SUBMITTED', 'WIP'), media: [] };
    txMock.deliverable.findFirst
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce({ id: 'rejected-older-version' });
    txMock.deliverable.create.mockResolvedValueOnce({ ...latest, id: 'fresh-wip' });

    const result = await submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'WIP' });

    expect(result.deliverable.id).toBe('fresh-wip');
    expect(txMock.deliverable.findFirst).toHaveBeenLastCalledWith({
      where: {
        commissionId: COMMISSION_ID,
        status: 'REJECTED',
        updatedAt: { gt: latest.createdAt },
      },
      select: { id: true },
    });
  });

  it('checks authorization before looking up a matching final submission', async () => {
    txMock.commission.findUnique.mockResolvedValue(makeCommission('DELIVERED'));
    txMock.deliverable.findFirst.mockResolvedValue({ ...makeDeliverable(), media: [] });

    await expect(
      submitDeliverable(COMMISSION_ID, UNRELATED_USER_ID, { type: 'FINAL' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(txMock.deliverable.findFirst).not.toHaveBeenCalled();
    expect(txMock.notification.create).not.toHaveBeenCalled();
  });

  it('retries a serialization conflict and reuses the committed winner', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('Serialization conflict', {
      code: 'P2034',
      clientVersion: Prisma.prismaVersion.client,
    });
    const winner = { ...makeDeliverable(), media: [] };
    prismaMock.$transaction.mockImplementationOnce(async (callback) => {
      await callback(txMock);
      // The first transaction is rolled back by PostgreSQL at commit time.
      txMock.commission.findUnique.mockResolvedValue(makeCommission('DELIVERED'));
      txMock.deliverable.findFirst.mockResolvedValueOnce(winner);
      throw conflict;
    });

    await expect(submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'FINAL' })).resolves.toEqual({
      deliverable: winner,
      commissionStatus: 'DELIVERED',
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(txMock.deliverable.create).toHaveBeenCalledTimes(1);
    expect(txMock.commissionEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.notification.create).toHaveBeenCalledTimes(1);
  });

  it('propagates a serialization conflict after three attempts', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('Serialization conflict', {
      code: 'P2034',
      clientVersion: Prisma.prismaVersion.client,
    });
    prismaMock.$transaction
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict);

    await expect(submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'WIP' })).rejects.toBe(
      conflict,
    );
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3);
  });

  it('records a FINAL submission, moves the commission to DELIVERED and notifies the client', async () => {
    const result = await submitDeliverable(COMMISSION_ID, ARTIST_ID, {
      type: 'FINAL',
      note: '  Final files attached.  ',
    });

    expect(txMock.deliverable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          commissionId: COMMISSION_ID,
          type: 'FINAL',
          status: 'SUBMITTED',
          note: 'Final files attached.',
        }),
      }),
    );
    expect(result.commissionStatus).toBe('DELIVERED');

    // The transition is on the audit trail, attributed to the artist.
    expect(txMock.commissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commissionId: COMMISSION_ID,
        fromStatus: 'IN_PROGRESS',
        toStatus: 'DELIVERED',
        actorId: ARTIST_ID,
      }),
    });

    expect(txMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: CLIENT_ID,
        type: 'COMMISSION_DELIVERABLE_SUBMITTED',
        data: expect.objectContaining({ deliverableId: 'deliverable-1', type: 'FINAL' }),
      }),
    });
  });

  it('records a WIP draft without completing anything', async () => {
    const result = await submitDeliverable(COMMISSION_ID, ARTIST_ID, {
      type: 'WIP',
      note: 'Rough composition.',
    });

    // Already IN_PROGRESS, so there is no transition to record.
    expect(result.commissionStatus).toBe('IN_PROGRESS');
    expect(txMock.commission.update).not.toHaveBeenCalled();
    expect(txMock.commissionEvent.create).not.toHaveBeenCalled();
    expect(txMock.notification.create).toHaveBeenCalled();
  });

  it('moves an ACCEPTED commission to IN_PROGRESS on the first WIP submission', async () => {
    txMock.commission.findUnique.mockResolvedValue(makeCommission('ACCEPTED'));

    const result = await submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'WIP' });

    expect(result.commissionStatus).toBe('IN_PROGRESS');
    expect(txMock.commissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: 'ACCEPTED', toStatus: 'IN_PROGRESS' }),
    });
  });

  it('attaches media that belongs to the artist, preserving order', async () => {
    txMock.media.findMany.mockResolvedValue([{ id: 'media-1' }, { id: 'media-2' }]);

    await submitDeliverable(COMMISSION_ID, ARTIST_ID, {
      type: 'FINAL',
      mediaIds: ['media-1', 'media-2'],
    });

    expect(txMock.media.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['media-1', 'media-2'] }, userId: ARTIST_ID },
      select: { id: true },
    });
    expect(txMock.deliverable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          media: {
            create: [
              { mediaId: 'media-1', sort: 0 },
              { mediaId: 'media-2', sort: 1 },
            ],
          },
        }),
      }),
    );
  });

  describe.each(['WIP', 'FINAL'] as const)('%s submission transaction', (type) => {
    it.each([
      ['media attachment', 'deliverable'],
      ['commission transition', 'commission'],
      ['audit event', 'commissionEvent'],
      ['client notification', 'notification'],
    ] as const)('rejects the transaction when %s fails', async (_stage, model) => {
      txMock.commission.findUnique.mockResolvedValue(makeCommission('ACCEPTED'));
      txMock.media.findMany.mockResolvedValue([{ id: 'media-1' }, { id: 'media-2' }]);
      const failure = new Error(`Failed to write ${model}`);
      const writes = [
        txMock.deliverable.create,
        txMock.commission.update,
        txMock.commissionEvent.create,
        txMock.notification.create,
      ];
      const failingWrite = model === 'commission' ? txMock.commission.update : txMock[model].create;
      failingWrite.mockRejectedValueOnce(failure);

      await expect(
        submitDeliverable(COMMISSION_ID, ARTIST_ID, {
          type,
          mediaIds: ['media-1', 'media-2'],
        }),
      ).rejects.toBe(failure);

      expect(prismaMock.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      // Rejecting the callback is what tells Prisma to roll back. Merely
      // rejecting outside it (after committing partial writes) is too late.
      await expect(prismaMock.$transaction.mock.results[0]!.value).rejects.toBe(failure);
      expect(txMock.deliverable.create).toHaveBeenCalledWith({
        data: {
          commissionId: COMMISSION_ID,
          type,
          status: 'SUBMITTED',
          note: null,
          media: {
            create: [
              { mediaId: 'media-1', sort: 0 },
              { mediaId: 'media-2', sort: 1 },
            ],
          },
        },
        include: { media: { orderBy: { sort: 'asc' } } },
      });
      for (const write of writes.slice(0, writes.indexOf(failingWrite) + 1)) {
        expect(write).toHaveBeenCalledTimes(1);
      }
      for (const write of writes.slice(writes.indexOf(failingWrite) + 1)) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it('propagates a transaction commit failure instead of reporting success', async () => {
      const failure = new Error('Transaction commit failed');
      prismaMock.$transaction.mockImplementationOnce(async (callback) => {
        await callback(txMock);
        throw failure;
      });

      await expect(
        submitDeliverable(COMMISSION_ID, ARTIST_ID, { type, mediaIds: ['media-1'] }),
      ).rejects.toBe(failure);

      expect(txMock.deliverable.create).toHaveBeenCalledTimes(1);
      expect(txMock.notification.create).toHaveBeenCalledTimes(1);
    });
  });

  it('de-duplicates media ids before attaching them', async () => {
    await submitDeliverable(COMMISSION_ID, ARTIST_ID, {
      type: 'FINAL',
      mediaIds: ['media-1', 'media-1'],
    });

    expect(txMock.media.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['media-1'] }, userId: ARTIST_ID },
      select: { id: true },
    });
  });

  it('rejects media that does not belong to the artist', async () => {
    txMock.media.findMany.mockResolvedValue([]);

    await expect(
      submitDeliverable(COMMISSION_ID, ARTIST_ID, {
        type: 'FINAL',
        mediaIds: ['someone-elses-media'],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(txMock.deliverable.create).not.toHaveBeenCalled();
  });

  it('rejects a submission from anyone but the assigned artist', async () => {
    await expect(
      submitDeliverable(COMMISSION_ID, CLIENT_ID, { type: 'FINAL' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(txMock.deliverable.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown commission before checking media or writing anything', async () => {
    txMock.commission.findUnique.mockResolvedValueOnce(null);

    const result = submitDeliverable(COMMISSION_ID, ARTIST_ID, {
      type: 'FINAL',
      mediaIds: ['media-1'],
    });

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Commission not found',
    });
    expect(txMock.media.findMany).not.toHaveBeenCalled();
    expect(txMock.deliverable.create).not.toHaveBeenCalled();
    expect(txMock.commission.update).not.toHaveBeenCalled();
    expect(txMock.commissionEvent.create).not.toHaveBeenCalled();
    expect(txMock.notification.create).not.toHaveBeenCalled();
  });

  it('returns a domain error when the commission is deleted before the insert', async () => {
    txMock.deliverable.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
        code: 'P2003',
        clientVersion: Prisma.prismaVersion.client,
        meta: { modelName: 'Deliverable', constraint: 'Deliverable_commissionId_fkey' },
      }),
    );

    const result = submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'FINAL' });

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Commission not found',
    });
    expect(txMock.commission.update).not.toHaveBeenCalled();
    expect(txMock.commissionEvent.create).not.toHaveBeenCalled();
    expect(txMock.notification.create).not.toHaveBeenCalled();
  });

  it.each([
    new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
      code: 'P2003',
      clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: 'Deliverable', constraint: 'DeliverableMedia_mediaId_fkey' },
    }),
    new Error('Database connection lost'),
  ])('propagates an unrelated insert failure: %s', async (error) => {
    txMock.deliverable.create.mockRejectedValueOnce(error);

    await expect(
      submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'FINAL', mediaIds: ['media-1'] }),
    ).rejects.toBe(error);
  });

  it.each(['PENDING', 'DELIVERED', 'COMPLETED', 'CANCELLED'])(
    'rejects a submission while the commission is %s',
    async (status) => {
      txMock.commission.findUnique.mockResolvedValue(makeCommission(status));

      await expect(
        submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'FINAL' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(txMock.deliverable.create).not.toHaveBeenCalled();
    },
  );

  it('rejects a note beyond the length limit', async () => {
    await expect(
      submitDeliverable(COMMISSION_ID, ARTIST_ID, { type: 'WIP', note: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(txMock.deliverable.create).not.toHaveBeenCalled();
  });

  it('rejects more than the media limit without querying', async () => {
    await expect(
      submitDeliverable(COMMISSION_ID, ARTIST_ID, {
        type: 'WIP',
        mediaIds: Array.from({ length: DELIVERABLE_MAX_MEDIA + 1 }, (_, i) => `media-${i}`),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(txMock.deliverable.create).not.toHaveBeenCalled();
  });
});

describe('reviewDeliverable (#823)', () => {
  beforeEach(() => {
    txMock.commission.findUnique.mockResolvedValue(makeCommission('DELIVERED'));
  });

  it('accepting the final deliverable completes the commission and releases escrow', async () => {
    const result = await reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
      decision: 'ACCEPT',
    });

    expect(txMock.deliverable.update).toHaveBeenCalledWith({
      where: { id: DELIVERABLE_ID },
      data: { status: 'ACCEPTED' },
    });
    expect(txMock.commission.update).toHaveBeenCalledWith({
      where: { id: COMMISSION_ID },
      data: { status: 'COMPLETED' },
    });
    expect(result).toMatchObject({
      commissionStatus: 'COMPLETED',
      escrowReleased: true,
      revisionCount: 0,
    });
    expect(txMock.commissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'DELIVERED',
        toStatus: 'COMPLETED',
        actorId: CLIENT_ID,
      }),
    });
    expect(txMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: ARTIST_ID,
        type: 'COMMISSION_DELIVERABLE_ACCEPTED',
        data: expect.objectContaining({ escrowReleased: true }),
      }),
    });
  });

  it('refuses to accept a work-in-progress draft', async () => {
    txMock.deliverable.findUnique.mockResolvedValue(makeDeliverable('SUBMITTED', 'WIP'));

    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, { decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(txMock.commission.update).not.toHaveBeenCalled();
  });

  it('refuses to accept when the commission is not DELIVERED', async () => {
    txMock.commission.findUnique.mockResolvedValue(makeCommission('IN_PROGRESS'));

    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, { decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each(['PENDING', 'ACCEPTED', 'COMPLETED', 'CANCELLED', 'DISPUTED'] as const)(
    'refuses to edit a deliverable while the commission is %s',
    async (status) => {
      txMock.commission.findUnique.mockResolvedValue(makeCommission(status));

      await expect(
        reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
          decision: 'REQUEST_CHANGES',
          note: 'Please revise',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, { decision: 'ACCEPT' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(txMock.deliverable.update).not.toHaveBeenCalled();
      expect(txMock.commission.update).not.toHaveBeenCalled();
      expect(txMock.commissionEvent.create).not.toHaveBeenCalled();
      expect(txMock.notification.create).not.toHaveBeenCalled();
    },
  );

  it('allows changes to be requested on a WIP while the work is in progress', async () => {
    txMock.commission.findUnique.mockResolvedValue(makeCommission('IN_PROGRESS'));
    txMock.deliverable.findUnique.mockResolvedValue(makeDeliverable('SUBMITTED', 'WIP'));

    const result = await reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
      decision: 'REQUEST_CHANGES',
      note: 'Try another palette',
    });

    expect(result).toMatchObject({
      commissionStatus: 'IN_PROGRESS',
      escrowReleased: false,
      revisionCount: 1,
    });
    expect(txMock.deliverable.update).toHaveBeenCalledWith({
      where: { id: DELIVERABLE_ID },
      data: { status: 'REJECTED' },
    });
    expect(txMock.commission.update).not.toHaveBeenCalled();
    expect(txMock.notification.create).toHaveBeenCalled();
  });

  it('requesting changes records a revision, reopens the work and notes the feedback', async () => {
    const result = await reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
      decision: 'REQUEST_CHANGES',
      note: '  Palette is off.  ',
    });

    expect(txMock.deliverable.update).toHaveBeenCalledWith({
      where: { id: DELIVERABLE_ID },
      data: { status: 'REJECTED' },
    });
    expect(txMock.commission.update).toHaveBeenCalledWith({
      where: { id: COMMISSION_ID },
      data: { status: 'IN_PROGRESS' },
    });
    expect(result).toMatchObject({
      commissionStatus: 'IN_PROGRESS',
      escrowReleased: false,
      revisionCount: 1,
      maxRevisions: 3,
    });
    expect(txMock.commissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toStatus: 'IN_PROGRESS',
        note: 'Changes requested: Palette is off.',
      }),
    });
    expect(txMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: ARTIST_ID,
        type: 'COMMISSION_CHANGES_REQUESTED',
        data: expect.objectContaining({ note: 'Palette is off.', revisionCount: 1 }),
      }),
    });
  });

  it('counts the revision this request creates', async () => {
    txMock.deliverable.count.mockResolvedValue(2);

    const result = await reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
      decision: 'REQUEST_CHANGES',
      note: 'Still not right.',
    });

    expect(result.revisionCount).toBe(3);
  });

  it('requires feedback to request changes', async () => {
    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
        decision: 'REQUEST_CHANGES',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(txMock.deliverable.update).not.toHaveBeenCalled();
  });

  it('enforces the configured revision limit', async () => {
    txMock.deliverable.count.mockResolvedValue(3);

    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
        decision: 'REQUEST_CHANGES',
        note: 'One more please.',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(txMock.deliverable.update).not.toHaveBeenCalled();
  });

  it('only lets the client review', async () => {
    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, ARTIST_ID, { decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(txMock.deliverable.update).not.toHaveBeenCalled();
  });

  it('rejects a deliverable that is not on this commission', async () => {
    txMock.deliverable.findUnique.mockResolvedValue({
      ...makeDeliverable(),
      commissionId: 'another-commission',
    });

    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, { decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['ACCEPTED', 'ACCEPT'],
    ['REJECTED', 'REQUEST_CHANGES'],
  ])('refuses to review a %s deliverable again', async (status, decision) => {
    txMock.deliverable.findUnique.mockResolvedValue(makeDeliverable(status));

    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, {
        decision: decision as 'ACCEPT' | 'REQUEST_CHANGES',
        note: 'again',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses both decisions while a dispute holds escrow', async () => {
    txMock.commissionDispute.findFirst.mockResolvedValue({ id: 'dispute-1', status: 'OPEN' });

    await expect(
      reviewDeliverable(COMMISSION_ID, DELIVERABLE_ID, CLIENT_ID, { decision: 'ACCEPT' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This commission has an open dispute; an admin must resolve it first',
    });
    expect(txMock.deliverable.update).not.toHaveBeenCalled();
  });
});
