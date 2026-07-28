/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import {NextFunction, Request, RequestHandler, Response} from 'express';

/** Methods that cannot change server state and are exempt from the guard. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when a state-changing request carrying `origin` must be refused because
 * it comes from a different origin than the one the server was reached on.
 *
 * A missing `Origin` means the caller is not a browser (the CLI, the SDK,
 * `curl`, Agent Engine, A2A peers) and is deliberately allowed: browsers always
 * send the header on cross-origin state changes.
 *
 * Comparison is on `host` (hostname and port) only, because the `Host` request
 * header carries no scheme, so an `https://` page on the identical host and
 * port counts as same-origin. The dev server speaks plain HTTP and so cannot
 * share a host:port with a TLS listener.
 */
export function isForbiddenCrossOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowOrigins?: string,
): boolean {
  if (!origin) {
    return false;
  }
  // Mirror the string-equality semantics of `cors({origin})` so the guard never
  // refuses a request the configured CORS middleware would have allowed.
  if (allowOrigins === '*' || origin === allowOrigins) {
    return false;
  }
  try {
    return new URL(origin).host !== host;
  } catch {
    // An opaque origin (`Origin: null` from a sandboxed iframe or a `file://`
    // page) is never same-origin.
    return true;
  }
}

/**
 * Express middleware refusing cross-origin state changes. Safe methods pass
 * straight through, leaving CORS preflight and static assets untouched.
 */
export function crossOriginGuard(
  logger: Logger,
  allowOrigins?: string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    if (
      SAFE_METHODS.has(req.method) ||
      !isForbiddenCrossOrigin(origin, req.headers.host, allowOrigins)
    ) {
      next();
      return;
    }

    logger.warn(
      `Refused cross-origin ${req.method} ${req.originalUrl} from origin ${origin}`,
    );
    res.status(403).json({
      error:
        `Cross-origin request from ${origin} refused. ` +
        `Pass --allow_origins to permit a specific origin.`,
    });
  };
}
