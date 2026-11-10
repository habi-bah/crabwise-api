/**
 * Notifications request-validation schemas (#842).
 */

import { z } from 'zod';

import { paginationSchema, uuidSchema } from './common.schemas';

export const listNotificationsQuerySchema = paginationSchema.extend({
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

export const notificationIdParamsSchema = z.object({
  id: uuidSchema,
});

export type ListNotificationsQuerySchema = z.infer<typeof listNotificationsQuerySchema>;
export type NotificationIdParamsSchema = z.infer<typeof notificationIdParamsSchema>;
