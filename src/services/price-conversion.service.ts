/**
 * Stellar-asset price conversion utility.
 *
 * Rates come from Stellar's public Horizon DEX order book (the "Stellar
 * DEX" data source named in the issue) and are cached in Redis for a short
 * TTL, so the DEX is queried at most once per asset pair per cache window
 * rather than on every request.
 *
 * Issuer accounts for USDC/EURC/NGNT are NOT guessed at here. USDC defaults
 * to Circle's well-known, widely-published issuer on the Stellar public
 * network; EURC and NGNT have no default and are only enabled once their
 * issuer is supplied via `EURC_ASSET_ISSUER` / `NGNT_ASSET_ISSUER` — an
 * incorrect issuer for a payment asset is worse than declining to support
 * it. Callers see this as a normal "rate unavailable" outcome, not a crash.
 */

import { env } from '@/config';
import { AppError } from '@/middlewares';
import { logger } from '@/utils';

import { tryGetRedisClient } from './redis.service';

export type PriceAsset = 'XLM' | 'USDC' | 'NGNT' | 'EURC';

const CACHE_TTL_SECONDS = 5 * 60;

const HORIZON_URL =
  env.stellarNetwork === 'public'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';

/**
 * Failure-mode counters for DEX rate lookups (#871). Distinguishing "no
 * price right now" from "Horizon is down" or "an issuer is misconfigured"
 * is the whole point — operators read these via `getPriceConversionMetrics`.
 */
export interface PriceConversionMetrics {
  /** Successful mid-price computations. */
  readonly successes: number;
  /** Successful queries whose order book had no usable bid/ask. */
  readonly emptyOrderBooks: number;
  /** Transport-level failures reaching Horizon (DNS, refused, reset…). */
  readonly networkErrors: number;
  /** Horizon responded, but not with 2xx. */
  readonly httpErrors: number;
  /** Local configuration problems — e.g. a missing asset issuer. */
  readonly configErrors: number;
}

const metrics = {
  successes: 0,
  emptyOrderBooks: 0,
  networkErrors: 0,
  httpErrors: 0,
  configErrors: 0,
};

/** Snapshot of the DEX lookup counters (#871). */
export function getPriceConversionMetrics(): Readonly<PriceConversionMetrics> {
  return { ...metrics };
}

function issuerFor(asset: Exclude<PriceAsset, 'XLM'>): string | undefined {
  return env.priceAssetIssuers[asset];
}

interface OrderBookLevel {
  readonly price: string;
}

interface OrderBookResponse {
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
}

function assetQueryParams(prefix: 'selling' | 'buying', asset: PriceAsset): [string, string][] {
  if (asset === 'XLM') {
    return [[`${prefix}_asset_type`, 'native']];
  }

  const issuer = issuerFor(asset);
  if (issuer === undefined) {
    throw new AppError('UNPROCESSABLE_ENTITY', `No issuer configured for asset ${asset}.`);
  }

  return [
    [`${prefix}_asset_type`, 'credit_alphanum4'],
    [`${prefix}_asset_code`, asset],
    [`${prefix}_asset_issuer`, issuer],
  ];
}

/**
 * Mid price of `base` priced in `counter`, from the DEX order book's best
 * bid/ask. Returns `null` (never throws) for any failure — missing issuer,
 * network error, empty order book — so callers get a uniform "unavailable"
 * signal regardless of cause, but each failure mode is now logged with
 * appropriate severity and counted (#871):
 *
 * - config error (missing issuer)  → `error`   (operator action required)
 * - Horizon unreachable / network  → `warn`    (likely transient)
 * - non-2xx Horizon response       → `warn`    (rate limit / outage)
 * - empty order book               │ `debug`   (normal market state)
 */
