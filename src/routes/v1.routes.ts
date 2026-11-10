/**
 * Versioned API router (v1).
 *
 * Every feature router mounts under `/api/v1/<feature>`. Feature routers are
 * created by the router factory so protection (e.g. auth rate limiting) and
 * construction stay consistent.
 */

import { Router } from 'express';
import { adminRouter } from './admin.routes';
import { analyticsRouter } from './analytics.routes';
import { artworksRouter } from './artworks.routes';
import { authRouter } from './auth.routes';
import { categoriesRouter } from './categories.routes';
import { commissionsRouter } from './commissions.routes';
import { v1HealthRouter } from './health-v1.routes';
import { marketplaceRouter } from './marketplace.routes';
import { mediaRouter } from './media.routes';
import { messagesRouter } from './messages.routes';
import { notificationsRouter } from './notifications.routes';
import { ordersRouter } from './orders.routes';
import { paymentsRouter } from './payments.routes';
import { portfoliosRouter } from './portfolios.routes';
import { profilesRouter } from './profiles.routes';
import { reviewsRouter } from './reviews.routes';
import { threadsRouter } from './threads.routes';
import { statsRouter } from './stats.routes';
import { searchRouter } from './search.routes';
import { tagsRouter } from './tags.routes';
import { usersRouter } from './users.routes';

/**
 * The single source of truth for the v1 mount points. Express 5 does not
 * expose a `path` on `use()` layers, so the table is exported for the mount
 * regression test (#867) instead of being re-derived from the stack.
 */
const FEATURE_MOUNTS = [
  ['/health', v1HealthRouter],
  ['/auth', authRouter],
  ['/users', usersRouter],
  ['/profiles', profilesRouter],
  ['/portfolios', portfoliosRouter],
  ['/artworks', artworksRouter],
  ['/marketplace', marketplaceRouter],
  ['/search', searchRouter],
  ['/categories', categoriesRouter],
  ['/media', mediaRouter],
  ['/tags', tagsRouter],
  ['/orders', ordersRouter],
  ['/payments', paymentsRouter],
  ['/commissions', commissionsRouter],
  ['/reviews', reviewsRouter],
  ['/threads', threadsRouter],
  ['/messages', messagesRouter],
  ['/notifications', notificationsRouter],
  ['/admin', adminRouter],
  ['/stats', statsRouter],
  ['/analytics', analyticsRouter],
] as const;

export const featureMounts: readonly string[] = FEATURE_MOUNTS.map(([path]) => path);

export const v1Router: Router = Router();

for (const [path, router] of FEATURE_MOUNTS) {
  v1Router.use(path, router);
}
