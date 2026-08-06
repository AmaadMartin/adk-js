/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  BaseAgentState,
  Event,
  InvocationContext,
  LoopAgent,
  PluginManager,
  ResumabilityConfig,
  Session,
  createEvent,
  createEventActions,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

// transformToCamelCaseEvent is internal to the events module, so it has no
// public entry point to import from.
import {transformToCamelCaseEvent} from '../../src/events/event.js';

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
 * Builds a context whose session holds `events`, the analogue of the reference
 * suite's `_create_test_invocation_context`.
 */
function makeContext(
  options: {
    resumabilityConfig?: ResumabilityConfig;
    events?: Event[];
    agent?: BaseAgent;
  } = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: options.agent ?? new LoopAgent({name: 'agent1'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events: options.events ?? [],
    }),
    pluginManager: new PluginManager(),
    resumabilityConfig: options.resumabilityConfig,
  });
}

function makeAgentEvent(params: Partial<Event>): Event {
  return createEvent({invocationId: 'inv-1', author: 'agent1', ...params});
}

const MODEL_CONTENT = {role: 'model', parts: [{text: 'hi'}]};

describe('InvocationContext.isResumable', () => {
  it('is true when the resumability config enables resumption', () => {
    expect(
      makeContext({resumabilityConfig: {isResumable: true}}).isResumable,
    ).toBe(true);
  });

  it('is false when the resumability config disables resumption', () => {
    expect(
      makeContext({resumabilityConfig: {isResumable: false}}).isResumable,
    ).toBe(false);
  });

  it('is false when no resumability config is set', () => {
    expect(makeContext().isResumable).toBe(false);
  });

  it('survives the child-context spread, which does not copy accessors', () => {
    const parent = makeContext({resumabilityConfig: {isResumable: true}});
    const child = new InvocationContext({
      ...parent,
      agent: new LoopAgent({name: 'sub'}),
    });
    expect(child.isResumable).toBe(true);
  });
});

describe('InvocationContext.setAgentState', () => {
  it('marks the agent final and drops its checkpoint', () => {
    const ctx = makeContext();
    ctx.setAgentState('agent1', {agentState: {}});

    ctx.setAgentState('agent1', {endOfAgent: true});

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({agent1: true});
  });

  it('records the checkpoint by reference and clears the final flag', () => {
    const ctx = makeContext();
    ctx.setAgentState('agent1', {endOfAgent: true});
    const agentState: BaseAgentState = {timesLooped: 1};

    ctx.setAgentState('agent1', {agentState});

    expect(ctx.agentStates['agent1']).toBe(agentState);
    expect(ctx.endOfAgents).toEqual({agent1: false});
  });

  it('ignores the checkpoint when the agent is also marked final', () => {
    const ctx = makeContext();

    ctx.setAgentState('agent1', {agentState: {}, endOfAgent: true});

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({agent1: true});
  });

  it('removes both entries when called with no options, so the agent may re-run', () => {
    const ctx = makeContext();
    ctx.setAgentState('agent1', {endOfAgent: true});

    ctx.setAgentState('agent1');

    expect('agent1' in ctx.agentStates).toBe(false);
    expect('agent1' in ctx.endOfAgents).toBe(false);
  });
});

describe('InvocationContext.resetSubAgentStates', () => {
  function makeAgentTree(): BaseAgent {
    return new LoopAgent({
      name: 'root_agent',
      subAgents: [
        new LoopAgent({
          name: 'sub_agent_1',
          subAgents: [new LoopAgent({name: 'sub_sub_agent_1'})],
        }),
        new LoopAgent({name: 'sub_agent_2'}),
      ],
    });
  }

  it('clears every transitive sub-agent', () => {
    const ctx = makeContext({agent: makeAgentTree()});
    ctx.setAgentState('sub_agent_1', {agentState: {}});
    ctx.setAgentState('sub_agent_2', {endOfAgent: true});
    ctx.setAgentState('sub_sub_agent_1', {agentState: {}});

    ctx.resetSubAgentStates('root_agent');

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({});
  });

  it('leaves the state of the named agent itself untouched', () => {
    const ctx = makeContext({agent: makeAgentTree()});
    ctx.setAgentState('root_agent', {agentState: {}});
    ctx.setAgentState('sub_agent_1', {agentState: {}});

    ctx.resetSubAgentStates('root_agent');

    expect(ctx.agentStates).toEqual({root_agent: {}});
    expect(ctx.endOfAgents).toEqual({root_agent: false});
  });

  it('is a no-op for an agent name that is not in the tree', () => {
    const ctx = makeContext({agent: makeAgentTree()});
    ctx.setAgentState('sub_agent_1', {agentState: {}});

    expect(() => ctx.resetSubAgentStates('nope')).not.toThrow();
    expect(ctx.agentStates).toEqual({sub_agent_1: {}});
    expect(ctx.endOfAgents).toEqual({sub_agent_1: false});
  });
});

