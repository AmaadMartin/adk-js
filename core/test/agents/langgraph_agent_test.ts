/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompiledLangGraph,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  isLangGraphAgent,
  LangGraphAgent,
  LangGraphThreadConfig,
  PluginManager,
} from '@google/adk';
import {AIMessage, BaseMessage, HumanMessage} from '@langchain/core/messages';
import {
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import {describe, expect, it, vi} from 'vitest';

const AGENT_NAME = 'weather_agent';
const INSTRUCTION = 'test system prompt';

/**
 * The digests adk-python produces for the same session triples. Pinning the
 * literals rejects any change that makes the thread id process-dependent, and
 * any change that makes the two SDKs disagree.
 */
const PYTHON_THREAD_ID = {
  ascii: '8c95b75b65efd3d1ddd363cfdcb7d1d4bdd9a747aa8f505a887b1dc217fca0e2',
  nonBmp: 'dc4fcdc510cc6a6b8827e0a26c5e37b2694bed7d0ae0795ffe2e7db0dce8c898',
};

/** A message reduced to the two properties the assertions care about. */
type MessageShape = [type: string, text: string];

function shapeOf(messages: BaseMessage[]): MessageShape[] {
  return messages.map((message) => [message.getType(), message.text]);
}

function userEvent(text?: string): Event {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function agentEvent(author: string, text?: string): Event {
  return createEvent({
    author,
    content: {role: 'model', parts: [{text}]},
  });
}

interface StubGraphOptions {
  /** Anything truthy marks the graph as compiled with a checkpointer. */
  checkpointer?: unknown;
  /** What `getState` reports for the thread. */
  stateValues?: Record<string, unknown>;
  /** The last message the graph returns. */
  response?: BaseMessage;
  /** When set, `invoke` rejects with it instead of returning a response. */
  failure?: Error;
  /** When set, `getState` rejects with it instead of reporting state. */
  stateFailure?: Error;
}

function createStubGraph(options: StubGraphOptions = {}) {
  const getState = vi.fn(async (_config: LangGraphThreadConfig) => {
    if (options.stateFailure) {
      throw options.stateFailure;
    }
    return {values: options.stateValues};
  });
  const invoke = vi.fn(
    async (
      _input: {messages: BaseMessage[]},
      _config: LangGraphThreadConfig,
    ) => {
      if (options.failure) {
        throw options.failure;
      }
      return {messages: [options.response ?? new AIMessage('test response')]};
    },
  );
  const graph: CompiledLangGraph = {
    checkpointer: options.checkpointer,
    getState,
    invoke,
  };
  return {graph, getState, invoke};
}

interface SessionTriple {
  appName?: string;
  userId?: string;
  sessionId?: string;
}

function createContext(
  agent: LangGraphAgent,
  events: Event[] = [],
  triple: SessionTriple = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test_invocation_id',
    branch: 'parent_agent',
    agent,
    session: createSession({
      id: triple.sessionId ?? 'test_session_id',
      appName: triple.appName ?? 'test_app',
      userId: triple.userId ?? 'test_user',
      events,
    }),
    pluginManager: new PluginManager(),
  });
}

