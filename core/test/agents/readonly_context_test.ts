/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'resolved-key',
};

function makeContext(
  credentialByKey?: Record<string, AuthCredential>,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-credentials',
    agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
    session: createSession({
      id: 's1',
      appName: 'app',
      userId: 'u',
      lastUpdateTime: Date.now(),
    }),
    pluginManager: new PluginManager(),
    credentialByKey,
  });
}

describe('ReadonlyContext.getCredential', () => {
  it('returns the credential resolved for the key', () => {
    const context = new ReadonlyContext(makeContext({'my-key': CREDENTIAL}));

    expect(context.getCredential('my-key')).toBe(CREDENTIAL);
  });

  it('returns undefined for a key nothing resolved', () => {
    const context = new ReadonlyContext(makeContext({'my-key': CREDENTIAL}));

    expect(context.getCredential('other-key')).toBeUndefined();
  });

  it('sees a credential stored after it was constructed', () => {
    const invocationContext = makeContext();
    const context = new ReadonlyContext(invocationContext);

    invocationContext.credentialByKey['late-key'] = CREDENTIAL;

    expect(context.getCredential('late-key')).toBe(CREDENTIAL);
  });

  it('does not resolve an inherited object key to a credential', () => {
    // The key comes from a model-supplied auth config, so a caller must not
    // reach `Object.prototype` through it.
    const context = new ReadonlyContext(makeContext({}));

    expect(context.getCredential('toString')).toBeUndefined();
    expect(context.getCredential('constructor')).toBeUndefined();
    expect(context.getCredential('__proto__')).toBeUndefined();
  });
});

describe('InvocationContext.credentialByKey', () => {
  it('starts as an empty map with no prototype', () => {
    const context = makeContext();

    expect(context.credentialByKey).toEqual({});
    expect(Object.getPrototypeOf(context.credentialByKey)).toBeNull();
  });

  it('is shared by reference with a cloned context', () => {
    const root = makeContext();
    const clone = root.clone();

    root.credentialByKey['k'] = CREDENTIAL;

    expect(clone.credentialByKey['k']).toBe(CREDENTIAL);
  });
});
