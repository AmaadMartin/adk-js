/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSession,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  PluginManager,
  Session,
} from '@google/adk';

import {beforeEach, describe, expect, it} from 'vitest';

describe('InvocationContext.copy', () => {
  let session: Session;
  let agent: LlmAgent;

  beforeEach(() => {
    session = createSession({id: 'session_1', appName: 'testApp'});
    agent = new LlmAgent({name: 'testAgent'});
  });

  function createContext(maxLlmCalls: number): InvocationContext {
    return new InvocationContext({
      invocationId: 'inv_1',
      session,
      agent,
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls},
    });
  }

  it('keeps enforcing maxLlmCalls across copies', () => {
    const context = createContext(2);
    context.incrementLlmCallCount();

    const copied = context.copy();
    copied.incrementLlmCallCount();

    expect(() => copied.incrementLlmCallCount()).toThrow(
      'Max number of llm calls limit of 2 exceeded',
    );
  });

  it('counts calls made through a copy against the original budget', () => {
    const context = createContext(1);
    context.copy().incrementLlmCallCount();

    expect(() => context.incrementLlmCallCount()).toThrow(
      'Max number of llm calls limit of 1 exceeded',
    );
  });

  it('applies overrides and carries the live request queue', () => {
    const liveRequestQueue = new LiveRequestQueue();
    const context = new InvocationContext({
      invocationId: 'inv_1',
      session,
      agent,
      pluginManager: new PluginManager(),
      liveRequestQueue,
      liveSessionResumptionHandle: 'handle_1',
    });

    const copied = context.copy({liveSessionResumptionHandle: undefined});

    expect(copied.liveSessionResumptionHandle).toBeUndefined();
    expect(copied.liveRequestQueue).toBe(liveRequestQueue);
    expect(copied.invocationId).toBe('inv_1');
  });
});
