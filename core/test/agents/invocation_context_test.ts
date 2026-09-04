/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  AuthCredential,
  AuthCredentialTypes,
  BaseAgent,
  BaseAgentConfig,
  BaseCredentialService,
  Event,
  InMemoryCredentialService,
  InvocationContext,
  InvocationContextParams,
  LlmCallsLimitExceededError,
  LoopAgent,
  PluginManager,
  QueuedInvocationEvent,
  RealtimeCacheEntry,
  Session,
  Task,
  createEvent,
  createResumabilityConfig,
  createSession,
  drainInvocationEvents,
  isLlmCallsLimitExceededError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

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

describe('InvocationContext resolved credentials', () => {
  it('starts a brand-new invocation with an empty credential map', () => {
    const context = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    expect(context.credentialByKey).toEqual({});
  });

  it('gives a brand-new invocation a credential map with no prototype', () => {
    const context = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    expect(Object.getPrototypeOf(context.credentialByKey)).toBeNull();
  });

  it('shares the credential map with child contexts', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-api-key',
    };
    const root = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    // Mirrors BaseAgent.createInvocationContext: a child context spreads the
    // parent, so one credential map must serve the whole invocation.
    const child = new InvocationContext({
      ...root,
      agent: new LoopAgent({name: 'sub'}),
    });
    root.credentialByKey['k'] = credential;

    expect(child.credentialByKey['k']).toBe(credential);
  });

  it('shares the credential map with a cloned context', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-api-key',
    };
    const root = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    const clone = root.clone({agent: new LoopAgent({name: 'sub'})});
    root.credentialByKey['k'] = credential;

    expect(clone.credentialByKey['k']).toBe(credential);
  });

  it('keeps a credential passed in at construction', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-api-key',
    };

    const context = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      credentialByKey: {k: credential},
    });

    expect(context.credentialByKey['k']).toBe(credential);
  });
});

