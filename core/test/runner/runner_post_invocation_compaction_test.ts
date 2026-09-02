/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  BasePlugin,
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
  Session,
  StaleSessionError,
} from '@google/adk';
import {Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

const USER_ID = 'u1';
const SESSION_ID = 's1';

class EchoAgent extends LlmAgent {
  constructor(name = 'echo') {
    super({name, model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'reply'}]},
    });
  }
}

class StubSummarizer implements BaseSummarizer {
  calls = 0;

  async summarize(events: Event[]): Promise<CompactedEvent> {
    this.calls++;
    return createCompactedEvent({
      author: 'summarizer',
      invocationId: events[events.length - 1].invocationId,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent: 'summary',
    });
  }
}

/** Records what reached storage, and can fail the compaction append. */
class RecordingSessionService extends InMemorySessionService {
  readonly appended: Event[] = [];
  compactionFailure?: Error;

  override async appendEvent(params: {
    session: Session;
    event: Event;
  }): Promise<Event> {
    if (isCompactedEvent(params.event) && this.compactionFailure) {
      throw this.compactionFailure;
    }
    this.appended.push(params.event);
    return super.appendEvent(params);
  }
}

class EarlyExitPlugin extends BasePlugin {
  constructor() {
    super('early_exit');
  }

  override async beforeRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return {role: 'model', parts: [{text: 'handled by the plugin'}]};
  }
}

let summarizer: StubSummarizer;
let sessionService: RecordingSessionService;

beforeEach(() => {
  summarizer = new StubSummarizer();
  sessionService = new RecordingSessionService();
});

function buildRunner(options: {
  appName: string;
  compacting: boolean;
  rootAgent?: BaseAgent;
  plugins?: BasePlugin[];
}): Runner {
  const app = new App({
    name: options.appName,
    rootAgent: options.rootAgent ?? new EchoAgent(),
    plugins: options.plugins,
    eventsCompactionConfig: options.compacting
      ? createEventsCompactionConfig({
          summarizer,
          compactionInterval: 2,
          overlapSize: 0,
        })
      : undefined,
  });
  return new Runner({app, sessionService});
}

/** Reads the stored session back, which is a copy of what the runner wrote. */
async function readSession(appName: string): Promise<Session> {
  const session = await sessionService.getSession({
    appName,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  if (!session) {
    expect.fail(`session ${SESSION_ID} is missing`);
  }
  return session;
}

/** Seeds a session that already holds one finished invocation. */
async function seedSession(appName: string): Promise<Session> {
  const session = await sessionService.createSession({
    appName,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  await sessionService.appendEvent({
    session,
    event: createEvent({
      invocationId: 'seed_inv',
      author: 'user',
      content: {role: 'user', parts: [{text: 'earlier turn'}]},
      timestamp: 1000,
    }),
  });
  return session;
}

async function drain(runner: Runner): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text: 'hello'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('post-invocation compaction', () => {
  it('does nothing for an app that declares no policy', async () => {
    const runner = buildRunner({appName: 'plain_app', compacting: false});
    await seedSession('plain_app');

    await drain(runner);

    expect(summarizer.calls).toBe(0);
    expect(sessionService.appended.filter(isCompactedEvent)).toEqual([]);
  });

  it('appends a summary once the window is full', async () => {
    const runner = buildRunner({appName: 'compacting_app', compacting: true});
    await seedSession('compacting_app');

    await drain(runner);

    const session = await readSession('compacting_app');
    expect(summarizer.calls).toBe(1);
    expect(session.events.filter(isCompactedEvent)).toHaveLength(1);
  });

  it('appends the summary after the last agent event', async () => {
    const runner = buildRunner({appName: 'ordering_app', compacting: true});
    await seedSession('ordering_app');

    await drain(runner);

    const last = sessionService.appended[sessionService.appended.length - 1];
    expect(isCompactedEvent(last)).toBe(true);
  });

  it('compacts on the early-exit path too', async () => {
    const runner = buildRunner({
      appName: 'early_exit_app',
      compacting: true,
      plugins: [new EarlyExitPlugin()],
    });
    await seedSession('early_exit_app');

    await drain(runner);

    expect(summarizer.calls).toBe(1);
  });

  it('discards a summary that lost a write race', async () => {
    const runner = buildRunner({appName: 'racing_app', compacting: true});
    await seedSession('racing_app');
    sessionService.compactionFailure = new StaleSessionError();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const events = await drain(runner);

    const session = await readSession('racing_app');
    expect(events).toHaveLength(1);
    expect(session.events.filter(isCompactedEvent)).toEqual([]);
    expect(session.events.map((e) => e.author)).toContain('echo');
    expect(
      info.mock.calls.filter((call) =>
        String(call[0]).includes('stale post-invocation compaction'),
      ),
    ).toHaveLength(1);
  });

  it('propagates any other append failure', async () => {
    const runner = buildRunner({appName: 'failing_app', compacting: true});
    await seedSession('failing_app');
    sessionService.compactionFailure = new Error('disk on fire');

    await expect(drain(runner)).rejects.toThrow('disk on fire');
  });
});
