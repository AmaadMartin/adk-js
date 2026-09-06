/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmRequest} from '@google/adk';
import {
  BasePlanner,
  BuiltInPlanner,
  Context,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  createSession,
  isBuiltInPlanner,
} from '@google/adk';
import type {Part} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({id: 'session-1', appName: 'app', userId: 'user-1'}),
    pluginManager: new PluginManager(),
  });
}

/** A third-party planner, proving `BasePlanner` is extendable elsewhere. */
class CustomPlanner extends BasePlanner {
  override buildPlanningInstruction(): string {
    return 'plan first';
  }

  override processPlanningResponse(): Part[] {
    return [];
  }
}

describe('BuiltInPlanner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the config it was constructed with', () => {
    const thinkingConfig = {includeThoughts: true, thinkingBudget: 1024};
    const planner = new BuiltInPlanner({thinkingConfig});

    expect(planner.thinkingConfig).toBe(thinkingConfig);
  });

  it('creates config when the request has none', () => {
    const thinkingConfig = {includeThoughts: true};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = createLlmRequest();

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config?.thinkingConfig).toBe(thinkingConfig);
  });

  it('overwrites an existing thinking config and leaves its siblings alone', () => {
    const thinkingConfig = {includeThoughts: true};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = createLlmRequest();
    llmRequest.config = {
      temperature: 0.5,
      thinkingConfig: {includeThoughts: false},
    };

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config.thinkingConfig).toBe(thinkingConfig);
    expect(llmRequest.config.temperature).toBe(0.5);
  });

  it('logs a debug message when it overwrites', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    const llmRequest = createLlmRequest();
    llmRequest.config = {thinkingConfig: {includeThoughts: false}};

    planner.applyThinkingConfig(llmRequest);

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Overwriting `thinking_config` from `generate_content_config`',
      ),
    );
  });

  it('does not log when the request has no config', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });

    planner.applyThinkingConfig(createLlmRequest());

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('does not log when the config carries no thinking config', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    const llmRequest = createLlmRequest();
    llmRequest.config = {temperature: 0.5};

    planner.applyThinkingConfig(llmRequest);

    expect(debugSpy).not.toHaveBeenCalled();
    expect(llmRequest.config.thinkingConfig).toBe(planner.thinkingConfig);
  });

  it('applies an empty thinking config', () => {
    const thinkingConfig = {};
    const planner = new BuiltInPlanner({thinkingConfig});
    const llmRequest = createLlmRequest();

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.config?.thinkingConfig).toBe(thinkingConfig);
  });

  it('leaves the rest of the request untouched', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    const llmRequest = createLlmRequest();
    const {contents, toolsDict, liveConnectConfig} = llmRequest;

    planner.applyThinkingConfig(llmRequest);

    expect(llmRequest.contents).toBe(contents);
    expect(llmRequest.contents).toHaveLength(0);
    expect(llmRequest.toolsDict).toBe(toolsDict);
    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.liveConnectConfig).toBe(liveConnectConfig);
    expect(llmRequest.liveConnectConfig).toEqual({});
  });

  it('builds no planning instruction', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    const readonlyContext = new ReadonlyContext(createInvocationContext());

    expect(
      planner.buildPlanningInstruction({
        readonlyContext,
        llmRequest: createLlmRequest(),
      }),
    ).toBeUndefined();
  });

  it('processes no planning response and does not mutate the parts', () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    const callbackContext = new Context({
      invocationContext: createInvocationContext(),
    });
    const responseParts: Part[] = [
      {text: 'thinking...', thought: true},
      {text: 'answer'},
    ];

    expect(
      planner.processPlanningResponse({
        context: callbackContext,
        responseParts,
      }),
    ).toBeUndefined();
    expect(responseParts).toEqual([
      {text: 'thinking...', thought: true},
      {text: 'answer'},
    ]);
  });
});

describe('isBuiltInPlanner', () => {
  it('accepts a BuiltInPlanner and a subclass of one', () => {
    class Sub extends BuiltInPlanner {}

    expect(isBuiltInPlanner(new BuiltInPlanner({thinkingConfig: {}}))).toBe(
      true,
    );
    expect(isBuiltInPlanner(new Sub({thinkingConfig: {}}))).toBe(true);
  });

  it('rejects anything that is not a BuiltInPlanner', () => {
    expect(isBuiltInPlanner(undefined)).toBe(false);
    expect(isBuiltInPlanner(null)).toBe(false);
    expect(isBuiltInPlanner({})).toBe(false);
    expect(isBuiltInPlanner('planner')).toBe(false);
    expect(isBuiltInPlanner(new CustomPlanner())).toBe(false);
  });
});
