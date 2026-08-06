/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  afterAgentCallback1,
  afterAgentCallback2,
  beforeAgentCallback1,
  beforeAgentCallback2,
  registerConformanceIntegrations,
  shortcutAgentExecution,
} from '../../src/conformance/conformance_integrations.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';

/**
 * The conformance callbacks read and write session state, so each test needs a
 * `Context` backed by its own `Session`.
 */
function createCallbackContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'callback_agent'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('registerConformanceIntegrations callbacks', () => {
  let registry: IntegrationRegistry;

  beforeEach(() => {
    registry = new IntegrationRegistry();
    registerConformanceIntegrations(registry);
  });

  it('registers every before agent callback under its qualified name', () => {
    expect(
      registry.getBeforeAgentCallback(
        'callback_agent_002.callbacks.shortcut_agent_execution',
      ),
    ).toBe(shortcutAgentExecution);
    expect(
      registry.getBeforeAgentCallback(
        'callback_agent_001.callbacks.before_agent_callback1',
      ),
    ).toBe(beforeAgentCallback1);
    expect(
      registry.getBeforeAgentCallback(
        'callback_agent_001.callbacks.before_agent_callback2',
      ),
    ).toBe(beforeAgentCallback2);
  });

  it('registers every after agent callback under its qualified name', () => {
    expect(
      registry.getAfterAgentCallback(
        'callback_agent_003.callbacks.after_agent_callback1',
      ),
    ).toBe(afterAgentCallback1);
    expect(
      registry.getAfterAgentCallback(
        'callback_agent_003.callbacks.after_agent_callback2',
      ),
    ).toBe(afterAgentCallback2);
  });
});

describe('shortcutAgentExecution', () => {
  it('lets the first turn through, then replies with the limit message', () => {
    // Both calls share one Context because the limit flag lives in state.
    const context = createCallbackContext();

    expect(shortcutAgentExecution(context)).toBeUndefined();
    expect(context.state.get('conversationLimitReached')).toBe('True');

    expect(shortcutAgentExecution(context)).toEqual({
      role: 'model',
      parts: [{text: 'Sorry, you have reached the limit of the conversation.'}],
    });
  });
});

describe('agent callback state chaining', () => {
  it('chains beforeAgentCallback1 into beforeAgentCallback2', async () => {
    const context = createCallbackContext();

    await expect(beforeAgentCallback1(context)).resolves.toBeUndefined();
    expect(context.state.get('beforeAgentCallbackStateKey')).toBe('value1');

    await expect(beforeAgentCallback2(context)).resolves.toBeUndefined();
    expect(context.state.get('beforeAgentCallbackStateKey')).toBe(
      'value1+value2',
    );
  });

  it('chains afterAgentCallback1 into afterAgentCallback2', async () => {
    const context = createCallbackContext();

    await expect(afterAgentCallback1(context)).resolves.toBeUndefined();
    expect(context.state.get('afterAgentCallbackStateKey')).toBe('value1');

    await expect(afterAgentCallback2(context)).resolves.toBeUndefined();
    expect(context.state.get('afterAgentCallbackStateKey')).toBe(
      'value1+value2',
    );
  });
});
