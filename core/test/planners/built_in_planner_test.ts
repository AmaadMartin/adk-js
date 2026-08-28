/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlanner,
  BuiltInPlanner,
  Context,
  createSession,
  InvocationContext,
  isBuiltInPlanner,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {ThinkingLevel} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
// `logger` is not part of the public surface, so the test reaches for it here.
import {logger} from '../../src/utils/logger.js';

const THINKING_CONFIG = {includeThoughts: true, thinkingBudget: 1024};

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

function createInvocationContext(): InvocationContext {
  const agent: BaseAgent = new LlmAgent({name: 'test_agent'});
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

/** A planner that is not a BuiltInPlanner, so the guard must reject it. */
class CustomPlanner implements BasePlanner {
  buildPlanningInstruction(): string | undefined {
    return 'plan first';
  }

  processPlanningResponse(): undefined {
    return undefined;
  }
}

class SubclassedPlanner extends BuiltInPlanner {}

describe('BuiltInPlanner', () => {
  it('keeps the thinking config it was constructed with', () => {
    const planner = new BuiltInPlanner({thinkingConfig: THINKING_CONFIG});

    expect(planner.thinkingConfig).toBe(THINKING_CONFIG);
  });

  it('creates the request config when the request carries none', () => {
    const planner = new BuiltInPlanner({thinkingConfig: THINKING_CONFIG});
    const llmRequest = createLlmRequest();

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config?.thinkingConfig).toEqual(THINKING_CONFIG);
  });

  it('overwrites an existing thinking config and keeps its siblings', () => {
    const planner = new BuiltInPlanner({thinkingConfig: THINKING_CONFIG});
    const llmRequest = createLlmRequest();
    llmRequest.config = {
      temperature: 0.5,
      thinkingConfig: {includeThoughts: false},
    };

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config.thinkingConfig).toEqual(THINKING_CONFIG);
    expect(llmRequest.config.temperature).toBe(0.5);
  });

  it('logs the overwrite of an existing thinking config', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const planner = new BuiltInPlanner({thinkingConfig: THINKING_CONFIG});
    const llmRequest = createLlmRequest();
    llmRequest.config = {thinkingConfig: {includeThoughts: false}};

    planner.applyThinkingConfig(llmRequest);

    expect(debug).toHaveBeenCalledOnce();
    expect(debug.mock.calls[0][0]).toContain('Overwriting `thinkingConfig`');
    debug.mockRestore();
  });

  it('logs nothing when the request has no thinking config yet', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const planner = new BuiltInPlanner({thinkingConfig: THINKING_CONFIG});

    planner.applyThinkingConfig(createLlmRequest());

    expect(debug).not.toHaveBeenCalled();
    debug.mockRestore();
  });

  it('applies an empty thinking config, matching adk-python', () => {
    const planner = new BuiltInPlanner({thinkingConfig: {}});
    const llmRequest = createLlmRequest();
    llmRequest.config = {thinkingConfig: {thinkingLevel: ThinkingLevel.HIGH}};

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config.thinkingConfig).toEqual({});
  });

  it('contributes no planning instruction and no response parts', () => {
    const planner = new BuiltInPlanner({thinkingConfig: THINKING_CONFIG});
    const invocationContext = createInvocationContext();

    expect(
      planner.buildPlanningInstruction(
        new ReadonlyContext(invocationContext),
        createLlmRequest(),
      ),
    ).toBeUndefined();
    expect(
      planner.processPlanningResponse(new Context({invocationContext}), [
        {text: 'answer'},
      ]),
    ).toBeUndefined();
  });
});

describe('isBuiltInPlanner', () => {
  it('accepts a BuiltInPlanner and a subclass of one', () => {
    expect(
      isBuiltInPlanner(new BuiltInPlanner({thinkingConfig: THINKING_CONFIG})),
    ).toBe(true);
    expect(isBuiltInPlanner(new SubclassedPlanner({thinkingConfig: {}}))).toBe(
      true,
    );
  });

  it('rejects another planner and every non-planner value', () => {
    expect(isBuiltInPlanner(new CustomPlanner())).toBe(false);
    expect(isBuiltInPlanner({})).toBe(false);
    expect(isBuiltInPlanner(null)).toBe(false);
    expect(isBuiltInPlanner(undefined)).toBe(false);
    expect(isBuiltInPlanner('BuiltInPlanner')).toBe(false);
  });

  it('rejects an object whose signature symbol is not true', () => {
    const impostor = {
      [Symbol.for('google.adk.builtInPlanner')]: 'yes',
    };

    expect(isBuiltInPlanner(impostor)).toBe(false);
  });
});
