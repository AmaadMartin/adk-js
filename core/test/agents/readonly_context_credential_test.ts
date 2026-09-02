/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'resolved-key',
};

function makeContext(
  credentialByKey?: Record<string, AuthCredential>,
): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      session: {
        id: 'session-1',
        appName: 'app',
        userId: 'user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
      credentialByKey,
    }),
  );
}

describe('ReadonlyContext.getCredential', () => {
  it('returns the credential the resolver stored under the key', () => {
    const context = makeContext({'toolset-key': CREDENTIAL});

    expect(context.getCredential('toolset-key')).toEqual(CREDENTIAL);
  });

  it('returns undefined for a key nothing resolved', () => {
    const context = makeContext({'toolset-key': CREDENTIAL});

    expect(context.getCredential('other-key')).toBeUndefined();
  });

  it('returns undefined when the invocation resolved no credential at all', () => {
    const context = makeContext();

    expect(context.getCredential('toolset-key')).toBeUndefined();
  });
});
