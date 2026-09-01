/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  AuthCredentialTypes,
  BaseAgent,
  BaseAgentConfig,
  Event,
  InvocationContext,
  InvocationContextParams,
  LlmCallsLimitExceededError,
  LoopAgent,
  PluginManager,
  QueuedInvocationEvent,
  Session,
  createContextCacheConfig,
  createEvent,
  createEventsCompactionConfig,
  createResumabilityConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeSession(): Session {
  return {
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    state: {},
    events: [],
    lastUpdateTime: Date.now(),
  } as unknown as Session;
}

/**
 * A minimal sub-agent that mirrors what an LlmAgent does per run: it records a
 * single LLM call against the invocation's shared counter (as
 * `LlmAgent.callLlmAsync` does via `invocationContext.incrementLlmCallCount()`)
 * and yields one event. It deliberately goes through `BaseAgent.runAsync`, so
 * each run builds a fresh child context via the real `createInvocationContext`
 * — the exact code path where the counter used to reset.
 */
class LlmCallingAgent extends BaseAgent {
  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    context.incrementLlmCallCount();
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'ok'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test.
  }
}

describe('InvocationContext LLM-call cost tracking', () => {
  it('shares the LLM-call counter across child contexts so maxLlmCalls spans the whole invocation', () => {
    const rootAgent = new LoopAgent({name: 'root'});
    const subAgent = new LoopAgent({name: 'sub'});

    const root = new InvocationContext({
      invocationId: 'inv-1',
      agent: rootAgent,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 2},
    });

    // Mirrors BaseAgent.createInvocationContext: a child context for a
    // sub-agent copies the parent context and swaps the agent. The LLM-call
    // counter must be shared, not reset.
    const child = new InvocationContext({...root, agent: subAgent});

    root.incrementLlmCallCount(); // invocation total = 1
    child.incrementLlmCallCount(); // invocation total = 2 (shared counter)

    // The 3rd call anywhere in the invocation must exceed the limit of 2.
    expect(() => child.incrementLlmCallCount()).toThrowError(
      /Max number of llm calls limit of 2 exceeded/,
    );
  });

  it('shares the counter across a grandchild context (nested sub-agents)', () => {
    const root = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 1},
    });
    const child = new InvocationContext({
      ...root,
      agent: new LoopAgent({name: 'child'}),
    });
    const grandChild = new InvocationContext({
      ...child,
      agent: new LoopAgent({name: 'grandchild'}),
    });

    root.incrementLlmCallCount(); // total = 1 (at limit)

    expect(() => grandChild.incrementLlmCallCount()).toThrowError(
      /Max number of llm calls limit of 1 exceeded/,
    );
  });

  it('starts a fresh counter for a separate invocation', () => {
    const agent = new LoopAgent({name: 'root'});

    const first = new InvocationContext({
      invocationId: 'inv-1',
      agent,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 1},
    });
    first.incrementLlmCallCount(); // total = 1 (at limit)
    expect(() => first.incrementLlmCallCount()).toThrow();

    // A brand-new invocation context must not inherit the previous counter.
    const second = new InvocationContext({
      invocationId: 'inv-2',
      agent,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 1},
    });
    expect(() => second.incrementLlmCallCount()).not.toThrow();
  });

  it('enforces maxLlmCalls across a real multi-iteration LoopAgent run', async () => {
    // Reproduces the reported runaway scenario end-to-end: a LoopAgent whose
    // sub-agent makes one LLM call per iteration. Before the fix, every
    // iteration built a child context with a fresh counter, so the run made an
    // unbounded number of LLM calls and never tripped `maxLlmCalls`. With the
    // shared cost manager, the counter accumulates across iterations and the
    // limit bounds the whole run.
    const inner = new LlmCallingAgent({name: 'inner'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [inner],
      // Far more iterations than maxLlmCalls; the LLM-call limit — not the
      // iteration count — must stop the run.
      maxIterations: 100,
    });

    const rootContext = new InvocationContext({
      invocationId: 'inv-run',
      agent: loop,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 3},
    });

    const events: Event[] = [];
    const run = async () => {
      for await (const event of loop.runAsync(rootContext)) {
        events.push(event);
      }
    };

    // The 4th call across the run exceeds the limit of 3.
    await expect(run()).rejects.toThrowError(
      /Max number of llm calls limit of 3 exceeded/,
    );
    // Exactly the 3 permitted iterations produced an event before the throw,
    // proving the counter is shared across the per-iteration child contexts.
    expect(events).toHaveLength(3);
  });
});

