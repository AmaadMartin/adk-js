/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  Event,
  InvocationContext,
  LoopAgent,
  PluginManager,
  Session,
  createEvent,
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
