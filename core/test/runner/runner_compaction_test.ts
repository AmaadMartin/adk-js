/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseEventsSummarizer,
  createEvent,
  createEventsCompactionConfig,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'compaction_app';
const USER_ID = 'u1';
const SESSION_ID = 's1';

class EchoAgent extends LlmAgent {
  constructor() {
    super({name: 'echo_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'answer'}]},
    });
  }
}

class StubSummarizer implements BaseEventsSummarizer {
  calls = 0;

  async maybeSummarizeEvents(events: Event[]): Promise<Event | undefined> {
    this.calls++;
    return createEvent({
      invocationId: 'compaction-inv',
      author: 'user',
      actions: {
        compaction: {
          startTimestamp: events[0].timestamp,
          endTimestamp: events[events.length - 1].timestamp,
          compactedContent: {role: 'model', parts: [{text: 'summary'}]},
        },
      },
    });
  }
}

class ThrowingSummarizer implements BaseEventsSummarizer {
  async maybeSummarizeEvents(_events: Event[]): Promise<Event | undefined> {
    throw new Error('summarizer exploded');
  }
}

function buildRunner(summarizer?: BaseEventsSummarizer): {
  runner: Runner;
  sessionService: InMemorySessionService;
} {
  const sessionService = new InMemorySessionService();
  const app = new App({
    name: APP_NAME,
    rootAgent: new EchoAgent(),
    eventsCompactionConfig: summarizer
      ? createEventsCompactionConfig({
          summarizer,
          compactionInterval: 1,
          overlapSize: 0,
        })
      : undefined,
  });
  return {runner: new Runner({app, sessionService}), sessionService};
}

async function runTurn(runner: Runner, text: string): Promise<Event[]> {
  const produced: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    produced.push(event);
  }
  return produced;
}

async function readSession(
  sessionService: InMemorySessionService,
): Promise<Session> {
  const session = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  if (!session) {
    expect.fail('session was not found after the run');
  }
  return session;
}

function compactionEvents(session: Session): Event[] {
  return session.events.filter((event) => event.actions?.compaction);
}

describe('Runner post-invocation compaction', () => {
  it('appends exactly one compaction event after the run drains', async () => {
    const summarizer = new StubSummarizer();
    const {runner, sessionService} = buildRunner(summarizer);
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    await runTurn(runner, 'hello');

    expect(summarizer.calls).toBe(1);
    expect(compactionEvents(await readSession(sessionService))).toHaveLength(1);
  });

  it('does not yield the compaction event to the caller', async () => {
    const {runner, sessionService} = buildRunner(new StubSummarizer());
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const produced = await runTurn(runner, 'hello');

    expect(produced.some((event) => event.actions?.compaction)).toBe(false);
  });

  it('appends nothing when the app declares no compaction config', async () => {
    const {runner, sessionService} = buildRunner();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    await runTurn(runner, 'hello');

    expect(runner.eventsCompactionConfig).toBeUndefined();
    expect(compactionEvents(await readSession(sessionService))).toEqual([]);
  });

  it('keeps the invocation successful when the summarizer throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const {runner, sessionService} = buildRunner(new ThrowingSummarizer());
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const produced = await runTurn(runner, 'hello');

    expect(produced).toHaveLength(1);
    expect(compactionEvents(await readSession(sessionService))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Post-invocation event compaction failed.',
      expect.objectContaining({message: 'summarizer exploded'}),
    );
    warn.mockRestore();
  });
});
