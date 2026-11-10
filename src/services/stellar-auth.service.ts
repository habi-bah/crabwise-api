/**
 * Stellar wallet authentication — nonce challenge + signature verification.
 *
 * 1. The client requests a nonce for its public key (`generateNonce`).
 * 2. The wallet signs the nonce string with its secret key.
 * 3. The server checks the signature (`verifySignature`) and consumes the
 *    nonce so it cannot be replayed. Nonces expire after `NONCE_TTL_MS`.
 */

import { randomBytes } from 'node:crypto';

import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { User } from '@prisma/client';

import { env } from '@/config';
import { AppError } from '@/middlewares';
import { prisma } from '@/services';
import { hashPassword } from '@/utils/password';
import { toPublicUser, uniqueUsername } from './auth.service';
import { issueTokenPair, type TokenPair } from './token.service';
import type { PublicUser } from './auth.service';

export const NONCE_TTL_MS = 5 * 60 * 1000;

export interface NonceChallenge {
  readonly nonce: string;
  readonly expiresAt: Date;
}

function assertValidPublicKey(publicKey: string): void {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new AppError('BAD_REQUEST', 'Invalid Stellar public key');
  }
}

export async function generateNonce(publicKey: string): Promise<NonceChallenge> {
  assertValidPublicKey(publicKey);
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  await prisma.stellarNonce.create({ data: { publicKey, nonce, expiresAt } });
  return { nonce, expiresAt };
}

/** Verify a base64 signature over `nonce` and consume the nonce (single use). */
export async function verifySignature(
  publicKey: string,
  nonce: string,
  signature: string,
): Promise<void> {
  assertValidPublicKey(publicKey);

  const record = await prisma.stellarNonce.findUnique({ where: { nonce } });
  if (
    record === null ||
    record.publicKey !== publicKey ||
    record.consumed ||
    record.expiresAt <= new Date()
  ) {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired nonce');
  }

  let valid: boolean;
  try {
    valid = Keypair.fromPublicKey(publicKey).verify(
      Buffer.from(nonce, 'utf8'),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new AppError('UNAUTHORIZED', 'Invalid signature');
  }

  // Conditional update guards against a concurrent replay of the same nonce.
  const { count } = await prisma.stellarNonce.updateMany({
    where: { id: record.id, consumed: false },
    data: { consumed: true },
  });
  if (count === 0) {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired nonce');
  }
}

/** Find or create a user by wallet public key, returning the public user and token pair. */
export async function findOrCreateUserByWalletPublicKey(
  publicKey: string,
): Promise<{ user: PublicUser; tokens: TokenPair }> {
  // `Wallet` has no Prisma relation to `User` (only the `userId` column), so
  // the owner is loaded with a second query rather than an `include`.
  const existingWallet = await prisma.wallet.findUnique({ where: { publicKey } });

  let userRecord: User;

  if (existingWallet !== null) {
    const walletUser = await prisma.user.findUnique({ where: { id: existingWallet.userId } });
    if (walletUser === null) {
      throw new AppError('NOT_FOUND', 'Wallet is not linked to a user');
    }
    userRecord = walletUser;
  } else {
    const email = `wallet_${publicKey.toLowerCase()}@stellar.local`;
    const baseName = `wallet_${publicKey.slice(1, 9).toLowerCase()}`;
    const username = await uniqueUsername(baseName + '@stellar.local');
    const passwordHash = await hashPassword(randomBytes(32).toString('hex'));

    userRecord = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          passwordHash,
          name: `Stellar User ${publicKey.slice(1, 7)}`,
          username,
          role: 'USER',
          emailVerified: false,
        },
      });
      await tx.wallet.create({
        data: {
          userId: newUser.id,
          publicKey,
          network: env.stellarNetwork,
          verified: true,
        },
      });
      return newUser;
    });
  }

  const tokens = await issueTokenPair({ id: userRecord.id, role: userRecord.role });
  return { user: toPublicUser(userRecord), tokens };
}

/** Link a wallet to an already-authenticated user. */
export async function linkWalletToUser(userId: string, publicKey: string): Promise<void> {
  const existingWallet = await prisma.wallet.findUnique({ where: { publicKey } });
  if (existingWallet !== null && existingWallet.userId !== userId) {
    throw new AppError('CONFLICT', 'Wallet already linked to another account');
  }

  await prisma.wallet.upsert({
    where: { userId },
    update: {
      publicKey,
      network: env.stellarNetwork,
      verified: true,
    },
    create: {
      userId,
      publicKey,
      network: env.stellarNetwork,
      verified: true,
    },
  });
}
