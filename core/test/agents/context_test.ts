/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SchemaLike,
  createSession,
  isStateSchemaError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

const SCHEMA = z.object({counter: z.number()});

function makeContext(stateSchema?: SchemaLike): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-state-schema',
      agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u',
        lastUpdateTime: Date.now(),
      }),
      pluginManager: new PluginManager(),
      stateSchema,
    }),
  });
}

describe('Context state schema', () => {
  it('rejects a key the invocation schema does not declare', () => {
    const context = makeContext(SCHEMA);

    expect(() => context.state.set('typo', 1)).toThrow(
      /not declared in the state schema/,
    );
  });

  it('reports the rejection as a StateSchemaError', () => {
    const context = makeContext(SCHEMA);

    try {
      context.state.set('typo', 1);
      expect.fail('the undeclared key should not be accepted');
    } catch (err: unknown) {
      expect(isStateSchemaError(err)).toBe(true);
    }
  });

  it('rejects a declared key whose value has the wrong type', () => {
    const context = makeContext(SCHEMA);

    expect(() => context.state.set('counter', 'one')).toThrow(
      /does not match the type declared in the state schema/,
    );
  });

  it('accepts a declared key with a matching value', () => {
    const context = makeContext(SCHEMA);

    context.state.set('counter', 3);

    expect(context.state.get('counter')).toBe(3);
    expect(context.actions.stateDelta['counter']).toBe(3);
  });

  it('exempts a prefixed key, which belongs to a wider scope', () => {
    const context = makeContext(SCHEMA);

    context.state.set('app:anything', 'free');
    context.state.set('user:anything', 'free');
    context.state.set('temp:anything', 'free');

    expect(context.state.get('temp:anything')).toBe('free');
  });

  it('validates nothing when the invocation declares no schema', () => {
    const context = makeContext();

    context.state.set('undeclared', 'anything');

    expect(context.state.get('undeclared')).toBe('anything');
  });
});
