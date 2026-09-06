/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  BasePlanner,
  BuildPlanningInstructionParams,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  ProcessPlanningResponseParams,
  ReadonlyContext,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it, Mock, vi} from 'vitest';
import {
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/nl_planning_request_processor.js';

const AGENT_NAME = 'test_agent';
const BRANCH = 'root.test_agent';
const CUSTOM_INSTRUCTION = 'Custom instruction';

/**
 * A model instance is used rather than a model name so that `canonicalModel`
 * resolves without credentials.
 */
class MockLlm extends BaseLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {}

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

class NonLlmAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

/** The adk-js counterpart of adk-python's `CustomPlanner` test fixture. */
class CustomPlanner extends BasePlanner {
  buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string | undefined {
    return CUSTOM_INSTRUCTION;
  }

  processPlanningResponse(
    params: ProcessPlanningResponseParams,
  ): Part[] | undefined {
    return params.responseParts;
  }
}

/** A planner whose two methods are spies, so calls can be asserted. */
class SpyPlanner extends BasePlanner {
  readonly buildPlanningInstruction: Mock<
    BasePlanner['buildPlanningInstruction']
  >;
  readonly processPlanningResponse: Mock<
    BasePlanner['processPlanningResponse']
  >;

  constructor(
    instruction: BasePlanner['buildPlanningInstruction'] = () =>
      CUSTOM_INSTRUCTION,
    process: BasePlanner['processPlanningResponse'] = () => undefined,
  ) {
    super();
    this.buildPlanningInstruction = vi.fn(instruction);
    this.processPlanningResponse = vi.fn(process);
  }
}

function createAgent(planner?: BasePlanner): LlmAgent {
  return new LlmAgent({
    name: AGENT_NAME,
    model: new MockLlm({model: 'mock-model'}),
    planner,
  });
}

/**
 * An agent whose `planner` holds an object with the planner methods but no
 * planner signature, as untyped JavaScript or a config file can produce.
 */
function createAgentWithLookalikePlanner() {
  const lookalike = {
    buildPlanningInstruction: vi.fn(() => CUSTOM_INSTRUCTION),
    processPlanningResponse: vi.fn(() => [{text: 'planned'}]),
  };
  const agent = createAgent();
  agent.planner = lookalike as unknown as BasePlanner;
  return {agent, lookalike};
}

function createMockInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    branch: BRANCH,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createLlmRequest(contents: Content[] = []): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}};
}

async function runRequestProcessor(
  agent: BaseAgent,
  llmRequest: LlmRequest,
): Promise<void> {
  const invocationContext = createMockInvocationContext(agent);
  for await (const _ of NL_PLANNING_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // The request processor yields nothing; drain it anyway.
  }
}

async function runResponseProcessor(
  agent: BaseAgent,
  llmResponse: LlmResponse,
): Promise<Event[]> {
  const invocationContext = createMockInvocationContext(agent);
  const events: Event[] = [];
  for await (const event of NL_PLANNING_RESPONSE_PROCESSOR.runAsync(
    invocationContext,
    llmResponse,
  )) {
    events.push(event);
  }
  return events;
}

function contentsWithThought(): Content[] {
  return [
    {role: 'user', parts: [{text: 'initial query'}]},
    {
      role: 'model',
      parts: [
        {text: 'Text with thought', thought: true},
        {text: 'Regular text'},
      ],
    },
    {role: 'user', parts: [{text: 'follow up'}]},
  ];
}

