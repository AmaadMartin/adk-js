/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BasePlugin,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  SequentialAgent,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'resume_app';
const USER_ID = 'u1';

/** An agent that records the user content it was resumed with. */
class RecordingAgent extends LlmAgent {
  readonly seenUserContent: Array<Content | undefined> = [];
  readonly runCount: number[] = [];

  constructor(name = 'root_agent') {
    super({name, model: 'gemini-2.0-flash'});
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.seenUserContent.push(ctx.userContent);
    this.runCount.push(this.runCount.length);
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ack'}]},
    });
  }
}

/** Rewrites every user message, so dedup cannot be comparing content. */
class RewritingPlugin extends BasePlugin {
  override async onUserMessageCallback(params: {
    userMessage: Content;
  }): Promise<Content> {
    const original = params.userMessage.parts?.[0].text ?? '';
    return {role: 'user', parts: [{text: `rewritten:${original}`}]};
  }
}

interface Harness {
  runner: Runner;
  agent: RecordingAgent;
  session: Session;
  sessionService: InMemorySessionService;
  reload(): Promise<Session>;
}

async function harness(options?: {
  isResumable?: boolean;
  plugins?: BasePlugin[];
  events?: (invocationId: string) => Event[];
}): Promise<Harness> {
  const sessionService = new InMemorySessionService();
  const agent = new RecordingAgent();
  const app = new App({
    name: APP_NAME,
    rootAgent: agent,
    plugins: options?.plugins,
    resumabilityConfig: {isResumable: options?.isResumable ?? true},
  });
  const runner = new Runner({app, sessionService});
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  for (const event of options?.events?.('inv-1') ?? []) {
    await sessionService.appendEvent({session, event});
  }
  return {
    runner,
    agent,
    session,
    sessionService,
    async reload() {
      const reloaded = await sessionService.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: session.id,
      });
      if (!reloaded) {
        expect.fail('session disappeared');
      }
      return reloaded;
    },
  };
}

async function drain(
  runner: Runner,
  params: {sessionId: string; invocationId?: string; newMessage?: Content},
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: params.sessionId,
    invocationId: params.invocationId,
    newMessage: params.newMessage,
  })) {
    events.push(event);
  }
  return events;
}

