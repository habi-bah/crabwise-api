import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const original = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import('./env.js')).env;
}

describe('LOG_STACK_TRACES_IN_PRODUCTION', () => {
  beforeEach(() => {
    process.env = { ...original };
    delete process.env.LOG_STACK_TRACES_IN_PRODUCTION;
  });

  it('defaults to false', async () => {
    expect((await loadEnv()).logStackTracesInProduction).toBe(false);
  });

  it('parses "true" and "false" explicitly', async () => {
    expect(
      (await loadEnv({ LOG_STACK_TRACES_IN_PRODUCTION: 'true' })).logStackTracesInProduction,
    ).toBe(true);
    expect(
      (await loadEnv({ LOG_STACK_TRACES_IN_PRODUCTION: 'false' })).logStackTracesInProduction,
    ).toBe(false);
  });

  it('rejects other values', async () => {
    await expect(loadEnv({ LOG_STACK_TRACES_IN_PRODUCTION: 'yes' })).rejects.toThrow(
      /LOG_STACK_TRACES_IN_PRODUCTION/,
    );
  });
});

describe('DATABASE_POOL_SIZE', () => {
  beforeEach(() => {
    process.env = { ...original };
    delete process.env.DATABASE_POOL_SIZE;
  });

  it('defaults to 20', async () => {
    expect((await loadEnv()).databasePoolSize).toBe(20);
  });

  it('reads a configured value', async () => {
    expect((await loadEnv({ DATABASE_POOL_SIZE: '5' })).databasePoolSize).toBe(5);
  });

  it.each(['0', '-3', '2.5', 'abc'])('rejects %s', async (value) => {
    await expect(loadEnv({ DATABASE_POOL_SIZE: value })).rejects.toThrow(/DATABASE_POOL_SIZE/);
  });
});

describe('env', () => {
  beforeEach(() => {
    process.env = { ...original };
    delete process.env.BCRYPT_COST;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  describe('BCRYPT_COST', () => {
    it('defaults to 12 outside the test environment', async () => {
      expect((await loadEnv({ NODE_ENV: 'development' })).bcryptCost).toBe(12);
    });

    it('uses a low cost automatically under NODE_ENV=test', async () => {
      expect((await loadEnv({ NODE_ENV: 'test' })).bcryptCost).toBe(4);
    });

    it('honours an explicit value in range', async () => {
      expect((await loadEnv({ NODE_ENV: 'development', BCRYPT_COST: '14' })).bcryptCost).toBe(14);
    });

    it.each(['9', '16', '12.5', 'abc'])('rejects %s', async (value) => {
      await expect(loadEnv({ BCRYPT_COST: value })).rejects.toThrow(/BCRYPT_COST/);
    });
  });

  describe('asset issuers', () => {
    it('rejects a malformed issuer address', async () => {
      await expect(loadEnv({ EURC_ASSET_ISSUER: 'not-an-address' })).rejects.toThrow(
        /EURC_ASSET_ISSUER/,
      );
    });

    it('requires EURC and NGNT issuers in production', async () => {
      await expect(
        loadEnv({
          NODE_ENV: 'production',
          EURC_ASSET_ISSUER: undefined,
          NGNT_ASSET_ISSUER: undefined,
        }),
      ).rejects.toThrow(/EURC_ASSET_ISSUER[\s\S]*NGNT_ASSET_ISSUER/);
    });

    it('starts in production when all issuers are configured', async () => {
      const env = await loadEnv({
        NODE_ENV: 'production',
        EURC_ASSET_ISSUER: ISSUER,
        NGNT_ASSET_ISSUER: ISSUER,
      });
      expect(env.priceAssetIssuers.EURC).toBe(ISSUER);
    });
  });
});
