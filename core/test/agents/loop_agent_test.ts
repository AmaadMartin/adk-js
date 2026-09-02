/**
 * @license
 * Copyright 2025 Google LLC
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
  createEventActions,
  createResumabilityConfig,
  createSession,
  getLogger,
  isLoopAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// `resetDeprecationWarnings` is test-only and deliberately not public API, so
// this is the one import here that cannot go through `@google/adk`.
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';

class MockSubAgent extends BaseAgent {
  private eventsToYield: Event[];

  constructor(config: BaseAgentConfig, eventsToYield: Event[]) {
    super(config);
    this.eventsToYield = eventsToYield;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.eventsToYield) {
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Ensure the event has the correct invocationId and branch from context
      yield {
        ...event,
        invocationId: context.invocationId,
        branch: context.branch,
      };
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }
}

describe('LoopAgent', () => {
  it('should be identified as LoopAgent', () => {
    const agent = new LoopAgent({name: 'loop'});
    expect(isLoopAgent(agent)).toBe(true);
  });

  it('should loop through sub-agents and yield events', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub1, sub2],
      maxIterations: 1,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    expect(yieldedEvents[0].author).toBe('sub1');
    expect(yieldedEvents[1].author).toBe('sub2');
  });

  it('should stop after maxIterations', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
  });

  it('should stop on escalation', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
      actions: createEventActions({escalate: true}),
    });
    const event3 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'should not reach'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1, event3]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub1, sub2],
      maxIterations: 5,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(3);
    expect(yieldedEvents[2].actions?.escalate).toBe(true);
  });

  it('should stop on abort signal', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 5,
    });

    const controller = new AbortController();

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    controller.abort();

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(0);
  });

  it('should loop through sub-agents and yield events in live mode', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub1, sub2],
      maxIterations: 1,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runLive(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    expect(yieldedEvents[0].author).toBe('sub1');
    expect(yieldedEvents[1].author).toBe('sub2');
  });

  it('should stop after maxIterations in live mode', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runLive(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
  });

  it('should stop on escalation in live mode', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
      actions: createEventActions({escalate: true}),
    });
    const event3 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'should not reach'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1, event3]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub1, sub2],
      maxIterations: 5,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runLive(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(3);
    expect(yieldedEvents[2].actions?.escalate).toBe(true);
  });

  it('should stop on abort signal in live mode', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 5,
    });

    const controller = new AbortController();

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    controller.abort();

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runLive(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(0);
  });
});

/** Yields one text event per run, mirroring adk-python's `_TestingAgent`. */
class GreetingAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: `Hello, async ${this.name}!`}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }
}

/** Escalates on its first event, then yields one more, like adk-python. */
class EscalatingAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: `Hello, async ${this.name}!`}]},
      actions: createEventActions({escalate: true}),
    });
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: 'I have done my job after escalation!!'}],
      },
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }
}

/** Escalates on its third run, so an uncapped loop still terminates. */
class ThirdRunEscalatingAgent extends BaseAgent {
  runs = 0;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runs++;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: `Run ${this.runs}!`}]},
      actions: createEventActions({escalate: this.runs === 3}),
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }
}

/** Yields one event, aborts the invocation, then yields a second event. */
class AbortingAgent extends BaseAgent {
  constructor(
    config: BaseAgentConfig,
    private readonly controller: AbortController,
  ) {
    super(config);
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'first'}]},
    });
    this.controller.abort();
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'second'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }
}

/** Emits an unanswered long-running function call, which pauses the loop. */
class PausingAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call-1', name: 'approve', args: {}}}],
      },
      longRunningToolIds: ['call-1'],
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }
}

function makeLoopContext(params: {
  agent: BaseAgent;
  isResumable?: boolean;
  abortSignal?: AbortSignal;
}): InvocationContext {
  return new InvocationContext({
    invocationId: 'loop-invocation',
    agent: params.agent,
    session: createSession({id: 'sess', appName: 'app', userId: 'user'}),
    pluginManager: new PluginManager(),
    abortSignal: params.abortSignal,
    resumabilityConfig: createResumabilityConfig({
      isResumable: params.isResumable ?? false,
    }),
  });
}

