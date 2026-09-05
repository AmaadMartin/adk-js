/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  Event,
  EventActions,
  InvocationContext,
  LoopAgent,
  ParallelAgent,
  PluginManager,
  SequentialAgent,
  createEvent,
  createResumabilityConfig,
  createSession,
  isParallelAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// Neither helper has a public entry point: the logger is internal plumbing and
// the reset exists only so a test can observe a once-per-class warning.
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';

class MockSubAgent extends BaseAgent {
  private eventsToYield: Event[];
  private delay: number;

  constructor(config: BaseAgentConfig, eventsToYield: Event[], delay = 0) {
    super(config);
    this.eventsToYield = eventsToYield;
    this.delay = delay;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.eventsToYield) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));

      yield {
        ...event,
        invocationId: context.invocationId,
        branch: context.branch,
      };
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test
  }
}

describe('ParallelAgent', () => {
  it('should be identified as ParallelAgent', () => {
    const agent = new ParallelAgent({name: 'parallel'});
    expect(isParallelAgent(agent)).toBe(true);
  });

  it('should run sub-agents in parallel and merge events', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    // sub1 takes longer, so sub2 should yield first
    const sub1 = new MockSubAgent({name: 'sub1'}, [event1], 50);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2], 10);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub1, sub2],
    });

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of parallelAgent.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    // sub2 should be first because it has a shorter delay
    expect(yieldedEvents[0].author).toBe('sub2');
    expect(yieldedEvents[1].author).toBe('sub1');
  });

  it('should create isolated branch context for sub-agents', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const e of parallelAgent.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].branch).toBe('parallel.sub');
  });

  it('should respect abort signal', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    // Make it take some time so we can abort
    const sub = new MockSubAgent({name: 'sub'}, [event], 100);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const controller = new AbortController();

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    // Run in background and abort
    const runPromise = (async () => {
      const events: Event[] = [];
      for await (const e of parallelAgent.runAsync(context)) {
        events.push(e);
      }
      return events;
    })();

    controller.abort();

    const yieldedEvents = await runPromise;

    expect(yieldedEvents.length).toBe(0);
  });

  it('should abort after some events are yielded', async () => {
    const event1 = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event1, event2], 10);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const controller = new AbortController();

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    const yieldedEvents: Event[] = [];

    const runPromise = (async () => {
      for await (const e of parallelAgent.runAsync(context)) {
        yieldedEvents.push(e);
        controller.abort();
      }
    })();

    await runPromise;

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].content?.parts?.[0]?.text).toBe('hello');
  });
});

const PARALLEL = 'parallel';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Emits whatever `produce` resolves to. A sub-agent whose work fails before it
 * has anything to say fails here, without ever reaching the yield.
 */
async function* eventStream(
  produce: () => Promise<Event[]>,
): AsyncGenerator<Event, void, void> {
  for (const event of await produce()) {
    yield event;
  }
}

/** Stands in for a resource release that fails, such as closing a session. */
async function failingCleanup(): Promise<void> {
  throw new Error('cleanup failed');
}

interface TestingAgentConfig extends BaseAgentConfig {
  /** Milliseconds to wait before emitting an event. */
  delay?: number;
}

/**
 * Emits one event after `delay`, then marks itself finished when the
 * invocation is resumable. The adk-js counterpart of the reference suite's
 * `_TestingAgent`.
 */
class TestingAgent extends BaseAgent<TestingAgentConfig> {
  readonly delay: number;

  constructor(config: TestingAgentConfig) {
    super(config);
    this.delay = config.delay ?? 0;
  }

  event(
    context: InvocationContext,
    options: {text?: string; actions?: Partial<EventActions>} = {},
  ): Event {
    return createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        role: 'model',
        parts: [{text: options.text ?? `Hello, async ${this.name}!`}],
      },
      actions: options.actions,
    });
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    await sleep(this.delay);
    yield this.event(context);
    this.finish(context);
  }

  protected finish(context: InvocationContext): void {
    if (context.isResumable) {
      context.setAgentState(this.name, {endOfAgent: true});
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for these tests.
  }
}