describe('InvocationContext customMetadata', () => {
  it('starts as an empty bag', () => {
    const context = new InvocationContext({
      invocationId: 'inv-1',
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    expect(context.customMetadata).toEqual({});
  });

  it('keeps the bag the caller supplied', () => {
    const context = new InvocationContext({
      invocationId: 'inv-1',
      session: makeSession(),
      pluginManager: new PluginManager(),
      customMetadata: {http_debug_info: []},
    });

    expect(context.customMetadata).toEqual({http_debug_info: []});
  });

  it('accepts the very record the caller supplied, not a copy', () => {
    const seeded = {seeded: true};

    const context = new InvocationContext({
      invocationId: 'inv-meta',
      agent: new LoopAgent({name: 'noop'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      customMetadata: seeded,
    });

    expect(context.customMetadata).toBe(seeded);
  });

  it('shares the bag with a cloned context', () => {
    const context = new InvocationContext({
      invocationId: 'inv-1',
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    context.clone().customMetadata['key'] = 'value';

    expect(context.customMetadata).toEqual({key: 'value'});
  });

  it('shares the record with a clone, so a child writes where a parent reads', () => {
    const parent = new InvocationContext({
      invocationId: 'inv-meta',
      agent: new LoopAgent({name: 'noop'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    const child = parent.clone({invocationId: 'inv-meta-child'});
    child.customMetadata['written_by_child'] = 1;

    expect(parent.customMetadata['written_by_child']).toBe(1);
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

/**
 * Builds a context with the given session events, optionally resumable.
 */
function makeAgentStateContext(
  options: {
    events?: Event[];
    isResumable?: boolean;
    invocationId?: string;
  } = {},
): InvocationContext {
  const session = makeSession();
  session.events = options.events ?? [];
  return new InvocationContext({
    invocationId: options.invocationId ?? 'inv-1',
    agent: new LoopAgent({name: 'root'}),
    session,
    pluginManager: new PluginManager(),
    resumabilityConfig:
      options.isResumable === undefined
        ? undefined
        : createResumabilityConfig({isResumable: options.isResumable}),
  });
}

describe('InvocationContext.isResumable', () => {
  it('is false when no resumability config is given', () => {
    expect(makeAgentStateContext().isResumable).toBe(false);
  });

  it('is false when the config disables resumability', () => {
    expect(makeAgentStateContext({isResumable: false}).isResumable).toBe(false);
  });

  it('is true when the config enables resumability', () => {
    expect(makeAgentStateContext({isResumable: true}).isResumable).toBe(true);
  });

  it('survives the spread that builds a child context', () => {
    const parent = makeAgentStateContext({isResumable: true});
    const child = new InvocationContext({
      ...parent,
      agent: new LoopAgent({name: 'child'}),
    });
    expect(child.isResumable).toBe(true);
    // The maps are shared by reference, which is what makes resume work.
    child.setAgentState('child', {agentState: {step: 1}});
    expect(parent.agentStates['child']).toEqual({step: 1});
  });
});

describe('InvocationContext.setAgentState', () => {
  it('records a state and clears the end-of-agent flag', () => {
    const ctx = makeAgentStateContext();
    ctx.setAgentState('a', {endOfAgent: true});
    ctx.setAgentState('a', {agentState: {current_sub_agent: 'b'}});
    expect(ctx.agentStates['a']).toEqual({current_sub_agent: 'b'});
    expect(ctx.endOfAgents['a']).toBe(false);
  });

  it('sets the end-of-agent flag and drops the state', () => {
    const ctx = makeAgentStateContext();
    ctx.setAgentState('a', {agentState: {current_sub_agent: 'b'}});
    ctx.setAgentState('a', {endOfAgent: true});
    expect(ctx.endOfAgents['a']).toBe(true);
    expect('a' in ctx.agentStates).toBe(false);
  });

  it('ignores the state when end-of-agent is also set', () => {
    const ctx = makeAgentStateContext();
    ctx.setAgentState('a', {agentState: {x: 1}, endOfAgent: true});
    expect(ctx.endOfAgents['a']).toBe(true);
    expect('a' in ctx.agentStates).toBe(false);
  });

  it('clears both entries when neither option is given', () => {
    const ctx = makeAgentStateContext();
    ctx.setAgentState('a', {agentState: {x: 1}});
    ctx.setAgentState('a');
    expect('a' in ctx.agentStates).toBe(false);
    expect('a' in ctx.endOfAgents).toBe(false);
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

  it('recognises the error through the type guard, and nothing else', () => {
    const context = makeContext({runConfig: {maxLlmCalls: 1}});
    context.incrementLlmCallCount();

    let thrown: unknown;
    try {
      context.incrementLlmCallCount();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isLlmCallsLimitExceededError(thrown)).toBe(true);
    expect(isLlmCallsLimitExceededError(new Error('other'))).toBe(false);
    expect(isLlmCallsLimitExceededError('not an error')).toBe(false);
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

describe('InvocationContext parity fields', () => {
  it('defaults the agent-state records to empty', () => {
    const context = makeContext();

    expect(context.agentStates).toEqual({});
    expect(context.endOfAgents).toEqual({});
    expect(context.resumabilityConfig).toBeUndefined();
  });

  it('carries the resumability config over to a clone', () => {
    const context = makeContext({
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
    });

    expect(context.clone().resumabilityConfig).toBe(context.resumabilityConfig);
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

/** Records its own checkpoint on whatever context it is handed. */
class CheckpointingAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    context.setAgentState(this.name, {agentState: {step: 'done'}});
    yield createEvent({author: this.name});
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test.
  }
}

describe('InvocationContext.isResumable', () => {
  it('is false when no resumability config is set', () => {
    expect(makeContext().isResumable).toBe(false);
  });

  it('is false when the config disables resumption', () => {
    expect(
      makeContext({resumabilityConfig: {isResumable: false}}).isResumable,
    ).toBe(false);
  });

  it('is true when the config enables resumption', () => {
    expect(
      makeContext({resumabilityConfig: {isResumable: true}}).isResumable,
    ).toBe(true);
  });

  it('survives clone, which copies fields but not accessors', () => {
    const parent = makeContext({resumabilityConfig: {isResumable: true}});
    expect(parent.clone().isResumable).toBe(true);
  });
});

describe('InvocationContext.setAgentState', () => {
  it('marks the agent finished and drops its checkpoint', () => {
    const context = makeContext();
    context.setAgentState('agent1', {agentState: {step: 'one'}});

    context.setAgentState('agent1', {endOfAgent: true});

    expect(context.endOfAgents).toEqual({agent1: true});
    expect(context.agentStates).toEqual({});
  });

  it('records a checkpoint and clears the finished flag', () => {
    const context = makeContext();
    context.setAgentState('agent1', {endOfAgent: true});

    context.setAgentState('agent1', {agentState: {step: 'one'}});

    expect(context.agentStates).toEqual({agent1: {step: 'one'}});
    expect(context.endOfAgents).toEqual({agent1: false});
  });
});

describe('InvocationContext agent-state sharing', () => {
  it('shares the records with a clone, so a branch write reaches the parent', () => {
    const parent = makeContext();
    const branch = parent.clone({branch: 'parallel.sub'});

    branch.setAgentState('sub', {agentState: {step: 'one'}});

    expect(parent.agentStates).toEqual({sub: {step: 'one'}});
    expect(parent.endOfAgents).toEqual({sub: false});
  });

  it('shares the records with the context BaseAgent builds for a sub-agent', async () => {
    const subAgent = new CheckpointingAgent({name: 'sub'});
    const parent = makeContext({agent: subAgent});

    for await (const _ of subAgent.runAsync(parent)) {
      // Draining the run is what makes the sub-agent record its checkpoint.
    }

    expect(parent.agentStates).toEqual({sub: {step: 'done'}});
  });
});

/** A model event requesting one long-running function call. */
function makeLongRunningCallEvent(callId: string): Event {
  return createEvent({
    invocationId: 'inv-1',
    author: 'agent1',
    content: {
      role: 'model',
      parts: [{functionCall: {id: callId, name: 'ask'}}],
    },
    longRunningToolIds: [callId],
  });
}

describe('InvocationContext.shouldPauseInvocation', () => {
  it('does not pause an event with no long-running tool id', () => {
    const event = makeLongRunningCallEvent('call-1');
    event.longRunningToolIds = [];

    expect(makeContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause an event that omits the long-running id field', () => {
    const event = makeLongRunningCallEvent('call-1');
    delete event.longRunningToolIds;

    expect(makeContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause an event with no function call', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'agent1',
      content: {role: 'model', parts: [{text: 'hi'}]},
      longRunningToolIds: ['call-1'],
    });

    expect(makeContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause on a call that is not long-running', () => {
    const event = makeLongRunningCallEvent('call-1');
    event.longRunningToolIds = ['other-call'];

    expect(makeContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause on a function call with no id', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'agent1',
      content: {role: 'model', parts: [{functionCall: {name: 'ask'}}]},
      longRunningToolIds: ['call-1'],
    });

    expect(makeContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('pauses when nothing in the session answers the call', () => {
    const event = makeLongRunningCallEvent('call-1');
    const context = makeContext();
    context.session.events.push(event);

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });

  it('pauses when the event is not in the session at all', () => {
    const event = makeLongRunningCallEvent('call-1');

    expect(makeContext().shouldPauseInvocation(event)).toBe(true);
  });

  it('does not pause when a later user event answers the call on a sub-branch', () => {
    const event = makeLongRunningCallEvent('call-1');
    const context = makeContext();
    context.session.events.push(
      event,
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        branch: 'agent1.ask@call-1',
        content: {role: 'user', parts: [{text: 'my answer'}]},
      }),
    );

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('pauses when the later user event is on a sub-branch of another call', () => {
    const event = makeLongRunningCallEvent('call-1');
    const context = makeContext();
    context.session.events.push(
      event,
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        branch: 'agent1.ask@call-2',
        content: {role: 'user', parts: [{text: 'my answer'}]},
      }),
    );

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });

  it('pauses when the answering user event precedes the call', () => {
    const event = makeLongRunningCallEvent('call-1');
    const context = makeContext();
    context.session.events.push(
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        branch: 'agent1.ask@call-1',
        content: {role: 'user', parts: [{text: 'too early'}]},
      }),
      event,
    );

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });

  it('pauses when a later event on the answering branch is not from the user', () => {
    const event = makeLongRunningCallEvent('call-1');
    const context = makeContext();
    context.session.events.push(
      event,
      createEvent({
        invocationId: 'inv-1',
        author: 'agent1',
        branch: 'agent1.ask@call-1',
        content: {role: 'model', parts: [{text: 'still working'}]},
      }),
    );

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });
});

describe('InvocationContext.populateInvocationAgentStates', () => {
  it('does nothing when the invocation is not resumable', () => {
    const ctx = makeAgentStateContext({
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          actions: {agentState: {current_sub_agent: 'b'}},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({});
  });

  it('records a checkpoint carried by an event', () => {
    const ctx = makeAgentStateContext({
      isResumable: true,
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          actions: {agentState: {current_sub_agent: 'b'}},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.agentStates['a']).toEqual({current_sub_agent: 'b'});
    expect(ctx.endOfAgents['a']).toBe(false);
  });

  it('marks an agent finished and drops its checkpoint', () => {
    const ctx = makeAgentStateContext({
      isResumable: true,
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          actions: {agentState: {current_sub_agent: 'b'}},
        }),
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          actions: {endOfAgent: true},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.endOfAgents['a']).toBe(true);
    expect('a' in ctx.agentStates).toBe(false);
  });

  it('seeds an empty state for an agent that produced content without one', () => {
    const ctx = makeAgentStateContext({
      isResumable: true,
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          content: {role: 'model', parts: [{text: 'hi'}]},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.agentStates['a']).toEqual({});
    expect(ctx.endOfAgents['a']).toBe(false);
  });

  it('ignores a user event and an event from another invocation', () => {
    const ctx = makeAgentStateContext({
      isResumable: true,
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'user',
          content: {role: 'user', parts: [{text: 'hi'}]},
        }),
        createEvent({
          invocationId: 'inv-other',
          author: 'a',
          actions: {agentState: {current_sub_agent: 'b'}},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.agentStates).toEqual({});
  });

  it('keys a workflow event by its node path rather than its author', () => {
    const ctx = makeAgentStateContext({
      isResumable: true,
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          nodeInfo: {path: 'flow.a'},
          actions: {agentState: {current_sub_agent: 'b'}},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.agentStates['flow.a']).toEqual({current_sub_agent: 'b'});
    expect('a' in ctx.agentStates).toBe(false);
  });

  it('skips an event with no author and no node path', () => {
    const ctx = makeAgentStateContext({
      isResumable: true,
      events: [
        createEvent({
          invocationId: 'inv-1',
          content: {role: 'model', parts: [{text: 'hi'}]},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.agentStates).toEqual({});
  });

  it('leaves an already-recorded state alone for a later content event', () => {
    const ctx = makeAgentStateContext({
      isResumable: true,
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          actions: {agentState: {current_sub_agent: 'b'}},
        }),
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          content: {role: 'model', parts: [{text: 'hi'}]},
        }),
      ],
    });
    ctx.populateInvocationAgentStates();
    expect(ctx.agentStates['a']).toEqual({current_sub_agent: 'b'});
  });
});

describe('InvocationContext.shouldPauseInvocation', () => {
  function longRunningCallEvent(callId: string): Event {
    return createEvent({
      invocationId: 'inv-1',
      author: 'a',
      content: {
        role: 'model',
        parts: [{functionCall: {id: callId, name: 'ask_human', args: {}}}],
      },
      longRunningToolIds: [callId],
    });
  }

  it('is false for an event with no long-running tool ids', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'a',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'c1', name: 'ask_human', args: {}}}],
      },
    });
    expect(makeAgentStateContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('is false for an event with no function calls', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'a',
      content: {role: 'model', parts: [{text: 'hi'}]},
      longRunningToolIds: ['c1'],
    });
    expect(makeAgentStateContext().shouldPauseInvocation(event)).toBe(false);
  });

  it('is true for an unanswered long-running call', () => {
    const event = longRunningCallEvent('c1');
    const ctx = makeAgentStateContext({events: [event]});
    expect(ctx.shouldPauseInvocation(event)).toBe(true);
  });

  it('is true when the event is not in the session history yet', () => {
    const event = longRunningCallEvent('c1');
    expect(makeAgentStateContext().shouldPauseInvocation(event)).toBe(true);
  });

  it('is false when a later user event resolves the call in a sub-branch', () => {
    const event = longRunningCallEvent('c1');
    const ctx = makeAgentStateContext({
      events: [
        event,
        createEvent({
          invocationId: 'inv-1',
          author: 'user',
          branch: 'root.ask_human@c1',
          content: {role: 'user', parts: [{text: 'answer'}]},
        }),
      ],
    });
    expect(ctx.shouldPauseInvocation(event)).toBe(false);
  });

  it('is true when the resolving user event precedes the call', () => {
    const event = longRunningCallEvent('c1');
    const ctx = makeAgentStateContext({
      events: [
        createEvent({
          invocationId: 'inv-1',
          author: 'user',
          branch: 'root.ask_human@c1',
          content: {role: 'user', parts: [{text: 'answer'}]},
        }),
        event,
      ],
    });
    expect(ctx.shouldPauseInvocation(event)).toBe(true);
  });

  it('is true when a later event on the sub-branch is not from the user', () => {
    const event = longRunningCallEvent('c1');
    const ctx = makeAgentStateContext({
      events: [
        event,
        createEvent({
          invocationId: 'inv-1',
          author: 'a',
          branch: 'root.ask_human@c1',
          content: {role: 'model', parts: [{text: 'still working'}]},
        }),
      ],
    });
    expect(ctx.shouldPauseInvocation(event)).toBe(true);
  });

  it('is true when a later user event carries no branch', () => {
    const event = longRunningCallEvent('c1');
    const ctx = makeAgentStateContext({
      events: [
        event,
        createEvent({
          invocationId: 'inv-1',
          author: 'user',
          content: {role: 'user', parts: [{text: 'answer'}]},
        }),
      ],
    });
    expect(ctx.shouldPauseInvocation(event)).toBe(true);
  });

  it('ignores a function call that is not long-running', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'a',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'c1', name: 'lookup', args: {}}},
          {functionCall: {id: 'c2', name: 'ask_human', args: {}}},
        ],
      },
      longRunningToolIds: ['c2'],
    });
    const ctx = makeAgentStateContext({
      events: [
        event,
        createEvent({
          invocationId: 'inv-1',
          author: 'user',
          branch: 'root.ask_human@c2',
          content: {role: 'user', parts: [{text: 'answer'}]},
        }),
      ],
    });
    expect(ctx.shouldPauseInvocation(event)).toBe(false);
  });

  it('ignores a function call with no id', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'a',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'ask_human', args: {}}}],
      },
      longRunningToolIds: ['c1'],
    });
    expect(makeAgentStateContext().shouldPauseInvocation(event)).toBe(false);
  });
});

/**
 * A leaf agent that yields nothing. Used only to build agent trees whose
 * checkpoints `resetSubAgentStates` has to clear.
 */
class SilentAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }
}

function makeResumableContext(params: {
  agent?: BaseAgent;
  events?: Event[];
  isResumable?: boolean;
  invocationId?: string;
}): InvocationContext {
  return new InvocationContext({
    invocationId: params.invocationId ?? 'inv-1',
    agent: params.agent,
    session: createSession({
      id: 'sess',
      appName: 'app',
      userId: 'user',
      events: params.events ?? [],
    }),
    pluginManager: new PluginManager(),
    resumabilityConfig: createResumabilityConfig({
      isResumable: params.isResumable ?? true,
    }),
  });
}

describe('InvocationContext.isResumable', () => {
  it('is false when no resumability config is given', () => {
    const context = new InvocationContext({
      invocationId: 'inv-1',
      session: makeSession(),
      pluginManager: new PluginManager(),
    });

    expect(context.isResumable).toBe(false);
  });

  it('follows the resumability config', () => {
    expect(makeResumableContext({isResumable: true}).isResumable).toBe(true);
    expect(makeResumableContext({isResumable: false}).isResumable).toBe(false);
  });
});

describe('InvocationContext.setAgentState', () => {
  it('records a checkpoint and clears the end-of-agent flag', () => {
    const context = makeResumableContext({});

    context.setAgentState('a', {agentState: {step: 1}});

    expect(context.agentStates['a']).toEqual({step: 1});
    expect(context.endOfAgents['a']).toBe(false);
  });

  it('sets the end-of-agent flag and drops the checkpoint', () => {
    const context = makeResumableContext({});
    context.setAgentState('a', {agentState: {step: 1}});

    context.setAgentState('a', {agentState: {step: 2}, endOfAgent: true});

    expect(context.endOfAgents['a']).toBe(true);
    expect(context.agentStates['a']).toBeUndefined();
  });

  it('clears both when neither option is given', () => {
    const context = makeResumableContext({});
    context.setAgentState('a', {agentState: {step: 1}});

    context.setAgentState('a');

    expect(context.agentStates['a']).toBeUndefined();
    expect(context.endOfAgents['a']).toBeUndefined();
  });

  it('shares the state maps with a cloned context', () => {
    const context = makeResumableContext({});

    const child = context.clone({agent: new SilentAgent({name: 'child'})});
    child.setAgentState('a', {agentState: {step: 1}});

    expect(context.agentStates).toBe(child.agentStates);
    expect(context.agentStates['a']).toEqual({step: 1});
  });
});

describe('InvocationContext.resetSubAgentStates', () => {
  it('clears every descendant across two levels', () => {
    const grandChild = new SilentAgent({name: 'grandchild'});
    const child = new SilentAgent({name: 'child', subAgents: [grandChild]});
    const root = new SilentAgent({name: 'root', subAgents: [child]});
    const context = makeResumableContext({agent: root});
    context.setAgentState('root', {agentState: {step: 0}});
    context.setAgentState('child', {agentState: {step: 1}});
    context.setAgentState('grandchild', {agentState: {step: 2}});

    context.resetSubAgentStates('root');

    expect(context.agentStates['child']).toBeUndefined();
    expect(context.agentStates['grandchild']).toBeUndefined();
    expect(context.agentStates['root']).toEqual({step: 0});
  });

  it('does nothing for an agent name that is not in the tree', () => {
    const root = new SilentAgent({name: 'root'});
    const context = makeResumableContext({agent: root});
    context.setAgentState('root', {agentState: {step: 0}});

    context.resetSubAgentStates('absent');

    expect(context.agentStates['root']).toEqual({step: 0});
  });

  it('does nothing when the context drives no agent', () => {
    const context = makeResumableContext({});
    context.setAgentState('a', {agentState: {step: 0}});

    context.resetSubAgentStates('a');

    expect(context.agentStates['a']).toEqual({step: 0});
  });
});

describe('InvocationContext.shouldPauseInvocation', () => {
  function longRunningCallEvent(callId: string): Event {
    return createEvent({
      invocationId: 'inv-1',
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: callId, name: 'approve', args: {}}}],
      },
      longRunningToolIds: [callId],
    });
  }

  it('pauses on a long-running call nothing has answered', () => {
    const event = longRunningCallEvent('call-1');
    const context = makeResumableContext({events: [event]});

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });

  it('pauses when the event is not in the session history yet', () => {
    const event = longRunningCallEvent('call-1');
    const context = makeResumableContext({});

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });

  it('does not pause without long-running tool ids', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: 'approve', args: {}}}],
      },
    });
    const context = makeResumableContext({events: [event]});

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause without a function call', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'agent',
      content: {role: 'model', parts: [{text: 'hi'}]},
      longRunningToolIds: ['call-1'],
    });
    const context = makeResumableContext({events: [event]});

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause on a call whose id is not long-running', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: 'approve', args: {}}}],
      },
      longRunningToolIds: ['other-call'],
    });
    const context = makeResumableContext({events: [event]});

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause on a call with no id', () => {
    const event = createEvent({
      invocationId: 'inv-1',
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'approve', args: {}}}],
      },
      longRunningToolIds: ['call-1'],
    });
    const context = makeResumableContext({events: [event]});

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('does not pause when a later user event answers the call in a sub-branch', () => {
    const event = longRunningCallEvent('call-1');
    const answer = createEvent({
      invocationId: 'inv-1',
      author: 'user',
      branch: 'root.approve@call-1',
      content: {role: 'user', parts: [{text: 'approved'}]},
    });
    const context = makeResumableContext({events: [event, answer]});

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('still pauses when the answering user event precedes the call', () => {
    const event = longRunningCallEvent('call-1');
    const answer = createEvent({
      invocationId: 'inv-1',
      author: 'user',
      branch: 'root.approve@call-1',
      content: {role: 'user', parts: [{text: 'approved'}]},
    });
    const context = makeResumableContext({events: [answer, event]});

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });
});

