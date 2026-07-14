/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createRunConfig,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {newInvocationContextId} from '../../src/agents/invocation_context.js';

describe('InvocationContext', () => {
  const agent = new LlmAgent({
    name: 'test_agent',
    model: 'gemini-2.0-flash',
  });

  const pluginManager = new PluginManager([]);

  it('correctly exposes appName, userId, sessionId, and state from session via getters', () => {
    const session = createSession({
      id: 'sess-123',
      appName: 'test_app',
      userId: 'test_user',
      state: {foo: 'bar', count: 42},
    });

    const ctx = new InvocationContext({
      invocationId: 'inv-abc',
      agent,
      session,
      pluginManager,
    });

    expect(ctx.appName).toBe('test_app');
    expect(ctx.userId).toBe('test_user');
    expect(ctx.sessionId).toBe('sess-123');
    expect(ctx.state).toEqual({foo: 'bar', count: 42});
    expect(ctx.invocationId).toBe('inv-abc');
    expect(ctx.endInvocation).toBe(false);
  });

  it('initializes optional properties correctly', () => {
    const session = createSession({
      id: 'sess-abc',
      appName: 'app',
      userId: 'usr',
    });
    const runConfig = createRunConfig({maxLlmCalls: 10});

    const ctx = new InvocationContext({
      invocationId: 'inv-opt',
      branch: 'branch-1',
      agent,
      session,
      endInvocation: true,
      runConfig,
      pluginManager,
    });

    expect(ctx.branch).toBe('branch-1');
    expect(ctx.endInvocation).toBe(true);
    expect(ctx.runConfig).toBe(runConfig);
  });

  it('increments LLM call count and enforces limit when runConfig is provided', () => {
    const session = createSession({
      id: 'sess-lim',
      appName: 'app',
      userId: 'usr',
    });
    const runConfig = createRunConfig({maxLlmCalls: 2});

    const ctx = new InvocationContext({
      invocationId: 'inv-lim',
      agent,
      session,
      runConfig,
      pluginManager,
    });

    expect(() => ctx.incrementLlmCallCount()).not.toThrow();
    expect(() => ctx.incrementLlmCallCount()).not.toThrow();
    expect(() => ctx.incrementLlmCallCount()).toThrow(
      'Max number of llm calls limit of 2 exceeded',
    );
  });

  it('increments LLM call count without error when runConfig is omitted or maxLlmCalls is not exceeded', () => {
    const session = createSession({
      id: 'sess-nolim',
      appName: 'app',
      userId: 'usr',
    });

    const ctx = new InvocationContext({
      invocationId: 'inv-nolim',
      agent,
      session,
      pluginManager,
    });

    expect(() => ctx.incrementLlmCallCount()).not.toThrow();
  });

  it('generates unique invocation context IDs with newInvocationContextId', () => {
    const id1 = newInvocationContextId();
    const id2 = newInvocationContextId();
    expect(id1).toMatch(/^e-/);
    expect(id2).toMatch(/^e-/);
    expect(id1).not.toBe(id2);
  });
});
