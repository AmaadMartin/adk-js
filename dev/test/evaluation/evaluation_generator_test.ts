/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Context,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  SingleBeforeToolCallback,
  START,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';
import {EvalTurn} from '../../src/evaluation/evaluation_constants.js';
import {
  applyMockToolCallback,
  DEFAULT_EVAL_APP_NAME,
  DEFAULT_EVAL_USER_ID,
  makeMockToolCallback,
  processQueryWithRootAgent,
} from '../../src/evaluation/evaluation_generator.js';

/**
 * Replies with the scripted turns in order: turn n answers the n-th model
 * call. Nothing here reaches the network.
 */
class ScriptedLlm extends BaseLlm {
  constructor(private readonly turns: LlmResponse[][]) {
    super({model: 'scripted-llm'});
  }

  private callCount = 0;

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield* this.turns[this.callCount++] ?? [];
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

/** A non-LLM agent, used to check that the walk passes through one. */
class PassThroughAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // A container agent of its own produces no events.
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // A container agent of its own produces no events.
  }
}

function functionCallResponse(
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {content: {role: 'model', parts: [{functionCall: {name, args}}]}};
}

function textResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

/** A tool that records every call, so a mocked call is distinguishable. */
function makeRollDieTool(calls: Array<{sides: number}>) {
  return new FunctionTool({
    name: 'roll_die',
    description: 'Rolls a die.',
    parameters: z.object({sides: z.number()}),
    execute: (args) => {
      calls.push(args);
      return {result: 'real tool ran'};
    },
  });
}

/** Minimal stand-in for the tool the callback is asked about. */
function toolNamed(name: string): BaseTool {
  return new FunctionTool({
    name,
    description: `The ${name} tool.`,
    execute: () => ({}),
  });
}

function callbackParams(
  name: string,
  args: Record<string, unknown>,
): Parameters<SingleBeforeToolCallback>[0] {
  return {
    tool: toolNamed(name),
    args,
    context: {} as Context,
  };
}

describe('makeMockToolCallback', () => {
  const turns: EvalTurn[] = [
    {
      query: 'roll a 6 sided die',
      expected_tool_use: [
        {tool_name: 'roll_die', tool_input: {sides: 6}, mock_tool_output: 4},
      ],
    },
  ];

  it('answers a matching call with the recorded mock output', () => {
    const callback = makeMockToolCallback(turns);

    expect(callback(callbackParams('roll_die', {sides: 6}))).toEqual({
      result: 4,
    });
  });

  it('consumes the matched turn so an identical second call falls through', () => {
    const callback = makeMockToolCallback(turns);

    expect(callback(callbackParams('roll_die', {sides: 6}))).toEqual({
      result: 4,
    });
    expect(callback(callbackParams('roll_die', {sides: 6}))).toBeUndefined();
  });

  it('does not match the right tool with different arguments', () => {
    const callback = makeMockToolCallback(turns);

    expect(callback(callbackParams('roll_die', {sides: 20}))).toBeUndefined();
  });

  it('does not match a different tool', () => {
    const callback = makeMockToolCallback(turns);

    expect(callback(callbackParams('check_prime', {sides: 6}))).toBeUndefined();
  });

  it('skips a turn that records no expected tool use', () => {
    const callback = makeMockToolCallback([
      {query: 'just talk'},
      {
        query: 'roll a die',
        expected_tool_use: [
          {tool_name: 'roll_die', tool_input: {sides: 6}, mock_tool_output: 4},
        ],
      },
    ]);

    expect(callback(callbackParams('roll_die', {sides: 6}))).toEqual({
      result: 4,
    });
  });

  it('never matches an entry that carries no mock_tool_output', () => {
    const callback = makeMockToolCallback([
      {
        query: 'roll a die',
        expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
      },
    ]);

    expect(callback(callbackParams('roll_die', {sides: 6}))).toBeUndefined();
  });

  it('matches a no-argument call against an entry with no tool_input', () => {
    const callback = makeMockToolCallback([
      {
        query: 'what time is it',
        expected_tool_use: [{tool_name: 'now', mock_tool_output: '12:00'}],
      },
    ]);

    expect(callback(callbackParams('now', {}))).toEqual({result: '12:00'});
  });

  it("leaves the caller's turns untouched when it consumes a match", () => {
    const original: EvalTurn[] = [
      {
        query: 'roll',
        expected_tool_use: [
          {tool_name: 'roll_die', tool_input: {sides: 6}, mock_tool_output: 4},
        ],
      },
    ];
    const callback = makeMockToolCallback(original);

    callback(callbackParams('roll_die', {sides: 6}));

    expect(original).toHaveLength(1);
  });
});