/** Escalates, then tries to emit one more event that must never arrive. */
class EscalatingAgent extends TestingAgent {
  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    await sleep(this.delay);
    yield this.event(context, {
      text: `Escalating from ${this.name}!`,
      actions: {escalate: true},
    });
    yield this.event(context, {
      text: 'This event should be cancelled after escalation.',
    });
    this.finish(context);
  }
}

/** Emits events until it is closed. */
class InfiniteAgent extends TestingAgent {
  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (;;) {
      await sleep(this.delay);
      yield this.event(context);
    }
  }
}

/** Emits one event, then fails while the caller is still busy with it. */
class FailingAfterEventAgent extends TestingAgent {
  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield this.event(context);
    await sleep(this.delay);
    throw new Error('simulated sub-agent failure');
  }
}

class SubAgentFailure extends Error {}

/** Fails without emitting anything. */
class FailingAgent extends TestingAgent {
  protected override runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    return eventStream(async () => {
      await sleep(this.delay);
      throw new SubAgentFailure('simulated sub-agent failure');
    });
  }
}

function makeContext(
  agent: BaseAgent,
  options: {isResumable?: boolean} = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(),
    resumabilityConfig: createResumabilityConfig({
      isResumable: options.isResumable ?? false,
    }),
  });
}

async function collect(
  agent: ParallelAgent,
  context: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) {
    events.push(event);
  }
  return events;
}

function textOf(event: Event): string | undefined {
  return event.content?.parts?.[0]?.text;
}

describe('ParallelAgent event stream', () => {
  it('interleaves sub-agent events by arrival and isolates their branches', async () => {
    const agent1 = new TestingAgent({name: 'agent1', delay: 50});
    const agent2 = new TestingAgent({name: 'agent2'});
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [agent1, agent2],
    });

    const events = await collect(parallel, makeContext(parallel));

    expect(events.map((event) => event.author)).toEqual(['agent2', 'agent1']);
    expect(events.map((event) => event.branch)).toEqual([
      'parallel.agent2',
      'parallel.agent1',
    ]);
    expect(events.map(textOf)).toEqual([
      'Hello, async agent2!',
      'Hello, async agent1!',
    ]);
  });

  it('brackets a resumable run with checkpoint events', async () => {
    const agent1 = new TestingAgent({name: 'agent1', delay: 50});
    const agent2 = new TestingAgent({name: 'agent2'});
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [agent1, agent2],
    });
    const context = makeContext(parallel, {isResumable: true});

    const events = await collect(parallel, context);

    expect(events.map((event) => event.author)).toEqual([
      PARALLEL,
      'agent2',
      'agent1',
      PARALLEL,
    ]);
    expect(events[0].actions.agentState).toEqual({});
    expect(events[0].actions.endOfAgent).toBeFalsy();
    expect(events[0].invocationId).toBe('test-invocation');
    expect(events[3].actions.endOfAgent).toBe(true);
    expect(events[3].actions.agentState).toBeUndefined();
    expect(context.endOfAgents[PARALLEL]).toBe(true);
    expect(context.agentStates[PARALLEL]).toBeUndefined();
  });

  it('gives every descendant of one sub-agent the same branch', async () => {
    const agent1 = new TestingAgent({name: 'agent1', delay: 50});
    const sequential = new SequentialAgent({
      name: 'sequential',
      subAgents: [
        new TestingAgent({name: 'agent2'}),
        new TestingAgent({name: 'agent3'}),
      ],
    });
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [sequential, agent1],
    });

    const events = await collect(parallel, makeContext(parallel));

    expect(events.map((event) => event.author)).toEqual([
      'agent2',
      'agent3',
      'agent1',
    ]);
    expect(events.map((event) => event.branch)).toEqual([
      'parallel.sequential',
      'parallel.sequential',
      'parallel.agent1',
    ]);
  });

  it('nests the fan-out branch under the branch it started from', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [new TestingAgent({name: 'agent1'})],
    });
    const context = makeContext(parallel);
    context.branch = 'root';

    const events = await collect(parallel, context);

    expect(events[0].branch).toBe('root.parallel.agent1');
  });

  it('emits nothing without sub-agents, resumable or not', async () => {
    for (const isResumable of [false, true]) {
      const parallel = new ParallelAgent({name: PARALLEL, subAgents: []});
      const context = makeContext(parallel, {isResumable});

      expect(await collect(parallel, context)).toEqual([]);
      expect(context.agentStates).toEqual({});
      expect(context.endOfAgents).toEqual({});
    }
  });

  it('asks a sub-agent for its next event only after the consumer took the last', async () => {
    const processed = new Set<string>();

    class BackpressureAgent extends TestingAgent {
      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        for (let i = 0; i < 3; i++) {
          const event = this.event(context, {text: `${this.name}#${i}`});
          yield event;
          expect(processed.has(event.id)).toBe(true);
        }
      }
    }

    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new BackpressureAgent({name: 'agent1'}),
        new BackpressureAgent({name: 'agent2'}),
      ],
    });

    for await (const event of parallel.runAsync(makeContext(parallel))) {
      processed.add(event.id);
    }

    expect(processed.size).toBe(6);
  });
});

