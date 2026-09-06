/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlanner,
  BuildPlanningInstructionParams,
  BuiltInPlanner,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PLANNING_TAG,
  PlanReActPlanner,
  PluginManager,
  ProcessPlanningResponseParams,
  createSession,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/nl_planning_processor.js';

class BareAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

/** A planner deriving straight from BasePlanner. */
class CustomPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string {
    return 'Custom instruction';
  }

  override processPlanningResponse({
    responseParts,
  }: ProcessPlanningResponseParams): Part[] {
    return responseParts;
  }
}

/** A planner whose two hooks resolve asynchronously. */
class AsyncPlanner extends BasePlanner {
  override async buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): Promise<string> {
    return 'Async instruction';
  }

  override async processPlanningResponse(
    _params: ProcessPlanningResponseParams,
  ): Promise<Part[]> {
    return [{text: 'async processed'}];
  }
}

/** A planner that contributes no instruction. */
class SilentPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string | undefined {
    return undefined;
  }

  override processPlanningResponse(
    _params: ProcessPlanningResponseParams,
  ): Part[] | undefined {
    return undefined;
  }
}

/** A planner that drops every part. */
class EmptyResultPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string | undefined {
    return undefined;
  }

  override processPlanningResponse(
    _params: ProcessPlanningResponseParams,
  ): Part[] {
    return [];
  }
}

/** A planner that writes session state while processing the response. */
class StateWritingPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string | undefined {
    return undefined;
  }

  override processPlanningResponse({
    context,
    responseParts,
  }: ProcessPlanningResponseParams): Part[] {
    context.state.set('planner_key', 'planner_value');
    return responseParts;
  }
}

/** A BuiltInPlanner subclass that overrides processPlanningResponse. */
class OverriddenBuiltInPlanner extends BuiltInPlanner {
  receivedParts?: Part[];

  override processPlanningResponse({
    responseParts,
  }: ProcessPlanningResponseParams): Part[] {
    this.receivedParts = responseParts;
    return responseParts;
  }
}

/** A BuiltInPlanner subclass that does NOT override processPlanningResponse. */
class NonOverriddenBuiltInPlanner extends BuiltInPlanner {}

function createInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    branch: 'test-branch',
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

function makeLlmRequest(contents: LlmRequest['contents'] = []): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}};
}