function userEvent(invocationId: string, text: string): Event {
  return createEvent({
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

describe('Runner invocation resume', () => {
  it('recovers the original user message and appends nothing new', async () => {
    const h = await harness({
      events: (invocationId) => [userEvent(invocationId, 'book a flight')],
    });

    await drain(h.runner, {sessionId: h.session.id, invocationId: 'inv-1'});

    expect(h.agent.seenUserContent).toEqual([
      {role: 'user', parts: [{text: 'book a flight'}]},
    ]);
    const events = (await h.reload()).events;
    expect(events.filter((e) => e.author === 'user')).toHaveLength(1);
  });

  it('leaves exactly one user event when the same message is re-sent', async () => {
    const h = await harness({
      events: (invocationId) => [userEvent(invocationId, 'book a flight')],
    });
    const newMessage: Content = {
      role: 'user',
      parts: [{text: 'book a flight'}],
    };

    await drain(h.runner, {
      sessionId: h.session.id,
      invocationId: 'inv-1',
      newMessage,
    });

    const users = (await h.reload()).events.filter((e) => e.author === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content?.parts?.[0].text).toBe('book a flight');
  });

  it('deduplicates the retry even when a plugin rewrote the stored message', async () => {
    const h = await harness({
      plugins: [new RewritingPlugin('rewriter')],
      events: (invocationId) => [
        userEvent(invocationId, 'stored-and-rewritten'),
      ],
    });

    await drain(h.runner, {
      sessionId: h.session.id,
      invocationId: 'inv-1',
      newMessage: {
        role: 'user',
        parts: [{text: 'a completely different text'}],
      },
    });

    const users = (await h.reload()).events.filter((e) => e.author === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content?.parts?.[0].text).toBe('stored-and-rewritten');
  });

  it('yields nothing when the agent already ended in that invocation', async () => {
    const h = await harness({
      events: (invocationId) => [
        userEvent(invocationId, 'book a flight'),
        createEvent({
          invocationId,
          author: 'root_agent',
          actions: {endOfAgent: true},
        }),
      ],
    });

    const events = await drain(h.runner, {
      sessionId: h.session.id,
      invocationId: 'inv-1',
    });

    expect(events).toEqual([]);
    expect(h.agent.runCount).toEqual([]);
  });

  it('runs the agent again when a later checkpoint reopened it', async () => {
    const h = await harness({
      events: (invocationId) => [
        userEvent(invocationId, 'book a flight'),
        createEvent({
          invocationId,
          author: 'root_agent',
          actions: {endOfAgent: true},
        }),
        createEvent({
          invocationId,
          author: 'root_agent',
          actions: {agentState: {step: 2}},
        }),
      ],
    });

    await drain(h.runner, {sessionId: h.session.id, invocationId: 'inv-1'});

    expect(h.agent.runCount).toEqual([0]);
  });

  it('rejects a resume against a session with no events', async () => {
    const h = await harness();

    await expect(
      drain(h.runner, {sessionId: h.session.id, invocationId: 'inv-1'}),
    ).rejects.toThrow(`Session ${h.session.id} has no events to resume.`);
  });

  it('rejects a resume of an invocation with no user message', async () => {
    const h = await harness({
      events: (invocationId) => [
        createEvent({
          invocationId,
          author: 'root_agent',
          content: {role: 'model', parts: [{text: 'orphaned turn'}]},
        }),
      ],
    });

    await expect(
      drain(h.runner, {sessionId: h.session.id, invocationId: 'inv-1'}),
    ).rejects.toThrow(
      'No user message available for resuming invocation: inv-1',
    );
  });

  it('rejects a run with neither a newMessage nor an invocationId', async () => {
    const h = await harness();

    await expect(drain(h.runner, {sessionId: h.session.id})).rejects.toThrow(
      'Running an agent requires either a newMessage or an invocationId to ' +
        `resume a previous invocation. Session: ${h.session.id}, User: ${USER_ID}`,
    );
  });

  it('rejects a resume when the app is not resumable', async () => {
    const h = await harness({isResumable: false});

    await expect(
      drain(h.runner, {sessionId: h.session.id, invocationId: 'inv-1'}),
    ).rejects.toThrow(
      'Running an agent requires a newMessage or a resumable app. ' +
        `Session: ${h.session.id}, User: ${USER_ID}`,
    );
  });

  it('appends the tool result and reuses the invocation it answers', async () => {
    const h = await harness({
      events: (invocationId) => [
        userEvent(invocationId, 'book a flight'),
        createEvent({
          invocationId,
          author: 'root_agent',
          content: {
            role: 'model',
            parts: [{functionCall: {id: 'fc-1', name: 'book', args: {}}}],
          },
        }),
      ],
    });

    const events = await drain(h.runner, {
      sessionId: h.session.id,
      newMessage: {
        role: 'user',
        parts: [
          {functionResponse: {id: 'fc-1', name: 'book', response: {ok: true}}},
        ],
      },
    });

    expect(events.every((e) => e.invocationId === 'inv-1')).toBe(true);
    const stored = (await h.reload()).events;
    expect(stored.filter((e) => e.author === 'user')).toHaveLength(2);
    // The agent is resumed against the turn the call belongs to, not the
    // function response.
    expect(h.agent.seenUserContent).toEqual([
      {role: 'user', parts: [{text: 'book a flight'}]},
    ]);
  });
});

/**
 * A root that is not an `LlmAgent` takes adk-python's plain runner path, which
 * neither resolves the invocation for every message nor refuses a mixed one.
 * A remote A2A caller relies on that: it answers a tool call and adds text in
 * the same message.
 */
describe('Runner with a root that is not an LlmAgent', () => {
  async function plainRunner(isResumable: boolean) {
    const sessionService = new InMemorySessionService();
    const app = new App({
      name: APP_NAME,
      rootAgent: new SequentialAgent({
        name: 'plain_agent',
        subAgents: [new RecordingAgent('step')],
      }),
      resumabilityConfig: {isResumable},
    });
    const runner = new Runner({app, sessionService});
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    return {runner, session};
  }

  const mixedMessage: Content = {
    role: 'user',
    parts: [
      {text: 'Approved'},
      {functionResponse: {id: 'fc-1', name: 'approve', response: {ok: true}}},
    ],
  };

  it('accepts a message mixing a tool result with text', async () => {
    const {runner, session} = await plainRunner(false);

    const events = await drain(runner, {
      sessionId: session.id,
      newMessage: mixedMessage,
    });

    expect(events.map((e) => e.author)).toContain('step');
  });

  it('resolves the invocation once the app is resumable', async () => {
    const {runner, session} = await plainRunner(true);

    await expect(
      drain(runner, {sessionId: session.id, newMessage: mixedMessage}),
    ).rejects.toThrow(
      'Function call not found for function response ids: fc-1',
    );
  });
});