/** Lets the microtask queue drain, so a pending promise can settle if it can. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('InvocationContext.enqueueEvent', () => {
  it('holds a non-partial event until the consumer marks it processed', async () => {
    const context = makeContext();
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    context.eventQueue = queue;

    let resolved = false;
    const enqueued = context
      .enqueueEvent(createEvent({author: 'node'}))
      .then(() => {
        resolved = true;
      });

    const iterator = queue[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await flushMicrotasks();
    expect(resolved).toBe(false);

    first.value?.markProcessed?.();
    await enqueued;
    expect(resolved).toBe(true);
  });

  it('does not hold a partial event and sends no callback with it', async () => {
    const context = makeContext();
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    context.eventQueue = queue;

    await context.enqueueEvent(createEvent({author: 'node', partial: true}));

    expect(queue.size).toBe(1);
    const first = await queue[Symbol.asyncIterator]().next();
    expect(first.value?.markProcessed).toBeUndefined();
  });

  it('delivers events in the order they were enqueued', async () => {
    const context = makeContext();
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    context.eventQueue = queue;

    const authors: string[] = [];
    const consumer = (async () => {
      for await (const queued of queue) {
        authors.push(queued.event.author!);
        queued.markProcessed?.();
      }
    })();

    for (const author of ['first', 'second', 'third']) {
      await context.enqueueEvent(createEvent({author}));
    }
    queue.close();
    await consumer;

    expect(authors).toEqual(['first', 'second', 'third']);
  });

  it('throws when no queue is set', async () => {
    await expect(
      makeContext().enqueueEvent(createEvent({author: 'node'})),
    ).rejects.toThrowError(/InvocationContext.eventQueue is not set/);
  });

  it('rejects rather than waiting forever when the queue is closed', async () => {
    const context = makeContext();
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    queue.close();
    context.eventQueue = queue;

    await expect(
      context.enqueueEvent(createEvent({author: 'node'})),
    ).rejects.toThrowError(/InvocationContext.eventQueue is closed/);
  });
});

describe('drainInvocationEvents', () => {
  it('releases each producer once its event has gone downstream', async () => {
    const context = makeContext();
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    context.eventQueue = queue;

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const event of drainInvocationEvents(queue)) {
        seen.push(event.author!);
      }
    })();

    await context.enqueueEvent(createEvent({author: 'first'}));
    await context.enqueueEvent(createEvent({author: 'second'}));
    queue.close();
    await consumer;

    expect(seen).toEqual(['first', 'second']);
  });

  it('releases a waiting producer when the consumer stops early', async () => {
    const context = makeContext();
    const queue = new AsyncQueue<QueuedInvocationEvent>();
    context.eventQueue = queue;

    const drain = drainInvocationEvents(queue);
    const enqueued = context.enqueueEvent(createEvent({author: 'first'}));
    await drain.next();

    // The consumer walks away rather than asking for the next event.
    await drain.return();

    // Without the release this never settles, and the queue stays open for a
    // producer that would wait on it again.
    await expect(enqueued).resolves.toBeUndefined();
    expect(queue.isClosed).toBe(true);
  });
});

describe('InvocationContext credential service', () => {
  const credentialService = new InMemoryCredentialService();

  function makeContext(): InvocationContext {
    return new InvocationContext({
      invocationId: 'invocation-1',
      session: makeSession(),
      pluginManager: new PluginManager(),
      credentialService,
    });
  }

  it('keeps the credential service it was constructed with', () => {
    // The field was declared and accepted but never assigned, so every tool
    // that reads it — `AgentTool` forwards it to its nested runner — saw
    // undefined however the runner was configured.
    expect(makeContext().credentialService).toBe(credentialService);
  });

  it('carries the credential service into a sub-agent branch', () => {
    const child = new InvocationContext({
      ...makeContext(),
      branch: 'parent.child',
    });

    expect(child.credentialService).toBe(credentialService);
  });
});

describe('InvocationContext credential service', () => {
  it('keeps the credential service it was constructed with', () => {
    const credentialService = new InMemoryCredentialService();

    const context = new InvocationContext({
      invocationId: 'inv-credential',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {},
      credentialService,
    });

    expect(context.credentialService).toBe(credentialService);
  });

  it('carries the credential service onto a child context', () => {
    const credentialService = new InMemoryCredentialService();

    const root = new InvocationContext({
      invocationId: 'inv-credential',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {},
      credentialService,
    });
    const child = new InvocationContext({
      ...root,
      agent: new LoopAgent({name: 'sub'}),
    });

    expect(child.credentialService).toBe(credentialService);
  });
});

describe('InvocationContext.credentialService', () => {
  const credentialService = new InMemoryCredentialService();

  it('is undefined when the caller passes none', () => {
    expect(makeContext().credentialService).toBeUndefined();
  });

  it('is the service the caller passed', () => {
    const context = new InvocationContext({
      invocationId: 'inv-credential-service',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      credentialService,
    });

    expect(context.credentialService).toBe(credentialService);
  });

  it('reaches a cloned context', () => {
    const context = new InvocationContext({
      invocationId: 'inv-credential-service-clone',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      credentialService,
    });

    expect(context.clone().credentialService).toBe(credentialService);
  });
});

describe('InvocationContext.stateSchema', () => {
  const schema = z.object({counter: z.number()});

  it('is undefined when the caller declares none', () => {
    expect(makeContext().stateSchema).toBeUndefined();
  });

  it('is the schema the caller declared, and reaches a cloned context', () => {
    const context = new InvocationContext({
      invocationId: 'inv-state-schema',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      stateSchema: schema,
    });

    expect(context.stateSchema).toBe(schema);
    expect(context.clone().stateSchema).toBe(schema);
  });
});

describe('InvocationContext credential service', () => {
  const credentialService: BaseCredentialService = {
    loadCredential: async () => undefined,
    saveCredential: async () => {},
  };

  it('exposes the credential service it was built with', () => {
    const context = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      credentialService,
    });

    expect(context.credentialService).toBe(credentialService);
  });

  it('carries the credential service into a child context', () => {
    const root = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      credentialService,
    });

    const child = new InvocationContext({
      ...root,
      agent: new LoopAgent({name: 'sub'}),
    });

    expect(child.credentialService).toBe(credentialService);
  });
});

describe('InvocationContext credential service', () => {
  it('exposes the credential service it was constructed with', () => {
    const credentialService = new InMemoryCredentialService();

    const context = new InvocationContext({
      invocationId: 'inv-credential',
      session: makeSession(),
      pluginManager: new PluginManager(),
      credentialService,
    });

    expect(context.credentialService).toBe(credentialService);
  });
});

/** A sub-agent that stamps a key onto the invocation's custom metadata. */
class MetadataWritingAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    context.customMetadata['writtenBySubAgent'] = true;
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

