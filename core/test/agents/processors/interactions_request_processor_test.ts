/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  createSession,
  Event,
  Gemini,
  INTERACTIONS_REQUEST_PROCESSOR,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  SequentialAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockLlm extends BaseLlm {
  constructor() {
    super({model: 'mock-model'});
  }

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {}

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

/**
 * A non-LlmAgent that still exposes a `canonicalModel`, so the `isLlmAgent`
 * early return is the only thing standing between the processor and a
 * Gemini-backed model.
 */
class NonLlmAgentWithModel extends SequentialAgent {
  readonly canonicalModel: BaseLlm;

  constructor(params: {name: string; model: BaseLlm}) {
    super({name: params.name});
    this.canonicalModel = params.model;
  }
}

function createMockEvent(
  id: string,
  author: string,
  branch: string,
  interactionId?: string,
): Event {
  return createEvent({
    id,
    invocationId: 'test-invoc',
    author,
    branch,
    interactionId,
  });
}

function createMockInvocationContext(
  events: Event[],
  model: BaseLlm,
  agentName = 'test_agent',
): InvocationContext {
  const session = createSession({
    id: 'test-session',
    events,
    appName: 'test-app',
    userId: 'test-user',
  });

  const agent = new LlmAgent({
    name: agentName,
    model: model,
  });

  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: agent as BaseAgent,
    session,
    pluginManager: new PluginManager([]),
  });
}

describe('InteractionsRequestProcessor', () => {
  it('should not set previousInteractionId if model is not Gemini', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
    ];
    const mockModel = new MockLlm();
    const invocationContext = createMockInvocationContext(rawEvents, mockModel);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBeUndefined();
  });

  it('should not set previousInteractionId if model is Gemini but useInteractionsApi is false', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: false,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBeUndefined();
  });

  it('should set previousInteractionId to latest interactionId from history if model is Gemini and useInteractionsApi is true', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
      createMockEvent('2', 'test_agent', 'main', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    invocationContext.branch = 'main';
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-2');
  });

  it('should ignore events from other branches', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'other-branch', 'int-1'),
      createMockEvent('2', 'test_agent', 'main', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    invocationContext.branch = 'main';

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-2');
  });

  it('should ignore events from other authors', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'other_agent', 'main', 'int-1'),
      createMockEvent('2', 'test_agent', 'main', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
      'test_agent',
    );
    invocationContext.branch = 'main';
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-2');
  });

  it('should do nothing if agent is not LlmAgent', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
    ];
    const invocationContext = createMockInvocationContext(
      rawEvents,
      new MockLlm(),
    );
    invocationContext.agent = new SequentialAgent({name: 'not-an-llm-agent'});
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBeUndefined();
  });

  it('should ignore a later event from another branch', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
      createMockEvent('2', 'test_agent', 'other-branch', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    invocationContext.branch = 'main';
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-1');
  });

  it('should ignore a later event from another author', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
      createMockEvent('2', 'other_agent', 'main', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
      'test_agent',
    );
    invocationContext.branch = 'main';
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-1');
  });

  it('should do nothing if agent is not LlmAgent even when it exposes a Gemini model', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    invocationContext.branch = 'main';
    invocationContext.agent = new NonLlmAgentWithModel({
      name: 'test_agent',
      model: geminiModel,
    });
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBeUndefined();
  });

  it('should skip a later event that has no interactionId', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
      createMockEvent('2', 'test_agent', 'main'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    invocationContext.branch = 'main';
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-1');
  });
});
