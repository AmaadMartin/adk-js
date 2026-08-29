/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {loadWebPage} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const {httpRequestMock, httpsRequestMock, lookupMock} = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock('parse5', () =>
  Promise.reject(
    // The shape Node raises for an unresolvable specifier, so the tool's
    // loadOptionalPeer call translates it the way a real missing install does.
    Object.assign(
      new Error("Cannot find package 'parse5' imported from /app"),
      {
        code: 'ERR_MODULE_NOT_FOUND',
      },
    ),
  ),
);

vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: httpRequestMock,
}));

vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: httpsRequestMock,
}));

/**
 * Vitest replaces a mock factory's rejection with an error of its own, so the
 * `ERR_MODULE_NOT_FOUND` below never reaches `loadOptionalPeer` and the
 * translated "install parse5" message cannot be asserted here. That message is
 * covered by `core/test/utils/optional_peer_test.ts`. What this file pins is
 * the tool's own behaviour: a parser it cannot load is reported by throwing,
 * before it parses the url or touches the network.
 */
describe('loadWebPage when parse5 cannot be loaded', () => {
  it('rejects instead of returning the failure string', async () => {
    // The reference raises ImportError outside its try/except, so a missing
    // parser is a configuration error and not a failed fetch. A parser error
    // caught by the tool would come back as `Failed to fetch url: ...`.
    await expect(loadWebPage('https://example.com/')).rejects.toThrow();
  });

  it('reports the parser before it parses the url or reaches the network', async () => {
    await expect(loadWebPage('file:///etc/passwd')).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});