const LONG_RUNNING_CALL_ID = 'tool_call_id_1';

function makeContext(
  overrides: Partial<InvocationContextParams> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_1',
    agent: new LoopAgent({name: 'agent'}),
    session: makeSession(),
    pluginManager: new PluginManager(),
    ...overrides,
  });
}

/** A model event issuing one long-running function call. */
function longRunningCallEvent(): Event {
  return createEvent({
    invocationId: 'inv_1',
    author: 'agent',
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: LONG_RUNNING_CALL_ID,
            name: 'long_running_function_call',
            args: {},
          },
        },
      ],
    },
    longRunningToolIds: [LONG_RUNNING_CALL_ID],
  });
}

function callEvent(callId: string, overrides: Partial<Event> = {}): Event {
  return createEvent({
    invocationId: 'inv_1',
    author: 'agent',
    content: {
      role: 'model',
      parts: [{functionCall: {id: callId, name: 'some_tool', args: {}}}],
    },
    ...overrides,
  });
}

function responseEvent(
  responseId: string | undefined,
  overrides: Partial<Event> = {},
): Event {
  return createEvent({
    invocationId: 'inv_1',
    author: 'agent',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: responseId,
            name: 'some_tool',
            response: {result: 'ok'},
          },
        },
      ],
    },
    ...overrides,
  });
}

