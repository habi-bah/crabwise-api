/**
 * Commission deliverables — the artist's submissions (#784) and the client's
 * review of them (#823).
 *
 * A submission is a version of the work: the row records the note, the
 * WIP/FINAL type and the media attached to that version. Submitting `FINAL`
 * hands the work to the client (`DELIVERED`); a `WIP` draft only starts or
 * continues the work (`IN_PROGRESS`). The client then accepts the final
 * version — which completes the commission and releases escrow — or sends it
 * back with a note, which is what a revision is.
 *
 * Escrow note: this service owns the *decision*, not the on-chain settlement.
 * The escrow contract (`contracts/escrow`) keys funds by commission id and
 * exposes `create_escrow` / `release_payment` / `refund_client`, all of which
 * require the caller (client or admin) to authorize the call itself. The API
 * holds no keys, so accepting a deliverable records the release as the
 * commission's `COMPLETED` transition and notifies the artist — the signed
 * contract invocation is the backend's to make, exactly as it already is for
 * an accepted dispute (#827).
 */

import type {
  CommissionDisputeStatus,
  CommissionStatus,
  Deliverable,
  DeliverableStatus,
  DeliverableType,
} from '@prisma/client';
import { Prisma } from '@prisma/client';

import { env } from '@/config';
import { AppError } from '@/middlewares';
import { prisma } from '@/services';

/** A deliverable as it is returned to clients: the row plus its media. */
export type DeliverableWithMedia = Prisma.DeliverableGetPayload<{
  include: { media: true };
}>;

export const DELIVERABLE_MAX_MEDIA = 20;
export const DELIVERABLE_NOTE_MAX_LENGTH = 2000;

/**
 * Statuses an artist may submit from. `DELIVERED` is deliberately excluded:
 * that version is waiting on the client's review, and a revision request
 * puts the commission back to `IN_PROGRESS` before another submission is
 * allowed — so a version can never be replaced out from under a review.
 */
const SUBMITTABLE_STATUSES: readonly CommissionStatus[] = ['ACCEPTED', 'IN_PROGRESS'];
const SUBMISSION_ATTEMPTS = 3;

export interface SubmitDeliverableInput {
  readonly type: DeliverableType;
  readonly note?: string;
  readonly mediaIds?: readonly string[];
}

export interface SubmitDeliverableResult {
  readonly deliverable: DeliverableWithMedia;
  readonly commissionStatus: CommissionStatus;
}

export type DeliverableDecision = 'ACCEPT' | 'REQUEST_CHANGES';

export interface ReviewDeliverableInput {
  readonly decision: DeliverableDecision;
  readonly note?: string;
}

export interface ReviewDeliverableResult {
  readonly deliverable: Deliverable;
  readonly commissionStatus: CommissionStatus;
  /** Revisions recorded against the commission, including this one. */
  readonly revisionCount: number;
  readonly maxRevisions: number;
  /** True once the artist's payout has been released (commission COMPLETED). */
  readonly escrowReleased: boolean;
}

/**
 * Rejections *are* the revision history, so the revision count is derived
 * from them rather than stored on the commission — a counter column could
 * silently drift from the submissions it claims to describe.
 */
const REVISION_STATUS: DeliverableStatus = 'REJECTED';

/**
 * States in which the client may still decide on a submitted deliverable.
 * `IN_PROGRESS` is when a WIP draft awaits feedback; `DELIVERED` is when the
 * final version awaits sign-off. Every other state has either not reached
 * delivery (PENDING/ACCEPTED), finished it (COMPLETED), or taken it out of the
 * review flow (CANCELLED/DISPUTED), so no deliverable may be edited there.
 */
const REVIEWABLE_COMMISSION_STATUSES: readonly CommissionStatus[] = ['IN_PROGRESS', 'DELIVERED'];

/**
 * Dispute states that hold escrow. Mirrors `OPEN_DISPUTE_STATUSES` in
 * `commissions.service`, which owns the dispute rules; duplicated rather than
 * imported to keep the two services independent.
 */
const ESCROW_HOLDING_DISPUTE_STATUSES: readonly CommissionDisputeStatus[] = ['OPEN', 'REVIEWING'];

