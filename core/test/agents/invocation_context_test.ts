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
  createSession,
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
