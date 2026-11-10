/**
 * Migration guard.
 *
 * Prisma applies pending migrations in lexicographic folder order, and the
 * timestamp prefix is what carries the author's intended ordering. Two
 * failure modes have already broken `prisma migrate deploy` here:
 *
 *   1. two folders sharing a timestamp prefix, which leaves ordering to the
 *      name suffix;
 *   2. two folders with *different* prefixes but byte-identical SQL, so the
 *      second one fails on a fresh database ("relation already exists").
 *
 * This script checks for both, plus folder names that do not carry a
 * 14-digit timestamp at all. Exits non-zero with a readable list.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');
const MIGRATION_NAME_RE = /^(\d{14})_.+$/;
/** `migration_lock.toml` and any other file in the directory are not migrations. */
const MIGRATION_FILENAME = 'migration.sql';

/**
 * Prefix collisions that predate this guard.
 *
 * Prisma records migrations by folder name, so renaming one that has already
 * been applied makes `migrate deploy` try to apply it again (and fail on the
 * existing table). These groups are therefore left alone, and the guard only
 * rejects them if their contents *change* or a new duplicate appears.
 */
const LEGACY_DUPLICATE_GROUPS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    '20260924130000',
    [
      '20260924130000_analytics_events',
      '20260924130000_artwork_price',
      '20260924130000_media_variants',
      '20260924130000_saves',
    ],
  ],
  [
    '20260924140000',
    ['20260924140000_artwork_search_indexes', '20260924140000_order_idempotency_key'],
  ],
]);

interface Migration {
  readonly folder: string;
  readonly timestamp: string;
  readonly checksum: string;
}

function loadMigrations(): Migration[] {
  const entries = readdirSync(MIGRATIONS_DIR).sort();
  const migrations: Migration[] = [];

  for (const folder of entries) {
    const path = join(MIGRATIONS_DIR, folder);
    if (!statSync(path).isDirectory()) {
      continue;
    }

    const match = MIGRATION_NAME_RE.exec(folder);
    if (match === null) {
      throw new Error(
        `prisma/migrations/${folder}: expected a 14-digit timestamp prefix ` +
          'followed by a description, e.g. 20260101120000_add_widgets',
      );
    }

    const sql = readFileSync(join(path, MIGRATION_FILENAME), 'utf8');
    migrations.push({
      folder,
      timestamp: match[1]!,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations;
}

function findProblems(migrations: readonly Migration[]): string[] {
  const problems: string[] = [];

  const byTimestamp = new Map<string, string[]>();
  const byChecksum = new Map<string, string[]>();

  for (const migration of migrations) {
    byTimestamp.set(migration.timestamp, [
      ...(byTimestamp.get(migration.timestamp) ?? []),
      migration.folder,
    ]);
    byChecksum.set(migration.checksum, [
      ...(byChecksum.get(migration.checksum) ?? []),
      migration.folder,
    ]);
  }

  for (const [timestamp, folders] of byTimestamp) {
    if (folders.length < 2) {
      continue;
    }

    const legacy = LEGACY_DUPLICATE_GROUPS.get(timestamp);
    const isUnchangedLegacyGroup =
      legacy !== undefined &&
      legacy.length === folders.length &&
      legacy.every((folder) => folders.includes(folder));
    if (isUnchangedLegacyGroup) {
      continue;
    }

    problems.push(
      `timestamp ${timestamp} is shared by ${folders.length} migrations, so ` +
        `apply order falls back to the name suffix:\n  ${folders.join('\n  ')}`,
    );
  }

  for (const folders of byChecksum.values()) {
    if (folders.length > 1) {
      problems.push(
        `identical migration.sql in ${folders.length} folders, so the later one ` +
          `always fails on a fresh database:\n  ${folders.join('\n  ')}`,
      );
    }
  }

  return problems;
}

function main(): void {
  const migrations = loadMigrations();
  const problems = findProblems(migrations);

  if (problems.length > 0) {
    console.error(`prisma/migrations is invalid (${problems.length} problem(s)):`);
    for (const problem of problems) {
      console.error(`\n- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`prisma/migrations: ${migrations.length} migrations, no problems found.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
