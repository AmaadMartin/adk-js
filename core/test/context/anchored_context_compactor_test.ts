/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnchoredContextCompactor,
  BaseAgent,
  BaseSummarizer,
  CompactedEvent,
  Event,
  InvocationContext,
  PluginManager,
  Session,
  createEvent,
  isScratchpadEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {getActiveEvents} from '../../src/context/compaction_utils.js';

/**
 * Builds an event with an explicit timestamp, so a test can place two events
 * in the same millisecond. `createMockEvent` stamps `Date.now()`.
 */
function createTimestampedEvent(
  id: string,
  timestamp: number,
  tokenCount: number,
): Event {
  return createEvent({
    id,
    author: 'user',
    timestamp,
    usageMetadata: {promptTokenCount: tokenCount},
    content: {role: 'user', parts: [{text: id}]},
  });
}

class MockSummarizer implements BaseSummarizer {
  async summarize(events: Event[]): Promise<CompactedEvent> {
    return {
      id: 'mock-id',
      invocationId: '',
      author: 'system',
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
      timestamp: Date.now(),
      isCompacted: true,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent: `Mock summary of ${events.length} events`,
      content: {
        role: 'model',
        parts: [{text: `Mock summary of ${events.length} events`}],
      },
    };
  }
}

class FailingSummarizer implements BaseSummarizer {
  async summarize(): Promise<CompactedEvent> {
    throw new Error('Summarization failed');
  }
}

function createMockEvent(
  id: string,
  tokenCount?: number,
  isFuncCall?: boolean,
  isFuncResp?: boolean,
): Event {
  const event: Event = {
    id,
    timestamp: Date.now(),
    content: {parts: []},
  } as unknown as Event;
  if (tokenCount !== undefined) {
    event.usageMetadata = {promptTokenCount: tokenCount};
  }
  if (isFuncCall) {
    event.content!.parts!.push({functionCall: {name: 'mock', args: {}}});
  }
  if (isFuncResp) {
    event.content!.parts!.push({
      functionResponse: {name: 'mock', response: {}},
    });
  }
  return event;
}

function createMockScratchpadEvent(
  id: string,
  tokenCount?: number,
  contentStr?: string,
): CompactedEvent {
  return {
    ...createMockEvent(id, tokenCount),
    isCompacted: true,
    isScratchpad: true,
    author: 'system',
    startTime: Date.now() - 10000,
    endTime: Date.now() - 5000,
    compactedContent: contentStr || 'Existing scratchpad content',
  };
}

function createMockInvocationContext(events: Event[]): InvocationContext {
  const session = {
    id: 'test-session',
    events,
    appName: 'test-app',
    userId: 'test-user',
  } as unknown as Session;
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: {} as BaseAgent,
    session,
    pluginManager: new PluginManager([]),
  });
}

