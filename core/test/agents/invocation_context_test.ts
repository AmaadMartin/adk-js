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
  InvocationContextParams,
  LoopAgent,
  PluginManager,
  Session,
  createEvent,
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

function makeContext(
  overrides: Partial<InvocationContextParams> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LoopAgent({name: 'agent1'}),
    session: makeSession(),
    pluginManager: new PluginManager(),
    ...overrides,
  });
}

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
