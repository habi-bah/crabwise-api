import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, loggerMock } = vi.hoisted(() => ({
  prismaMock: { media: { findMany: vi.fn(), delete: vi.fn() } },
  loggerMock: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/services', () => ({ prisma: prismaMock }));
vi.mock('@/utils', () => ({ logger: loggerMock }));

import { cleanupOrphanedMedia } from './media-cleanup.service';
import { buildObjectKey, deleteObject, s3Client } from './s3.service';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildObjectKey', () => {
  it('uses a short URL-safe random identifier and preserves namespacing', () => {
    const key = buildObjectKey('user-1', 'images', 'my photo.png');

    expect(key).toMatch(/^images\/user-1\/[A-Za-z0-9_-]{16}-my_photo\.png$/);
  });

  it('generates distinct identifiers for repeated uploads', () => {
    const keys = new Set(Array.from({ length: 100 }, () => buildObjectKey('u1', 'files', 'a.png')));
    expect(keys.size).toBe(100);
  });
});

describe('media cleanup storage failures', () => {
  const first = { id: 'media-1', bucket: 'test-bucket', key: 'images/first.png' };
  const second = { id: 'media-2', bucket: 'test-bucket', key: 'images/second.png' };

  function missingObjectError(): Error {
    return Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.media.findMany.mockResolvedValue([first, second]);
    prismaMock.media.delete.mockResolvedValue({});
    vi.spyOn(s3Client, 'send').mockResolvedValue(undefined);
  });

  it('passes the bucket and key to S3 and propagates deletion errors', async () => {
    const failure = new Error('S3 unavailable');
    vi.mocked(s3Client.send).mockRejectedValueOnce(failure);

    await expect(deleteObject(first.bucket, first.key)).rejects.toBe(failure);

    const command = vi.mocked(s3Client.send).mock.calls[0]![0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: first.bucket, Key: first.key });
  });

  it('returns successful cleanup statistics when all objects are deleted', async () => {
    await expect(cleanupOrphanedMedia()).resolves.toEqual({ scanned: 2, deleted: 2, failed: 0 });

    expect(s3Client.send).toHaveBeenCalledTimes(2);
    expect(prismaMock.media.delete.mock.calls).toEqual([
      [{ where: { id: first.id } }],
      [{ where: { id: second.id } }],
    ]);
  });

  it('tolerates an already-removed object and still deletes its row', async () => {
    vi.mocked(s3Client.send).mockRejectedValueOnce(missingObjectError());

    await expect(cleanupOrphanedMedia()).resolves.toEqual({ scanned: 2, deleted: 2, failed: 0 });

    expect(prismaMock.media.delete.mock.calls).toEqual([
      [{ where: { id: first.id } }],
      [{ where: { id: second.id } }],
    ]);
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('media-cleanup: run complete', {
      scanned: 2,
      deleted: 2,
      failed: 0,
    });
  });

  it.each([
    ['a 404 status', Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 404 } })],
    ['a NoSuchKey name', Object.assign(new Error('gone'), { name: 'NoSuchKey' })],
    ['a missing-key message', new Error('The specified key does not exist.')],
  ])('recognises a missing object from %s', async (_label, error) => {
    vi.mocked(s3Client.send).mockRejectedValueOnce(error);

    await expect(cleanupOrphanedMedia()).resolves.toEqual({ scanned: 2, deleted: 2, failed: 0 });
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('does not hide other storage errors alongside a missing object', async () => {
    const failure = Object.assign(new Error('Access denied'), {
      $metadata: { httpStatusCode: 403 },
    });
    vi.mocked(s3Client.send)
      .mockRejectedValueOnce(missingObjectError())
      .mockRejectedValueOnce(failure);

    await expect(cleanupOrphanedMedia()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [failure],
    });

    expect(prismaMock.media.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: first.id } });
    expect(loggerMock.error).toHaveBeenCalledExactlyOnceWith(
      'media-cleanup: failed to delete orphaned media',
      { mediaId: second.id, message: failure.message },
    );
    expect(loggerMock.info).toHaveBeenCalledWith('media-cleanup: run complete', {
      scanned: 2,
      deleted: 1,
      failed: 1,
    });
  });

  it('still reports a database failure after tolerating a missing object', async () => {
    const failure = new Error('Database unavailable');
    vi.mocked(s3Client.send).mockRejectedValueOnce(missingObjectError());
    prismaMock.media.delete.mockRejectedValueOnce(failure);

    await expect(cleanupOrphanedMedia()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [failure],
    });
    expect(loggerMock.error).toHaveBeenCalledWith(
      'media-cleanup: failed to delete orphaned media',
      {
        mediaId: first.id,
        message: failure.message,
      },
    );
  });

  it('rejects after a partial S3 failure, retains its row and continues the batch', async () => {
    const failure = new Error('S3 access denied');
    vi.mocked(s3Client.send).mockRejectedValueOnce(failure);

    await expect(cleanupOrphanedMedia()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [failure],
    });

    expect(s3Client.send).toHaveBeenCalledTimes(2);
    expect(prismaMock.media.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: second.id } });
    expect(loggerMock.error).toHaveBeenCalledWith(
      'media-cleanup: failed to delete orphaned media',
      { mediaId: first.id, message: failure.message },
    );
    expect(loggerMock.info).toHaveBeenCalledWith('media-cleanup: run complete', {
      scanned: 2,
      deleted: 1,
      failed: 1,
    });
  });

  it('reports every failure when S3 rejects the whole batch', async () => {
    const failures = [new Error('S3 unavailable'), new Error('S3 timeout')];
    vi.mocked(s3Client.send).mockRejectedValueOnce(failures[0]).mockRejectedValueOnce(failures[1]);

    await expect(cleanupOrphanedMedia()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: failures,
    });

    expect(prismaMock.media.delete).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('media-cleanup: run complete', {
      scanned: 2,
      deleted: 0,
      failed: 2,
    });
  });

  it('also rejects database deletion failures instead of reporting job success', async () => {
    const failure = new Error('Database unavailable');
    prismaMock.media.delete.mockRejectedValueOnce(failure);

    await expect(cleanupOrphanedMedia()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [failure],
    });

    expect(prismaMock.media.delete).toHaveBeenCalledTimes(2);
    expect(loggerMock.info).toHaveBeenCalledWith('media-cleanup: run complete', {
      scanned: 2,
      deleted: 1,
      failed: 1,
    });
  });

  it('succeeds without storage calls when there are no orphaned objects', async () => {
    prismaMock.media.findMany.mockResolvedValue([]);

    await expect(cleanupOrphanedMedia()).resolves.toEqual({ scanned: 0, deleted: 0, failed: 0 });

    expect(s3Client.send).not.toHaveBeenCalled();
    expect(prismaMock.media.delete).not.toHaveBeenCalled();
  });
});