describe('InvocationContext resumability', () => {
  it('is resumable only when the config says so', () => {
    expect(
      makeContext({
        resumabilityConfig: createResumabilityConfig({isResumable: true}),
      }).isResumable,
    ).toBe(true);
    expect(
      makeContext({resumabilityConfig: createResumabilityConfig()}).isResumable,
    ).toBe(false);
    expect(makeContext().isResumable).toBe(false);
  });

  it('pauses on a long-running call whatever the resumability setting', () => {
    const event = longRunningCallEvent();

    expect(
      makeContext({
        resumabilityConfig: createResumabilityConfig({isResumable: true}),
      }).shouldPauseInvocation(event),
    ).toBe(true);
    expect(
      makeContext({
        resumabilityConfig: createResumabilityConfig({isResumable: false}),
      }).shouldPauseInvocation(event),
    ).toBe(true);
  });

  it('does not pause when no call is long running', () => {
    const event = createEvent({
      ...longRunningCallEvent(),
      longRunningToolIds: [],
    });

    expect(makeContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause when the event carries no function call', () => {
    const event = createEvent({
      invocationId: 'inv_1',
      author: 'agent',
      content: {role: 'user', parts: [{text: 'test text part'}]},
      longRunningToolIds: [LONG_RUNNING_CALL_ID],
    });

    expect(makeContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause when a later user event sits on a sub-branch of the call', () => {
    const event = longRunningCallEvent();
    const session = makeSession();
    session.events = [
      event,
      createEvent({
        invocationId: 'inv_1',
        author: 'user',
        branch: `agent@${LONG_RUNNING_CALL_ID}.child`,
      }),
    ];

    expect(makeContext({session}).shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause when the later user event sits on a deeply nested sub-branch', () => {
    const event = longRunningCallEvent();
    const session = makeSession();
    session.events = [
      event,
      createEvent({
        invocationId: 'inv_1',
        author: 'user',
        branch: `parent@other.child@${LONG_RUNNING_CALL_ID}.grandchild`,
      }),
    ];

    expect(makeContext({session}).shouldPauseInvocation(event)).toBe(false);
  });

  it('pauses when the later user event sits on a different branch', () => {
    const event = longRunningCallEvent();
    const session = makeSession();
    session.events = [
      event,
      createEvent({
        invocationId: 'inv_1',
        author: 'user',
        branch: 'parent@different_id.child',
      }),
    ];

    expect(makeContext({session}).shouldPauseInvocation(event)).toBe(true);
  });

  it('pauses when a later user event answers on an unbranched event', () => {
    const event = longRunningCallEvent();
    const session = makeSession();
    session.events = [
      event,
      createEvent({invocationId: 'inv_1', author: 'user'}),
    ];

    expect(makeContext({session}).shouldPauseInvocation(event)).toBe(true);
  });
});

describe('InvocationContext.populateInvocationAgentStates', () => {
  function contextWithEvents(
    events: Event[],
    isResumable = true,
  ): InvocationContext {
    const session = makeSession();
    session.events = events;
    return makeContext({
      session,
      resumabilityConfig: createResumabilityConfig({isResumable}),
    });
  }

  it('does nothing when the invocation is not resumable', () => {
    const context = contextWithEvents(
      [
        createEvent({
          invocationId: 'inv_1',
          author: 'agent1',
          actions: {endOfAgent: true},
        }),
      ],
      false,
    );

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({});
  });

  it('records the end of an agent and drops its state', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_1',
        author: 'agent1',
        actions: {endOfAgent: true},
      }),
    ]);
    context.agentStates['agent1'] = {step: 1};

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({agent1: true});
  });

  it('records an agent state and clears the end flag', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_1',
        author: 'agent1',
        actions: {endOfAgent: false, agentState: {}},
      }),
    ]);

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({agent1: {}});
    expect(context.endOfAgents).toEqual({agent1: false});
  });

  it('lets the end of an agent win over its state', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_1',
        author: 'agent1',
        actions: {endOfAgent: true, agentState: {}},
      }),
    ]);

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({agent1: true});
  });

  it('records an empty state for an authored event that carries content', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_1',
        author: 'agent1',
        content: {role: 'model', parts: [{text: 'hi'}]},
      }),
    ]);

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({agent1: {}});
    expect(context.endOfAgents).toEqual({agent1: false});
  });

  it('ignores a user event', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'hi'}]},
      }),
    ]);

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({});
  });

  it('ignores an event with neither content nor state', () => {
    const context = contextWithEvents([
      createEvent({invocationId: 'inv_1', author: 'agent1'}),
    ]);

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({});
  });

  it('keeps a recorded non-empty state instead of overwriting it', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_1',
        author: 'agent1',
        content: {role: 'model', parts: [{text: 'hi'}]},
      }),
    ]);
    context.agentStates['agent1'] = {step: 2};

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({agent1: {step: 2}});
  });

  it('keys off the node path when the event has one', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_1',
        author: 'agent1',
        nodeInfo: {path: 'wf.child'},
        actions: {agentState: {step: 1}},
      }),
    ]);

    context.populateInvocationAgentStates();

    expect(context.agentStates).toEqual({'wf.child': {step: 1}});
    expect(context.endOfAgents).toEqual({'wf.child': false});
  });

  it('skips an event with neither a node path nor an author', () => {
    const context = contextWithEvents([
      createEvent({invocationId: 'inv_1', actions: {endOfAgent: true}}),
    ]);

    context.populateInvocationAgentStates();

    expect(context.endOfAgents).toEqual({});
  });

  it('ignores events from another invocation', () => {
    const context = contextWithEvents([
      createEvent({
        invocationId: 'inv_2',
        author: 'agent1',
        actions: {endOfAgent: true},
      }),
    ]);

    context.populateInvocationAgentStates();

    expect(context.endOfAgents).toEqual({});
  });
});

describe('InvocationContext.setAgentState', () => {
  it('marks the agent finished and drops its state', () => {
    const context = makeContext();
    context.agentStates['agent1'] = {};
    context.endOfAgents['agent1'] = false;

    context.setAgentState('agent1', {endOfAgent: true});

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({agent1: true});
  });

  it('ignores the state when the agent is marked finished', () => {
    const context = makeContext();

    context.setAgentState('agent1', {agentState: {step: 1}, endOfAgent: true});

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({agent1: true});
  });

  it('records the state and clears the finished flag', () => {
    const context = makeContext();
    context.endOfAgents['agent1'] = true;

    context.setAgentState('agent1', {agentState: {}});

    expect(context.agentStates).toEqual({agent1: {}});
    expect(context.endOfAgents).toEqual({agent1: false});
  });

  it('drops both records when given no options', () => {
    const context = makeContext();
    context.agentStates['agent1'] = {};
    context.endOfAgents['agent1'] = true;

    context.setAgentState('agent1');

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({});
  });
});