function assertNoteLength(note: string): void {
  if (note.length > DELIVERABLE_NOTE_MAX_LENGTH) {
    throw new AppError(
      'BAD_REQUEST',
      `A note must be at most ${DELIVERABLE_NOTE_MAX_LENGTH} characters`,
    );
  }
}

/**
 * Rejects malformed identifiers before they reach persistence. Identifiers are
 * opaque, non-empty strings; anything else is a client error, not a lookup miss.
 */
function assertValidId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('BAD_REQUEST', `A valid ${label} is required`);
  }
}

function assertValidMediaIds(mediaIds: readonly unknown[]): void {
  for (const mediaId of mediaIds) {
    assertValidId(mediaId, 'media identifier');
  }
}

/**
 * Verifies that a user is either a participant in the commission (client or artist)
 * or an admin, throwing an error if they are unauthorized.
 */
export async function verifyDeliverableAccess(commissionId: string, userId: string, isAdmin = false): Promise<void> {
  if (isAdmin) {
    return;
  }
  const commission = await prisma.commission.findUnique({
    where: { id: commissionId },
    select: { clientId: true, artistId: true },
  });
  if (commission === null) {
    throw new AppError('NOT_FOUND', 'Commission not found');
  }
  if (commission.clientId !== userId && commission.artistId !== userId) {
    throw new AppError('FORBIDDEN', 'You do not have access to deliverables for this commission');
  }
}

/**
 * The artist on a commission submits a WIP draft or the final artefact.
 *
 * Only the assigned artist may submit (#784). New versions require an
 * `ACCEPTED`/`IN_PROGRESS` commission, and attached media must belong to that
 * artist — otherwise an artist could reference (and effectively publish)
 * someone else's upload. The client is notified with the submission details,
 * and a `FINAL` submission moves the commission to `DELIVERED` and appends
 * the transition to the audit trail.
 */
