/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

/** Status used when an error carries no usable HTTP status of its own. */
const INTERNAL_SERVER_ERROR = 500;

/**
 * An express handler that returns a promise. The resolved value is discarded,
 * so a handler that ends in `return res.json(...)` fits this type without a
 * cast.
 */
export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Adapts a promise-returning handler to express 4's void-returning
 * `RequestHandler`.
 *
 * Express 4 ignores the promise a handler returns, so a rejection reaches
 * nobody: the client waits for a response that never arrives and node raises
 * `unhandledRejection`, which terminates the process under node's default
 * mode. Forwarding the rejection to `next` sends it to the error middleware
 * instead.
 */
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

/**
 * Reads the HTTP status an error carries. Express middleware such as the JSON
 * body parser sets `status` on the errors it raises; dropping it would report
 * a malformed or oversized request body as a server fault.
 */
export function errorStatus(err: unknown): number {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? err.status
      : undefined;

  return typeof status === 'number' && status >= 400 && status < 600
    ? status
    : INTERNAL_SERVER_ERROR;
}

/**
 * Builds the terminal express error middleware. It answers with the `{error}`
 * JSON shape that every route in the dev API server already uses, unless the
 * response has started, in which case only express can tear the connection
 * down cleanly.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    const error = `Failed to handle ${req.method} ${req.originalUrl}: ${err}`;
    logger.error(error);

    if (res.headersSent) {
      next(err);
      return;
    }

    res.status(errorStatus(err)).json({error});
  };
}