describe('InvocationContext.resetSubAgentStates', () => {
  function treeContext(): InvocationContext {
    const subSubAgent = new LoopAgent({name: 'sub_sub_agent_1'});
    const subAgent1 = new LoopAgent({
      name: 'sub_agent_1',
      subAgents: [subSubAgent],
    });
    const subAgent2 = new LoopAgent({name: 'sub_agent_2'});
    return makeContext({
      agent: new LoopAgent({
        name: 'root_agent',
        subAgents: [subAgent1, subAgent2],
      }),
    });
  }

  it('clears the state of every agent below the named one', () => {
    const context = treeContext();
    context.setAgentState('sub_agent_1', {agentState: {}});
    context.setAgentState('sub_agent_2', {endOfAgent: true});
    context.setAgentState('sub_sub_agent_1', {agentState: {}});

    context.resetSubAgentStates('root_agent');

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({});
  });

  it('leaves the named agent state alone', () => {
    const context = treeContext();
    context.setAgentState('root_agent', {agentState: {step: 1}});

    context.resetSubAgentStates('root_agent');

    expect(context.agentStates).toEqual({root_agent: {step: 1}});
  });

  it('does nothing when the name is unknown', () => {
    const context = treeContext();
    context.setAgentState('sub_agent_1', {agentState: {}});

    context.resetSubAgentStates('missing_agent');

    expect(context.agentStates).toEqual({sub_agent_1: {}});
  });

  it('does nothing when the context has no agent', () => {
    const context = makeContext({agent: undefined});
    context.setAgentState('sub_agent_1', {agentState: {}});

    context.resetSubAgentStates('root_agent');

    expect(context.agentStates).toEqual({sub_agent_1: {}});
  });
});

describe('InvocationContext.getEvents', () => {
  it('returns the session events untouched when no filter is asked for', () => {
    const session = makeSession();
    session.events = [
      createEvent({invocationId: 'inv_1', author: 'agent'}),
      createEvent({invocationId: 'inv_2', author: 'agent'}),
    ];

    expect(makeContext({session}).getEvents()).toBe(session.events);
  });

  it('narrows to the current invocation and branch', () => {
    const onBranch = createEvent({
      invocationId: 'inv_1',
      author: 'agent',
      branch: 'agent_1',
    });
    const session = makeSession();
    session.events = [
      onBranch,
      createEvent({invocationId: 'inv_1', author: 'agent', branch: 'agent_2'}),
      createEvent({invocationId: 'inv_2', author: 'agent', branch: 'agent_1'}),
    ];

    const context = makeContext({session, branch: 'agent_1'});

    expect(
      context.getEvents({currentInvocation: true, currentBranch: true}),
    ).toEqual([onBranch]);
  });
});

describe('InvocationContext.findMatchingFunctionCall', () => {
  function contextWithEvents(events: Event[]): InvocationContext {
    const session = makeSession();
    session.events = events;
    return makeContext({session});
  }

  it('finds the call the response answers', () => {
    const call = callEvent('test_function_call_id');
    const response = responseEvent('test_function_call_id');
    const context = contextWithEvents([call, response]);

    expect(context.findMatchingFunctionCall(response)).toBe(call);
  });

  it('returns undefined when no call has that id', () => {
    const call = callEvent('another_function_call_id');
    const response = responseEvent('test_function_call_id');
    const context = contextWithEvents([call, response]);

    expect(context.findMatchingFunctionCall(response)).toBeUndefined();
  });

  it('returns undefined when the history holds no call event', () => {
    const response = responseEvent('test_function_call_id');
    const context = contextWithEvents([response]);

    expect(context.findMatchingFunctionCall(response)).toBeUndefined();
  });

  it('returns undefined when the event carries no function response', () => {
    const call = callEvent('test_function_call_id');
    const plain = createEvent({
      invocationId: 'inv_1',
      author: 'agent',
      content: {role: 'user', parts: [{text: 'user message'}]},
    });
    const context = contextWithEvents([call, plain]);

    expect(context.findMatchingFunctionCall(plain)).toBeUndefined();
  });

  it('returns undefined when the response carries no id', () => {
    const call = callEvent('test_function_call_id');
    const response = responseEvent(undefined);
    const context = contextWithEvents([call, response]);

    expect(context.findMatchingFunctionCall(response)).toBeUndefined();
  });

  it('finds the call when the response is not the last event', () => {
    const call = callEvent('test_function_call_id');
    const response = responseEvent('test_function_call_id');
    const later = createEvent({
      invocationId: 'inv_1',
      author: 'user',
      content: {role: 'user', parts: [{text: 'next user message'}]},
    });
    const context = contextWithEvents([call, response, later]);

    expect(context.findMatchingFunctionCall(response)).toBe(call);
  });
});

