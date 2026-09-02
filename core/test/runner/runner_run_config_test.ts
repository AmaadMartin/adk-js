/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  createEvent,
  Event,
  GetSessionConfig,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
} from '@google/adk';
import {Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const APP_NAME = 'run_config_app';
const USER_ID = 'run_config_user';
const SESSION_ID = 'run_config_session';
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

/** Stamps its own value for one metadata key on the event it emits. */
class OpinionatedAgent extends LlmAgent {
  constructor() {
    super({name: 'opinionated_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'mine'}]},
      customMetadata: {requestId: 'set-by-agent'},
    });
  }
}

/** Reports how many session events the agent could see. */
class HistorySizeAgent extends LlmAgent {
  constructor() {
    super({name: 'history_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: String(context.session.events.length)}],
      },
    });
  }
}

class EarlyExitPlugin extends BasePlugin {
  constructor() {
    super('early_exit_plugin');
  }

  override async beforeRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return {role: 'model', parts: [{text: 'short circuit'}]};
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

describe('Runner run-level configuration', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  function newRunner(agent: LlmAgent, plugins: BasePlugin[] = []): Runner {
    return new Runner({appName: APP_NAME, agent, sessionService, plugins});
  }

  it('stamps customMetadata on every yielded and persisted event', async () => {
    const events = await drain(
      newRunner(new EchoAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
        yieldUserMessage: true,
        runConfig: {customMetadata: {requestId: 'req-1'}},
      }),
    );

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.customMetadata).toEqual({requestId: 'req-1'});
    }

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const userEvent = session?.events.find((e) => e.author === 'user');
    expect(userEvent?.customMetadata).toEqual({requestId: 'req-1'});
  });

  it("keeps the event's own value for a key the run config also sets", async () => {
    const events = await drain(
      newRunner(new OpinionatedAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
        runConfig: {
          customMetadata: {requestId: 'set-by-run', tenant: 'acme'},
        },
      }),
    );

    expect(events[0].customMetadata).toEqual({
      requestId: 'set-by-agent',
      tenant: 'acme',
    });
  });

  it('stamps the early-exit event a plugin produced', async () => {
    const events = await drain(
      newRunner(new EchoAgent(), [new EarlyExitPlugin()]).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
        runConfig: {customMetadata: {requestId: 'req-2'}},
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0]?.text).toBe('short circuit');
    expect(events[0].customMetadata).toEqual({requestId: 'req-2'});
  });

  it('leaves customMetadata untouched when the run config sets none', async () => {
    const events = await drain(
      newRunner(new EchoAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
      }),
    );

    expect(events[0].customMetadata).toBeUndefined();
  });

  it('passes getSessionConfig to the session service', async () => {
    const getSession = vi.spyOn(sessionService, 'getSession');
    const getSessionConfig: GetSessionConfig = {numRecentEvents: 50};

    await drain(
      newRunner(new EchoAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
        runConfig: {getSessionConfig},
      }),
    );

    expect(getSession).toHaveBeenCalledWith({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: getSessionConfig,
    });
    getSession.mockRestore();
  });

  it('limits the events the run sees with numRecentEvents', async () => {
    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(session).toBeDefined();
    for (let i = 0; i < 5; i++) {
      await sessionService.appendEvent({
        session: session!,
        event: createEvent({
          invocationId: `history-${i}`,
          author: 'user',
          content: {role: 'user', parts: [{text: `old ${i}`}]},
        }),
      });
    }

    const events = await drain(
      newRunner(new HistorySizeAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
        runConfig: {getSessionConfig: {numRecentEvents: 2}},
      }),
    );

    // Two loaded events plus the user message this run appended.
    expect(events[0].content?.parts?.[0]?.text).toBe('3');
  });

  it('loads the whole history when getSessionConfig is omitted', async () => {
    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(session).toBeDefined();
    for (let i = 0; i < 5; i++) {
      await sessionService.appendEvent({
        session: session!,
        event: createEvent({
          invocationId: `history-${i}`,
          author: 'user',
          content: {role: 'user', parts: [{text: `old ${i}`}]},
        }),
      });
    }

    const events = await drain(
      newRunner(new HistorySizeAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
      }),
    );

    expect(events[0].content?.parts?.[0]?.text).toBe('6');
  });

  it('yields the user event first when yieldUserMessage is set', async () => {
    const events = await drain(
      newRunner(new EchoAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
        yieldUserMessage: true,
      }),
    );

    expect(events.map((e) => e.author)).toEqual(['user', 'echo_agent']);
    expect(events[0].content?.parts?.[0]?.text).toBe('hello');
  });

  it('yields no user event when yieldUserMessage is omitted', async () => {
    const events = await drain(
      newRunner(new EchoAgent()).runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: MESSAGE,
      }),
    );

    expect(events.map((e) => e.author)).toEqual(['echo_agent']);
  });
});
