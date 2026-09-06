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
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

class CustomPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string {
    return 'Custom instruction';
  }

  override processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] {
    return responseParts;
  }
}

/** A planner that contributes no instruction but still clears thoughts. */
class SilentPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  override processPlanningResponse(
    _callbackContext: Context,
    _responseParts: Part[],
  ): Part[] | undefined {
    return undefined;
  }
}

/** A planner that writes to state so the response processor emits an event. */
class StateWritingPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  override processPlanningResponse(
    callbackContext: Context,
    responseParts: Part[],
  ): Part[] {
    callbackContext.state.set('plan_step', 2);
    return responseParts;
  }
}

/** A planner that returns nothing, so the response parts stay as they are. */
class NoOpResponsePlanner extends BasePlanner {
  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return undefined;
  }

  override processPlanningResponse(
    _callbackContext: Context,
    _responseParts: Part[],
  ): Part[] {
    return [];
  }
}

class OverriddenBuiltInPlanner extends BuiltInPlanner {
  receivedParts?: Part[];

  override processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] {
    this.receivedParts = responseParts;
    return responseParts;
  }
}

class NonOverriddenBuiltInPlanner extends BuiltInPlanner {}

class BareAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function makeInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    branch: 'main.test_agent',
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

function makeLlmRequest(contents: Content[] = []): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}};
}

function conversationWithThought(): Content[] {
  return [
    {role: 'user', parts: [{text: 'Hello'}]},
    {
      role: 'model',
      parts: [
        {text: 'thinking...', thought: true},
        {text: 'Here is my response'},
      ],
    },
    {role: 'user', parts: [{text: 'Follow up'}]},
  ];
}

async function runRequestProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of NL_PLANNING_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    events.push(event);
  }
  return events;
}

async function runResponseProcessor(
  invocationContext: InvocationContext,
  llmResponse: LlmResponse,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of NL_PLANNING_RESPONSE_PROCESSOR.runAsync(
    invocationContext,
    llmResponse,
  )) {
    events.push(event);
  }
  return events;
}

function modelResponse(): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [
        {text: 'thinking...', thought: true},
        {text: 'Here is my response'},
      ],
    },
  };
}

describe('NlPlanningRequestProcessor', () => {
  it('leaves the request untouched when the agent has no planner', async () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const llmRequest = makeLlmRequest(conversationWithThought());

    const events = await runRequestProcessor(
      makeInvocationContext(agent),
      llmRequest,
    );

    expect(events).toEqual([]);
    expect(llmRequest.contents).toEqual(conversationWithThought());
    expect(llmRequest.config).toBeUndefined();
  });

  it('leaves the request untouched for an agent that is not an LlmAgent', async () => {
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(
      makeInvocationContext(new BareAgent({name: 'bare_agent'})),
      llmRequest,
    );

    expect(llmRequest.contents).toEqual(conversationWithThought());
  });

  it('keeps the content list unchanged for a BuiltInPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new BuiltInPlanner({thinkingConfig: {includeThoughts: true}}),
    });
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(makeInvocationContext(agent), llmRequest);

    expect(llmRequest.contents).toEqual(conversationWithThought());
    expect(llmRequest.config?.thinkingConfig).toEqual({includeThoughts: true});
  });

  it('calls applyThinkingConfig once with the request', async () => {
    const planner = new BuiltInPlanner({thinkingConfig: {}});
    const applyThinkingConfig = vi.spyOn(planner, 'applyThinkingConfig');
    const agent = new LlmAgent({name: 'test_agent', planner});
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(makeInvocationContext(agent), llmRequest);

    expect(applyThinkingConfig).toHaveBeenCalledExactlyOnceWith(llmRequest);
  });

  it('appends the planning instruction after an existing instruction', async () => {
    const planner = new PlanReActPlanner();
    vi.spyOn(planner, 'buildPlanningInstruction').mockReturnValue(
      'Test instruction',
    );
    const agent = new LlmAgent({name: 'test_agent', planner});
    const llmRequest = makeLlmRequest();
    llmRequest.config = {systemInstruction: 'Original instruction'};

    await runRequestProcessor(makeInvocationContext(agent), llmRequest);

    expect(llmRequest.config.systemInstruction).toBe(
      'Original instruction\n\nTest instruction',
    );
  });

  it('clears the thought flag on every request part', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new PlanReActPlanner(),
    });
    const llmRequest = makeLlmRequest([
      ...conversationWithThought(),
      {role: 'model', parts: undefined},
    ]);

    await runRequestProcessor(makeInvocationContext(agent), llmRequest);

    const thoughts = llmRequest.contents.flatMap((content) =>
      (content.parts ?? []).map((part) => part.thought),
    );
    expect(thoughts).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('appends the instruction of a planner deriving straight from BasePlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(makeInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe('Custom instruction');
    const thoughts = llmRequest.contents.flatMap((content) =>
      (content.parts ?? []).map((part) => part.thought),
    );
    expect(thoughts.every((thought) => thought === undefined)).toBe(true);
  });

  it('clears thought flags even when the planner returns no instruction', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new SilentPlanner(),
    });
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(makeInvocationContext(agent), llmRequest);

    expect(llmRequest.config).toBeUndefined();
    const thoughts = llmRequest.contents.flatMap((content) =>
      (content.parts ?? []).map((part) => part.thought),
    );
    expect(thoughts.every((thought) => thought === undefined)).toBe(true);
  });

  it('falls back to PlanReActPlanner for a planner without the ADK brand', async () => {
    const planner = new CustomPlanner();
    Object.defineProperty(planner, Symbol.for('google.adk.basePlanner'), {
      value: false,
    });
    const agent = new LlmAgent({name: 'test_agent', planner});
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(makeInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain('/*PLANNING*/');
  });
});

