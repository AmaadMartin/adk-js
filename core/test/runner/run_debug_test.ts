/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, InvocationContext, RunConfig} from '@google/adk';
import {
  createEvent,
  InMemoryRunner,
  LlmAgent,
  StreamingMode,
} from '@google/adk';
import type {Part} from '@google/genai';
import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

const AGENT_NAME = 'debug_agent';
const APP_NAME = 'InMemoryRunner';
const DEFAULT_USER_ID = 'debug_user_id';
const DEFAULT_SESSION_ID = 'debug_session_id';

/**
 * An agent that echoes the incoming user message, so the caller can tell which
 * message each event belongs to.
 */
class EchoAgent extends LlmAgent {
  constructor(private readonly extraParts: Part[] = []) {
    super({name: AGENT_NAME, model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [
          ...this.extraParts,
          {text: `echo: ${context.userContent?.parts?.[0]?.text}`},
        ],
      },
    });
  }
}

/** An agent that yields no events at all. */
class SilentAgent extends LlmAgent {
  constructor() {
    super({name: AGENT_NAME, model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function textOf(event: Event): string | undefined {
  return event.content?.parts?.at(-1)?.text;
}

function loggedLines(info: MockInstance<(...args: unknown[]) => void>) {
  return info.mock.calls.map((call) => call.join(' '));
}

describe('Runner.runDebug', () => {
  let info: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the events produced for a single message', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    const events = await runner.runDebug('hello');

    expect(events.map(textOf)).toEqual(['echo: hello']);
  });

  it('returns the events of every message in order', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    const events = await runner.runDebug(['first', 'second']);

    expect(events.map(textOf)).toEqual(['echo: first', 'echo: second']);
  });

  it('returns an empty array when the agent yields nothing', async () => {
    const runner = new InMemoryRunner({agent: new SilentAgent()});

    expect(await runner.runDebug('hello')).toEqual([]);
  });

  it('logs nothing when quiet is set', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    const events = await runner.runDebug('hello', {quiet: true});

    expect(events).toHaveLength(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('logs the session, the user message and the transcript by default', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    await runner.runDebug('hello');

    expect(loggedLines(info)).toEqual([
      `Debug session: ${DEFAULT_SESSION_ID}`,
      'User > hello',
      `${AGENT_NAME} > echo: hello`,
    ]);
  });

  it('creates the default debug session', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    await runner.runDebug('hello');

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: DEFAULT_USER_ID,
      sessionId: DEFAULT_SESSION_ID,
    });
    expect(session?.id).toBe(DEFAULT_SESSION_ID);
  });

  it('honours a custom session id', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    await runner.runDebug('hello', {sessionId: 'my_session'});

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: DEFAULT_USER_ID,
      sessionId: 'my_session',
    });
    expect(session?.id).toBe('my_session');
  });

  it('honours a custom user id', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    await runner.runDebug('hello', {userId: 'alice'});

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: 'alice',
      sessionId: DEFAULT_SESSION_ID,
    });
    expect(session?.userId).toBe('alice');
  });

  it('passes the run config through to runAsync', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});
    const runConfig: RunConfig = {streamingMode: StreamingMode.SSE};
    const runAsync = vi.spyOn(runner, 'runAsync');

    await runner.runDebug('hello', {runConfig});

    expect(runAsync).toHaveBeenCalledTimes(1);
    expect(runAsync.mock.calls[0][0].runConfig).toBe(runConfig);
  });

  it('continues the same conversation across two calls', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});

    await runner.runDebug('first');
    await runner.runDebug('second');

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: DEFAULT_USER_ID,
      sessionId: DEFAULT_SESSION_ID,
    });
    const userTurns = session?.events
      .filter((event) => event.author === 'user')
      .map(textOf);
    expect(userTurns).toEqual(['first', 'second']);
  });

  it('reuses a session that already exists', async () => {
    const runner = new InMemoryRunner({agent: new EchoAgent()});
    const existing = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: DEFAULT_USER_ID,
      sessionId: DEFAULT_SESSION_ID,
    });
    await runner.sessionService.appendEvent({
      session: existing,
      event: createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'earlier turn'}]},
      }),
    });

    await runner.runDebug('hello');

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: DEFAULT_USER_ID,
      sessionId: DEFAULT_SESSION_ID,
    });
    const userTurns = session?.events
      .filter((event) => event.author === 'user')
      .map(textOf);
    expect(userTurns).toEqual(['earlier turn', 'hello']);
  });

  it('logs tool call detail only when verbose is set', async () => {
    const toolCall: Part = {
      functionCall: {name: 'calculate', args: {expression: '42 * 3.14'}},
    };
    const plain = new InMemoryRunner({agent: new EchoAgent([toolCall])});
    const verbose = new InMemoryRunner({agent: new EchoAgent([toolCall])});

    await plain.runDebug('hi');
    const withoutVerbose = loggedLines(info);
    info.mockClear();
    await verbose.runDebug('hi', {verbose: true});
    const withVerbose = loggedLines(info);

    expect(withoutVerbose).not.toContain(
      `${AGENT_NAME} > [Calling tool: calculate({"expression":"42 * 3.14"})]`,
    );
    expect(withVerbose).toContain(
      `${AGENT_NAME} > [Calling tool: calculate({"expression":"42 * 3.14"})]`,
    );
    expect(withoutVerbose).toContain(`${AGENT_NAME} > echo: hi`);
    expect(withVerbose).toContain(`${AGENT_NAME} > echo: hi`);
  });
});
