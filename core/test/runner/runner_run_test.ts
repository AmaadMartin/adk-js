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
  LlmAgent,
  Runner,
  Session,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'run_app';
const USER_ID = 'u1';
const SESSION_ID = 's1';
const MESSAGE = {role: 'user', parts: [{text: 'hello'}]};

/** Emits `count` events, then optionally throws. */
class ScriptedAgent extends LlmAgent {
  /** Set when the generator is torn down, however it ended. */
  closed = false;
  /** Set only when the agent reached the end of its script on its own. */
  completed = false;
  emitted = 0;

  constructor(
    private readonly count: number,
    private readonly failure?: unknown,
    private readonly pauseBetweenEvents = false,
  ) {
    super({name: 'scripted', model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    try {
      for (let i = 0; i < this.count; i++) {
        if (this.pauseBetweenEvents) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        this.emitted++;
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {role: 'model', parts: [{text: `event ${i}`}]},
        });
      }
      if (this.failure !== undefined) {
        throw this.failure;
      }
      this.completed = true;
    } finally {
      this.closed = true;
    }
  }
}

let sessionService: InMemorySessionService;

beforeEach(async () => {
  sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
});

function buildRunner(agent: LlmAgent): Runner {
  return new Runner({appName: APP_NAME, agent, sessionService});
}

function run(
  runner: Runner,
  stateDelta?: Record<string, unknown>,
): AsyncGenerator<Event, void, undefined> {
  return runner.run({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: MESSAGE,
    stateDelta,
  });
}

async function readSession(): Promise<Session> {
  const session = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  if (!session) {
    expect.fail(`session ${SESSION_ID} is missing`);
  }
  return session;
}

describe('Runner.run', () => {
  it('delivers the events in production order', async () => {
    const runner = buildRunner(new ScriptedAgent(3));
    const texts: string[] = [];

    for await (const event of run(runner)) {
      texts.push(event.content?.parts?.[0]?.text ?? '');
    }

    expect(texts).toEqual(['event 0', 'event 1', 'event 2']);
  });

  it('carries the state delta onto the persisted user event', async () => {
    const runner = buildRunner(new ScriptedAgent(1));

    for await (const _event of run(runner, {visits: 7})) {
      // Drain the run so the user event reaches storage.
    }

    const session = await readSession();
    const userEvent = session.events.find((e) => e.author === 'user');
    expect(userEvent?.actions.stateDelta).toEqual({visits: 7});
    expect(session.state['visits']).toBe(7);
  });

  it('rethrows an agent failure that arrives before any event', async () => {
    const runner = buildRunner(new ScriptedAgent(0, new Error('boom')));

    await expect(async () => {
      for await (const _event of run(runner)) {
        // The agent fails before producing anything.
      }
    }).rejects.toThrow('boom');
  });

  it('delivers the events it produced before it failed', async () => {
    const agent = new ScriptedAgent(2, new Error('late boom'));
    const runner = buildRunner(agent);
    const iterator = run(runner);
    const texts: string[] = [];

    const first = await iterator.next();
    texts.push(first.value?.content?.parts?.[0]?.text ?? '');
    // Let the invocation finish, so the failure is already known while an
    // event it produced is still waiting to be handed over.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.closed).toBe(true);

    await expect(async () => {
      for await (const event of iterator) {
        texts.push(event.content?.parts?.[0]?.text ?? '');
      }
    }).rejects.toThrow('late boom');
    expect(texts).toEqual(['event 0', 'event 1']);
  });

  it('wraps a failure that is not an Error', async () => {
    const runner = buildRunner(new ScriptedAgent(0, 'cancelled'));

    const failure = await run(runner)
      .next()
      .then(
        () => expect.fail('the run should have failed'),
        (e: unknown) => e,
      );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Agent run terminated by cancelled.',
    );
    expect((failure as Error).cause).toBe('cancelled');
  });

  it('closes the invocation and raises nothing when the caller stops', async () => {
    const agent = new ScriptedAgent(5, undefined, true);
    const runner = buildRunner(agent);
    const texts: string[] = [];

    for await (const event of run(runner)) {
      texts.push(event.content?.parts?.[0]?.text ?? '');
      break;
    }

    expect(texts).toEqual(['event 0']);
    expect(agent.closed).toBe(true);
    // The invocation stopped where the caller stopped, rather than running its
    // script out in the background.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agent.completed).toBe(false);
    expect(agent.emitted).toBeLessThan(5);
  });

  it('produces ahead of a caller that is busy between events', async () => {
    const agent = new ScriptedAgent(4);
    const runner = buildRunner(agent);
    const seen: string[] = [];

    const iterator = run(runner);
    const first = await iterator.next();
    seen.push(first.value ? 'first' : 'none');
    // The invocation runs on while the caller waits, so by the time the
    // caller asks again the agent has finished. runAsync, being
    // demand-driven, would still be sitting on its second event here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.closed).toBe(true);

    for await (const _event of iterator) {
      seen.push('more');
    }
    expect(seen).toEqual(['first', 'more', 'more', 'more']);
  });
});