describe('InvocationContext.stampEventBranchContext', () => {
  function contextWithEvents(events: Event[]): InvocationContext {
    const session = makeSession();
    session.events = events;
    return makeContext({session});
  }

  it('stamps the branch and keeps an isolation scope the event already has', () => {
    const call = callEvent('test_function_call_id', {branch: 'root@1'});
    const response = responseEvent('test_function_call_id', {
      isolationScope: 'task_123',
    });
    contextWithEvents([call, response]).stampEventBranchContext(response);

    expect(response.branch).toBe('root@1');
    expect(response.isolationScope).toBe('task_123');
  });

  it('does not overwrite an isolation scope with the call own scope', () => {
    const call = callEvent('test_function_call_id', {
      branch: 'root@1',
      isolationScope: 'task_456',
    });
    const response = responseEvent('test_function_call_id', {
      isolationScope: 'task_123',
    });
    contextWithEvents([call, response]).stampEventBranchContext(response);

    expect(response.branch).toBe('root@1');
    expect(response.isolationScope).toBe('task_123');
  });

  it('takes the isolation scope from the call when the event has none', () => {
    const call = callEvent('test_function_call_id', {
      branch: 'root@1',
      isolationScope: 'task_456',
    });
    const response = responseEvent('test_function_call_id');
    contextWithEvents([call, response]).stampEventBranchContext(response);

    expect(response.branch).toBe('root@1');
    expect(response.isolationScope).toBe('task_456');
  });

  it('leaves the event alone when no call matches', () => {
    const response = responseEvent('test_function_call_id', {
      branch: 'original',
    });
    contextWithEvents([response]).stampEventBranchContext(response);

    expect(response.branch).toBe('original');
  });
});

describe('InvocationContext LLM-call limit errors', () => {
  it('throws LlmCallsLimitExceededError once the limit is passed', () => {
    const context = makeContext({runConfig: {maxLlmCalls: 2}});

    context.incrementLlmCallCount();
    context.incrementLlmCallCount();

    expect(() => context.incrementLlmCallCount()).toThrowError(
      LlmCallsLimitExceededError,
    );
  });

  it('keeps throwing once the limit is passed', () => {
    const context = makeContext({runConfig: {maxLlmCalls: 1}});
    context.incrementLlmCallCount();

    expect(() => context.incrementLlmCallCount()).toThrowError(
      LlmCallsLimitExceededError,
    );
    expect(() => context.incrementLlmCallCount()).toThrowError(
      LlmCallsLimitExceededError,
    );
  });

  it('does not enforce a non-positive limit', () => {
    for (const maxLlmCalls of [0, -1]) {
      const context = makeContext({runConfig: {maxLlmCalls}});

      for (let i = 0; i < 5; i++) {
        context.incrementLlmCallCount();
      }
    }
  });

  it('does not enforce a limit without a run config', () => {
    const context = makeContext();

    for (let i = 0; i < 5; i++) {
      context.incrementLlmCallCount();
    }

    expect(context.runConfig).toBeUndefined();
  });
});

