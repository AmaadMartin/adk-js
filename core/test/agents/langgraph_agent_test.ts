/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompiledLangGraph,
  Event,
  InvocationContext,
  LangGraphAgent,
  LangGraphThreadConfig,
  LoopAgent,
  PluginManager,
  createEvent,
  createSession,
  isLangGraphAgent,
} from '@google/adk';
import {AIMessage, BaseMessage} from '@langchain/core/messages';
import {
  MemorySaver,
  MessagesAnnotation,
  StateGraph,
} from '@langchain/langgraph';
import {describe, expect, it, vi} from 'vitest';

const SESSION_ID = 'test-session';
const INSTRUCTION = 'test system prompt';
const AGENT_NAME = 'weather_agent';
const BRANCH = 'parent_agent';
const INVOCATION_ID = 'test_invocation_id';
const THREAD_CONFIG: LangGraphThreadConfig = {
  configurable: {thread_id: SESSION_ID},
};

/** The `{messages}` payload the agent passes to `graph.invoke`. */
interface GraphInput {
  messages: BaseMessage[];
}

/**
 * Creates a graph stub that records its calls, so the tests can assert on the
 * exact messages the adapter builds without involving a model.
 */
function createStubGraph(options: {
  checkpointer?: unknown;
  stateValues?: Record<string, unknown>;
  responseContent?: unknown;
}) {
  const invoke = vi.fn(
    async (
      _input: GraphInput,
      _config: LangGraphThreadConfig,
    ): Promise<{messages: Array<{content: unknown}>}> => ({
      messages: [{content: options.responseContent ?? 'test response'}],
    }),
  );
  const getState = vi.fn(
    async (
      _config: LangGraphThreadConfig,
    ): Promise<{values?: Record<string, unknown>}> => ({
      values: options.stateValues ?? {},
    }),
  );
  return {
    checkpointer: options.checkpointer,
    getState,
    invoke,
  } satisfies CompiledLangGraph;
}

