import { describe, expect, it } from 'vitest';

import { BCRYPT_COST, comparePassword, hashPassword } from './password';

describe('hashPassword', () => {
  it('returns a bcrypt hash for a plain password', async () => {
    const hash = await hashPassword('SuperSecret123!');
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash).not.toContain('SuperSecret123!');
  });

  it('uses the documented cost factor', async () => {
    // Cost is encoded as the second field of a bcrypt hash, zero-padded to two
    // digits: $2b$12$, or $2b$04$ for the test-env cost of 4.
    const hash = await hashPassword('AnotherSecret456!');
    expect(hash.split('$')).toContain(String(BCRYPT_COST).padStart(2, '0'));
  });

  it('produces distinct hashes for the same password (salt)', async () => {
    const [first, second] = await Promise.all([
      hashPassword('SamePassword1!'),
      hashPassword('SamePassword1!'),
    ]);
    expect(first).not.toBe(second);
  });
});

describe('comparePassword', () => {
  it('matches the correct password', async () => {
    const hash = await hashPassword('CorrectHorse99');
    await expect(comparePassword('CorrectHorse99', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('CorrectHorse99');
    await expect(comparePassword('WrongHorse00', hash)).resolves.toBe(false);
  });

  it('rejects an invalid stored hash', async () => {
    await expect(comparePassword('Anything1!', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});
