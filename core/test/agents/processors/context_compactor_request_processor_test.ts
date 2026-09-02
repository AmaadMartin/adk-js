/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseContextCompactor,
  BaseLlm,
  BaseLlmConnection,
  BaseSummarizer,
  CompactedEvent,
  ContextCompactorRequestProcessor,
  Event,
  EventsCompactionConfig,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LlmSummarizer,
  PluginManager,
  createEvent,
  createEventsCompactionConfig,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {ContextCompactionTrigger} from '../../../src/plugins/base_plugin.js';

describe('ContextCompactorRequestProcessor', () => {
  it('should run compactors in order and stop after first compaction', async () => {
    const mockPluginManager = {
      runBeforeContextCompaction: vi.fn().mockResolvedValue(undefined),
      runAfterContextCompaction: vi.fn().mockResolvedValue(undefined),
    };
    const mockCtx = {
      session: {
        events: [],
      },
      pluginManager: mockPluginManager,
    } as unknown as InvocationContext;
    const mockReq = {} as LlmRequest;

    const compactor1: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };

    const compactor2: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const compactor3: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const processor = new ContextCompactorRequestProcessor([
      compactor1,
      compactor2,
      compactor3,
    ]);

    const generator = processor.runAsync(mockCtx, mockReq);
    for await (const _ of generator) {
      // iterate
    }

    expect(compactor1.shouldCompact).toHaveBeenCalledWith(mockCtx);
    expect(compactor1.compact).not.toHaveBeenCalled();

    expect(compactor2.shouldCompact).toHaveBeenCalledWith(mockCtx);
    expect(compactor2.compact).toHaveBeenCalledWith(mockCtx);

    expect(compactor3.shouldCompact).not.toHaveBeenCalled();
    expect(compactor3.compact).not.toHaveBeenCalled();

    expect(mockPluginManager.runBeforeContextCompaction).toHaveBeenCalledWith({
      invocationContext: mockCtx,
      trigger: ContextCompactionTrigger.Auto,
    });

    expect(mockPluginManager.runAfterContextCompaction).toHaveBeenCalledWith({
      invocationContext: mockCtx,
      trigger: ContextCompactionTrigger.Auto,
    });
  });
});

/** A model that is never asked for a response, only carried by the agent. */
class StubLlm extends BaseLlm {
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: 'stub'}]}};
  }

  connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('StubLlm does not connect.'));
  }
}

/** A summarizer that records one compacted event, without a model. */
class StubSummarizer implements BaseSummarizer {
  async summarize(events: Event[]): Promise<CompactedEvent> {
    return {
      ...createEvent({author: 'system', invocationId: 'inv-compaction'}),
      isCompacted: true,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent: `summary of ${events.length} events`,
    } as CompactedEvent;
  }
}

function compactableEvents(): Event[] {
  return [12, 40, 60, 80].map((promptTokenCount, index) => ({
    ...createEvent({
      author: 'user',
      invocationId: 'inv-compaction',
      content: {role: 'user', parts: [{text: `turn ${index}`}]},
    }),
    usageMetadata: {promptTokenCount},
  }));
}

function contextWith(
  eventsCompactionConfig?: EventsCompactionConfig,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-compaction',
    agent: new LlmAgent({name: 'agent', model: new StubLlm({model: 'stub'})}),
    session: createSession({
      id: 's1',
      appName: 'app',
      userId: 'u',
      events: compactableEvents(),
      lastUpdateTime: Date.now(),
    }),
    pluginManager: new PluginManager(),
    eventsCompactionConfig,
  });
}

async function runProcessor(
  processor: ContextCompactorRequestProcessor,
  context: InvocationContext,
): Promise<Event[]> {
  const emitted: Event[] = [];
  for await (const event of processor.runAsync(context, {} as LlmRequest)) {
    emitted.push(event);
  }
  return emitted;
}

describe('ContextCompactorRequestProcessor app-level compaction', () => {
  const tokenTrigger = {
    tokenThreshold: 10,
    eventRetentionSize: 2,
    summarizer: new StubSummarizer(),
  };

  it('compacts from the app config when the agent declares no compactors', async () => {
    const context = contextWith(createEventsCompactionConfig(tokenTrigger));

    const emitted = await runProcessor(
      new ContextCompactorRequestProcessor([]),
      context,
    );

    expect(emitted).toHaveLength(1);
    expect(context.tokenCompactionChecked).toBe(true);
  });

  it('does nothing with neither compactors nor an app config', async () => {
    const context = contextWith(undefined);

    const emitted = await runProcessor(
      new ContextCompactorRequestProcessor([]),
      context,
    );

    expect(emitted).toEqual([]);
    expect(context.session.events).toHaveLength(4);
  });

  it('prefers the compactors the agent declared over the app config', async () => {
    const declared: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };
    const context = contextWith(createEventsCompactionConfig(tokenTrigger));

    const emitted = await runProcessor(
      new ContextCompactorRequestProcessor([declared]),
      context,
    );

    expect(declared.shouldCompact).toHaveBeenCalledWith(context);
    expect(emitted).toEqual([]);
    expect(context.tokenCompactionChecked).toBe(false);
  });

  it('summarizes with the agent model when the config names no summarizer', async () => {
    const context = contextWith(
      createEventsCompactionConfig({
        tokenThreshold: 10,
        eventRetentionSize: 2,
      }),
    );
    const summarize = vi
      .spyOn(LlmSummarizer.prototype, 'summarize')
      .mockResolvedValue(
        await new StubSummarizer().summarize(compactableEvents()),
      );

    await runProcessor(new ContextCompactorRequestProcessor([]), context);

    expect(summarize).toHaveBeenCalled();
    summarize.mockRestore();
  });

  it('compacts nothing when the invocation carries a window-only config', async () => {
    // App construction rejects this, so it can only be set on the context.
    const context = contextWith({compactionInterval: 2, overlapSize: 1});

    const emitted = await runProcessor(
      new ContextCompactorRequestProcessor([]),
      context,
    );

    expect(emitted).toEqual([]);
    expect(context.session.events).toHaveLength(4);
  });

  it('compacts nothing when no model can summarize', async () => {
    const context = new InvocationContext({
      invocationId: 'inv-compaction',
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u',
        events: compactableEvents(),
        lastUpdateTime: Date.now(),
      }),
      pluginManager: new PluginManager(),
      eventsCompactionConfig: createEventsCompactionConfig({
        tokenThreshold: 10,
        eventRetentionSize: 2,
      }),
    });

    const emitted = await runProcessor(
      new ContextCompactorRequestProcessor([]),
      context,
    );

    expect(emitted).toEqual([]);
    expect(context.session.events).toHaveLength(4);
  });
});