function userEvent(text?: string): Event {
  return createEvent({
    invocationId: INVOCATION_ID,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function agentEvent(author: string, text: string): Event {
  return createEvent({
    invocationId: INVOCATION_ID,
    author,
    content: {role: 'model', parts: [{text}]},
  });
}

function createContext(agent: LangGraphAgent, events: Event[]) {
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    branch: BRANCH,
    agent,
    session: createSession({
      id: SESSION_ID,
      appName: 'test-app',
      userId: 'test-user',
      events,
    }),
    pluginManager: new PluginManager(),
  });
}

function createAgent(graph: CompiledLangGraph, instruction?: string) {
  return new LangGraphAgent({
    name: AGENT_NAME,
    description: 'A agent that answers weather questions',
    instruction,
    graph,
  });
}

/** Renders a message as a `[className, content]` pair for assertions. */
function describeMessage(message: BaseMessage): [string, unknown] {
  return [message.constructor.name, message.content];
}

async function runAgent(
  agent: LangGraphAgent,
  events: Event[],
): Promise<Event[]> {
  const yielded: Event[] = [];
  for await (const event of agent.runAsync(createContext(agent, events))) {
    yielded.push(event);
  }
  return yielded;
}

const FOUR_TURN_CONVERSATION: Event[] = [
  userEvent('user prompt 1'),
  agentEvent('root_agent', 'root agent response'),
  agentEvent(AGENT_NAME, 'weather agent response'),
  userEvent('user prompt 2'),
];

describe('LangGraphAgent', () => {
  it('forwards only the trailing user messages when the graph checkpoints', async () => {
    const graph = createStubGraph({checkpointer: {}});
    const agent = createAgent(graph, INSTRUCTION);

    await runAgent(agent, [
      userEvent('test prompt'),
      agentEvent('root_agent', '(some delegation)'),
    ]);

    expect(graph.getState).toHaveBeenCalledExactlyOnceWith(THREAD_CONFIG);
    expect(graph.invoke).toHaveBeenCalledOnce();
    expect(graph.invoke.mock.calls[0][1]).toEqual(THREAD_CONFIG);
    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [
        ['SystemMessage', INSTRUCTION],
        ['HumanMessage', 'test prompt'],
      ],
    );
  });

  it('replays the whole user/agent conversation when the graph does not checkpoint', async () => {
    const graph = createStubGraph({});
    const agent = createAgent(graph, INSTRUCTION);

    await runAgent(agent, FOUR_TURN_CONVERSATION);

    expect(graph.getState).not.toHaveBeenCalled();
    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [
        ['SystemMessage', INSTRUCTION],
        ['HumanMessage', 'user prompt 1'],
        ['AIMessage', 'weather agent response'],
        ['HumanMessage', 'user prompt 2'],
      ],
    );
  });

  it('forwards only the last user message of a long conversation when the graph checkpoints', async () => {
    const graph = createStubGraph({checkpointer: {}});
    const agent = createAgent(graph, INSTRUCTION);

    await runAgent(agent, FOUR_TURN_CONVERSATION);

    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [
        ['SystemMessage', INSTRUCTION],
        ['HumanMessage', 'user prompt 2'],
      ],
    );
  });

  it('yields exactly one event carrying the graph response', async () => {
    const graph = createStubGraph({});
    const agent = createAgent(graph, INSTRUCTION);

    const events = await runAgent(agent, [userEvent('test prompt')]);

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe(AGENT_NAME);
    expect(events[0].invocationId).toBe(INVOCATION_ID);
    expect(events[0].branch).toBe(BRANCH);
    expect(events[0].content?.role).toBe('model');
    expect(events[0].content?.parts?.[0].text).toBe('test response');
  });

  it('omits the system instruction when the checkpointed state already has messages', async () => {
    const graph = createStubGraph({
      checkpointer: {},
      stateValues: {messages: [new AIMessage('previously checkpointed')]},
    });
    const agent = createAgent(graph, INSTRUCTION);

    await runAgent(agent, [userEvent('test prompt')]);

    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [['HumanMessage', 'test prompt']],
    );
  });

  it('keeps the system instruction when the checkpointed state has an empty message list', async () => {
    const graph = createStubGraph({
      checkpointer: {},
      stateValues: {messages: []},
    });
    const agent = createAgent(graph, INSTRUCTION);

    await runAgent(agent, [userEvent('test prompt')]);

    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [
        ['SystemMessage', INSTRUCTION],
        ['HumanMessage', 'test prompt'],
      ],
    );
  });

  it('omits the system message when no instruction is configured', async () => {
    const withoutCheckpointer = createStubGraph({});
    const withCheckpointer = createStubGraph({checkpointer: {}});

    await runAgent(createAgent(withoutCheckpointer), [userEvent('hello')]);
    await runAgent(createAgent(withCheckpointer, ''), [userEvent('hello')]);

    expect(
      withoutCheckpointer.invoke.mock.calls[0][0].messages.map(describeMessage),
    ).toEqual([['HumanMessage', 'hello']]);
    expect(
      withCheckpointer.invoke.mock.calls[0][0].messages.map(describeMessage),
    ).toEqual([['HumanMessage', 'hello']]);
  });

  it('skips events without usable content when replaying the conversation', async () => {
    const graph = createStubGraph({});
    const agent = createAgent(graph);

    await runAgent(agent, [
      userEvent('kept'),
      createEvent({invocationId: INVOCATION_ID, author: 'user'}),
      createEvent({
        invocationId: INVOCATION_ID,
        author: AGENT_NAME,
        content: {role: 'model', parts: []},
      }),
      agentEvent(AGENT_NAME, 'also kept'),
    ]);

    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [
        ['HumanMessage', 'kept'],
        ['AIMessage', 'also kept'],
      ],
    );
  });

  it('stops the reverse walk on a contentless non-user event', async () => {
    const graph = createStubGraph({checkpointer: {}});
    const agent = createAgent(graph);

    await runAgent(agent, [
      userEvent('older prompt'),
      createEvent({invocationId: INVOCATION_ID, author: 'root_agent'}),
      userEvent('latest prompt'),
    ]);

    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [['HumanMessage', 'latest prompt']],
    );
  });

  it('keeps walking backwards past a trailing non-user event', async () => {
    const graph = createStubGraph({checkpointer: {}});
    const agent = createAgent(graph);

    await runAgent(agent, [
      userEvent('first prompt'),
      userEvent('second prompt'),
      agentEvent('root_agent', '(some delegation)'),
    ]);

    expect(graph.invoke.mock.calls[0][0].messages.map(describeMessage)).toEqual(
      [
        ['HumanMessage', 'first prompt'],
        ['HumanMessage', 'second prompt'],
      ],
    );
  });

  it('maps a user part without text to an empty message', async () => {
    const withoutCheckpointer = createStubGraph({});
    const withCheckpointer = createStubGraph({checkpointer: {}});

    await runAgent(createAgent(withoutCheckpointer), [userEvent()]);
    await runAgent(createAgent(withCheckpointer), [userEvent()]);

    expect(
      withoutCheckpointer.invoke.mock.calls[0][0].messages.map(describeMessage),
    ).toEqual([['HumanMessage', '']]);
    expect(
      withCheckpointer.invoke.mock.calls[0][0].messages.map(describeMessage),
    ).toEqual([['HumanMessage', '']]);
  });

  it('concatenates the text blocks of a structured response content', async () => {
    const graph = createStubGraph({
      responseContent: [
        {type: 'text', text: 'a'},
        {type: 'image_url', image_url: {url: 'https://example.com/i.png'}},
        {type: 'text', text: 'b'},
      ],
    });
    const agent = createAgent(graph);

    const events = await runAgent(agent, [userEvent('hello')]);

    expect(events[0].content?.parts?.[0].text).toBe('ab');
  });

  it('renders a response content that is neither string nor array as empty text', async () => {
    const graph = createStubGraph({responseContent: 42});
    const agent = createAgent(graph);

    const events = await runAgent(agent, [userEvent('hello')]);

    expect(events[0].content?.parts?.[0].text).toBe('');
  });

  it('is recognised by isLangGraphAgent', () => {
    expect(isLangGraphAgent(createAgent(createStubGraph({})))).toBe(true);
    expect(isLangGraphAgent(new LoopAgent({name: 'loop'}))).toBe(false);
    expect(isLangGraphAgent(undefined)).toBe(false);
  });

  it('rejects live mode', async () => {
    const agent = createAgent(createStubGraph({}));
    const context = createContext(agent, []);

    await expect(async () => {
      for await (const _event of agent.runLive(context)) {
        // Draining the generator is what surfaces the rejection.
      }
    }).rejects.toThrow('Live mode is not supported in LangGraphAgent.');
  });

  it('runs a real compiled state graph', async () => {
    const observedMessages: BaseMessage[] = [];
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('respond', (state) => {
        observedMessages.push(...state.messages);
        return {messages: [new AIMessage('real graph response')]};
      })
      .addEdge('__start__', 'respond')
      .addEdge('respond', '__end__')
      .compile();
    const agent = createAgent(graph, INSTRUCTION);

    const events = await runAgent(agent, []);

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe('real graph response');
    expect(observedMessages.map(describeMessage)).toEqual([
      ['SystemMessage', INSTRUCTION],
    ]);
  });

  it('drives a real checkpointed graph across two turns', async () => {
    const observedTurns: Array<Array<[string, unknown]>> = [];
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('respond', (state) => {
        observedTurns.push(state.messages.map(describeMessage));
        return {messages: [new AIMessage(`reply ${observedTurns.length}`)]};
      })
      .addEdge('__start__', 'respond')
      .addEdge('respond', '__end__')
      .compile({checkpointer: new MemorySaver()});
    const agent = createAgent(graph, INSTRUCTION);

    const firstTurn = await runAgent(agent, [userEvent('first prompt')]);
    const secondTurn = await runAgent(agent, [
      userEvent('first prompt'),
      agentEvent(AGENT_NAME, 'reply 1'),
      userEvent('second prompt'),
    ]);

    expect(firstTurn[0].content?.parts?.[0].text).toBe('reply 1');
    expect(secondTurn[0].content?.parts?.[0].text).toBe('reply 2');
    expect(observedTurns[0]).toEqual([
      ['SystemMessage', INSTRUCTION],
      ['HumanMessage', 'first prompt'],
    ]);
    // The checkpointer replayed turn 1, so only the new user message is
    // forwarded and the instruction is not prepended again.
    expect(observedTurns[1]).toEqual([
      ['SystemMessage', INSTRUCTION],
      ['HumanMessage', 'first prompt'],
      ['AIMessage', 'reply 1'],
      ['HumanMessage', 'second prompt'],
    ]);
  });
});