function makeMetadataContext(
  overrides: Partial<InvocationContextParams> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-metadata',
    session: makeSession(),
    pluginManager: new PluginManager(),
    ...overrides,
  });
}

describe('InvocationContext customMetadata', () => {
  it('seeds from runConfig.customMetadata', () => {
    const context = makeMetadataContext({
      runConfig: {customMetadata: {testKey: 'testValue'}},
    });

    expect(context.customMetadata).toEqual({testKey: 'testValue'});
  });

  it('defaults to an empty object when there is no runConfig', () => {
    expect(makeMetadataContext().customMetadata).toEqual({});
  });

  it('defaults to an empty object when the runConfig omits it', () => {
    const context = makeMetadataContext({runConfig: {maxLlmCalls: 3}});

    expect(context.customMetadata).toEqual({});
  });

  it('copies rather than aliases the runConfig record', () => {
    const runConfig = {customMetadata: {tenant: 'acme'}};
    const context = makeMetadataContext({runConfig});

    context.customMetadata['addedLater'] = 1;

    expect(context.customMetadata).not.toBe(runConfig.customMetadata);
    expect(runConfig.customMetadata).toEqual({tenant: 'acme'});
  });

  it('shares one record with its clones', () => {
    const context = makeMetadataContext({
      runConfig: {customMetadata: {tenant: 'acme'}},
    });
    const clone = context.clone();

    clone.customMetadata['writtenByClone'] = true;

    expect(clone.customMetadata).toBe(context.customMetadata);
    expect(context.customMetadata['writtenByClone']).toBe(true);
  });

  it('keeps the original record when a clone overrides the runConfig', () => {
    const context = makeMetadataContext({
      runConfig: {customMetadata: {tenant: 'acme'}},
    });

    const clone = context.clone({
      runConfig: {customMetadata: {tenant: 'other', extra: 'ignored'}},
    });

    expect(clone.customMetadata).toBe(context.customMetadata);
    expect(clone.customMetadata).toEqual({tenant: 'acme'});
  });

  it('carries a sub-agent write back to the parent context', async () => {
    const agent = new MetadataWritingAgent({name: 'writer'});
    const context = makeMetadataContext({
      agent,
      runConfig: {customMetadata: {tenant: 'acme'}},
    });

    for await (const _event of agent.runAsync(context)) {
      // Drain the stream; the assertion is on the shared record.
    }

    expect(context.customMetadata).toEqual({
      tenant: 'acme',
      writtenBySubAgent: true,
    });
  });
});