async function collectLoopEvents(
  agent: BaseAgent,
  context: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) {
    events.push(event);
  }
  return events;
}

/**
 * Reduces an event to `[author, payload]`, where the payload is the checkpoint,
 * the literal `'END_OF_AGENT'`, or the event's text. Mirrors adk-python's
 * `simplify_resumable_app_events` so the expectations read like theirs.
 */
function simplify(event: Event): [string | undefined, unknown] {
  if (event.actions.endOfAgent) {
    return [event.author, 'END_OF_AGENT'];
  }
  if (event.actions.agentState) {
    return [event.author, event.actions.agentState];
  }
  return [event.author, event.content?.parts?.[0]?.text];
}

describe('LoopAgent agent state and resumption', () => {
  it('checkpoints each sub-agent run and ends with an end-of-agent event', async () => {
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([
      ['loop', {current_sub_agent: 'sub', times_looped: 0}],
      ['sub', 'Hello, async sub!'],
      ['loop', {current_sub_agent: 'sub', times_looped: 1}],
      ['sub', 'Hello, async sub!'],
      ['loop', 'END_OF_AGENT'],
    ]);
    expect(context.endOfAgents['loop']).toBe(true);
    expect(context.agentStates['loop']).toBeUndefined();
  });

  it('emits no checkpoint events when the invocation is not resumable', async () => {
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });
    const context = makeLoopContext({agent: loop});

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([
      ['sub', 'Hello, async sub!'],
      ['sub', 'Hello, async sub!'],
    ]);
  });

  it('resumes at the checkpointed sub-agent without repeating its checkpoint', async () => {
    const first = new GreetingAgent({name: 'agent1'});
    const second = new GreetingAgent({name: 'agent2'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [first, second],
      maxIterations: 2,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('loop', {
      agentState: {current_sub_agent: 'agent2', times_looped: 1},
    });

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([
      ['agent2', 'Hello, async agent2!'],
      ['loop', 'END_OF_AGENT'],
    ]);
  });

  it('restarts from the first sub-agent when the checkpoint names a removed one', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 1,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('loop', {
      agentState: {current_sub_agent: 'deleted', times_looped: 0},
    });

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([
      ['sub', 'Hello, async sub!'],
      ['loop', 'END_OF_AGENT'],
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Sub-agent deleted was not found. Restarting from the beginning.',
    );
    warn.mockRestore();
  });

  it('resumes at the first sub-agent when the checkpoint names none', async () => {
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('loop', {
      agentState: {current_sub_agent: '', times_looped: 1},
    });

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([
      ['sub', 'Hello, async sub!'],
      ['loop', 'END_OF_AGENT'],
    ]);
  });

  it.each([
    [0, 0],
    [-1, 0],
    [undefined, 3],
    [2, 2],
  ])(
    'runs %s passes at most and the sub-agent %s times',
    async (maxIterations, expectedRuns) => {
      const sub = new ThirdRunEscalatingAgent({name: 'sub'});
      const loop = new LoopAgent({
        name: 'loop',
        subAgents: [sub],
        maxIterations,
      });
      const context = makeLoopContext({agent: loop});

      await collectLoopEvents(loop, context);

      expect(sub.runs).toBe(expectedRuns);
    },
  );

  it(
    'terminates immediately with no sub-agents and no maxIterations',
    {timeout: 5000},
    async () => {
      const loop = new LoopAgent({name: 'loop', subAgents: []});
      const context = makeLoopContext({agent: loop});

      const events = await collectLoopEvents(loop, context);

      expect(events).toEqual([]);
    },
  );

  it.each([true, false])(
    'yields the escalating sub-agent\u2019s remaining events and skips the next one (resumable=%s)',
    async (isResumable) => {
      const before = new GreetingAgent({name: 'before'});
      const escalating = new EscalatingAgent({name: 'escalating'});
      const after = new GreetingAgent({name: 'after'});
      const loop = new LoopAgent({
        name: 'loop',
        subAgents: [before, escalating, after],
      });
      const context = makeLoopContext({agent: loop, isResumable});

      const events = await collectLoopEvents(loop, context);

      const expected: Array<[string | undefined, unknown]> = isResumable
        ? [
            ['loop', {current_sub_agent: 'before', times_looped: 0}],
            ['before', 'Hello, async before!'],
            ['loop', {current_sub_agent: 'escalating', times_looped: 0}],
            ['escalating', 'Hello, async escalating!'],
            ['escalating', 'I have done my job after escalation!!'],
            ['loop', 'END_OF_AGENT'],
          ]
        : [
            ['before', 'Hello, async before!'],
            ['escalating', 'Hello, async escalating!'],
            ['escalating', 'I have done my job after escalation!!'],
          ];
      expect(events.map(simplify)).toEqual(expected);
    },
  );

  it('clears the sub-agents\u2019 checkpoints after a completed pass', async () => {
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 1,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('sub', {agentState: {some_key: 'some_value'}});

    await collectLoopEvents(loop, context);

    expect(context.agentStates['sub']).toBeUndefined();
  });

  it('pauses on an unanswered long-running call, keeping both checkpoints', async () => {
    const sub = new PausingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('sub', {agentState: {some_key: 'some_value'}});

    const events = await collectLoopEvents(loop, context);

    expect(events.map((event) => event.author)).toEqual(['loop', 'sub']);
    expect(events.some((event) => event.actions.endOfAgent)).toBe(false);
    expect(context.agentStates['sub']).toEqual({some_key: 'some_value'});
    expect(context.agentStates['loop']).toEqual({
      current_sub_agent: 'sub',
      times_looped: 0,
    });
  });

  it('stops mid-run on the abort signal without an end-of-agent event', async () => {
    const controller = new AbortController();
    const sub = new AbortingAgent({name: 'sub'}, controller);
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });
    const context = makeLoopContext({
      agent: loop,
      isResumable: true,
      abortSignal: controller.signal,
    });

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([
      ['loop', {current_sub_agent: 'sub', times_looped: 0}],
      ['sub', 'first'],
    ]);
    expect(context.endOfAgents['loop']).toBe(false);
  });

  it('emits only the end-of-agent event when the loop already ran out of passes', async () => {
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('loop', {
      agentState: {current_sub_agent: '', times_looped: 2},
    });

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([['loop', 'END_OF_AGENT']]);
  });

  it.each([
    [
      {current_sub_agent: 1, times_looped: 0},
      'Invalid LoopAgent state: "current_sub_agent" must be a string, got number.',
    ],
    [
      {current_sub_agent: 'sub', times_looped: 'x'},
      'Invalid LoopAgent state: "times_looped" must be an integer, got x.',
    ],
    [
      {current_sub_agent: 'sub', times_looped: 1.5},
      'Invalid LoopAgent state: "times_looped" must be an integer, got 1.5.',
    ],
    [
      {current_sub_agent: 'sub', times_looped: Number.NaN},
      'Invalid LoopAgent state: "times_looped" must be an integer, got NaN.',
    ],
    [
      {current_sub_agent: 'sub', times_looped: 0, extra: true},
      'Invalid LoopAgent state: unexpected field "extra".',
    ],
  ])('rejects the checkpoint %j', async (agentState, message) => {
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({name: 'loop', subAgents: [sub]});
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('loop', {agentState});

    await expect(collectLoopEvents(loop, context)).rejects.toThrowError(
      message,
    );
  });

  it('defaults both checkpoint fields when the record omits them', async () => {
    const sub = new GreetingAgent({name: 'sub'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 1,
    });
    const context = makeLoopContext({agent: loop, isResumable: true});
    context.setAgentState('loop', {agentState: {}});

    const events = await collectLoopEvents(loop, context);

    expect(events.map(simplify)).toEqual([
      ['sub', 'Hello, async sub!'],
      ['loop', 'END_OF_AGENT'],
    ]);
  });
});

describe('LoopAgent deprecation', () => {
  it('warns that a Workflow cannot yet be an LlmAgent sub-agent', () => {
    resetDeprecationWarnings();
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

    new LoopAgent({name: 'loop'});

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sub-agent'));
    warn.mockRestore();
  });
});
