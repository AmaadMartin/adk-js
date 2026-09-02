/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  Runner,
  SessionNotFoundError,
} from '@google/adk';
import {Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const APP_NAME = 'resolution_test_app';
const USER_ID = 'test_user';
const MISSING_SESSION_ID = 'no_such_session';
const MESSAGE: Content = {role: 'user', parts: [{text: 'hello'}]};

/** An agent that yields one event, so a run can complete without a model. */
class EchoAgent extends BaseAgent {
  constructor() {
    super({name: 'echo'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'echo'}]},
    });
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'live echo'}]},
    });
  }
}

async function drain(
  events: AsyncGenerator<Event, void, undefined>,
): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('Runner session resolution', () => {
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
  });

  function createRunner(autoCreateSession?: boolean, appName = APP_NAME) {
    return new Runner({
      appName,
      agent: new EchoAgent(),
      sessionService,
      autoCreateSession,
    });
  }

  it('reports a missing session as a SessionNotFoundError by default', async () => {
    const runner = createRunner();

    const error = await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        newMessage: MESSAGE,
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SessionNotFoundError);
    expect((error as Error).message).toBe(
      `Session not found: ${MISSING_SESSION_ID}`,
    );
  });

  it('creates the missing session when autoCreateSession is set', async () => {
    const runner = createRunner(true);

    const events = await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        newMessage: MESSAGE,
      }),
    );

    expect(events.map((e) => e.author)).toContain('echo');
    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: MISSING_SESSION_ID,
    });
    expect(session?.id).toBe(MISSING_SESSION_ID);
  });

  it('reports a missing live session as a SessionNotFoundError by default', async () => {
    const runner = createRunner();
    const queue = new LiveRequestQueue();
    queue.close();

    const error = await drain(
      runner.runLive({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        liveRequestQueue: queue,
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SessionNotFoundError);
    const created = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: MISSING_SESSION_ID,
    });
    expect(created).toBeUndefined();
  });

  it('creates the missing live session when autoCreateSession is set', async () => {
    const runner = createRunner(true);
    const queue = new LiveRequestQueue();
    queue.close();

    await drain(
      runner.runLive({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        liveRequestQueue: queue,
      }),
    );

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: MISSING_SESSION_ID,
    });
    expect(session?.id).toBe(MISSING_SESSION_ID);
  });

  it.each([true, false])(
    'reuses an existing session without creating one (autoCreateSession: %s)',
    async (autoCreateSession) => {
      const existing = await sessionService.createSession({
        appName: APP_NAME,
        userId: USER_ID,
      });
      const createSpy = vi.spyOn(sessionService, 'createSession');
      const runner = createRunner(autoCreateSession);

      const events = await drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: existing.id,
          newMessage: MESSAGE,
        }),
      );

      expect(events.map((e) => e.author)).toContain('echo');
      expect(createSpy).not.toHaveBeenCalled();
    },
  );

  it('reports the missing appName rather than creating a session', async () => {
    const createSpy = vi.spyOn(sessionService, 'createSession');
    const runner = new Runner({
      agent: new LlmAgent({name: 'root', model: 'gemini-2.5-flash'}),
      sessionService,
      autoCreateSession: true,
    });

    await expect(
      drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: MISSING_SESSION_ID,
          newMessage: MESSAGE,
        }),
      ),
    ).rejects.toThrow('appName must be provided in runner constructor');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('defaults autoCreateSession to false', () => {
    expect(createRunner().autoCreateSession).toBe(false);
    expect(createRunner(true).autoCreateSession).toBe(true);
  });

  it('yields nothing for an already-aborted run rather than reporting the session', async () => {
    const runner = createRunner();

    const events = await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        newMessage: MESSAGE,
        abortSignal: AbortSignal.abort(),
      }),
    );

    expect(events).toEqual([]);
  });

  it('stops when the run is aborted while the session loads', async () => {
    const existing = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    const controller = new AbortController();
    const load = sessionService.getSession.bind(sessionService);
    vi.spyOn(sessionService, 'getSession').mockImplementation(async (req) => {
      controller.abort();
      return load(req);
    });
    const runner = createRunner();

    const events = await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: existing.id,
        newMessage: MESSAGE,
        abortSignal: controller.signal,
      }),
    );

    expect(events).toEqual([]);
    const reloaded = await load({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: existing.id,
    });
    expect(reloaded?.events).toEqual([]);
  });

  it('creates no session for an already-aborted run', async () => {
    const createSpy = vi.spyOn(sessionService, 'createSession');
    const runner = createRunner(true);

    await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        newMessage: MESSAGE,
        abortSignal: AbortSignal.abort(),
      }),
    );

    expect(createSpy).not.toHaveBeenCalled();
  });

  it('creates no live session for an already-aborted run', async () => {
    const createSpy = vi.spyOn(sessionService, 'createSession');
    const runner = createRunner(true);
    const queue = new LiveRequestQueue();
    queue.close();

    const events = await drain(
      runner.runLive({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        liveRequestQueue: queue,
        abortSignal: AbortSignal.abort(),
      }),
    );

    expect(events).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
