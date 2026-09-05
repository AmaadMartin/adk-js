/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NextFunction, Request, Response} from 'express';
import {describe, expect, it} from 'vitest';

import {defaultAppRewriteMiddleware} from '../../src/server/default_app_rewrite.js';

/**
 * Drives the middleware with the two fields it reads and writes, and reports
 * the resulting URL plus whether the chain continued.
 */
function rewrite(
  defaultAppName: string | undefined,
  url: string,
): {url: string; continued: boolean} {
  const req = {url} as Request;
  let continued = false;
  const next: NextFunction = () => {
    continued = true;
  };

  defaultAppRewriteMiddleware(defaultAppName)(req, {} as Response, next);

  return {url: req.url, continued};
}

describe('defaultAppRewriteMiddleware', () => {
  it('serves a user path as the default app', () => {
    expect(rewrite('myAgent', '/users/u1/sessions/s1').url).toBe(
      '/apps/myAgent/users/u1/sessions/s1',
    );
  });

  it('keeps the query string', () => {
    expect(rewrite('myAgent', '/users/u1/sessions/s1?x=1&y=2').url).toBe(
      '/apps/myAgent/users/u1/sessions/s1?x=1&y=2',
    );
  });

  it('rewrites the app-info path', () => {
    expect(rewrite('myAgent', '/app-info').url).toBe('/apps/myAgent/app-info');
  });

  it('rewrites the app-info path carrying a query string', () => {
    expect(rewrite('myAgent', '/app-info?detail=1').url).toBe(
      '/apps/myAgent/app-info?detail=1',
    );
  });

  it('rewrites a trigger path', () => {
    expect(rewrite('myAgent', '/trigger/pubsub').url).toBe(
      '/apps/myAgent/trigger/pubsub',
    );
  });

  it('leaves a path that only starts like app-info alone', () => {
    expect(rewrite('myAgent', '/app-infos').url).toBe('/app-infos');
  });

  it('leaves a path that already names an app alone', () => {
    expect(rewrite('myAgent', '/apps/other/users/u1').url).toBe(
      '/apps/other/users/u1',
    );
  });

  it('leaves an unlisted path alone', () => {
    expect(rewrite('myAgent', '/list-apps').url).toBe('/list-apps');
  });

  it('passes every path through when no default app is set', () => {
    expect(rewrite(undefined, '/users/u1/sessions/s1').url).toBe(
      '/users/u1/sessions/s1',
    );
    expect(rewrite('', '/app-info').url).toBe('/app-info');
  });

  it('continues the middleware chain in both modes', () => {
    expect(rewrite('myAgent', '/users/u1').continued).toBe(true);
    expect(rewrite(undefined, '/users/u1').continued).toBe(true);
  });
});
