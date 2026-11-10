/**
 * Typed validated-request helpers.
 *
 * `validate()` middleware parses `req.body`, `req.params` and `req.query`
 * against Zod schemas and exposes the parsed output on `req.validated`.
 * Controllers read it through `getValidated()` so they never touch raw
 * `req.body` and always receive fully typed, validated data.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import type { ApiErrorField, ApiResponse } from '@/types';
import { formatZodIssues } from './error-handler.middleware';
import { AppError } from './app-error.middleware';

export interface ValidatedData<Body = unknown, Params = unknown, Query = unknown> {
  readonly body: Body;
  readonly params: Params;
  readonly query: Query;
}

export interface ValidatedRequest<
  Body = unknown,
  Params = unknown,
  Query = unknown,
> extends Request {
  validated?: ValidatedData<Body, Params, Query>;
}

interface ValidateOptions<
  BodySchema extends z.ZodType | undefined,
  ParamsSchema extends z.ZodType | undefined,
  QuerySchema extends z.ZodType | undefined,
> {
  readonly body?: BodySchema;
  readonly params?: ParamsSchema;
  readonly query?: QuerySchema;
}

export function validate<
  BodySchema extends z.ZodType | undefined = undefined,
  ParamsSchema extends z.ZodType | undefined = undefined,
  QuerySchema extends z.ZodType | undefined = undefined,
>(options: ValidateOptions<BodySchema, ParamsSchema, QuerySchema>): RequestHandler {
  return (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    const failures: Array<{ source: 'body' | 'params' | 'query'; error: z.ZodError }> = [];
    const parsed: Record<string, unknown> = {};

    for (const source of ['body', 'params', 'query'] as const) {
      const schema = options[source];
      if (schema === undefined) {
        continue;
      }
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        failures.push({ source, error: result.error });
      } else {
        parsed[source] = result.data;
      }
    }

    if (failures.length > 0) {
      const fields: ApiErrorField[] = failures.flatMap(({ source, error }) =>
        formatZodIssues(error, source),
      );
      res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', fields },
      });
      return;
    }

    (req as ValidatedRequest).validated = parsed as unknown as ValidatedData;
    next();
  };
}

export function getValidated<Body, Params, Query>(
  req: Request,
): ValidatedData<Body, Params, Query> {
  const validated = (req as ValidatedRequest).validated;
  if (validated === undefined) {
    throw AppError.internal();
  }
  return validated as ValidatedData<Body, Params, Query>;
}