describe('AnchoredContextCompactor', () => {
  it('should not compact if event count is within retention size', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 3,
      summarizer: new MockSummarizer(),
    });

    const context = createMockInvocationContext([
      createMockEvent('1', 5),
      createMockEvent('2', 5),
      createMockEvent('3', 5),
    ]);

    expect(await compactor.shouldCompact(context)).toBe(false);

    await compactor.compact(context);
    expect(context.session.events.length).toBe(3);
  });

  it('should not compact if event count including scratchpad is within retention size plus scratchpad', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    const context = createMockInvocationContext([
      createMockScratchpadEvent('scratchpad', 5),
      createMockEvent('1', 5),
      createMockEvent('2', 5),
    ]);

    // Raw events count = 2 <= retention size 2. So should not compact.
    expect(await compactor.shouldCompact(context)).toBe(false);

    await compactor.compact(context);
    expect(context.session.events.length).toBe(3);
  });

  it('should compact if token threshold exceeded (first compaction - no scratchpad)', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    // Total tokens: 5 * 4 = 20 > 10. Raw events: 4 > 2.
    const context = createMockInvocationContext([
      createMockEvent('1', 5),
      createMockEvent('2', 5),
      createMockEvent('3', 5),
      createMockEvent('4', 5),
    ]);

    expect(await compactor.shouldCompact(context)).toBe(true);

    await compactor.compact(context);

    // Should compact '1' and '2' (index 0 and 1) into scratchpad.
    // Kept events should be '3' and '4' (index 2 and 3).
    // Result events array should be [scratchpad, '3', '4'].
    expect(context.session.events.length).toBe(3);
    const firstEvent = context.session.events[0];
    expect(isScratchpadEvent(firstEvent)).toBe(true);
    expect((firstEvent as CompactedEvent).compactedContent).toBe(
      'Mock summary of 2 events',
    );
    expect(context.session.events[1].id).toBe('3');
    expect(context.session.events[2].id).toBe('4');
  });

  it('should compact if token threshold exceeded (subsequent compaction - merges into existing scratchpad)', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    // We have a scratchpad, and 4 raw events.
    // Total raw events = 4 > retention size 2.
    // Total tokens = 5 (scratchpad) + 5 * 4 (raw) = 25 > 10.
    const context = createMockInvocationContext([
      createMockScratchpadEvent('scratchpad', 5, 'existing summary'),
      createMockEvent('1', 5),
      createMockEvent('2', 5),
      createMockEvent('3', 5),
      createMockEvent('4', 5),
    ]);

    expect(await compactor.shouldCompact(context)).toBe(true);

    await compactor.compact(context);

    // Should merge scratchpad, '1', and '2' (3 events in total) into a new scratchpad.
    // Kept events should be '3' and '4'.
    // Result events array: [new_scratchpad, '3', '4'].
    expect(context.session.events.length).toBe(3);
    const firstEvent = context.session.events[0];
    expect(isScratchpadEvent(firstEvent)).toBe(true);
    expect((firstEvent as CompactedEvent).compactedContent).toBe(
      'Mock summary of 3 events',
    );
    expect(context.session.events[1].id).toBe('3');
    expect(context.session.events[2].id).toBe('4');
  });

  it('should not split tool call and responses', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    // 4 raw events. Retention = 2 implies events[2] ('3') and events[3] ('4') retained.
    // But '3' is a response and '2' is a call. They must not be split.
    // So retention start index drops to 1, meaning we retain '2', '3', '4'.
    // Compaction should only compress event '1' (index 0).
    const context = createMockInvocationContext([
      createMockEvent('1', 5),
      createMockEvent('2', 5, true, false), // call
      createMockEvent('3', 5, false, true), // response
      createMockEvent('4', 5),
    ]);

    await compactor.compact(context);

    expect(context.session.events.length).toBe(4); // scratchpad, '2', '3', '4'
    expect(isScratchpadEvent(context.session.events[0])).toBe(true);
    expect((context.session.events[0] as CompactedEvent).compactedContent).toBe(
      'Mock summary of 1 events',
    );
    expect(context.session.events[1].id).toBe('2');
    expect(context.session.events[2].id).toBe('3');
    expect(context.session.events[3].id).toBe('4');
  });

  it('should not mutate history if summarizer fails', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new FailingSummarizer(),
    });

    const context = createMockInvocationContext([
      createMockEvent('1', 5),
      createMockEvent('2', 5),
      createMockEvent('3', 5),
      createMockEvent('4', 5),
    ]);

    await expect(compactor.compact(context)).rejects.toThrow(
      'Summarization failed',
    );

    // History should remain exactly as before.
    expect(context.session.events.length).toBe(4);
    expect(context.session.events[0].id).toBe('1');
    expect(context.session.events[1].id).toBe('2');
    expect(context.session.events[2].id).toBe('3');
    expect(context.session.events[3].id).toBe('4');
  });

  it('records the first retained event so the shared getActiveEvents keeps a same-millisecond event', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    // '2' and '3' share a millisecond across the compaction boundary.
    const context = createMockInvocationContext([
      createTimestampedEvent('1', 1000, 5),
      createTimestampedEvent('2', 2000, 5),
      createTimestampedEvent('3', 2000, 5),
      createTimestampedEvent('4', 3000, 5),
    ]);

    await compactor.compact(context);

    const scratchpad = context.session.events[0] as CompactedEvent;
    expect(isScratchpadEvent(scratchpad)).toBe(true);
    expect(scratchpad.retainFromEventId).toBe('3');
    expect(context.session.events.map((e) => e.id)).toEqual([
      scratchpad.id,
      '3',
      '4',
    ]);
    expect(getActiveEvents(context.session.events).map((e) => e.id)).toEqual([
      scratchpad.id,
      '3',
      '4',
    ]);
  });

  it('merges a same-millisecond retained event on a second compaction instead of discarding it', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    const context = createMockInvocationContext([
      createTimestampedEvent('1', 1000, 5),
      createTimestampedEvent('2', 2000, 5),
      createTimestampedEvent('3', 2000, 5),
      createTimestampedEvent('4', 3000, 5),
    ]);

    await compactor.compact(context);
    context.session.events.push(
      createTimestampedEvent('5', 4000, 5),
      createTimestampedEvent('6', 5000, 5),
    );
    await compactor.compact(context);

    // The second round sees the scratchpad plus '3' and '4', so the summary
    // covers 3 events. A timestamp boundary would drop '3' and summarize 2.
    const scratchpad = context.session.events[0] as CompactedEvent;
    expect(scratchpad.compactedContent).toBe('Mock summary of 3 events');
    expect(context.session.events.map((e) => e.id)).toEqual([
      scratchpad.id,
      '5',
      '6',
    ]);
  });
});
