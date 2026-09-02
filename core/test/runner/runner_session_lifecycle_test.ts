/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemoryRunner,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  SessionNotFoundError,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'weather_bot';
const USER_ID = 'lifecycle_user';
const MESSAGE = {role: 'user', parts: [{text: 'hello'}]};

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
      content: {role: 'model', parts: [{text: 'echo'}]},
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

describe('Runner session lifecycle', () => {
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
  });

  it('raises SessionNotFoundError when the session is missing', async () => {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new EchoAgent(),
      sessionService,
    });

    await expect(
      drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: 'nope',
          newMessage: MESSAGE,
        }),
      ),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('leaves the message out of the not-found error when names align', async () => {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new EchoAgent(),
      sessionService,
    });

    await expect(
      drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: 'nope',
          newMessage: MESSAGE,
        }),
      ),
    ).rejects.toThrow('Session not found: nope');
  });

  it('creates the missing session when autoCreateSession is set', async () => {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new EchoAgent(),
      sessionService,
      autoCreateSession: true,
    });

    const events = await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: 'fresh',
        newMessage: MESSAGE,
      }),
    );

    expect(events.map((e) => e.author)).toEqual(['echo_agent']);
    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'fresh',
    });
    expect(session?.id).toBe('fresh');
  });

  it('explains a mismatched app name in the not-found message', async () => {
    const agent = new EchoAgent();
    agent.adkOrigin = {
      appName: 'weather_agent',
      path: '/workspace/agents/weather_agent',
    };
    const runner = new Runner({appName: APP_NAME, agent, sessionService});

    await expect(
      drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: 'nope',
          newMessage: MESSAGE,
        }),
      ),
    ).rejects.toThrow(
      'Session not found: nope. The runner is configured with app name ' +
        '"weather_bot", but the root agent was loaded from ' +
        '"/workspace/agents/weather_agent", which implies app name ' +
        '"weather_agent". Ensure the runner appName matches that directory ' +
        'or pass appName explicitly when constructing the runner. The ' +
        'mismatch prevents the runner from locating the session. To ' +
        'automatically create a session when missing, set ' +
        'autoCreateSession=true when constructing the runner.',
    );
  });

  it('warns once at construction about a mismatched app name', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new EchoAgent();
    agent.adkOrigin = {
      appName: 'weather_agent',
      path: '/workspace/agents/weather_agent',
    };

    new Runner({appName: APP_NAME, agent, sessionService});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      'App name mismatch detected. The runner is configured with app name ' +
        '"weather_bot", but the root agent was loaded from ' +
        '"/workspace/agents/weather_agent", which implies app name ' +
        '"weather_agent".',
    );
    warn.mockRestore();
  });

  it('does not warn when the recorded origin agrees', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new EchoAgent();
    agent.adkOrigin = {appName: APP_NAME, path: `/workspace/${APP_NAME}`};

    new Runner({appName: APP_NAME, agent, sessionService});

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the appName diagnostic when the runner has no app name', async () => {
    const runner = new Runner({
      appName: '',
      agent: new EchoAgent(),
      sessionService,
      autoCreateSession: true,
    });

    await expect(
      drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: 'nope',
          newMessage: MESSAGE,
        }),
      ),
    ).rejects.toThrow(
      'Session lookup failed: appName must be provided in runner constructor ' +
        '(or via app.name)',
    );
  });

  it('lets InMemoryRunner forward autoCreateSession', async () => {
    const runner = new InMemoryRunner({
      agent: new EchoAgent(),
      autoCreateSession: true,
    });

    const events = await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: 'fresh',
        newMessage: MESSAGE,
      }),
    );

    expect(events.map((e) => e.author)).toEqual(['echo_agent']);
  });

  it('leaves InMemoryRunner raising by default', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    await expect(
      drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: 'nope',
          newMessage: MESSAGE,
        }),
      ),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
