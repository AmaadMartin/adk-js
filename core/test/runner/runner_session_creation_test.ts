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
  Runner,
  SessionNotFoundError,
  stampAgentOrigin,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'billing';
const USER_ID = 'u1';
const MISSING_SESSION_ID = 'no_such_session';

class EchoAgent extends BaseAgent {
  constructor(name = 'echo_agent') {
    super({name});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ok'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function newRunner(options: {
  autoCreateSession?: boolean;
  appName?: string;
  agent?: BaseAgent;
}): Runner {
  return new Runner({
    appName: options.appName ?? APP_NAME,
    agent: options.agent ?? new EchoAgent(),
    sessionService: new InMemorySessionService(),
    autoCreateSession: options.autoCreateSession,
  });
}

async function collect(
  events: AsyncGenerator<Event, void, undefined>,
): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

const HELLO = {role: 'user', parts: [{text: 'hello'}]};

describe('Runner session creation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a missing session by default', async () => {
    const runner = newRunner({});

    await expect(
      collect(
        runner.runAsync({
          userId: USER_ID,
          sessionId: MISSING_SESSION_ID,
          newMessage: HELLO,
        }),
      ),
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('names the missing session in the error', async () => {
    const runner = newRunner({});

    await expect(
      collect(
        runner.runAsync({
          userId: USER_ID,
          sessionId: MISSING_SESSION_ID,
          newMessage: HELLO,
        }),
      ),
    ).rejects.toThrow(`Session not found: ${MISSING_SESSION_ID}`);
  });

  it('creates the missing session and runs when asked to', async () => {
    const runner = newRunner({autoCreateSession: true});

    const events = await collect(
      runner.runAsync({
        userId: USER_ID,
        sessionId: MISSING_SESSION_ID,
        newMessage: HELLO,
      }),
    );

    expect(events.map((e) => e.author)).toEqual(['echo_agent']);
    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: MISSING_SESSION_ID,
    });
    expect(session?.id).toBe(MISSING_SESSION_ID);
  });

  it('reuses a session that already exists', async () => {
    const runner = newRunner({autoCreateSession: true});
    const existing = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'existing',
    });

    await collect(
      runner.runAsync({
        userId: USER_ID,
        sessionId: 'existing',
        newMessage: HELLO,
      }),
    );

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'existing',
    });
    expect(session?.events.length).toBeGreaterThan(existing.events.length);
  });

  it('applies the same gate to runLive', async () => {
    const runner = newRunner({});
    const queue = new LiveRequestQueue();
    queue.close();

    await expect(
      collect(
        runner.runLive({
          userId: USER_ID,
          sessionId: MISSING_SESSION_ID,
          liveRequestQueue: queue,
        }),
      ),
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('still reports a runner that was given no app name', async () => {
    const runner = new Runner({
      agent: new EchoAgent(),
      sessionService: new InMemorySessionService(),
      autoCreateSession: true,
    });

    await expect(
      collect(
        runner.runAsync({
          userId: USER_ID,
          sessionId: MISSING_SESSION_ID,
          newMessage: HELLO,
        }),
      ),
    ).rejects.toThrow('Session lookup failed: appName must be provided');
  });
});

describe('Runner app name alignment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when the loader directory implies another app name', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new EchoAgent();
    stampAgentOrigin(agent, {appName: 'invoices', path: '/apps/invoices'});

    newRunner({agent});

    expect(warn).toHaveBeenCalledWith(
      'App name mismatch detected. The runner is configured with app name ' +
        `"${APP_NAME}", but the root agent was loaded from "/apps/invoices", ` +
        'which implies app name "invoices".',
    );
  });

  it('explains the mismatch when the session is not found', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new EchoAgent();
    stampAgentOrigin(agent, {appName: 'invoices', path: '/apps/invoices'});
    const runner = newRunner({agent});

    await expect(
      collect(
        runner.runAsync({
          userId: USER_ID,
          sessionId: MISSING_SESSION_ID,
          newMessage: HELLO,
        }),
      ),
    ).rejects.toThrow(
      `Session not found: ${MISSING_SESSION_ID}. The runner is configured ` +
        `with app name "${APP_NAME}", but the root agent was loaded from ` +
        '"/apps/invoices", which implies app name "invoices". Ensure the ' +
        'runner appName matches that directory or pass appName explicitly ' +
        'when constructing the runner. The mismatch prevents the runner from ' +
        'locating the session. To automatically create a session when ' +
        'missing, set `autoCreateSession: true` when constructing the runner.',
    );
  });

  it('falls back to the origin name when the loader gave no path', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new EchoAgent();
    stampAgentOrigin(agent, {appName: 'invoices'});

    newRunner({agent});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('loaded from "invoices"'),
    );
  });

  it('stays silent when the origin agrees with the app name', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new EchoAgent();
    stampAgentOrigin(agent, {appName: APP_NAME, path: '/apps/billing'});
    const runner = newRunner({agent});

    expect(warn).not.toHaveBeenCalled();
    await expect(
      collect(
        runner.runAsync({
          userId: USER_ID,
          sessionId: MISSING_SESSION_ID,
          newMessage: HELLO,
        }),
      ),
    ).rejects.toThrow(`Session not found: ${MISSING_SESSION_ID}`);
  });

  it('ignores a dunder-prefixed loader directory', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new EchoAgent();
    stampAgentOrigin(agent, {
      appName: '__pycache__',
      path: '/apps/__pycache__',
    });

    newRunner({agent});

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent for an agent no loader stamped', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    newRunner({});

    expect(warn).not.toHaveBeenCalled();
  });
});