export async function submitDeliverable(
  commissionId: string,
  artistId: string,
  input: SubmitDeliverableInput,
): Promise<SubmitDeliverableResult> {
  assertValidId(commissionId, 'commission identifier');
  assertValidId(artistId, 'artist identifier');
  const trimmedNote = input.note?.trim() ?? '';
  assertNoteLength(trimmedNote);
  const note = trimmedNote || null;

  const mediaIds = [...new Set(input.mediaIds ?? [])];
  if (mediaIds.length > DELIVERABLE_MAX_MEDIA) {
    throw new AppError(
      'BAD_REQUEST',
      `At most ${DELIVERABLE_MAX_MEDIA} media files can be attached to a submission`,
    );
  }
  assertValidMediaIds(mediaIds);

  // Keep the deliverable, nested media links and submission side effects in
  // one transaction. Let failures escape the callback so Prisma rolls back
  // every write, including links created before a later attachment fails.
  const submit = async (tx: Prisma.TransactionClient): Promise<SubmitDeliverableResult> => {
    const commission = await tx.commission.findUnique({ where: { id: commissionId } });
    if (commission === null) {
      throw new AppError('NOT_FOUND', 'Commission not found');
    }
    if (commission.artistId !== artistId) {
      throw new AppError('FORBIDDEN', 'Only the artist on this commission can submit deliverables');
    }
    // A retry can reuse only the latest submitted version in the current
    // attempt. A newer version or a rejection starts a fresh attempt, even
    // when the artist resubmits older content. Attachment order is significant.
    const canSubmit = SUBMITTABLE_STATUSES.includes(commission.status);
    if (canSubmit || (commission.status === 'DELIVERED' && input.type === 'FINAL')) {
      const latest = await tx.deliverable.findFirst({
        where: { commissionId, status: { not: 'UPLOADED' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { media: { orderBy: { sort: 'asc' } } },
      });
      if (
        latest?.status === 'SUBMITTED' &&
        latest.type === input.type &&
        (latest.note?.trim() || null) === note &&
        latest.media.length === mediaIds.length &&
        latest.media.every(({ mediaId }, index) => mediaId === mediaIds[index])
      ) {
        // The client may request changes on an older version too.
        const laterRejection = await tx.deliverable.findFirst({
          where: {
            commissionId,
            status: REVISION_STATUS,
            updatedAt: { gt: latest.createdAt },
          },
          select: { id: true },
        });
        if (laterRejection === null) {
          return { deliverable: latest, commissionStatus: commission.status };
        }
      }
    }

    if (!canSubmit) {
      throw new AppError(
        'CONFLICT',
        `Deliverables can only be submitted while a commission is ${SUBMITTABLE_STATUSES.join(' or ')} (this one is ${commission.status})`,
      );
    }

    if (mediaIds.length > 0) {
      const owned = await tx.media.findMany({
        where: { id: { in: mediaIds }, userId: artistId },
        select: { id: true },
      });
      if (owned.length !== mediaIds.length) {
        throw new AppError('BAD_REQUEST', 'Every attached media file must belong to you');
      }
    }

    const deliverable = await tx.deliverable
      .create({
        data: {
          commissionId,
          type: input.type,
          note,
          // The artist is submitting this version, not merely uploading it.
          status: 'SUBMITTED',
          ...(mediaIds.length > 0
            ? { media: { create: mediaIds.map((mediaId, sort) => ({ mediaId, sort })) } }
            : {}),
        },
        include: { media: { orderBy: { sort: 'asc' } } },
      })
      .catch((error: unknown) => {
        // The commission can be deleted between the lookup and the insert.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2003' &&
          error.meta?.constraint === 'Deliverable_commissionId_fkey'
        ) {
          throw new AppError('NOT_FOUND', 'Commission not found');
        }
        throw error;
      });

    const toStatus: CommissionStatus = input.type === 'FINAL' ? 'DELIVERED' : 'IN_PROGRESS';
    let commissionStatus = commission.status;
    if (commission.status !== toStatus) {
      const updated = await tx.commission.update({
        where: { id: commissionId },
        data: { status: toStatus },
      });
      commissionStatus = updated.status;
      await tx.commissionEvent.create({
        data: {
          commissionId,
          fromStatus: commission.status,
          toStatus,
          actorId: artistId,
          note:
            input.type === 'FINAL' ? 'Final deliverable submitted' : 'Work in progress submitted',
        },
      });
    }

    await tx.notification.create({
      data: {
        userId: commission.clientId,
        type: 'COMMISSION_DELIVERABLE_SUBMITTED',
        data: {
          commissionId,
          deliverableId: deliverable.id,
          type: input.type,
          note,
          mediaCount: mediaIds.length,
          commissionStatus,
        },
      },
    });

    return { deliverable, commissionStatus };
  };

  // PostgreSQL can abort one of two overlapping read-before-insert
  // transactions. Retry the entire transaction so it sees the winning row.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(submit, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        attempt === SUBMISSION_ATTEMPTS ||
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2034'
      ) {
        throw error;
      }
    }
  }
}

/**
 * The client reviews a submitted deliverable (#823).
 *
 * `ACCEPT` is the client's sign-off: only the `FINAL` version can be accepted,
 * and accepting it completes the commission, which is the state change that
 * releases the artist's escrow (see the module note on escrow).
 * `REQUEST_CHANGES` records the submission as `REJECTED` — that rejection is
 * the revision — requires the feedback note, returns the commission to
 * `IN_PROGRESS` for the artist, and is refused once the configured revision
 * limit is reached. The artist is notified of either decision.
 *
 * A submission can only be decided while the commission is `IN_PROGRESS` or
 * `DELIVERED`; accepting additionally requires `DELIVERED`. While a dispute is
 * open, escrow is held and neither decision is allowed: only an admin
 * resolution can move the commission (the same rule the status endpoint and
 * dispute resolution already enforce).
 */