describe('ParallelAgent resumption', () => {
  it('skips a sub-agent that already finished in an earlier run', async () => {
    const agent1 = new TestingAgent({name: 'agent1'});
    const agent2 = new TestingAgent({name: 'agent2'});
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [agent1, agent2],
    });
    const context = makeContext(parallel, {isResumable: true});
    context.setAgentState(PARALLEL, {agentState: {}});
    context.setAgentState('agent2', {endOfAgent: true});

    const events = await collect(parallel, context);

    expect(events.map((event) => event.author)).toEqual(['agent1', PARALLEL]);
    expect(events[1].actions.endOfAgent).toBe(true);
  });

  it('withholds the final checkpoint while a sub-agent is unfinished', async () => {
    /** Emits an event but never records that it finished. */
    class UnfinishedAgent extends TestingAgent {
      protected override finish(_context: InvocationContext): void {}
    }

    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new TestingAgent({name: 'agent1'}),
        new UnfinishedAgent({name: 'agent2'}),
      ],
    });
    const context = makeContext(parallel, {isResumable: true});

    const events = await collect(parallel, context);

    expect(events.map((event) => event.author)).toEqual([
      PARALLEL,
      'agent1',
      'agent2',
    ]);
    // The opening checkpoint set the flag to false; the run must not raise it.
    expect(context.endOfAgents[PARALLEL]).toBe(false);
  });

  it('does not repeat the opening checkpoint on a resumed run', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [new TestingAgent({name: 'agent1'})],
    });
    const context = makeContext(parallel, {isResumable: true});
    context.setAgentState(PARALLEL, {agentState: {}});

    const events = await collect(parallel, context);

    expect(events.map((event) => event.author)).toEqual(['agent1', PARALLEL]);
  });
});

