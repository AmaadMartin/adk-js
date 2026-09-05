/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  createSession,
  getFunctionCalls,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {buildAuthRequestEvent} from '../../src/agents/functions.js';

function makeAuthConfig(credentialKey: string): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'x-api-key'},
    credentialKey,
  };
}

function makeContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'invocation-id',
    agent: new LlmAgent({name: 'agent', model: 'fake-model'}),
    session: createSession({id: 'session-id', appName: 'app', userId: 'user'}),
    pluginManager: new PluginManager(),
  });
}

describe('buildAuthRequestEvent', () => {
  it('mints one long-running credential request per auth config', () => {
    const event = buildAuthRequestEvent(makeContext(), {
      'call-a': makeAuthConfig('key-a'),
      'call-b': makeAuthConfig('key-b'),
    });

    const functionCalls = getFunctionCalls(event);
    expect(functionCalls).toHaveLength(2);
    expect(functionCalls.map((call) => call.name)).toEqual([
      REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
      REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
    ]);
    expect(event.longRunningToolIds).toEqual(
      functionCalls.map((call) => call.id),
    );
    expect(event.author).toBe('agent');
    expect(event.content?.role).toBeUndefined();
  });

  it('asks once for auth configs that share a credential key', () => {
    const event = buildAuthRequestEvent(makeContext(), {
      'call-a': makeAuthConfig('shared-key'),
      'call-b': makeAuthConfig('shared-key'),
    });

    const functionCalls = getFunctionCalls(event);
    expect(functionCalls).toHaveLength(1);
    const args = functionCalls[0].args as {function_call_id: string};
    expect(args.function_call_id).toBe('call-a');
  });

  it('keeps every auth config that carries no credential key', () => {
    const event = buildAuthRequestEvent(makeContext(), {
      'call-a': makeAuthConfig(''),
      'call-b': makeAuthConfig(''),
    });

    expect(getFunctionCalls(event)).toHaveLength(2);
  });

  it('honours the author and role overrides', () => {
    const event = buildAuthRequestEvent(
      makeContext(),
      {'call-a': makeAuthConfig('key-a')},
      {author: 'other-agent', role: 'user'},
    );

    expect(event.author).toBe('other-agent');
    expect(event.content?.role).toBe('user');
  });
});
