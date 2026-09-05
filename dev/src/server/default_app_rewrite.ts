/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NextFunction, Request, RequestHandler, Response} from 'express';

/**
 * Environment variable naming the app that serves requests which omit the app
 * name. Set it for a single-app deployment so clients can drop `/apps/<name>`
 * from every path.
 */
export const DEFAULT_APP_NAME_ENV_VAR = 'ADK_DEFAULT_APP_NAME';

/**
 * Path shapes that are rewritten under `/apps/<defaultAppName>`. Taken from
 * adk-python's `_DefaultAppRewriteMiddleware`. `/trigger/` has no route on
 * this server yet; it is kept so the two SDKs rewrite the same set.
 */
const REWRITTEN_PATH_PATTERNS = [/^\/users\//, /^\/app-info$/, /^\/trigger\//];

/**
 * Returns middleware that serves an app-name-less path as the default app's.
 *
 * Returns a pass-through when no default app is configured, so an unset
 * `ADK_DEFAULT_APP_NAME` leaves every path exactly as the client sent it.
 */
export function defaultAppRewriteMiddleware(
  defaultAppName: string | undefined,
): RequestHandler {
  if (!defaultAppName) {
    return (req: Request, res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    // Express keeps the query string on `req.url`, while adk-python rewrites
    // an ASGI `scope["path"]` that never carries one. Matching and rewriting
    // the pathname alone keeps `?a=b` intact.
    const queryStart = req.url.indexOf('?');
    const pathname = queryStart === -1 ? req.url : req.url.slice(0, queryStart);
    const query = queryStart === -1 ? '' : req.url.slice(queryStart);

    if (REWRITTEN_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
      req.url = `/apps/${defaultAppName}${pathname}${query}`;
    }

    next();
  };
}
