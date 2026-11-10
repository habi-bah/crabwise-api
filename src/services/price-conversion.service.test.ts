import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, envMock, redisMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  envMock: {
    stellarNetwork: 'testnet' as 'testnet' | 'public',
    databaseUrl: 'postgresql://u:p@localhost:5432/db',
    databasePoolSize: 20,
    priceAssetIssuers: {
      USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      EURC: undefined as string | undefined,
      NGNT: undefined as string | undefined,
    },
  },
  redisMock: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('@/config', () => ({ env: envMock }));
vi.mock('@/utils', () => ({ logger: loggerMock }));
vi.mock('./redis.service', () => ({ tryGetRedisClient: () => redisMock }));

import { convertAmount, getPriceConversionMetrics, getRate } from './price-conversion.service';

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  envMock.stellarNetwork = 'testnet';
  envMock.priceAssetIssuers.NGNT = undefined;
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue('OK');
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('price conversion observability (#871)', () => {
  it('logs a warn and counts a network error when Horizon is unreachable', async () => {
    const before = getPriceConversionMetrics().networkErrors;
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    expect(rate).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'price-conversion: could not reach Horizon',
      expect.objectContaining({ pair: 'XLM/USDC', message: 'ECONNREFUSED' }),
    );
    expect(getPriceConversionMetrics().networkErrors).toBe(before + 1);
  });

  it('logs a warn with status details on a non-2xx Horizon response', async () => {
    const before = getPriceConversionMetrics().httpErrors;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    expect(rate).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'price-conversion: Horizon returned an error',
      expect.objectContaining({ status: 429, pair: 'XLM/USDC' }),
    );
    expect(getPriceConversionMetrics().httpErrors).toBe(before + 1);
  });

  it('logs an error (not a warn) when an asset issuer is missing — config, not outage', async () => {
    const before = getPriceConversionMetrics().configErrors;
    global.fetch = vi.fn() as unknown as typeof fetch;

    const rate = await getRate('NGNT', 'XLM');

    expect(rate).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'price-conversion: asset issuer not configured',
      expect.objectContaining({ pair: 'NGNT/XLM' }),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(getPriceConversionMetrics().configErrors).toBe(before + 1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('logs debug and counts an empty order book separately from failures', async () => {
    const before = getPriceConversionMetrics().emptyOrderBooks;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [], asks: [] }),
    }) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    expect(rate).toBeNull();
    expect(loggerMock.debug).toHaveBeenCalledWith('price-conversion: order book is empty', {
      pair: 'XLM/USDC',
    });
    expect(getPriceConversionMetrics().emptyOrderBooks).toBe(before + 1);
  });

  it('counts successes and keeps the public getRate contract unchanged', async () => {
    const before = getPriceConversionMetrics().successes;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [{ price: '0.10' }], asks: [{ price: '0.12' }] }),
    }) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    // Public API is unchanged: a plain number (or null) — no Result type.
    expect(rate).toBeCloseTo(0.11);
    expect(getPriceConversionMetrics().successes).toBe(before + 1);
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('convertAmount still surfaces a 422 when no rate is available', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;

    await expect(convertAmount(10, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    });
  });
});