describe('ParallelAgent escalation', () => {
  it('stops the remaining branches when a sub-agent escalates', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new TestingAgent({name: 'fast', delay: 5}),
        new EscalatingAgent({name: 'escalating', delay: 20}),
        new TestingAgent({name: 'slow', delay: 500}),
      ],
    });

    const events = await collect(parallel, makeContext(parallel));

    expect(events.map((event) => event.author)).toEqual(['fast', 'escalating']);
    expect(events[1].actions.escalate).toBe(true);
    expect(textOf(events[1])).toBe('Escalating from escalating!');
    expect(events.map(textOf)).not.toContain(
      'This event should be cancelled after escalation.',
    );
  });

  it('closes a resumable escalating run even though a branch never finished', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new TestingAgent({name: 'fast', delay: 5}),
        new EscalatingAgent({name: 'escalating', delay: 20}),
        new TestingAgent({name: 'slow', delay: 500}),
      ],
    });
    const context = makeContext(parallel, {isResumable: true});

    const events = await collect(parallel, context);

    expect(events.map((event) => event.author)).toEqual([
      PARALLEL,
      'fast',
      'escalating',
      PARALLEL,
    ]);
    expect(events[3].actions.endOfAgent).toBe(true);
    expect(context.endOfAgents['slow']).toBeUndefined();
  });

  it('keeps siblings running when a nested loop ends itself', async () => {
    const ticks = new Map<string, number>();

    /** Escalates on its `escalateOn`-th run, ending its enclosing loop. */
    class LoopingAgent extends TestingAgent {
      escalateOn = 1;

      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        await sleep(this.delay);
        const tick = (ticks.get(this.name) ?? 0) + 1;
        ticks.set(this.name, tick);
        yield this.event(context, {
          text: `${this.name}#${tick}`,
          actions: tick >= this.escalateOn ? {escalate: true} : {},
        });
      }
    }

    const fastInner = new LoopingAgent({name: 'fastInner'});
    const slowInner = new LoopingAgent({name: 'slowInner', delay: 10});
    slowInner.escalateOn = 3;
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new LoopAgent({
          name: 'fastLoop',
          subAgents: [fastInner],
          maxIterations: 5,
        }),
        new LoopAgent({
          name: 'slowLoop',
          subAgents: [slowInner],
          maxIterations: 5,
        }),
      ],
    });

    const events = await collect(parallel, makeContext(parallel));

    expect(events.map(textOf)).toEqual([
      'fastInner#1',
      'slowInner#1',
      'slowInner#2',
      'slowInner#3',
    ]);
  });

  it('ignores an escalation on an event with no author', async () => {
    /** Escalates on an author-less event, which addresses no agent. */
    class AnonymousEscalatingAgent extends TestingAgent {
      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          invocationId: context.invocationId,
          branch: context.branch,
          content: {role: 'model', parts: [{text: 'anonymous escalation'}]},
          actions: {escalate: true},
        });
      }
    }

    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new AnonymousEscalatingAgent({name: 'anonymous'}),
        new TestingAgent({name: 'sibling', delay: 20}),
      ],
    });

    const events = await collect(parallel, makeContext(parallel));

    expect(events.map(textOf)).toEqual([
      'anonymous escalation',
      'Hello, async sibling!',
    ]);
  });
});

describe('ParallelAgent pausing', () => {
  /** Requests a long-running tool call, which pauses the invocation. */
  class LongRunningToolAgent extends TestingAgent {
    private readonly escalate: boolean;

    constructor(config: TestingAgentConfig & {escalate?: boolean}) {
      super(config);
      this.escalate = config.escalate ?? false;
    }

    protected override async *runAsyncImpl(
      context: InvocationContext,
    ): AsyncGenerator<Event, void, void> {
      await sleep(this.delay);
      const callId = `${this.name}-call`;
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        branch: context.branch,
        content: {
          role: 'model',
          parts: [{functionCall: {id: callId, name: 'ask'}}],
        },
        longRunningToolIds: [callId],
        actions: this.escalate ? {escalate: true} : {},
      });
      this.finish(context);
    }
  }

  it('withholds the final checkpoint when a sibling pauses the invocation', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new LongRunningToolAgent({name: 'fast', delay: 5}),
        new EscalatingAgent({name: 'escalating', delay: 20}),
      ],
    });
    const context = makeContext(parallel, {isResumable: true});

    const events = await collect(parallel, context);

    expect(events.map((event) => event.author)).toEqual([
      PARALLEL,
      'fast',
      'escalating',
    ]);
    expect(events.some((event) => event.actions.endOfAgent)).toBe(false);
    expect(events.some((event) => event.actions.escalate)).toBe(true);
    expect(context.endOfAgents[PARALLEL]).toBe(false);
  });

  it('withholds the final checkpoint when the escalating event pauses the invocation', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new TestingAgent({name: 'fast', delay: 5}),
        new LongRunningToolAgent({
          name: 'escalating',
          delay: 20,
          escalate: true,
        }),
      ],
    });
    const context = makeContext(parallel, {isResumable: true});

    const events = await collect(parallel, context);

    expect(events.map((event) => event.author)).toEqual([
      PARALLEL,
      'fast',
      'escalating',
    ]);
    expect(events.some((event) => event.actions.endOfAgent)).toBe(false);
    expect(events.some((event) => event.actions.escalate)).toBe(true);
    expect(context.endOfAgents[PARALLEL]).toBe(false);
  });
});

