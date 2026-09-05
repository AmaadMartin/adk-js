/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NextFunction, Request, Response} from 'express';
import {describe, expect, it} from 'vitest';
import {defaultAppRewriteMiddleware} from '../../src/server/default_app_rewrite.js';

const DEFAULT_APP = 'default_app';

/**
 * Runs the middleware over a request carrying `url`, and reports the url the
 * next handler would route on together with the url the client sent.
 */
function rewrite(
  url: string,
  defaultAppName?: string,
): {url: string; originalUrl: string} {
  const [pathname] = url.split('?');
  const req = {url, originalUrl: url, path: pathname} as Request;
  let reachedNext = false;
  const next: NextFunction = () => {
    reachedNext = true;
  };

  defaultAppRewriteMiddleware(defaultAppName)(req, {} as Response, next);

  expect(reachedNext).toBe(true);
  return {url: req.url, originalUrl: req.originalUrl};
}

describe('defaultAppRewriteMiddleware', () => {
  it('rewrites a /users path to the default app', () => {
    expect(rewrite('/users/u1/sessions/s1', DEFAULT_APP).url).toBe(
      '/apps/default_app/users/u1/sessions/s1',
    );
  });

  it('rewrites /app-info to the default app', () => {
    expect(rewrite('/app-info', DEFAULT_APP).url).toBe(
      '/apps/default_app/app-info',
    );
  });

  it('rewrites a /trigger path to the default app', () => {
    expect(rewrite('/trigger/pubsub', DEFAULT_APP).url).toBe(
      '/apps/default_app/trigger/pubsub',
    );
  });

  it('leaves a path matching none of the three patterns alone', () => {
    expect(rewrite('/list-apps', DEFAULT_APP).url).toBe('/list-apps');
    expect(rewrite('/apps/other/users/u1', DEFAULT_APP).url).toBe(
      '/apps/other/users/u1',
    );
    expect(rewrite('/sessions/s1', DEFAULT_APP).url).toBe('/sessions/s1');
  });

  it('leaves /app-info/extra alone, because the pattern is anchored', () => {
    expect(rewrite('/app-info/extra', DEFAULT_APP).url).toBe('/app-info/extra');
  });

  it('leaves every path alone when no default app is set', () => {
    expect(rewrite('/users/u1/sessions/s1').url).toBe('/users/u1/sessions/s1');
    expect(rewrite('/app-info').url).toBe('/app-info');
    expect(rewrite('/trigger/pubsub').url).toBe('/trigger/pubsub');
  });

  it('keeps the query string on a rewritten path', () => {
    expect(rewrite('/users/u1/sessions?limit=2', DEFAULT_APP).url).toBe(
      '/apps/default_app/users/u1/sessions?limit=2',
    );
  });

  it('leaves originalUrl showing what the client sent', () => {
    expect(rewrite('/app-info', DEFAULT_APP).originalUrl).toBe('/app-info');
  });

  it('prefixes a traversal-shaped path without collapsing its segments', () => {
    // Express matches the prefixed path literally, so a path shaped like this
    // reaches no route rather than resolving to another app.
    expect(rewrite('/users/../../etc/passwd', DEFAULT_APP).url).toBe(
      '/apps/default_app/users/../../etc/passwd',
    );
  });
});
