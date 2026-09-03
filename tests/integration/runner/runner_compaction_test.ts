/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseSummarizer,
  CompactedEvent,
  createCompactedEvent,
  createEvent,
  createEventsCompactionConfig,
  Event,
  InMemorySessionService,
  InvocationContext,
  isCompactedEvent,
  LlmAgent,
  Runner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

// getActiveEvents is internal, so it has no public entry point to import from.
import {getActiveEvents} from '../../../core/src/context/compaction_utils.js';

const APP_NAME = 'compaction_integration_app';
const USER_ID = 'u1';
const SESSION_ID = 's1';

class ReplyingAgent extends LlmAgent {
  constructor() {
    super({name: 'replier', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ack'}]},
    });
  }
}

/** Summarizes by joining the text of the window, so the result is checkable. */
class JoiningSummarizer implements BaseSummarizer {
  async summarize(events: Event[]): Promise<CompactedEvent> {
    return createCompactedEvent({
      author: 'summarizer',
      invocationId: events[events.length - 1].invocationId,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent: events
        .map((e) => e.content?.parts?.[0]?.text ?? '')
        .join(' | '),
    });
  }
}

/** Ends its turn on an unanswered call, as a long-running tool does. */
class PendingToolAgent extends LlmAgent {
  constructor() {
    super({name: 'pending', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc1', name: 'lookup', args: {}}}],
      },
    });
  }
}

describe('post-invocation compaction against a real session service', () => {
  it('appends a summary the shipped reader then honours', async () => {
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const runner = new Runner({
      app: new App({
        name: APP_NAME,
        rootAgent: new ReplyingAgent(),
        eventsCompactionConfig: createEventsCompactionConfig({
          summarizer: new JoiningSummarizer(),
          compactionInterval: 2,
          overlapSize: 0,
        }),
      }),
      sessionService,
    });

    for (const turn of ['one', 'two', 'three']) {
      for await (const _event of runner.runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: {role: 'user', parts: [{text: turn}]},
      })) {
        // Drain the turn so its events reach the session.
      }
    }

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    if (!session) {
      expect.fail(`session ${SESSION_ID} is missing`);
    }

    const summaries = session.events.filter(isCompactedEvent);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].compactedContent).toBe('one | ack | two | ack');

    // getActiveEvents is the shipped consumer: it must return the summary and
    // then only the raw events that came after it.
    const active = getActiveEvents(session.events);
    expect(active[0]).toBe(summaries[0]);
    expect(active.slice(1).map((e) => e.content?.parts?.[0]?.text)).toEqual([
      'three',
      'ack',
    ]);
  });

  it('keeps a call the turn never answered out of the summary', async () => {
    const appName = 'pending_tool_app';
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const runner = new Runner({
      app: new App({
        name: appName,
        rootAgent: new PendingToolAgent(),
        eventsCompactionConfig: createEventsCompactionConfig({
          summarizer: new JoiningSummarizer(),
          compactionInterval: 2,
          overlapSize: 0,
        }),
      }),
      sessionService,
    });

    for (const turn of ['one', 'two']) {
      for await (const _event of runner.runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: {role: 'user', parts: [{text: turn}]},
      })) {
        // Drain the turn so its events reach the session.
      }
    }

    const session = await sessionService.getSession({
      appName,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    if (!session) {
      expect.fail(`session ${SESSION_ID} is missing`);
    }

    expect(session.events.filter(isCompactedEvent)).toHaveLength(1);

    // The reader must still show the model the open call, or the user's reply
    // would arrive as a functionResponse with no matching call.
    const active = getActiveEvents(session.events);
    const calls = active.flatMap((e) =>
      (e.content?.parts ?? []).flatMap((part) =>
        part.functionCall?.id ? [part.functionCall.id] : [],
      ),
    );
    expect(calls).toContain('fc1');
  });
});
