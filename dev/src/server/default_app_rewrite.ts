/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NextFunction, Request, RequestHandler, Response} from 'express';

/**
 * The request paths that resolve against the default app.
 *
 * Exactly these three, matching adk-python's
 * `_DefaultAppRewriteMiddleware._PRODUCTION_PATH_PATTERNS`. Widening the set
 * would silently reroute requests that are meant to reach the server itself.
 * `/app-info` is anchored, so `/app-info/extra` is left alone.
 */
const DEFAULT_APP_PATH_PATTERNS = [
  /^\/users\//,
  /^\/app-info$/,
  /^\/trigger\//,
];

/**
 * Builds the middleware that rewrites a default-app path to its
 * `/apps/<defaultAppName>` form, so a single-app deployment can drop the app
 * name from every URL.
 *
 * The middleware is inert when no default app name is configured.
 *
 * @param defaultAppName The app every unqualified path resolves to.
 */
export function defaultAppRewriteMiddleware(
  defaultAppName?: string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (
      defaultAppName &&
      DEFAULT_APP_PATH_PATTERNS.some((pattern) => pattern.test(req.path))
    ) {
      // `req.url` is what Express routes on and carries the query string;
      // `req.originalUrl` is left alone so the access log still records the
      // path the client asked for.
      req.url = `/apps/${defaultAppName}${req.url}`;
    }
    next();
  };
}