describe('applyMockToolCallback', () => {
  const mockCallback: SingleBeforeToolCallback = () => ({result: 'mocked'});

  it('installs the callback on an agent that owns a mocked tool', async () => {
    const agent = new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
    });

    await applyMockToolCallback(agent, mockCallback, new Set(['roll_die']));

    expect(agent.beforeToolCallback).toBe(mockCallback);
  });

  it('leaves an agent that owns no mocked tool alone', async () => {
    const agent = new LlmAgent({
      name: 'greeter',
      model: new ScriptedLlm([]),
      tools: [toolNamed('say_hello')],
    });

    await applyMockToolCallback(agent, mockCallback, new Set(['roll_die']));

    expect(agent.beforeToolCallback).toBeUndefined();
  });

  it('recurses into subAgents', async () => {
    const child = new LlmAgent({
      name: 'child',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
    });
    const parent = new LlmAgent({
      name: 'parent',
      model: new ScriptedLlm([]),
      subAgents: [child],
    });

    await applyMockToolCallback(parent, mockCallback, new Set(['roll_die']));

    expect(child.beforeToolCallback).toBe(mockCallback);
    expect(parent.beforeToolCallback).toBeUndefined();
  });

  it('walks through a non-LLM agent to reach its LLM children', async () => {
    const child = new LlmAgent({
      name: 'child',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
    });
    const root = new PassThroughAgent({name: 'pipeline', subAgents: [child]});

    await applyMockToolCallback(root, mockCallback, new Set(['roll_die']));

    expect(child.beforeToolCallback).toBe(mockCallback);
  });

  it('installs nothing on a workflow root, which owns no sub-agents', async () => {
    const child = new LlmAgent({
      name: 'child',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
    });
    const workflow = new Workflow({
      name: 'graph',
      edges: [[START, child]],
    });

    const dispose = await applyMockToolCallback(
      workflow,
      mockCallback,
      new Set(['roll_die']),
    );
    dispose();

    expect(child.beforeToolCallback).toBeUndefined();
  });

  it('prepends to an existing callback instead of replacing it', async () => {
    const userCalls: string[] = [];
    const userCallback: SingleBeforeToolCallback = () => {
      userCalls.push('user');
      return undefined;
    };
    const agent = new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
      beforeToolCallback: userCallback,
    });

    await applyMockToolCallback(agent, mockCallback, new Set(['roll_die']));

    expect(agent.beforeToolCallback).toEqual([mockCallback, userCallback]);
    expect(agent.canonicalBeforeToolCallbacks[1]).toBe(userCallback);
  });

  it('prepends to an existing callback array', async () => {
    const first: SingleBeforeToolCallback = () => undefined;
    const second: SingleBeforeToolCallback = () => undefined;
    const agent = new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
      beforeToolCallback: [first, second],
    });

    await applyMockToolCallback(agent, mockCallback, new Set(['roll_die']));

    expect(agent.beforeToolCallback).toEqual([mockCallback, first, second]);
  });

  it('restores an absent callback exactly', async () => {
    const agent = new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
    });

    const dispose = await applyMockToolCallback(
      agent,
      mockCallback,
      new Set(['roll_die']),
    );
    dispose();

    expect(agent.beforeToolCallback).toBeUndefined();
  });

  it('does not accumulate callbacks across two apply-and-dispose rounds', async () => {
    const userCallback: SingleBeforeToolCallback = () => undefined;
    const agent = new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
      beforeToolCallback: userCallback,
    });

    for (let round = 0; round < 2; round++) {
      const dispose = await applyMockToolCallback(
        agent,
        mockCallback,
        new Set(['roll_die']),
      );
      dispose();
    }

    expect(agent.beforeToolCallback).toBe(userCallback);
  });
});

