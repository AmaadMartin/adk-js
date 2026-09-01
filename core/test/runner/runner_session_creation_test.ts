/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  Runner,
  SessionNotFoundError,
  stampAgentOrigin,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const TEST_USER_ID = 'test_user_id';
const MISSING_SESSION_ID = 'missing_session_id';

class EchoAgent extends LlmAgent {
  constructor(name = 'echo_agent', subAgents: LlmAgent[] = []) {
    super({name, model: 'gemini-2.5-flash', subAgents});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ok'}]},
    });
  }
}

async function drain(
  runner: Runner,
  sessionId: string,
  appName?: string,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: TEST_USER_ID,
    sessionId,
    newMessage: {role: 'user', parts: [{text: `hello ${appName ?? ''}`}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('Runner session creation', () => {
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
  });

  it('reports a missing session as a SessionNotFoundError by default', async () => {
    const runner = new Runner({
      appName: 'app_missing_default',
      agent: new EchoAgent(),
      sessionService,
    });

    await expect(drain(runner, MISSING_SESSION_ID)).rejects.toThrow(
      SessionNotFoundError,
    );
    await expect(drain(runner, MISSING_SESSION_ID)).rejects.toThrow(
      `Session not found: ${MISSING_SESSION_ID}`,
    );
  });

  it('creates the missing session and runs in it when autoCreateSession is set', async () => {
    const appName = 'app_auto_create';
    const runner = new Runner({
      appName,
      agent: new EchoAgent(),
      sessionService,
      autoCreateSession: true,
    });

    const events = await drain(runner, MISSING_SESSION_ID);

    expect(events.map((e) => e.author)).toContain('echo_agent');
    const created = await sessionService.getSession({
      appName,
      userId: TEST_USER_ID,
      sessionId: MISSING_SESSION_ID,
    });
    expect(created?.id).toBe(MISSING_SESSION_ID);
  });

  it('never creates a session when one already exists', async () => {
    const appName = 'app_existing_session';
    const session = await sessionService.createSession({
      appName,
      userId: TEST_USER_ID,
      sessionId: 'existing',
    });
    const createSession = vi.spyOn(sessionService, 'createSession');
    const runner = new Runner({
      appName,
      agent: new EchoAgent(),
      sessionService,
      autoCreateSession: true,
    });

    await drain(runner, session.id);

    expect(createSession).not.toHaveBeenCalled();
    createSession.mockRestore();
  });

  it('keeps reporting a runner with no appName as a configuration error', async () => {
    const runner = new Runner({
      agent: new EchoAgent(),
      sessionService,
      autoCreateSession: true,
    });
    const createSession = vi.spyOn(sessionService, 'createSession');

    await expect(drain(runner, MISSING_SESSION_ID)).rejects.toThrow(
      'appName must be provided in runner constructor',
    );
    expect(createSession).not.toHaveBeenCalled();
    createSession.mockRestore();
  });

  it('reports a missing session from runLive too', async () => {
    const runner = new Runner({
      appName: 'app_live_missing',
      agent: new EchoAgent(),
      sessionService,
    });
    const liveRequestQueue = new LiveRequestQueue();
    liveRequestQueue.close();

    await expect(
      (async () => {
        for await (const _ of runner.runLive({
          userId: TEST_USER_ID,
          sessionId: MISSING_SESSION_ID,
          liveRequestQueue,
        })) {
          // The lookup fails before any event is produced.
        }
      })(),
    ).rejects.toThrow(SessionNotFoundError);
  });
});

describe('Runner app name alignment', () => {
  let sessionService: InMemorySessionService;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  function runnerWithOrigin(
    appName: string,
    origin: {appName?: string; path?: string},
  ): Runner {
    const agent = new EchoAgent();
    stampAgentOrigin(agent, origin);
    return new Runner({appName, agent, sessionService});
  }

  it('warns and explains the mismatch in the session-not-found message', async () => {
    const runner = runnerWithOrigin('configured_app', {
      appName: 'loaded_app',
      path: '/workspace/agents/loaded_app',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('App name mismatch detected.');

    const error = await drain(runner, MISSING_SESSION_ID).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SessionNotFoundError);
    const message = (error as Error).message;
    expect(message).toContain(`Session not found: ${MISSING_SESSION_ID}`);
    expect(message).toContain('configured_app');
    expect(message).toContain('loaded_app');
    expect(message).toContain('/workspace/agents/loaded_app');
    expect(message).toContain('Ensure the runner appName matches');
    expect(message).toContain('set autoCreateSession: true');
  });

  it('names the origin app when the loader recorded no location', () => {
    runnerWithOrigin('configured_app', {appName: 'loaded_app'});

    expect(warn.mock.calls[0][0]).toContain('loaded from "loaded_app"');
  });

  it('stays quiet when the origin app name matches', async () => {
    const runner = runnerWithOrigin('same_app', {appName: 'same_app'});

    expect(warn).not.toHaveBeenCalled();
    const error = await drain(runner, MISSING_SESSION_ID).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe(
      `Session not found: ${MISSING_SESSION_ID}`,
    );
  });

  it('stays quiet for a dunder origin app name', () => {
    runnerWithOrigin('configured_app', {appName: '__pycache__'});

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when no loader recorded an origin', () => {
    new Runner({
      appName: 'configured_app',
      agent: new EchoAgent(),
      sessionService,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Runner uncached transfer warning', () => {
  let sessionService: InMemorySessionService;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  function multiAgentRunner(appName: string): Runner {
    return new Runner({
      appName,
      agent: new EchoAgent('root_agent', [new EchoAgent('child_agent')]),
      sessionService,
    });
  }

  it('warns once for an app whose agents can transfer', () => {
    multiAgentRunner('transfer_app_one');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      'App "transfer_app_one" can transfer between agents',
    );
  });

  it('does not warn for a single agent with no transfer targets', () => {
    new Runner({
      appName: 'single_agent_app',
      agent: new EchoAgent(),
      sessionService,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns only once for two runners built on the same app name', () => {
    multiAgentRunner('transfer_app_two');
    multiAgentRunner('transfer_app_two');

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
