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
import {z} from 'zod/v4';

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

describe('ReadonlyContext.state schema', () => {
  const schema = z.object({counter: z.number()});

  function makeSchemaContext(): ReadonlyContext {
    return new ReadonlyContext(
      new InvocationContext({
        invocationId: 'inv-readonly-schema',
        agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
        session: createSession({
          id: 's1',
          appName: 'app',
          userId: 'u',
          lastUpdateTime: Date.now(),
        }),
        pluginManager: new PluginManager(),
        stateSchema: schema,
      }),
    );
  }

  it('rejects a key the invocation schema does not declare', () => {
    expect(() => makeSchemaContext().state.set('typo', 1)).toThrow(
      /not declared in the state schema/,
    );
  });

  it('rejects a declared key whose value has the wrong type', () => {
    expect(() => makeSchemaContext().state.set('counter', 'one')).toThrow(
      /does not match the type declared in the state schema/,
    );
  });

  it('accepts a declared key with a matching value', () => {
    const context = makeSchemaContext();

    context.state.set('counter', 7);

    expect(context.state.get('counter')).toBe(7);
  });

  it('validates nothing when the invocation declares no schema', () => {
    const context = new ReadonlyContext(makeContext());

    context.state.set('undeclared', 'anything');

    expect(context.state.get('undeclared')).toBe('anything');
  });
});
