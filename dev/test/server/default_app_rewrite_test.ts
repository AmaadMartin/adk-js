/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Request, Response} from 'express';
import {describe, expect, it, vi} from 'vitest';

import {
  defaultAppRewriteMiddleware,
  rewriteDefaultAppUrl,
} from '../../src/server/default_app_rewrite.js';

const DEFAULT_APP = 'my_agent';

describe('rewriteDefaultAppUrl', () => {
  it.each([
    ['/users/u/sessions', '/apps/my_agent/users/u/sessions'],
    ['/users/u', '/apps/my_agent/users/u'],
    ['/app-info', '/apps/my_agent/app-info'],
    ['/trigger/x', '/apps/my_agent/trigger/x'],
    ['/users/u/sessions?limit=2', '/apps/my_agent/users/u/sessions?limit=2'],
    ['/app-info?dark=true', '/apps/my_agent/app-info?dark=true'],
  ])('rewrites %s to %s', (url, expected) => {
    expect(rewriteDefaultAppUrl(url, DEFAULT_APP)).toBe(expected);
  });

  it.each([
    ['/apps/other/users/u'],
    ['/list-apps'],
    ['/users'],
    ['/app-info/extra'],
    ['/app-information'],
    ['/trigger'],
    ['/run_sse'],
    ['/'],
  ])('leaves %s untouched', (url) => {
    expect(rewriteDefaultAppUrl(url, DEFAULT_APP)).toBe(url);
  });
});

describe('defaultAppRewriteMiddleware', () => {
  function runMiddleware(url: string): {url: string; nextCalls: number} {
    const req = {url} as Request;
    const next = vi.fn();
    defaultAppRewriteMiddleware(DEFAULT_APP)(req, {} as Response, next);
    return {url: req.url, nextCalls: next.mock.calls.length};
  }

  it('rewrites the request url in place and continues', () => {
    expect(runMiddleware('/users/u/sessions')).toEqual({
      url: '/apps/my_agent/users/u/sessions',
      nextCalls: 1,
    });
  });

  it('continues without touching a url it does not match', () => {
    expect(runMiddleware('/list-apps')).toEqual({
      url: '/list-apps',
      nextCalls: 1,
    });
  });
});
