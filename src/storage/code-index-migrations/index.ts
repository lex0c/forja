// Migrations for the code-index database (separate file from the
// sessions DB; see `CODE_INDEX.md` §2.1). Reuses the generic
// `migrate()` runner from `../migrate.ts` — the runner's
// `_migrations` table is per-database, so each DB tracks its own
// version chain independently. Adding a new migration here ONLY
// affects the code-index DB; sessions migrations live in
// `../migrations/`.
import type { Migration } from '../migrations/index.ts';
import { m001Initial } from './001-initial.ts';

export const CODE_INDEX_MIGRATIONS: readonly Migration[] = [m001Initial] as const;
