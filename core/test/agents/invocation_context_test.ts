/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseAgent,
  BaseAgentConfig,
  Event,
  InvocationContext,
  LoopAgent,
  PluginManager,
  QueuedInvocationEvent,
  Session,
  createEvent,
  drainInvocationEvents,
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

function makeContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-queue',
    agent: new LoopAgent({name: 'root'}),
    session: makeSession(),
    pluginManager: new PluginManager(),
  });
}

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
