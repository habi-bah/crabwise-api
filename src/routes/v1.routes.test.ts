/**
 * v1 router mount regression tests (#867) — every feature router must be
 * mounted exactly once so no request can hit two handlers for one path.
 */

import { describe, expect, it } from 'vitest';

import { featureMounts } from './v1.routes';

function mountedPaths(): readonly string[] {
  return featureMounts;
}

describe('v1Router mounts (#867)', () => {
  it('mounts /categories exactly once', () => {
    const categoriesMounts = mountedPaths().filter((path) => path === '/categories');
    expect(categoriesMounts).toHaveLength(1);
  });

  it('mounts every feature path exactly once', () => {
    const paths = mountedPaths();
    const duplicated = paths.filter((path, index) => paths.indexOf(path) !== index);
    expect(duplicated).toEqual([]);
  });
});