describe('NlPlanningRequestProcessor', () => {
  it('appends the planner instruction when none is set', async () => {
    const llmRequest = createLlmRequest();

    await runRequestProcessor(createAgent(new CustomPlanner()), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe(CUSTOM_INSTRUCTION);
  });

  it('appends the planner instruction after an existing one', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = {systemInstruction: 'Original instruction'};

    await runRequestProcessor(createAgent(new CustomPlanner()), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe(
      'Original instruction\n\nCustom instruction',
    );
  });

  it('appends nothing when the planner returns no instruction', async () => {
    const planner = new SpyPlanner(() => undefined);
    const llmRequest = createLlmRequest();

    await runRequestProcessor(createAgent(planner), llmRequest);

    expect(planner.buildPlanningInstruction).toHaveBeenCalledOnce();
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('clears every thought marker on the request contents', async () => {
    const llmRequest = createLlmRequest(contentsWithThought());

    await runRequestProcessor(createAgent(new CustomPlanner()), llmRequest);

    const parts = llmRequest.contents.flatMap((content) => content.parts ?? []);
    expect(parts.map((part) => part.thought)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(parts.map((part) => part.text)).toEqual([
      'initial query',
      'Text with thought',
      'Regular text',
      'follow up',
    ]);
  });

  it('tolerates a content that carries no parts', async () => {
    const llmRequest = createLlmRequest([{role: 'user'}]);

    await runRequestProcessor(createAgent(new CustomPlanner()), llmRequest);

    expect(llmRequest.contents[0].parts).toBeUndefined();
  });

  it('leaves the request untouched when the agent has no planner', async () => {
    const llmRequest = createLlmRequest(contentsWithThought());

    await runRequestProcessor(createAgent(), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents[1].parts?.[0].thought).toBe(true);
  });

  it('leaves the request untouched when the planner has no signature', async () => {
    const {agent, lookalike} = createAgentWithLookalikePlanner();
    const llmRequest = createLlmRequest(contentsWithThought());

    await runRequestProcessor(agent, llmRequest);

    expect(lookalike.buildPlanningInstruction).not.toHaveBeenCalled();
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents[1].parts?.[0].thought).toBe(true);
  });

  it('leaves the request untouched when the agent is not an LlmAgent', async () => {
    const llmRequest = createLlmRequest(contentsWithThought());

    await runRequestProcessor(new NonLlmAgent({name: 'plain'}), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents[1].parts?.[0].thought).toBe(true);
  });

  it('passes a readonly context for the agent and the same request', async () => {
    const planner = new SpyPlanner();
    const llmRequest = createLlmRequest();

    await runRequestProcessor(createAgent(planner), llmRequest);

    const [params] = planner.buildPlanningInstruction.mock.calls[0];
    expect(params.readonlyContext).toBeInstanceOf(ReadonlyContext);
    expect(params.readonlyContext.agentName).toBe(AGENT_NAME);
    expect(params.llmRequest).toBe(llmRequest);
  });

  it('lets an exception from the planner propagate', async () => {
    const planner = new SpyPlanner(() => {
      throw new Error('planner failed');
    });
    const llmRequest = createLlmRequest(contentsWithThought());

    await expect(
      runRequestProcessor(createAgent(planner), llmRequest),
    ).rejects.toThrow('planner failed');
    expect(llmRequest.contents[1].parts?.[0].thought).toBe(true);
  });

  it('awaits a planner that returns the instruction as a promise', async () => {
    const planner = new SpyPlanner(async () => CUSTOM_INSTRUCTION);
    const llmRequest = createLlmRequest();

    await runRequestProcessor(createAgent(planner), llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe(CUSTOM_INSTRUCTION);
  });
});

describe('NlPlanningResponseProcessor', () => {
  it('replaces the response parts the planner returns', async () => {
    const replacement: Part[] = [{text: 'planned', thought: true}];
    const planner = new SpyPlanner(undefined, () => replacement);
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'raw'}]},
    };

    const events = await runResponseProcessor(
      createAgent(planner),
      llmResponse,
    );

    expect(llmResponse.content?.parts).toBe(replacement);
    expect(events).toHaveLength(0);
  });

  it('keeps the model parts when the planner returns nothing', async () => {
    const originalParts: Part[] = [{text: 'raw'}];
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: originalParts},
    };

    const events = await runResponseProcessor(
      createAgent(new SpyPlanner()),
      llmResponse,
    );

    expect(llmResponse.content?.parts).toBe(originalParts);
    expect(events).toHaveLength(0);
  });

  it('emits one state delta event when the planner writes state', async () => {
    const planner = new SpyPlanner(undefined, ({context}) => {
      context.state.set('plan', 'step one');
      return undefined;
    });
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'raw'}]},
    };

    const events = await runResponseProcessor(
      createAgent(planner),
      llmResponse,
    );

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe(AGENT_NAME);
    expect(events[0].branch).toBe(BRANCH);
    expect(events[0].actions.stateDelta).toMatchObject({plan: 'step one'});
  });

  it('mutates the parts the planner was handed', async () => {
    const parts: Part[] = [{text: 'reasoning'}, {text: 'answer'}];
    const planner = new SpyPlanner(undefined, ({responseParts}) => {
      responseParts[0].thought = true;
      return responseParts;
    });
    const llmResponse: LlmResponse = {content: {role: 'model', parts}};

    await runResponseProcessor(createAgent(planner), llmResponse);

    expect(llmResponse.content?.parts).toBe(parts);
    expect(parts[0].thought).toBe(true);
    expect(parts[1].thought).toBeUndefined();
  });

  it('skips the planner for a response with no content', async () => {
    const planner = new SpyPlanner();

    const events = await runResponseProcessor(createAgent(planner), {});

    expect(planner.processPlanningResponse).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('skips the planner for a response with empty parts', async () => {
    const planner = new SpyPlanner();

    const events = await runResponseProcessor(createAgent(planner), {
      content: {role: 'model', parts: []},
    });

    expect(planner.processPlanningResponse).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('does nothing when the agent has no planner', async () => {
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'raw'}]},
    };

    const events = await runResponseProcessor(createAgent(), llmResponse);

    expect(events).toHaveLength(0);
  });

  it('does nothing when the planner has no signature', async () => {
    const {agent, lookalike} = createAgentWithLookalikePlanner();
    const parts: Part[] = [{text: 'raw'}];
    const llmResponse: LlmResponse = {content: {role: 'model', parts}};

    const events = await runResponseProcessor(agent, llmResponse);

    expect(lookalike.processPlanningResponse).not.toHaveBeenCalled();
    expect(llmResponse.content?.parts).toBe(parts);
    expect(events).toHaveLength(0);
  });

  it('lets an exception from the planner propagate', async () => {
    const parts: Part[] = [{text: 'raw'}];
    const planner = new SpyPlanner(undefined, () => {
      throw new Error('planner failed');
    });
    const llmResponse: LlmResponse = {content: {role: 'model', parts}};

    await expect(
      runResponseProcessor(createAgent(planner), llmResponse),
    ).rejects.toThrow('planner failed');
    expect(llmResponse.content?.parts).toBe(parts);
  });

  it('awaits a planner that returns the parts as a promise', async () => {
    const replacement: Part[] = [{text: 'planned', thought: true}];
    const planner = new SpyPlanner(undefined, async () => replacement);
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'raw'}]},
    };

    await runResponseProcessor(createAgent(planner), llmResponse);

    expect(llmResponse.content?.parts).toBe(replacement);
  });
});
