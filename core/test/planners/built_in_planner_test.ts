/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BuiltInPlanner,
  Context,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
  createSession,
  isBuiltInPlanner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class ThinkingPlanner extends BuiltInPlanner {}

function makeLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

function makeContexts(): {readonly: ReadonlyContext; callback: Context} {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
  return {
    readonly: new ReadonlyContext(invocationContext),
    callback: new Context({invocationContext}),
  };
}

describe('BuiltInPlanner.applyThinkingConfig', () => {
  it('creates the request config when it is absent', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    const llmRequest = makeLlmRequest();

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config?.thinkingConfig).toEqual({includeThoughts: true});
  });

  it('overwrites a thinking config the request already carries', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {thinkingBudget: 1024},
    });
    const llmRequest = makeLlmRequest();
    llmRequest.config = {temperature: 0.5, thinkingConfig: {thinkingBudget: 8}};

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config.thinkingConfig).toEqual({thinkingBudget: 1024});
    expect(llmRequest.config.temperature).toBe(0.5);
  });
});

describe('BuiltInPlanner planner hooks', () => {
  it('contributes no instruction and no response processing', () => {
    const planner = new BuiltInPlanner({thinkingConfig: {}});
    const {readonly, callback} = makeContexts();

    expect(
      planner.buildPlanningInstruction(readonly, makeLlmRequest()),
    ).toBeUndefined();
    expect(
      planner.processPlanningResponse(callback, [{text: 'hi'}]),
    ).toBeUndefined();
  });
});

describe('isBuiltInPlanner', () => {
  it('accepts the class and its subclasses', () => {
    expect(isBuiltInPlanner(new BuiltInPlanner({thinkingConfig: {}}))).toBe(
      true,
    );
    expect(isBuiltInPlanner(new ThinkingPlanner({thinkingConfig: {}}))).toBe(
      true,
    );
  });

  it('rejects another planner and non-planner values', () => {
    expect(isBuiltInPlanner(new PlanReActPlanner())).toBe(false);
    expect(isBuiltInPlanner(undefined)).toBe(false);
    expect(isBuiltInPlanner(null)).toBe(false);
    expect(isBuiltInPlanner({thinkingConfig: {}})).toBe(false);
  });
});
