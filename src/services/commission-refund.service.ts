/**
 * Commission cancellation refunds (#874).
 *
 * `cancelCommission` only *assesses* a refund; this service settles it in
 * the background. A BullMQ job (see `commission-refunds.queue`) invokes
 * `processCommissionRefund`, which claims the refund row
 * (PENDING → PROCESSING), builds the unsigned refund transaction via
 * `stellar-payment.service`, and notifies both parties. The API holds no
 * signing keys, so "processing" ends with a ready-to-sign XDR stored on the
 * refund — the same boundary as order payment intents.
 *
 * Idempotency: the `CommissionRefund.commissionId` unique plus the guarded
 * status transition mean a retried job can never double-build or
 * double-notify; already-COMPLETED/PROCESSING rows are skipped.
 */

import type { Commission, CommissionRefund } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { enqueueCommissionRefund } from '@/queues';
import { prisma } from '@/services/prisma.service';
import { buildCommissionRefundIntent } from '@/services/stellar-payment.service';
import { logger } from '@/utils';

/** How the worker moved the refund forward; surfaced for tests and logs. */
export type CommissionRefundOutcome =
  'COMPLETED' | 'SKIPPED_ALREADY_PROCESSED' | 'SKIPPED_NOT_REQUIRED';

/**
 * Records the intent to refund inside `cancelCommission`'s transaction: one
 * `CommissionRefund` row (PENDING) plus a queued background job. Must be
 * called with the transaction client so the row commits atomically with the
 * cancellation itself.
 */
export async function scheduleCommissionRefund(
  tx: Prisma.TransactionClient,
  commission: Pick<Commission, 'id' | 'clientId' | 'artistId' | 'asset'>,
  amount: { readonly toFixed: (dp: number) => string },
): Promise<CommissionRefund> {
  const refund = await tx.commissionRefund.upsert({
    where: { commissionId: commission.id },
    create: {
      commissionId: commission.id,
      amount: amount.toFixed(2),
      asset: commission.asset,
      status: 'PENDING',
    },
    // Re-cancelling a commission that already has a refund row must not
    // reset a COMPLETED/PROCESSING refund back to PENDING.
    update: {},
  });

  if (refund.status === 'PENDING') {
    // Enqueue after the row exists. A queue outage must not roll back the
    // cancellation itself — the PENDING row stays as the durable record and
    // the job (deduped by commission id) can be re-enqueued safely (#874).
    try {
      await enqueueCommissionRefund({ commissionId: commission.id, refundId: refund.id });
    } catch (error) {
      logger.error('commission-refund: enqueue failed; refund row left PENDING', {
        commissionId: commission.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return refund;
}

/**
 * Idempotent background processing for one commission refund (#874).
 * Safe to retry any number of times.
 */
export async function processCommissionRefund(
  commissionId: string,
  deps: { readonly now?: () => number } = {},
): Promise<CommissionRefundOutcome> {
  const commission = await prisma.commission.findUnique({ where: { id: commissionId } });
  if (commission === null) {
    logger.warn('commission-refund: commission not found, skipping', { commissionId });
    return 'SKIPPED_NOT_REQUIRED';
  }

  const refund = await prisma.commissionRefund.findUnique({ where: { commissionId } });
  if (refund === null) {
    logger.warn('commission-refund: no refund row, skipping', { commissionId });
    return 'SKIPPED_NOT_REQUIRED';
  }
  if (refund.status !== 'PENDING') {
    // Already claimed/finished by a previous attempt — the guarded
    // transition below is what makes retries safe.
    return 'SKIPPED_ALREADY_PROCESSED';
  }

  // Atomic claim: only one worker can move PENDING → PROCESSING.
  const claimed = await prisma.commissionRefund.updateMany({
    where: { commissionId, status: 'PENDING' },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return 'SKIPPED_ALREADY_PROCESSED';
  }

  try {
    const intent = await buildCommissionRefundIntent(commission, refund.amount, {
      now: deps.now,
    });

    await prisma.commissionRefund.update({
      where: { commissionId },
      data: { status: 'COMPLETED', xdr: intent.xdr, lastError: null },
    });

    await notifyParties(commission, {
      type: 'COMMISSION_REFUND_PROCESSED',
      data: {
        commissionId,
        amount: intent.amount,
        asset: intent.asset,
        refundStatus: 'COMPLETED',
        xdr: intent.xdr,
        networkPassphrase: intent.networkPassphrase,
        source: intent.source,
        destination: intent.destination,
      },
    });

    logger.info('commission-refund: completed', { commissionId, amount: intent.amount });
    return 'COMPLETED';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.commissionRefund.update({
      where: { commissionId },
      data: { status: 'FAILED', lastError: message },
    });
    await notifyParties(commission, {
      type: 'COMMISSION_REFUND_FAILED',
      data: { commissionId, error: message },
    }).catch(() => undefined);
    logger.error('commission-refund: processing failed', { commissionId, message });
    // Re-throw so BullMQ records the failure and applies its retry policy;
    // the FAILED row plus lastError give operators the trail.
    throw error;
  }
}

async function notifyParties(
  commission: Pick<Commission, 'id' | 'clientId' | 'artistId'>,
  notification: { type: string; data: Record<string, unknown> },
): Promise<void> {
  await prisma.notification.createMany({
    data: [commission.clientId, commission.artistId].map((userId) => ({
      userId,
      type: notification.type,
      data: notification.data as Prisma.InputJsonValue,
    })),
  });
}