describe('processQueryWithRootAgent', () => {
  function makeAgent(
    turns: LlmResponse[][],
    toolCalls: Array<{sides: number}>,
  ) {
    return new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm(turns),
      tools: [makeRollDieTool(toolCalls)],
    });
  }

  it('records the tool calls and the final response of each turn', async () => {
    const toolCalls: Array<{sides: number}> = [];
    const rootAgent = makeAgent(
      [
        [functionCallResponse('roll_die', {sides: 6})],
        [textResponse('I rolled a 4.')],
      ],
      toolCalls,
    );

    const results = await processQueryWithRootAgent({
      data: [
        {
          query: 'roll a 6 sided die',
          expected_tool_use: [
            {
              tool_name: 'roll_die',
              tool_input: {sides: 6},
              mock_tool_output: 4,
            },
          ],
        },
      ],
      rootAgent,
      sessionId: 'session-1',
    });

    expect(results[0].actual_tool_use).toEqual([
      {tool_name: 'roll_die', tool_input: {sides: 6}},
    ]);
    expect(results[0].response).toBe('I rolled a 4.');
    // The mock answered the call, so the real tool body never ran.
    expect(toolCalls).toEqual([]);
  });

  it('runs the real tool when the eval data supplies no mock output', async () => {
    const toolCalls: Array<{sides: number}> = [];
    const rootAgent = makeAgent(
      [[functionCallResponse('roll_die', {sides: 6})], [textResponse('Done.')]],
      toolCalls,
    );

    await processQueryWithRootAgent({
      data: [
        {
          query: 'roll a 6 sided die',
          expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        },
      ],
      rootAgent,
      sessionId: 'session-2',
    });

    expect(toolCalls).toEqual([{sides: 6}]);
  });

  it("does not mutate the caller's data array", async () => {
    const data: EvalTurn[] = [{query: 'hello'}];
    const rootAgent = makeAgent([[textResponse('Hi.')]], []);

    const results = await processQueryWithRootAgent({
      data,
      rootAgent,
      sessionId: 'session-3',
    });

    expect(data).toEqual([{query: 'hello'}]);
    expect(results[0].response).toBe('Hi.');
  });

  it('awaits resetFunc once before the turns, not once per turn', async () => {
    let resetCount = 0;
    let resetFinished = false;
    const rootAgent = makeAgent(
      [[textResponse('one')], [textResponse('two')]],
      [],
    );

    await processQueryWithRootAgent({
      data: [{query: 'first'}, {query: 'second'}],
      rootAgent,
      resetFunc: async () => {
        resetCount++;
        await Promise.resolve();
        resetFinished = true;
      },
      sessionId: 'session-4',
    });

    expect(resetCount).toBe(1);
    expect(resetFinished).toBe(true);
  });

  it('creates the session under the supplied id and initial session', async () => {
    const sessionService = new InMemorySessionService();
    const rootAgent = makeAgent([[textResponse('Hi.')]], []);

    await processQueryWithRootAgent({
      data: [{query: 'hello'}],
      rootAgent,
      initialSession: {
        app_name: 'my_app',
        user_id: 'my_user',
        state: {seen: true},
      },
      sessionId: 'session-5',
      sessionService,
    });

    const session = await sessionService.getSession({
      appName: 'my_app',
      userId: 'my_user',
      sessionId: 'session-5',
    });
    expect(session?.state['seen']).toBe(true);
  });

  it('falls back to the adk-python default app name and user id', async () => {
    const sessionService = new InMemorySessionService();
    const rootAgent = makeAgent([[textResponse('Hi.')]], []);

    await processQueryWithRootAgent({
      data: [{query: 'hello'}],
      rootAgent,
      sessionId: 'session-6',
      sessionService,
    });

    const session = await sessionService.getSession({
      appName: DEFAULT_EVAL_APP_NAME,
      userId: DEFAULT_EVAL_USER_ID,
      sessionId: 'session-6',
    });
    expect(session).toBeDefined();
  });

  it('records a call with no arguments as an empty tool_input', async () => {
    const rootAgent = new LlmAgent({
      name: 'clock',
      model: new ScriptedLlm([
        [{content: {role: 'model', parts: [{functionCall: {name: 'now'}}]}}],
        [textResponse('It is noon.')],
      ]),
      tools: [
        new FunctionTool({
          name: 'now',
          description: 'Returns the time.',
          execute: () => ({result: '12:00'}),
        }),
      ],
    });

    const results = await processQueryWithRootAgent({
      data: [{query: 'what time is it'}],
      rootAgent,
      sessionId: 'session-7',
    });

    expect(results[0].actual_tool_use).toEqual([
      {tool_name: 'now', tool_input: {}},
    ]);
  });

  it('records an unnamed function call under an empty tool name', async () => {
    const rootAgent = new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm([
        [{content: {role: 'model', parts: [{functionCall: {args: {x: 1}}}]}}],
        [textResponse('done')],
      ]),
    });

    const results = await processQueryWithRootAgent({
      data: [{query: 'go'}],
      rootAgent,
      sessionId: 'session-9',
    });

    expect(results[0].actual_tool_use).toEqual([
      {tool_name: '', tool_input: {x: 1}},
    ]);
  });

  it('restores the agent callback when the case throws', async () => {
    const rootAgent = new LlmAgent({
      name: 'roller',
      model: new ScriptedLlm([]),
      tools: [toolNamed('roll_die')],
    });

    await expect(
      processQueryWithRootAgent({
        data: [
          {
            query: 'roll',
            expected_tool_use: [
              {
                tool_name: 'roll_die',
                tool_input: {sides: 6},
                mock_tool_output: 4,
              },
            ],
          },
        ],
        rootAgent,
        resetFunc: () => {
          throw new Error('resetData exploded');
        },
        sessionId: 'session-8',
      }),
    ).rejects.toThrow('resetData exploded');

    expect(rootAgent.beforeToolCallback).toBeUndefined();
  });
});
