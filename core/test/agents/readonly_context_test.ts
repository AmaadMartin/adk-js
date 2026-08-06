/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {accessToken: 'parked_token'},
};

function createReadonlyContext(
  credentialByKey?: Record<string, AuthCredential>,
): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'test-invocation-id',
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      session: createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager(),
      credentialByKey,
    }),
  );
}

describe('ReadonlyContext.getCredential', () => {
  it('returns the credential parked under the key', () => {
    const context = createReadonlyContext({known_key: CREDENTIAL});

    expect(context.getCredential('known_key')).toBe(CREDENTIAL);
  });

  it('returns undefined for a key with no credential', () => {
    const context = createReadonlyContext({known_key: CREDENTIAL});

    expect(context.getCredential('unknown_key')).toBeUndefined();
  });

  it('returns undefined when nothing was resolved for the invocation', () => {
    expect(createReadonlyContext().getCredential('known_key')).toBeUndefined();
  });
});