export async function reviewDeliverable(
  commissionId: string,
  deliverableId: string,
  clientId: string,
  input: ReviewDeliverableInput,
): Promise<ReviewDeliverableResult> {
  assertValidId(commissionId, 'commission identifier');
  assertValidId(deliverableId, 'deliverable identifier');
  assertValidId(clientId, 'client identifier');
  const note = input.note?.trim() ?? '';
  assertNoteLength(note);
  const maxRevisions = env.maxCommissionRevisions;

  if (input.decision === 'REQUEST_CHANGES' && note === '') {
    throw new AppError('BAD_REQUEST', 'A note is required when requesting changes');
  }

  return prisma.$transaction(async (tx) => {
    const commission = await tx.commission.findUnique({ where: { id: commissionId } });
    if (commission === null) {
      throw new AppError('NOT_FOUND', 'Commission not found');
    }
    if (commission.clientId !== clientId) {
      throw new AppError(
        'FORBIDDEN',
        'Only the client on this commission can review a deliverable',
      );
    }

    const deliverable = await tx.deliverable.findUnique({ where: { id: deliverableId } });
    if (deliverable === null || deliverable.commissionId !== commissionId) {
      throw new AppError('NOT_FOUND', 'Deliverable not found on this commission');
    }
    if (deliverable.status !== 'SUBMITTED') {
      throw new AppError(
        'CONFLICT',
        `This deliverable has already been ${deliverable.status.toLowerCase()}`,
      );
    }
    if (!REVIEWABLE_COMMISSION_STATUSES.includes(commission.status)) {
      throw new AppError(
        'CONFLICT',
        `Cannot review a deliverable while the commission is ${commission.status}`,
      );
    }

    const openDispute = await tx.commissionDispute.findFirst({
      where: { commissionId, status: { in: [...ESCROW_HOLDING_DISPUTE_STATUSES] } },
    });
    if (openDispute !== null) {
      throw new AppError(
        'CONFLICT',
        'This commission has an open dispute; an admin must resolve it first',
      );
    }

    const revisionCount = await tx.deliverable.count({
      where: { commissionId, status: REVISION_STATUS },
    });

    if (input.decision === 'REQUEST_CHANGES') {
      if (revisionCount >= maxRevisions) {
        throw new AppError(
          'CONFLICT',
          `This commission has already used all ${maxRevisions} of its revisions`,
        );
      }

      const rejected = await tx.deliverable.update({
        where: { id: deliverableId },
        data: { status: 'REJECTED' },
      });

      // Back to the artist. The commission is already IN_PROGRESS whenever a
      // WIP was rejected, so the transition (and its timeline entry) is only
      // recorded when the status actually moves.
      let commissionStatus = commission.status;
      if (commission.status !== 'IN_PROGRESS') {
        const updated = await tx.commission.update({
          where: { id: commissionId },
          data: { status: 'IN_PROGRESS' },
        });
        commissionStatus = updated.status;
        await tx.commissionEvent.create({
          data: {
            commissionId,
            fromStatus: commission.status,
            toStatus: 'IN_PROGRESS',
            actorId: clientId,
            note: `Changes requested: ${note}`,
          },
        });
      }

      await tx.notification.create({
        data: {
          userId: commission.artistId,
          type: 'COMMISSION_CHANGES_REQUESTED',
          data: {
            commissionId,
            deliverableId,
            note,
            revisionCount: revisionCount + 1,
            maxRevisions,
          },
        },
      });

      return {
        deliverable: rejected,
        commissionStatus,
        revisionCount: revisionCount + 1,
        maxRevisions,
        escrowReleased: false,
      };
    }

    // ACCEPT. Only the final artefact can be signed off — accepting a WIP draft
    // would complete the commission before the finished work exists.
    if (deliverable.type !== 'FINAL') {
      throw new AppError(
        'CONFLICT',
        'Only the final deliverable can be accepted — request changes on a work-in-progress draft instead',
      );
    }
    // A FINAL submission always moves the commission to DELIVERED, so a
    // mismatch means the commission was moved out from under this review and
    // completing it would skip the state machine.
    if (commission.status !== 'DELIVERED') {
      throw new AppError(
        'CONFLICT',
        `Cannot accept a deliverable while the commission is ${commission.status}`,
      );
    }

    const accepted = await tx.deliverable.update({
      where: { id: deliverableId },
      data: { status: 'ACCEPTED' },
    });
    const completed = await tx.commission.update({
      where: { id: commissionId },
      data: { status: 'COMPLETED' },
    });
    await tx.commissionEvent.create({
      data: {
        commissionId,
        fromStatus: commission.status,
        toStatus: 'COMPLETED',
        actorId: clientId,
        note: 'Final deliverable accepted; escrow released',
      },
    });

    await tx.notification.create({
      data: {
        userId: commission.artistId,
        type: 'COMMISSION_DELIVERABLE_ACCEPTED',
        data: { commissionId, deliverableId, escrowReleased: true },
      },
    });

    return {
      deliverable: accepted,
      commissionStatus: completed.status,
      revisionCount,
      maxRevisions,
      escrowReleased: true,
    };
  });
}
