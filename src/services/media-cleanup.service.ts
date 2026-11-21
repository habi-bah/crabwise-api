/**
 * Orphaned media detection and cleanup.
 *
 * "Orphaned" means not referenced by any artwork, portfolio item, or order
 * deliverable — checked via the join tables directly (`none: {}`), so a
 * media record linked to any active entity is never a candidate. A media
 * row also has to be older than `GRACE_PERIOD_MS` before it's eligible,
 * so a just-uploaded file that hasn't been attached yet (e.g. mid
 * multi-step upload flow) isn't deleted out from under it.
 */

import { logger } from '@/utils';
import { prisma } from '@/services';

import { deleteObject } from './s3.service';

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const MISSING_OBJECT_ERROR_NAMES = new Set(['NoSuchKey', 'NotFound']);

function isMissingObjectError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  if (
    [candidate.name, candidate.Code, candidate.code].some(
      (value) => typeof value === 'string' && MISSING_OBJECT_ERROR_NAMES.has(value),
    )
  ) {
    return true;
  }

  if (candidate.$metadata?.httpStatusCode === 404) {
    return true;
  }

  return (
    typeof candidate.message === 'string' &&
    /no such key|specified key does not exist|does not exist|not found/i.test(candidate.message)
  );
}

async function deleteObjectIfPresent(bucket: string, key: string): Promise<void> {
  try {
    await deleteObject(bucket, key);
  } catch (error) {
    if (!isMissingObjectError(error)) {
      throw error;
    }
  }
}

export interface MediaCleanupStats {
  readonly scanned: number;
  readonly deleted: number;
  readonly failed: number;
}

export async function cleanupOrphanedMedia(): Promise<MediaCleanupStats> {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);

  const orphaned = await prisma.media.findMany({
    where: {
      createdAt: { lt: cutoff },
      artworks: { none: {} },
      portfolio: { none: {} },
      deliverables: { none: {} },
    },
  });

  let deleted = 0;
  let failed = 0;
  const errors: unknown[] = [];

  for (const media of orphaned) {
    try {
      await deleteObjectIfPresent(media.bucket, media.key);
      await prisma.media.delete({ where: { id: media.id } });
      deleted += 1;
    } catch (error) {
      failed += 1;
      errors.push(error);
      logger.error('media-cleanup: failed to delete orphaned media', {
        mediaId: media.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stats: MediaCleanupStats = { scanned: orphaned.length, deleted, failed };
  logger.info('media-cleanup: run complete', { ...stats });
  // Finish the batch, then reject so the queue worker marks the job as failed.
  if (failed > 0) {
    throw new AggregateError(
      errors,
      `media-cleanup: failed to delete ${failed} of ${orphaned.length} orphaned media`,
    );
  }
  return stats;
}