describe('InvocationContext.populateInvocationAgentStates', () => {
  function populate(events: Event[]): InvocationContext {
    const ctx = makeContext({
      resumabilityConfig: {isResumable: true},
      events,
    });
    ctx.populateInvocationAgentStates();
    return ctx;
  }

  it('marks an agent final from an endOfAgent event', () => {
    const ctx = populate([
      makeAgentEvent({actions: createEventActions({endOfAgent: true})}),
    ]);

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({agent1: true});
  });

  it('restores a checkpoint and invalidates a stale final flag', () => {
    const ctx = makeContext({
      resumabilityConfig: {isResumable: true},
      events: [makeAgentEvent({actions: createEventActions({agentState: {}})})],
    });
    ctx.setAgentState('agent1', {endOfAgent: true});

    ctx.populateInvocationAgentStates();

    expect(ctx.agentStates).toEqual({agent1: {}});
    expect(ctx.endOfAgents).toEqual({agent1: false});
  });

  it('seeds an empty checkpoint for an agent that produced content without one', () => {
    const ctx = populate([makeAgentEvent({content: MODEL_CONTENT})]);

    expect(ctx.agentStates).toEqual({agent1: {}});
    expect(ctx.endOfAgents).toEqual({agent1: false});
  });

  it('lets endOfAgent win over agentState on the same event', () => {
    const ctx = populate([
      makeAgentEvent({
        actions: createEventActions({endOfAgent: true, agentState: {}}),
      }),
    ]);

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({agent1: true});
  });

  it('ignores events belonging to another invocation', () => {
    const ctx = populate([
      makeAgentEvent({content: MODEL_CONTENT}),
      createEvent({
        invocationId: 'inv-2',
        author: 'agent1',
        actions: createEventActions({endOfAgent: true}),
      }),
    ]);

    expect(ctx.agentStates).toEqual({agent1: {}});
    expect(ctx.endOfAgents).toEqual({agent1: false});
  });

  it('drops an earlier checkpoint once the agent reports it finished', () => {
    const ctx = populate([
      makeAgentEvent({actions: createEventActions({agentState: {step: 1}})}),
      makeAgentEvent({actions: createEventActions({endOfAgent: true})}),
    ]);

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({agent1: true});
  });

  it('replays this invocation in session order, so the last checkpoint wins', () => {
    const ctx = populate([
      makeAgentEvent({actions: createEventActions({agentState: {step: 1}})}),
      makeAgentEvent({actions: createEventActions({agentState: {step: 2}})}),
      createEvent({
        invocationId: 'inv-2',
        author: 'agent1',
        actions: createEventActions({endOfAgent: true}),
      }),
    ]);

    expect(ctx.agentStates).toEqual({agent1: {step: 2}});
    expect(ctx.endOfAgents).toEqual({agent1: false});
  });

  it('leaves both maps empty for a session with no events', () => {
    const ctx = populate([]);

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({});
  });

  it('does nothing when the invocation is not resumable', () => {
    const ctx = makeContext({
      resumabilityConfig: {isResumable: false},
      events: [
        makeAgentEvent({actions: createEventActions({endOfAgent: true})}),
      ],
    });

    ctx.populateInvocationAgentStates();

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({});
  });

  it('ignores a user content event', () => {
    const ctx = populate([
      makeAgentEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hi'}]},
      }),
    ]);

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({});
  });

  it('ignores an event with neither content nor agent-state actions', () => {
    const ctx = populate([makeAgentEvent({})]);

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({});
  });

  it('ignores an event with no author', () => {
    const ctx = populate([
      createEvent({
        invocationId: 'inv-1',
        content: MODEL_CONTENT,
        actions: createEventActions({endOfAgent: true}),
      }),
    ]);

    expect(ctx.agentStates).toEqual({});
    expect(ctx.endOfAgents).toEqual({});
  });

  it('does not overwrite a recorded checkpoint with the empty seed', () => {
    const ctx = makeContext({
      resumabilityConfig: {isResumable: true},
      events: [makeAgentEvent({content: MODEL_CONTENT})],
    });
    ctx.setAgentState('agent1', {agentState: {timesLooped: 1}});

    ctx.populateInvocationAgentStates();

    expect(ctx.agentStates).toEqual({agent1: {timesLooped: 1}});
    expect(ctx.endOfAgents).toEqual({agent1: false});
  });

  it('treats a null agent_state written by adk-python as "not recorded"', () => {
    // A persisted adk-python event serializes an unset checkpoint as null, not
    // as an absent key, so it arrives here as `agentState: null`.
    const pythonEvent = transformToCamelCaseEvent({
      id: 'e1',
      invocation_id: 'inv-1',
      author: 'agent1',
      content: {role: 'model', parts: [{text: 'hi'}]},
      actions: {end_of_agent: null, agent_state: null},
    });

    const ctx = populate([pythonEvent]);

    expect(ctx.agentStates).toEqual({agent1: {}});
    expect(ctx.endOfAgents).toEqual({agent1: false});
  });
});

describe('InvocationContext agent-state sharing with child contexts', () => {
  it('records a sub-agent checkpoint on the parent context', () => {
    const parent = makeContext({resumabilityConfig: {isResumable: true}});
    const child = new InvocationContext({
      ...parent,
      agent: new LoopAgent({name: 'sub'}),
    });

    child.setAgentState('sub', {agentState: {timesLooped: 2}});
    child.setAgentState('agent1', {endOfAgent: true});

    expect(parent.agentStates).toEqual({sub: {timesLooped: 2}});
    expect(parent.endOfAgents).toEqual({sub: false, agent1: true});
  });

  it('starts a separate invocation with its own maps', () => {
    const first = makeContext();
    first.setAgentState('agent1', {endOfAgent: true});

    expect(makeContext().endOfAgents).toEqual({});
    expect(first.endOfAgents).toEqual({agent1: true});
  });
});
