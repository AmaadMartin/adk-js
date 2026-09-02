/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentOrigin,
  BaseAgent,
  createEvent,
  Event,
  getAgentOrigin,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  setAgentOrigin,
} from '@google/adk';
import {Content} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'configured_app';
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

  protected override async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/**
 * Builds a runner whose root agent origin is supplied rather than read from a
 * loader, mirroring how `adk-python`'s test drives the same warning.
 *
 * The override closes over `origin` rather than reading an instance field,
 * because the base constructor calls it before a subclass field is assigned.
 */
function createRunnerWithOrigin(
  origin: AgentOrigin,
  sessionService: InMemorySessionService,
): Runner {
  class OriginRunner extends Runner {
    protected override inferAgentOrigin(): AgentOrigin {
      return origin;
    }
  }
  return new OriginRunner({
    appName: APP_NAME,
    agent: new EchoAgent(),
    sessionService,
  });
}

async function runToError(runner: Runner): Promise<unknown> {
  try {
    for await (const _ of runner.runAsync({
      userId: USER_ID,
      sessionId: MISSING_SESSION_ID,
      newMessage: MESSAGE,
    })) {
      // Drain the stream so the session lookup runs.
    }
  } catch (e: unknown) {
    return e;
  }
  return expect.fail('the run must reject with a missing session');
}

describe('Runner app name alignment', () => {
  let sessionService: InMemorySessionService;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('explains a mismatched app name in the session-not-found message', async () => {
    const runner = createRunnerWithOrigin(
      {appName: 'loaded_app', dir: '/agents/loaded_app'},
      sessionService,
    );

    const message = ((await runToError(runner)) as Error).message;

    expect(message).toBe(
      `Session not found: ${MISSING_SESSION_ID}. The runner is configured ` +
        `with app name "${APP_NAME}", but the root agent was loaded from ` +
        `"/agents/loaded_app", which implies app name "loaded_app". Ensure ` +
        `the runner appName matches that directory or pass appName ` +
        `explicitly when constructing the runner. The mismatch prevents the ` +
        `runner from locating the session. To automatically create a session ` +
        `when missing, set autoCreateSession: true when constructing the ` +
        `runner.`,
    );
  });

  it('names the origin app name when no directory was recorded', async () => {
    const runner = createRunnerWithOrigin(
      {appName: 'loaded_app'},
      sessionService,
    );

    const message = ((await runToError(runner)) as Error).message;

    expect(message).toContain('was loaded from "loaded_app"');
  });

  it('warns once at construction when the app names disagree', () => {
    createRunnerWithOrigin({appName: 'loaded_app'}, sessionService);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      `The runner is configured with app name "${APP_NAME}"`,
    );
  });

  it('stays silent when the origin app name matches', async () => {
    const runner = createRunnerWithOrigin({appName: APP_NAME}, sessionService);

    expect(warn).not.toHaveBeenCalled();
    expect(((await runToError(runner)) as Error).message).toBe(
      `Session not found: ${MISSING_SESSION_ID}`,
    );
  });

  it('stays silent for an agent no loader stamped', async () => {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new EchoAgent(),
      sessionService,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(((await runToError(runner)) as Error).message).toBe(
      `Session not found: ${MISSING_SESSION_ID}`,
    );
  });

  it('stays silent for a built-in agent whose origin starts with __', async () => {
    const runner = createRunnerWithOrigin(
      {appName: '__builtin'},
      sessionService,
    );

    expect(warn).not.toHaveBeenCalled();
    expect(((await runToError(runner)) as Error).message).toBe(
      `Session not found: ${MISSING_SESSION_ID}`,
    );
  });

  it('stays silent when the runner was given no app name', () => {
    new Runner({
      agent: new LlmAgent({name: 'root', model: 'gemini-2.5-flash'}),
      sessionService,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('reads back the origin a loader recorded', () => {
    const agent = new EchoAgent();
    const origin = {appName: 'stamped_app', dir: '/agents/stamped_app'};

    setAgentOrigin(agent, origin);

    expect(getAgentOrigin(agent)).toEqual(origin);
  });

  it('reports no origin for an unstamped agent', () => {
    expect(getAgentOrigin(new EchoAgent())).toBeUndefined();
  });

  it('picks up an origin a loader stamped on the root agent', async () => {
    const agent = new EchoAgent();
    setAgentOrigin(agent, {appName: 'loaded_app', dir: '/agents/loaded_app'});
    const runner = new Runner({appName: APP_NAME, agent, sessionService});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(((await runToError(runner)) as Error).message).toContain(
      'which implies app name "loaded_app"',
    );
  });
});