function makeLlmResponse(parts: Part[]): LlmResponse {
  return {content: {role: 'model', parts}};
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

function conversationWithThought(): LlmRequest['contents'] {
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

describe('NlPlanningRequestProcessor', () => {
  it('leaves the content list unchanged for a BuiltInPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new BuiltInPlanner({thinkingConfig: {}}),
    });
    const contents = conversationWithThought();
    const llmRequest = makeLlmRequest(contents);
    const originalContents = structuredClone(contents);

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('calls applyThinkingConfig once with the request', async () => {
    const planner = new BuiltInPlanner({thinkingConfig: {}});
    const spy = vi.spyOn(planner, 'applyThinkingConfig');
    const agent = new LlmAgent({name: 'test_agent', planner});
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(llmRequest);
  });

  it('sets the thinking config on the request for a BuiltInPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new BuiltInPlanner({thinkingConfig: {includeThoughts: true}}),
    });
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.thinkingConfig).toEqual({includeThoughts: true});
  });

  it('appends the PlanReActPlanner instruction after the existing one', async () => {
    const planner = new PlanReActPlanner();
    vi.spyOn(planner, 'buildPlanningInstruction').mockReturnValue(
      'Test instruction',
    );
    const agent = new LlmAgent({name: 'test_agent', planner});
    const llmRequest = makeLlmRequest();
    llmRequest.config = {systemInstruction: 'Original instruction'};

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config.systemInstruction).toBe(
      'Original instruction\n\nTest instruction',
    );
  });

  it('removes the thought marks for a PlanReActPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new PlanReActPlanner(),
    });
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    const thoughts = llmRequest.contents.flatMap((content) =>
      (content.parts ?? []).map((part) => part.thought),
    );
    expect(thoughts.every((thought) => thought === undefined)).toBe(true);
  });

  it('appends the instruction of a planner deriving from BasePlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe('Custom instruction');
  });

  it('removes the thought marks for a planner deriving from BasePlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    for (const content of llmRequest.contents) {
      for (const part of content.parts ?? []) {
        expect(part.thought).toBeUndefined();
      }
    }
  });

  it('awaits an instruction that resolves asynchronously', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new AsyncPlanner(),
    });
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe('Async instruction');
  });

  it('appends no instruction when the planner returns undefined', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new SilentPlanner(),
    });
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents[1].parts?.[0].thought).toBeUndefined();
  });

  it('falls back to PlanReActPlanner for a non-BasePlanner value', async () => {
    const agent = new LlmAgent({name: 'test_agent'});
    Object.assign(agent, {planner: {}});
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(PLANNING_TAG);
  });

  it('ignores a planner on an agent that is not an LlmAgent', async () => {
    const agent = new BareAgent({name: 'test_agent'});
    Object.assign(agent, {planner: new CustomPlanner()});
    const llmRequest = makeLlmRequest();

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('leaves the request untouched when the agent has no planner', async () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const llmRequest = makeLlmRequest(conversationWithThought());

    const events = await runRequestProcessor(
      createInvocationContext(agent),
      llmRequest,
    );

    expect(events).toHaveLength(0);
    expect(llmRequest.config).toBeUndefined();
    expect(llmRequest.contents[1].parts?.[0].thought).toBe(true);
  });

  it('leaves the request untouched for an agent with no planner property', async () => {
    const agent = new BareAgent({name: 'test_agent'});
    const llmRequest = makeLlmRequest(conversationWithThought());

    await runRequestProcessor(createInvocationContext(agent), llmRequest);

    expect(llmRequest.config).toBeUndefined();
  });

  it('accepts empty contents and a content with no parts', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });
    const emptyRequest = makeLlmRequest([]);
    const partlessRequest = makeLlmRequest([{role: 'user'}]);
    const invocationContext = createInvocationContext(agent);

    await runRequestProcessor(invocationContext, emptyRequest);
    await runRequestProcessor(invocationContext, partlessRequest);

    expect(emptyRequest.config?.systemInstruction).toBe('Custom instruction');
    expect(partlessRequest.config?.systemInstruction).toBe(
      'Custom instruction',
    );
  });

  it('yields no events', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });

    const events = await runRequestProcessor(
      createInvocationContext(agent),
      makeLlmRequest(),
    );

    expect(events).toHaveLength(0);
  });
});