describe('ParallelAgent failure handling', () => {
  it('stops the fan-out when one sub-agent fails', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new FailingAfterEventAgent({name: 'failing'}),
        new InfiniteAgent({name: 'infinite'}),
      ],
    });

    await expect(collect(parallel, makeContext(parallel))).rejects.toThrow(
      'simulated sub-agent failure',
    );
  }, 5000);

  it('hands the caller the error the sub-agent raised, unwrapped', async () => {
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [new FailingAgent({name: 'failing'})],
    });

    await expect(
      collect(parallel, makeContext(parallel)),
    ).rejects.toBeInstanceOf(SubAgentFailure);
  });

  it('surfaces the earliest failure when several branches fail', async () => {
    class LateFailure extends Error {}

    class LateFailingAgent extends TestingAgent {
      protected override runAsyncImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        return eventStream(async () => {
          await sleep(this.delay);
          throw new LateFailure('late failure');
        });
      }
    }

    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new FailingAgent({name: 'early', delay: 10}),
        new LateFailingAgent({name: 'late', delay: 200}),
      ],
    });

    await expect(
      collect(parallel, makeContext(parallel)),
    ).rejects.toBeInstanceOf(SubAgentFailure);
  });

  it('reaches a caller that is busy between events, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);

    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new FailingAfterEventAgent({name: 'failing', delay: 10}),
        new InfiniteAgent({name: 'infinite'}),
      ],
    });

    const consume = async () => {
      for await (const _ of parallel.runAsync(makeContext(parallel))) {
        await sleep(100);
      }
    };

    try {
      await expect(consume()).rejects.toThrow('simulated sub-agent failure');
      await sleep(50);
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(unhandled).toEqual([]);
  }, 10000);
});

describe('ParallelAgent branch cleanup', () => {
  /** Records in `closed` that its cleanup ran. */
  class CleanupTrackingAgent extends TestingAgent {
    constructor(
      config: TestingAgentConfig,
      private readonly closed: Set<string>,
    ) {
      super(config);
    }

    protected override async *runAsyncImpl(
      context: InvocationContext,
    ): AsyncGenerator<Event, void, void> {
      try {
        for (;;) {
          await sleep(this.delay);
          yield this.event(context);
        }
      } finally {
        this.closed.add(this.name);
      }
    }
  }

  it('closes every branch after a sub-agent fails', async () => {
    const closed = new Set<string>();
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new FailingAgent({name: 'failing', delay: 10}),
        new CleanupTrackingAgent({name: 'survivor', delay: 5}, closed),
      ],
    });

    await expect(collect(parallel, makeContext(parallel))).rejects.toThrow(
      'simulated sub-agent failure',
    );

    expect(closed).toEqual(new Set(['survivor']));
  });

  it('closes every branch when the consumer stops reading', async () => {
    const closed = new Set<string>();
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [
        new CleanupTrackingAgent({name: 'first'}, closed),
        new CleanupTrackingAgent({name: 'second'}, closed),
      ],
    });

    for await (const _ of parallel.runAsync(makeContext(parallel))) {
      break;
    }

    expect(closed).toEqual(new Set(['first', 'second']));
  });

  it('logs, rather than throws, when a branch fails to close', async () => {
    /** Fails during its own cleanup. */
    class BadCleanupAgent extends TestingAgent {
      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        try {
          for (;;) {
            yield this.event(context);
          }
        } finally {
          await failingCleanup();
        }
      }
    }

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parallel = new ParallelAgent({
      name: PARALLEL,
      subAgents: [new BadCleanupAgent({name: 'bad'})],
    });

    try {
      for await (const _ of parallel.runAsync(makeContext(parallel))) {
        break;
      }
      expect(warn).toHaveBeenCalledWith(
        'Failed to close a parallel sub-agent run:',
        expect.objectContaining({message: 'cleanup failed'}),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ParallelAgent deprecation', () => {
  it('warns that a Workflow cannot yet be an LlmAgent sub-agent', () => {
    resetDeprecationWarnings();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      new ParallelAgent({name: 'deprecated-parallel'});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sub-agent'));
    } finally {
      warn.mockRestore();
    }
  });
});