async function fetchOrderBookMidPrice(
  base: PriceAsset,
  counter: PriceAsset,
): Promise<number | null> {
  const pair = `${base}/${counter}`;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams([
      ...assetQueryParams('selling', base),
      ...assetQueryParams('buying', counter),
    ]);
  } catch (error) {
    // Missing issuer for a non-native asset — a configuration problem, not a
    // transient outage, so it logs at error severity (#871).
    metrics.configErrors += 1;
    logger.error('price-conversion: asset issuer not configured', {
      pair,
      network: env.stellarNetwork,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`${HORIZON_URL}/order_book?${params.toString()}`);
  } catch (error) {
    metrics.networkErrors += 1;
    logger.warn('price-conversion: could not reach Horizon', {
      pair,
      horizonUrl: HORIZON_URL,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!response.ok) {
    metrics.httpErrors += 1;
    logger.warn('price-conversion: Horizon returned an error', {
      pair,
      horizonUrl: HORIZON_URL,
      status: response.status,
      statusText: response.statusText,
    });
    return null;
  }

  const book = (await response.json()) as OrderBookResponse;
  const bestBid = book.bids[0] !== undefined ? Number.parseFloat(book.bids[0].price) : undefined;
  const bestAsk = book.asks[0] !== undefined ? Number.parseFloat(book.asks[0].price) : undefined;

  if (bestBid === undefined && bestAsk === undefined) {
    metrics.emptyOrderBooks += 1;
    logger.debug('price-conversion: order book is empty', { pair });
    return null;
  }

  metrics.successes += 1;
  if (bestBid !== undefined && bestAsk !== undefined) {
    return (bestBid + bestAsk) / 2;
  }
  return bestBid ?? bestAsk ?? null;
}

function cacheKey(base: PriceAsset, counter: PriceAsset): string {
  return `price-rate:${base}:${counter}`;
}

/**
 * Rate to convert 1 unit of `base` into `counter`, or `null` if unavailable.
 * Cached in Redis for `CACHE_TTL_SECONDS` when Redis is configured; falls
 * through to a direct DEX lookup on a cache miss or when Redis isn't set up
 * (no caching in that case, but no failure either).
 */
export async function getRate(base: PriceAsset, counter: PriceAsset): Promise<number | null> {
  if (base === counter) {
    return 1;
  }

  const redis = tryGetRedisClient();

  if (redis !== undefined) {
    const cached = await redis.get(cacheKey(base, counter));
    if (cached !== null) {
      return Number.parseFloat(cached);
    }
  }

  const rate = await fetchOrderBookMidPrice(base, counter);

  if (rate !== null && redis !== undefined) {
    await redis.set(cacheKey(base, counter), rate.toString(), 'EX', CACHE_TTL_SECONDS);
  }

  return rate;
}

export interface ConversionResult {
  readonly amount: number;
  readonly rate: number;
  readonly from: PriceAsset;
  readonly to: PriceAsset;
}

/**
 * Converts `amount` of `from` into `to`. Throws `AppError('UNPROCESSABLE_ENTITY', ...)`
 * when no rate is currently available — callers that want a soft fallback
 * (e.g. displaying a price without conversion) should catch this rather
 * than let it propagate, or use `tryConvertAmount` which returns `null`.
 */
export async function convertAmount(
  amount: number,
  from: PriceAsset,
  to: PriceAsset,
): Promise<ConversionResult> {
  const rate = await getRate(from, to);
  if (rate === null) {
    throw new AppError(
      'UNPROCESSABLE_ENTITY',
      `No exchange rate is currently available for ${from} -> ${to}.`,
    );
  }
  return { amount: amount * rate, rate, from, to };
}

/**
 * Like `convertAmount`, but returns `null` instead of throwing when no rate is
 * currently available — for callers that would rather display the original
 * asset than handle an error.
 */
export async function tryConvertAmount(
  amount: number,
  from: PriceAsset,
  to: PriceAsset,
): Promise<ConversionResult | null> {
  const rate = await getRate(from, to);
  if (rate === null) {
    return null;
  }
  return { amount: amount * rate, rate, from, to };
}
