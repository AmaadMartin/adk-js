/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express, {Request, Response} from 'express';

/**
 * Environment variable naming the app that serves the app-less routes, so a
 * deployment of a single agent can be called without repeating its name in
 * every path.
 */
export const DEFAULT_APP_NAME_ENV_VAR = 'ADK_DEFAULT_APP_NAME';

/**
 * Paths the default app name is injected into. They are the routes adk-python
 * serves both with and without an app name; every other path is left alone,
 * including `/list-apps`, which is about the whole server.
 */
const REWRITTEN_PATH_PATTERNS = [/^\/users\//, /^\/app-info$/, /^\/trigger\//];

/**
 * Rewrites `/users/...` to `/apps/<defaultAppName>/users/...`, and leaves any
 * other URL untouched. The query string is preserved and is not matched
 * against, as adk-python matches the path alone.
 */
export function rewriteDefaultAppUrl(
  url: string,
  defaultAppName: string,
): string {
  const queryStart = url.indexOf('?');
  const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
  if (!REWRITTEN_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return url;
  }
  return `/apps/${defaultAppName}${url}`;
}

/**
 * Serves the app-less paths from one app.
 *
 * adk-python does the same in `_DefaultAppRewriteMiddleware`. The rewrite is
 * unvalidated there and here: a variable naming an app that does not exist
 * produces the same 404 the rewritten path would.
 */
export function defaultAppRewriteMiddleware(
  defaultAppName: string,
): express.RequestHandler {
  return (req: Request, _res: Response, next: express.NextFunction) => {
    req.url = rewriteDefaultAppUrl(req.url, defaultAppName);
    next();
  };
}
