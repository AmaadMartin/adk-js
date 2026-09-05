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
  RealtimeCacheEntry,
  Session,
  Task,
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

function makeContext(
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
    const context = makeContext({
      runConfig: {customMetadata: {testKey: 'testValue'}},
    });

    expect(context.customMetadata).toEqual({testKey: 'testValue'});
  });

  it('defaults to an empty object when there is no runConfig', () => {
    expect(makeContext().customMetadata).toEqual({});
  });

  it('defaults to an empty object when the runConfig omits it', () => {
    const context = makeContext({runConfig: {maxLlmCalls: 3}});

    expect(context.customMetadata).toEqual({});
  });

  it('copies rather than aliases the runConfig record', () => {
    const runConfig = {customMetadata: {tenant: 'acme'}};
    const context = makeContext({runConfig});

    context.customMetadata['addedLater'] = 1;

    expect(context.customMetadata).not.toBe(runConfig.customMetadata);
    expect(runConfig.customMetadata).toEqual({tenant: 'acme'});
  });

  it('shares one record with its clones', () => {
    const context = makeContext({
      runConfig: {customMetadata: {tenant: 'acme'}},
    });
    const clone = context.clone();

    clone.customMetadata['writtenByClone'] = true;

    expect(clone.customMetadata).toBe(context.customMetadata);
    expect(context.customMetadata['writtenByClone']).toBe(true);
  });

  it('keeps the original record when a clone overrides the runConfig', () => {
    const context = makeContext({
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
    const context = makeContext({
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
    const context = makeContext();

    expect(context.inputRealtimeCache).toBeUndefined();
    expect(context.outputRealtimeCache).toBeUndefined();
  });

  it('round-trips a cached entry unchanged', () => {
    const context = makeContext({inputRealtimeCache: [entry]});

    expect(context.inputRealtimeCache).toEqual([
      {
        role: 'user',
        data: {mimeType: 'audio/pcm', data: 'AAAA'},
        timestamp: 1.5,
      },
    ]);
  });

  it('carries both caches by reference through clone()', () => {
    const context = makeContext({
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
    const context = makeContext({
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
    expect(makeContext().activeNonBlockingToolTasks).toBeUndefined();
  });

  it('carries the task registry by reference through clone()', async () => {
    const task = new Task(async () => {});
    const context = makeContext({activeNonBlockingToolTasks: {}});

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
    const context = makeContext({
      activeNonBlockingToolTasks: {'myTool_call-1': task},
    });

    const clone = context.clone();
    delete clone.activeNonBlockingToolTasks!['myTool_call-1'];

    expect(context.activeNonBlockingToolTasks).toEqual({});
    await task.promise;
  });
});
