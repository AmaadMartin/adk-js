/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnchoredContextCompactor,
  BaseSummarizer,
  CONTENT_REQUEST_PROCESSOR,
  CompactedEvent,
  ContextCompactorRequestProcessor,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Session,
  createEvent,
  createSession,
  isScratchpadEvent,
} from '@google/adk';
import {assert, describe, expect, it} from 'vitest';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';

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

/** Builds a raw event the content processor keeps: it carries a role and text. */
function createRawEvent(id: string, timestamp: number, text: string): Event {
  return createEvent({
    id,
    author: 'user',
    timestamp,
    usageMetadata: {promptTokenCount: 5},
    content: {role: 'user', parts: [{text}]},
  });
}

function createScratchpad(
  id: string,
  timestamp: number,
  endTime: number,
  compactedContent: string,
): CompactedEvent {
  return {
    ...createEvent({
      id,
      author: 'system',
      timestamp,
      usageMetadata: {promptTokenCount: 5},
      content: {role: 'model', parts: [{text: compactedContent}]},
    }),
    isCompacted: true,
    isScratchpad: true,
    startTime: 0,
    endTime,
    compactedContent,
  };
}

function createInvocationContext(session: Session): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
}

function createMockInvocationContext(events: Event[]): InvocationContext {
  return createInvocationContext(
    createSession({
      id: 'test-session',
      appName: APP_NAME,
      userId: USER_ID,
      events,
    }),
  );
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

    // Should compact '1' and '2' (index 0 and 1) into the scratchpad, which is
    // appended: [1, 2, 3, 4, scratchpad]. '3' and '4' stay active because they
    // are newer than the scratchpad's endTime.
    expect(context.session.events.map((e) => e.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      'mock-id',
    ]);
    const scratchpad = context.session.events[4];
    assert(isScratchpadEvent(scratchpad), 'the last event is the scratchpad');
    expect(scratchpad.compactedContent).toBe('Mock summary of 2 events');
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

    // Should merge the scratchpad, '1' and '2' (3 events in total) into a new
    // scratchpad, which is appended. The superseded scratchpad stays in the
    // array: [scratchpad, 1, 2, 3, 4, new_scratchpad].
    expect(context.session.events.map((e) => e.id)).toEqual([
      'scratchpad',
      '1',
      '2',
      '3',
      '4',
      'mock-id',
    ]);
    const newScratchpad = context.session.events[5];
    assert(
      isScratchpadEvent(newScratchpad),
      'the last event is the new scratchpad',
    );
    expect(newScratchpad.compactedContent).toBe('Mock summary of 3 events');
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

    // Only '1' is summarized, so '2' (the call) stays out of the scratchpad.
    expect(context.session.events.map((e) => e.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      'mock-id',
    ]);
    const scratchpad = context.session.events[4];
    assert(isScratchpadEvent(scratchpad), 'the last event is the scratchpad');
    expect(scratchpad.compactedContent).toBe('Mock summary of 1 events');
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

  it('should keep every event it was given and append the scratchpad', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    const events = [
      createRawEvent('1', 1001, 'Message 1'),
      createRawEvent('2', 1002, 'Message 2'),
      createRawEvent('3', 1003, 'Message 3'),
      createRawEvent('4', 1004, 'Message 4'),
    ];
    const context = createMockInvocationContext([...events]);

    await compactor.compact(context);

    expect(context.session.events).toHaveLength(5);
    expect(context.session.events.slice(0, 4)).toEqual(events);
    const scratchpad = context.session.events[4];
    assert(isScratchpadEvent(scratchpad), 'the last event is the scratchpad');
    expect(scratchpad.author).toBe('system');
    expect(scratchpad.compactedContent).toBe('Mock summary of 2 events');
    // The retained raw events are back within the retention size, so the same
    // context does not compact again.
    expect(await compactor.shouldCompact(context)).toBe(false);
  });

  it('should leave the stored session and the invocation session identical', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });
    const sessionService = new InMemorySessionService();
    const created = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    for (let i = 1; i <= 4; i++) {
      await sessionService.appendEvent({
        session: created,
        event: createRawEvent(String(i), 1000 + i, `Message ${i}`),
      });
    }

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: created.id,
    });
    assert(session, 'the session service returns the session it created');
    const context = createInvocationContext(session);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const processor = new ContextCompactorRequestProcessor([compactor]);
    for await (const event of processor.runAsync(context, llmRequest)) {
      // The runner persists every event a request processor yields.
      await sessionService.appendEvent({session, event});
    }

    const stored = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: created.id,
    });
    assert(stored, 'the session service still holds the session');
    expect(stored.events.map((e) => e.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      'mock-id',
    ]);
    expect(stored.events.map((e) => e.id)).toEqual(
      context.session.events.map((e) => e.id),
    );
  });

  it('should compact a reloaded session whose scratchpad is at the tail', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    // The layout a session service produces: the scratchpad follows the events
    // it summarizes, and newer raw events follow the scratchpad.
    const events = [
      createRawEvent('1', 1001, 'Message 1'),
      createRawEvent('2', 1002, 'Message 2'),
      createRawEvent('3', 1003, 'Message 3'),
      createRawEvent('4', 1004, 'Message 4'),
      createScratchpad('sp', 1005, 1002, 'Summary of 1 and 2'),
      createRawEvent('5', 1006, 'Message 5'),
      createRawEvent('6', 1007, 'Message 6'),
    ];
    const context = createMockInvocationContext([...events]);

    expect(await compactor.shouldCompact(context)).toBe(true);
    await compactor.compact(context);

    expect(context.session.events).toHaveLength(8);
    expect(context.session.events.slice(0, 7)).toEqual(events);
    const scratchpad = context.session.events[7];
    assert(isScratchpadEvent(scratchpad), 'the last event is the scratchpad');
    // The previous scratchpad plus the two raw events it does not cover yet.
    expect(scratchpad.compactedContent).toBe('Mock summary of 3 events');
  });

  it('should send the model the scratchpad and the retained events only', async () => {
    const compactor = new AnchoredContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });
    const context = createMockInvocationContext([
      createRawEvent('1', 1001, 'Message 1'),
      createRawEvent('2', 1002, 'Message 2'),
      createRawEvent('3', 1003, 'Message 3'),
      createRawEvent('4', 1004, 'Message 4'),
    ]);

    await compactor.compact(context);

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      context,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.contents).toHaveLength(3);
    expect(llmRequest.contents[0].parts?.[0]?.text).toContain(
      'Mock summary of 2 events',
    );
    expect(llmRequest.contents[1].parts?.[0]?.text).toBe('Message 3');
    expect(llmRequest.contents[2].parts?.[0]?.text).toBe('Message 4');
  });
});