async function collectEvents(
  stream: AsyncGenerator<Event, void, void>,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Runs the agent once over a checkpointed stub and reports the configs used. */
async function runAndCaptureThread(triple: Required<SessionTriple>) {
  const {graph, getState, invoke} = createStubGraph({checkpointer: {}});
  const agent = new LangGraphAgent({
    name: AGENT_NAME,
    instruction: INSTRUCTION,
    graph,
  });

  await collectEvents(agent.runAsync(createContext(agent, [], triple)));

  const readConfig = getState.mock.calls[0][0];
  const writeConfig = invoke.mock.calls[0][1];
  return {
    readConfig,
    writeConfig,
    threadId: writeConfig.configurable.thread_id,
  };
}

describe('LangGraphAgent', () => {
  it('is recognised by isLangGraphAgent', () => {
    const {graph} = createStubGraph();
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});

    expect(isLangGraphAgent(agent)).toBe(true);
    expect(isLangGraphAgent({name: AGENT_NAME})).toBe(false);
  });

  it('yields one event carrying the last message of the graph', async () => {
    const {graph} = createStubGraph();
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });

    const events = await collectEvents(
      agent.runAsync(createContext(agent, [userEvent('test prompt')])),
    );

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe(AGENT_NAME);
    expect(events[0].invocationId).toBe('test_invocation_id');
    expect(events[0].branch).toBe('parent_agent');
    expect(events[0].content?.parts?.[0].text).toBe('test response');
  });

  it('forwards only the trailing user messages when the graph checkpoints', async () => {
    const {graph, getState, invoke} = createStubGraph({checkpointer: {}});
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });
    const events = [
      userEvent('test prompt'),
      agentEvent('root_agent', '(some delegation)'),
    ];

    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['system', INSTRUCTION],
      ['human', 'test prompt'],
    ]);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(getState.mock.calls[0][0]).toEqual(invoke.mock.calls[0][1]);
  });

  it('replays the whole conversation when the graph does not checkpoint', async () => {
    const {graph, getState, invoke} = createStubGraph();
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });
    const events = [
      userEvent('user prompt 1'),
      agentEvent('root_agent', 'root agent response'),
      agentEvent(AGENT_NAME, 'weather agent response'),
      userEvent('user prompt 2'),
    ];

    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['system', INSTRUCTION],
      ['human', 'user prompt 1'],
      ['ai', 'weather agent response'],
      ['human', 'user prompt 2'],
    ]);
    expect(getState).not.toHaveBeenCalled();
  });

  it('forwards only the last user message of a long checkpointed conversation', async () => {
    const {graph, invoke} = createStubGraph({checkpointer: {}});
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });
    const events = [
      userEvent('user prompt 1'),
      agentEvent('root_agent', 'root agent response'),
      agentEvent(AGENT_NAME, 'weather agent response'),
      userEvent('user prompt 2'),
    ];

    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['system', INSTRUCTION],
      ['human', 'user prompt 2'],
    ]);
  });

  it('keeps walking back past trailing agent events', async () => {
    const {graph, invoke} = createStubGraph({checkpointer: {}});
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});
    const events = [
      userEvent('first'),
      userEvent('second'),
      agentEvent('root_agent', 'delegating'),
      agentEvent('other_agent', 'still delegating'),
    ];

    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['human', 'first'],
      ['human', 'second'],
    ]);
  });

  it('stops walking back at a contentless agent event', async () => {
    const {graph, invoke} = createStubGraph({checkpointer: {}});
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});
    const events = [
      userEvent('older prompt'),
      createEvent({author: 'root_agent'}),
      userEvent('newer prompt'),
    ];

    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['human', 'newer prompt'],
    ]);
  });

  it('skips events without content or without parts when replaying', async () => {
    const {graph, invoke} = createStubGraph();
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});
    const events = [
      createEvent({author: 'user'}),
      createEvent({author: AGENT_NAME, content: {role: 'model', parts: []}}),
      userEvent('the only prompt'),
    ];

    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['human', 'the only prompt'],
    ]);
  });

  it('maps a user part without text to an empty message when checkpointing', async () => {
    const {graph, invoke} = createStubGraph({checkpointer: {}});
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});

    await collectEvents(
      agent.runAsync(createContext(agent, [userEvent(undefined)])),
    );

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([['human', '']]);
  });

  it('maps parts without text to empty messages when replaying', async () => {
    const {graph, invoke} = createStubGraph();
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});
    const events = [userEvent(undefined), agentEvent(AGENT_NAME, undefined)];

    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['human', ''],
      ['ai', ''],
    ]);
  });

  it('omits the system instruction when the checkpointed state has messages', async () => {
    const {graph, invoke} = createStubGraph({
      checkpointer: {},
      stateValues: {messages: [new HumanMessage('earlier turn')]},
    });
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });

    await collectEvents(
      agent.runAsync(createContext(agent, [userEvent('next prompt')])),
    );

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['human', 'next prompt'],
    ]);
  });

  it('keeps the system instruction when the checkpointed state is empty', async () => {
    const {graph, invoke} = createStubGraph({
      checkpointer: {},
      stateValues: {messages: []},
    });
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });

    await collectEvents(
      agent.runAsync(createContext(agent, [userEvent('first prompt')])),
    );

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['system', INSTRUCTION],
      ['human', 'first prompt'],
    ]);
  });

  it('omits the system message when no instruction is configured', async () => {
    const {graph, invoke} = createStubGraph();
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});

    await collectEvents(
      agent.runAsync(createContext(agent, [userEvent('a prompt')])),
    );

    expect(shapeOf(invoke.mock.calls[0][0].messages)).toEqual([
      ['human', 'a prompt'],
    ]);
  });

  it('concatenates the text blocks of a structured response message', async () => {
    const {graph} = createStubGraph({
      response: new AIMessage({
        content: [
          {type: 'text', text: 'first block '},
          {type: 'text', text: 'second block'},
        ],
      }),
    });
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});

    const events = await collectEvents(
      agent.runAsync(createContext(agent, [userEvent('a prompt')])),
    );

    expect(events[0].content?.parts?.[0].text).toBe('first block second block');
  });

  it('rejects live mode', async () => {
    const {graph} = createStubGraph();
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});

    await expect(
      collectEvents(agent.runLive(createContext(agent))),
    ).rejects.toThrow('Live mode is not supported in LangGraphAgent.');
  });

  it('propagates an invoke failure unchanged', async () => {
    const failure = new Error('graph exploded');
    const {graph} = createStubGraph({failure});
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});

    await expect(
      collectEvents(agent.runAsync(createContext(agent))),
    ).rejects.toBe(failure);
  });

  it('propagates a state read failure unchanged', async () => {
    const stateFailure = new Error('checkpointer unreachable');
    const {graph, invoke} = createStubGraph({
      checkpointer: {},
      stateFailure,
    });
    const agent = new LangGraphAgent({name: AGENT_NAME, graph});

    await expect(
      collectEvents(agent.runAsync(createContext(agent))),
    ).rejects.toBe(stateFailure);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('LangGraphAgent thread id', () => {
  it('matches the digest adk-python derives for the same session', async () => {
    const {threadId} = await runAndCaptureThread({
      appName: 'app',
      userId: 'alice',
      sessionId: 'session-id',
    });

    expect(threadId).toBe(PYTHON_THREAD_ID.ascii);
  });

  it('counts code points, not UTF-16 code units, in the length prefix', async () => {
    const {threadId} = await runAndCaptureThread({
      appName: 'app',
      userId: '\u{1F600}',
      sessionId: 'session-id',
    });

    expect(threadId).toBe(PYTHON_THREAD_ID.nonBmp);
  });

  it('does not share a thread between users with the same session id', async () => {
    const alice = await runAndCaptureThread({
      appName: 'app',
      userId: 'alice',
      sessionId: 'shared-id',
    });
    const bob = await runAndCaptureThread({
      appName: 'app',
      userId: 'bob',
      sessionId: 'shared-id',
    });

    expect(alice.threadId).not.toBe(bob.threadId);
  });

  it('does not share a thread between apps with the same session id', async () => {
    const first = await runAndCaptureThread({
      appName: 'app_one',
      userId: 'a',
      sessionId: 'shared-id',
    });
    const second = await runAndCaptureThread({
      appName: 'app_two',
      userId: 'a',
      sessionId: 'shared-id',
    });

    expect(first.threadId).not.toBe(second.threadId);
  });

  it('resolves the same session to the same thread, read and write', async () => {
    const first = await runAndCaptureThread({
      appName: 'app',
      userId: 'alice',
      sessionId: 'session-id',
    });
    const second = await runAndCaptureThread({
      appName: 'app',
      userId: 'alice',
      sessionId: 'session-id',
    });

    expect(first.threadId).toBe(second.threadId);
    expect(first.readConfig).toEqual(first.writeConfig);
  });

  it.each([
    [
      {appName: 'app', userId: 'alice', sessionId: 'bob|s1'},
      {appName: 'app', userId: 'alice|bob', sessionId: 's1'},
    ],
    [
      {appName: 'app|alice', userId: 'bob', sessionId: 's1'},
      {appName: 'app', userId: 'alice|bob', sessionId: 's1'},
    ],
    [
      {appName: 'app', userId: 'alice', sessionId: '1:x'},
      {appName: 'app', userId: 'alice|1:x', sessionId: ''},
    ],
  ])('cannot be forged by moving the separator (%#)', async (left, right) => {
    const first = await runAndCaptureThread(left);
    const second = await runAndCaptureThread(right);

    expect(first.threadId).not.toBe(second.threadId);
  });
});

describe('LangGraphAgent with a real compiled graph', () => {
  it('runs a graph compiled without a checkpointer', async () => {
    const observed: BaseMessage[] = [];
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('respond', (state) => {
        observed.push(...state.messages);
        return {messages: [new AIMessage('real graph response')]};
      })
      .addEdge(START, 'respond')
      .addEdge('respond', END)
      .compile();
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });

    const events = await collectEvents(agent.runAsync(createContext(agent)));

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe('real graph response');
    expect(shapeOf(observed)).toEqual([['system', INSTRUCTION]]);
  });

  it('does not resend the instruction on the second checkpointed turn', async () => {
    const turns: BaseMessage[][] = [];
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('respond', (state) => {
        turns.push([...state.messages]);
        return {messages: [new AIMessage(`reply ${turns.length}`)]};
      })
      .addEdge(START, 'respond')
      .addEdge('respond', END)
      .compile({checkpointer: new MemorySaver()});
    const agent = new LangGraphAgent({
      name: AGENT_NAME,
      instruction: INSTRUCTION,
      graph,
    });
    const events = [userEvent('first prompt')];

    await collectEvents(agent.runAsync(createContext(agent, events)));
    events.push(agentEvent(AGENT_NAME, 'reply 1'), userEvent('second prompt'));
    await collectEvents(agent.runAsync(createContext(agent, events)));

    expect(shapeOf(turns[0])).toEqual([
      ['system', INSTRUCTION],
      ['human', 'first prompt'],
    ]);
    expect(shapeOf(turns[1])).toEqual([
      ['system', INSTRUCTION],
      ['human', 'first prompt'],
      ['ai', 'reply 1'],
      ['human', 'second prompt'],
    ]);
  });
});