describe('NlPlanningResponseProcessor', () => {
  it('calls processPlanningResponse on an overriding BuiltInPlanner subclass', async () => {
    const planner = new OverriddenBuiltInPlanner({thinkingConfig: {}});
    const agent = new LlmAgent({name: 'test_agent', planner});
    const responseParts: Part[] = [
      {text: 'thinking...', thought: true},
      {text: 'Here is my response'},
    ];

    await runResponseProcessor(
      createInvocationContext(agent),
      makeLlmResponse(responseParts),
    );

    expect(planner.receivedParts).toEqual(responseParts);
  });

  it('leaves the parts alone for a plain BuiltInPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new BuiltInPlanner({thinkingConfig: {}}),
    });
    const parts: Part[] = [
      {text: 'thinking...', thought: true},
      {text: 'Here is my response'},
    ];
    const llmResponse = makeLlmResponse(parts);

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      llmResponse,
    );

    expect(llmResponse.content?.parts).toEqual(parts);
    expect(events).toHaveLength(0);
  });

  it('leaves the parts alone for a non-overriding BuiltInPlanner subclass', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new NonOverriddenBuiltInPlanner({thinkingConfig: {}}),
    });
    const parts: Part[] = [
      {text: 'thinking...', thought: true},
      {text: 'Here is my response'},
    ];
    const llmResponse = makeLlmResponse(parts);

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      llmResponse,
    );

    expect(llmResponse.content?.parts).toEqual(parts);
    expect(events).toHaveLength(0);
  });

  it('replaces the parts with what the planner returned', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new PlanReActPlanner(),
    });
    const llmResponse = makeLlmResponse([
      {text: `${PLANNING_TAG}Step one.\n/*FINAL_ANSWER*/The answer.`},
    ]);

    await runResponseProcessor(createInvocationContext(agent), llmResponse);

    expect(llmResponse.content?.parts).toEqual([
      {text: 'Step one.\n', thought: true},
      {text: 'The answer.'},
    ]);
  });

  it('awaits parts that resolve asynchronously', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new AsyncPlanner(),
    });
    const llmResponse = makeLlmResponse([{text: 'raw'}]);

    await runResponseProcessor(createInvocationContext(agent), llmResponse);

    expect(llmResponse.content?.parts).toEqual([{text: 'async processed'}]);
  });

  it('keeps the original parts when the planner returns an empty array', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new EmptyResultPlanner(),
    });
    const llmResponse = makeLlmResponse([{text: 'original'}]);

    await runResponseProcessor(createInvocationContext(agent), llmResponse);

    expect(llmResponse.content?.parts).toEqual([{text: 'original'}]);
  });

  it('keeps the original parts when the planner returns undefined', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new SilentPlanner(),
    });
    const llmResponse = makeLlmResponse([{text: 'original'}]);

    await runResponseProcessor(createInvocationContext(agent), llmResponse);

    expect(llmResponse.content?.parts).toEqual([{text: 'original'}]);
  });

  it('yields one state-delta event when the planner writes state', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new StateWritingPlanner(),
    });

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      makeLlmResponse([{text: 'original'}]),
    );

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('test_agent');
    expect(events[0].invocationId).toBe('test-invocation');
    expect(events[0].branch).toBe('test-branch');
    expect(events[0].actions.stateDelta).toEqual({
      planner_key: 'planner_value',
    });
  });

  it('yields no event when the planner writes no state', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new CustomPlanner(),
    });

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      makeLlmResponse([{text: 'original'}]),
    );

    expect(events).toHaveLength(0);
  });

  it('returns early for a response with no content', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new StateWritingPlanner(),
    });

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      {},
    );

    expect(events).toHaveLength(0);
  });

  it('returns early for content with no parts', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new StateWritingPlanner(),
    });

    const events = await runResponseProcessor(createInvocationContext(agent), {
      content: {role: 'model'},
    });

    expect(events).toHaveLength(0);
  });

  it('returns early for content with an empty parts array', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      planner: new StateWritingPlanner(),
    });

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      makeLlmResponse([]),
    );

    expect(events).toHaveLength(0);
  });

  it('returns early when the agent has no planner', async () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const llmResponse = makeLlmResponse([{text: 'original'}]);

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      llmResponse,
    );

    expect(events).toHaveLength(0);
    expect(llmResponse.content?.parts).toEqual([{text: 'original'}]);
  });

  it('falls back to PlanReActPlanner for a non-BasePlanner value', async () => {
    const agent = new LlmAgent({name: 'test_agent'});
    Object.assign(agent, {planner: {}});
    const llmResponse = makeLlmResponse([
      {text: `${PLANNING_TAG}Step one.\n/*FINAL_ANSWER*/The answer.`},
    ]);

    await runResponseProcessor(createInvocationContext(agent), llmResponse);

    expect(llmResponse.content?.parts).toEqual([
      {text: 'Step one.\n', thought: true},
      {text: 'The answer.'},
    ]);
  });

  it('ignores a planner on an agent that is not an LlmAgent', async () => {
    const agent = new BareAgent({name: 'test_agent'});
    Object.assign(agent, {planner: new StateWritingPlanner()});
    const llmResponse = makeLlmResponse([{text: 'original'}]);

    const events = await runResponseProcessor(
      createInvocationContext(agent),
      llmResponse,
    );

    expect(events).toHaveLength(0);
    expect(llmResponse.content?.parts).toEqual([{text: 'original'}]);
  });
});