describe('InvocationContext realtime audio caches', () => {
  const entry: RealtimeCacheEntry = {
    role: 'user',
    data: {mimeType: 'audio/pcm', data: 'AAAA'},
    timestamp: 1.5,
  };

  it('leaves both caches undefined by default', () => {
    const context = makeMetadataContext();

    expect(context.inputRealtimeCache).toBeUndefined();
    expect(context.outputRealtimeCache).toBeUndefined();
  });

  it('round-trips a cached entry unchanged', () => {
    const context = makeMetadataContext({inputRealtimeCache: [entry]});

    expect(context.inputRealtimeCache).toEqual([
      {
        role: 'user',
        data: {mimeType: 'audio/pcm', data: 'AAAA'},
        timestamp: 1.5,
      },
    ]);
  });

  it('carries both caches by reference through clone()', () => {
    const context = makeMetadataContext({
      inputRealtimeCache: [],
      outputRealtimeCache: [],
    });
    const clone = context.clone();

    clone.inputRealtimeCache!.push(entry);
    clone.outputRealtimeCache!.push({...entry, role: 'model'});

    expect(context.inputRealtimeCache).toEqual([entry]);
    expect(context.outputRealtimeCache).toEqual([{...entry, role: 'model'}]);
  });

  it('replaces only the cache a clone overrides', () => {
    const context = makeMetadataContext({
      inputRealtimeCache: [entry],
      outputRealtimeCache: [entry],
    });

    const clone = context.clone({outputRealtimeCache: []});

    expect(clone.inputRealtimeCache).toBe(context.inputRealtimeCache);
    expect(clone.outputRealtimeCache).toEqual([]);
    expect(context.outputRealtimeCache).toEqual([entry]);
  });
});

describe('InvocationContext activeNonBlockingToolTasks', () => {
  it('is undefined by default', () => {
    expect(makeMetadataContext().activeNonBlockingToolTasks).toBeUndefined();
  });

  it('carries the task registry by reference through clone()', async () => {
    const task = new Task(async () => {});
    const context = makeMetadataContext({activeNonBlockingToolTasks: {}});

    const clone = context.clone();
    clone.activeNonBlockingToolTasks!['myTool_call-1'] = task;

    expect(context.activeNonBlockingToolTasks).toBe(
      clone.activeNonBlockingToolTasks,
    );
    expect(context.activeNonBlockingToolTasks!['myTool_call-1']).toBe(task);
    await task.promise;
  });

  it('shows a deletion made through the clone on the original', async () => {
    const task = new Task(async () => {});
    const context = makeMetadataContext({
      activeNonBlockingToolTasks: {'myTool_call-1': task},
    });

    const clone = context.clone();
    delete clone.activeNonBlockingToolTasks!['myTool_call-1'];

    expect(context.activeNonBlockingToolTasks).toEqual({});
    await task.promise;
  });
});