describe('NlPlanningResponseProcessor', () => {
  it('ignores a response with no content', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });
    const llmResponse: LlmResponse = {};

    const events = await runResponseProcessor(
      makeInvocationContext(agent),
      llmResponse,
    );

    expect(events).toEqual([]);
    expect(llmResponse.content).toBeUndefined();
  });

  it('ignores a response whose content has no parts', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });
    const llmResponse: LlmResponse = {content: {role: 'model', parts: []}};

    const events = await runResponseProcessor(
      makeInvocationContext(agent),
      llmResponse,
    );

    expect(events).toEqual([]);
    expect(llmResponse.content?.parts).toEqual([]);
  });

  it('ignores a response when the agent has no planner', async () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const llmResponse = modelResponse();

    const events = await runResponseProcessor(
      makeInvocationContext(agent),
      llmResponse,
    );

    expect(events).toEqual([]);
    expect(llmResponse.content).toEqual(modelResponse().content);
  });

  it('calls processPlanningResponse on a subclass that overrides it', async () => {
    const planner = new OverriddenBuiltInPlanner({thinkingConfig: {}});
    const agent = new LlmAgent({name: 'test_agent', planner});
    const llmResponse = modelResponse();
    const originalParts = llmResponse.content?.parts;

    await runResponseProcessor(makeInvocationContext(agent), llmResponse);

    expect(planner.receivedParts).toBe(originalParts);
  });

  it.each([
    ['BuiltInPlanner', () => new BuiltInPlanner({thinkingConfig: {}})],
    [
      'a subclass that does not override',
      () => new NonOverriddenBuiltInPlanner({thinkingConfig: {}}),
    ],
  ])(
    'does not call processPlanningResponse for %s',
    async (_name, makePlanner) => {
      const planner = makePlanner();
      const processPlanningResponse = vi.spyOn(
        BuiltInPlanner.prototype,
        'processPlanningResponse',
      );
      const agent = new LlmAgent({name: 'test_agent', planner});

      await runResponseProcessor(makeInvocationContext(agent), modelResponse());

      expect(processPlanningResponse).not.toHaveBeenCalled();
      processPlanningResponse.mockRestore();
    },
  );

  it('leaves the parts alone when the planner returns an empty array', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new NoOpResponsePlanner(),
    });
    const llmResponse = modelResponse();

    const events = await runResponseProcessor(
      makeInvocationContext(agent),
      llmResponse,
    );

    expect(events).toEqual([]);
    expect(llmResponse.content?.parts).toEqual(modelResponse().content?.parts);
  });

  it('replaces the parts with the planner output', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new PlanReActPlanner(),
    });
    const llmResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [{text: '/*REASONING*/Thinking./*FINAL_ANSWER*/Answer.'}],
      },
    };

    const events = await runResponseProcessor(
      makeInvocationContext(agent),
      llmResponse,
    );

    expect(events).toEqual([]);
    expect(llmResponse.content?.parts).toEqual([
      {text: 'Thinking.', thought: true},
      {text: 'Answer.'},
    ]);
  });

  it('emits one state delta event when the planner writes to state', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new StateWritingPlanner(),
    });

    const events = await runResponseProcessor(
      makeInvocationContext(agent),
      modelResponse(),
    );

    expect(events).toHaveLength(1);
    expect(events[0].invocationId).toBe('test-invocation');
    expect(events[0].author).toBe('test_agent');
    expect(events[0].branch).toBe('main.test_agent');
    expect(events[0].actions.stateDelta).toEqual({plan_step: 2});
  });
});
