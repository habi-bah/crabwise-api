import { describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    $connect = vi.fn();
    $disconnect = vi.fn();
  },
}));
vi.mock('@/config', () => ({
  env: { databaseUrl: 'postgresql://u:p@localhost:5432/db', databasePoolSize: 20 },
}));
vi.mock('@/utils', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildDatabaseUrl } from './prisma.service';

const BASE = 'postgresql://u:p@localhost:5432/db';

describe('buildDatabaseUrl', () => {
  it('defaults the pool to the configured size (20)', () => {
    expect(new URL(buildDatabaseUrl()).searchParams.get('connection_limit')).toBe('20');
  });

  it('uses a configured pool size', () => {
    expect(new URL(buildDatabaseUrl(BASE, 5)).searchParams.get('connection_limit')).toBe('5');
  });

  it('keeps a connection_limit already present in the URL', () => {
    expect(
      new URL(buildDatabaseUrl(`${BASE}?connection_limit=3`, 5)).searchParams.get(
        'connection_limit',
      ),
    ).toBe('3');
  });
});
