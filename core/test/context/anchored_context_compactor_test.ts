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
  createEventActions,
  isScratchpadEvent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

/** Text carried only by the invocation that gets rewound. */
const REWOUND_TEXT = 'SECRET_REWOUND_CONTENT';

class MockSummarizer implements BaseSummarizer {
  async summarize(events: Event[]): Promise<CompactedEvent> {
    return {
      id: 'mock-id',
      invocationId: '',
      author: 'system',
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: [],
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
    } as CompactedEvent;
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
  const event = createMockEvent(id, tokenCount) as CompactedEvent;
  event.isCompacted = true;
  event.isScratchpad = true;
  event.author = 'system';
  event.startTime = Date.now() - 10000;
  event.endTime = Date.now() - 5000;
  event.compactedContent = contentStr || 'Existing scratchpad content';
  return event;
}

function createInvocationEvent(
  invocationId: string,
  text: string,
  tokenCount: number,
): Event {
  return createEvent({
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
    usageMetadata: {promptTokenCount: tokenCount},
  });
}

function createRewindMarkerEvent(
  invocationId: string,
  rewindBeforeInvocationId: string,
): Event {
  return createEvent({
    invocationId,
    author: 'user',
    actions: createEventActions({rewindBeforeInvocationId}),
  });
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

  it('never summarizes a rewound invocation into the scratchpad', async () => {
    const summarizer = new MockSummarizer();
    const summarizeSpy = vi.spyOn(summarizer, 'summarize');
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 1,
      eventRetentionSize: 1,
      summarizer,
    });

    const context = createMockInvocationContext([
      createInvocationEvent('inv1', 'hello', 5),
      createInvocationEvent('inv_to_rewind', REWOUND_TEXT, 5),
      createInvocationEvent('inv_to_rewind', 'acknowledged', 5),
      createRewindMarkerEvent('rewind_inv', 'inv_to_rewind'),
      createInvocationEvent('inv3', 'next', 5),
    ]);

    await compactor.compact(context);

    expect(summarizeSpy).toHaveBeenCalledOnce();
    const summarized = summarizeSpy.mock.calls[0][0];
    expect(summarized.map((event) => event.invocationId)).toEqual(['inv1']);
  });

  it('honours a rewind marker sitting past the window it is compacting', async () => {
    const summarizer = new MockSummarizer();
    const summarizeSpy = vi.spyOn(summarizer, 'summarize');
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 1,
      eventRetentionSize: 3,
      summarizer,
    });

    // The marker sits past the compaction boundary while the invocation it
    // annuls falls inside it, so resolving rewinds over the slice alone would
    // miss the marker and summarize the rewound event.
    const marker = createRewindMarkerEvent('rewind_inv', 'inv_to_rewind');
    const context = createMockInvocationContext([
      createInvocationEvent('inv1', 'hello', 5),
      createInvocationEvent('inv1', 'hi', 5),
      createInvocationEvent('inv_to_rewind', REWOUND_TEXT, 5),
      marker,
      createInvocationEvent('inv3', 'next', 5),
      createInvocationEvent('inv4', 'and again', 5),
    ]);

    await compactor.compact(context);

    expect(summarizeSpy).toHaveBeenCalledOnce();
    const summarized = summarizeSpy.mock.calls[0][0];
    expect(
      summarized.flatMap((event) => event.content?.parts ?? []),
    ).not.toContainEqual({text: REWOUND_TEXT});
    expect(summarized.map((event) => event.invocationId)).toEqual(['inv1']);
    // The marker sits outside the compacted window, so the rebuild keeps it
    // and it goes on annulling its invocation.
    expect(context.session.events).toContain(marker);
  });

  it('does not compact when every compactable event has been rewound', async () => {
    const summarizer = new MockSummarizer();
    const summarizeSpy = vi.spyOn(summarizer, 'summarize');
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 1,
      eventRetentionSize: 1,
      summarizer,
    });

    // Everything ahead of the retained tail is rewound, so there is nothing
    // left to summarize. The summarizer must not be handed an empty list, and
    // shouldCompact has to agree or it would ask for this compaction forever.
    const context = createMockInvocationContext([
      createInvocationEvent('inv_to_rewind', REWOUND_TEXT, 5),
      createInvocationEvent('inv_to_rewind', 'acknowledged', 5),
      createRewindMarkerEvent('rewind_inv', 'inv_to_rewind'),
      createInvocationEvent('inv3', 'next', 5),
    ]);

    expect(await compactor.shouldCompact(context)).toBe(false);
    await expect(compactor.compact(context)).resolves.toBeUndefined();
    expect(summarizeSpy).not.toHaveBeenCalled();
    expect(context.session.events).toHaveLength(4);
  });
});