describe('InvocationContext.enqueueEvent', () => {
  async function nextTurn(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('blocks a non-partial event until the consumer marks it processed', async () => {
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    const context = makeContext({invocationEventQueue: queue});
    const event = createEvent({author: 'test'});

    let released = false;
    const enqueued = context.enqueueEvent(event).then(() => {
      released = true;
    });

    await nextTurn();
    expect(released).toBe(false);

    const queued = (await queue[Symbol.asyncIterator]().next()).value;
    if (!queued?.markProcessed) {
      expect.fail('the consumer received no markProcessed callback');
    }
    expect(queued.event).toBe(event);
    queued.markProcessed();
    await enqueued;

    expect(released).toBe(true);
  });

  it('does not block a partial event and sends no callback with it', async () => {
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    const context = makeContext({invocationEventQueue: queue});
    const event = createEvent({author: 'test', partial: true});

    await context.enqueueEvent(event);

    expect(queue.size).toBe(1);
    const queued = (await queue[Symbol.asyncIterator]().next()).value;
    expect(queued?.event).toBe(event);
    expect(queued?.markProcessed).toBeUndefined();
  });

  it('delivers events in the order they were pushed', async () => {
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    const context = makeContext({invocationEventQueue: queue});

    for (let i = 0; i < 5; i++) {
      await context.enqueueEvent(
        createEvent({author: `test_${i}`, partial: true}),
      );
    }

    const iterator = queue[Symbol.asyncIterator]();
    for (let i = 0; i < 5; i++) {
      const queued = (await iterator.next()).value;
      expect(queued?.event.author).toBe(`test_${i}`);
    }
  });

  it('rejects when the queue is not set', async () => {
    const context = makeContext();

    await expect(
      context.enqueueEvent(createEvent({author: 'test'})),
    ).rejects.toThrowError(/invocationEventQueue is not set/);
  });

  it('rejects rather than hanging when the queue is closed', async () => {
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    queue.close();
    const context = makeContext({invocationEventQueue: queue});

    await expect(
      context.enqueueEvent(createEvent({author: 'test'})),
    ).rejects.toThrowError(/invocationEventQueue is closed/);
  });
});

describe('InvocationContext parity fields', () => {
  it('defaults the record fields to empty and the compaction flag to false', () => {
    const context = makeContext();

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({});
    expect(context.credentialByKey).toEqual({});
    expect(context.tokenCompactionChecked).toBe(false);
    expect(context.contextCacheConfig).toBeUndefined();
    expect(context.eventsCompactionConfig).toBeUndefined();
    expect(context.canonicalToolsCache).toBeUndefined();
    expect(context.nodePath).toBeUndefined();
    expect(context.stateSchema).toBeUndefined();
    expect(context.inputRealtimeCache).toBeUndefined();
    expect(context.outputRealtimeCache).toBeUndefined();
    expect(context.activeNonBlockingToolTasks).toBeUndefined();
    expect(context.invocationEventQueue).toBeUndefined();
  });

  it('carries every new field over to a clone', () => {
    const context = makeContext({
      contextCacheConfig: createContextCacheConfig({cacheIntervals: 3}),
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
      eventsCompactionConfig: createEventsCompactionConfig({
        compactionInterval: 2,
        overlapSize: 1,
      }),
      tokenCompactionChecked: true,
      credentialByKey: {
        key: {authType: AuthCredentialTypes.API_KEY, apiKey: 'placeholder'},
      },
      canonicalToolsCache: [],
      nodePath: 'wf/child',
      inputRealtimeCache: [],
      outputRealtimeCache: [],
      activeNonBlockingToolTasks: {},
      invocationEventQueue: new AsyncQueue<QueuedInvocationEvent>(),
    });

    const clone = context.clone();

    expect(clone.contextCacheConfig).toBe(context.contextCacheConfig);
    expect(clone.resumabilityConfig).toBe(context.resumabilityConfig);
    expect(clone.eventsCompactionConfig).toBe(context.eventsCompactionConfig);
    expect(clone.tokenCompactionChecked).toBe(true);
    expect(clone.credentialByKey).toBe(context.credentialByKey);
    expect(clone.canonicalToolsCache).toBe(context.canonicalToolsCache);
    expect(clone.nodePath).toBe('wf/child');
    expect(clone.inputRealtimeCache).toBe(context.inputRealtimeCache);
    expect(clone.outputRealtimeCache).toBe(context.outputRealtimeCache);
    expect(clone.activeNonBlockingToolTasks).toBe(
      context.activeNonBlockingToolTasks,
    );
    expect(clone.invocationEventQueue).toBe(context.invocationEventQueue);
  });

  it('shares the agent-state records with a clone', () => {
    const context = makeContext();
    const clone = context.clone();

    clone.setAgentState('sub', {agentState: {step: 1}});

    expect(context.agentStates).toEqual({sub: {step: 1}});
    expect(context.endOfAgents).toEqual({sub: false});
  });

  it('keeps the isResumable getter on a clone', () => {
    const context = makeContext({
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
    });

    expect(context.clone().isResumable).toBe(true);
    expect(context.clone({resumabilityConfig: undefined}).isResumable).toBe(
      false,
    );
  });
});
