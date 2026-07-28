/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'InMemoryRunner';
const USER_ID = 'live_user';
const SESSION_ID = 'live_session';

/**
 * A live agent that drains the invocation's {@link LiveRequestQueue} and echoes
 * each content request back as a model event, terminating when the queue closes.
 *
 * It overrides `runLiveImpl` directly and never contacts a real model, so the
 * test exercises the full `Runner.runLive` lifecycle through the public
 * `InMemoryRunner` API with no external services.
 */
class EchoLiveAgent extends LlmAgent {
  constructor() {
    super({name: 'echo_live_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const queue = context.liveRequestQueue;
    if (!queue) {
      throw new Error('Expected a liveRequestQueue on the invocation context.');
    }
    for await (const request of queue) {
      if (request.close) {
        break;
      }
      const text = request.content?.parts?.[0]?.text ?? '';
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: `echo: ${text}`}]},
      });
    }
  }
}

describe('Runner.runLive integration', () => {
  it('streams and persists echoed events driven by the live queue', async () => {
    const runner = new InMemoryRunner({agent: new EchoLiveAgent()});
    await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const liveRequestQueue = new LiveRequestQueue();

    const collected: Event[] = [];
    const consumed = (async () => {
      for await (const event of runner.runLive({
        userId: USER_ID,
        sessionId: SESSION_ID,
        liveRequestQueue,
      })) {
        collected.push(event);
      }
    })();

    // Drive input into the same queue the agent is draining, then end the loop.
    liveRequestQueue.sendContent({role: 'user', parts: [{text: 'hello'}]});
    liveRequestQueue.sendContent({role: 'user', parts: [{text: 'world'}]});
    liveRequestQueue.close();

    await consumed;

    // Events are streamed back to the caller...
    expect(collected.map((e) => e.content?.parts?.[0]?.text)).toEqual([
      'echo: hello',
      'echo: world',
    ]);

    // ...and persisted (non-partial) to the in-memory session.
    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(session!.events.map((e) => e.content?.parts?.[0]?.text)).toEqual([
      'echo: hello',
      'echo: world',
    ]);
    expect(session!.events.every((e) => e.author === 'echo_live_agent')).toBe(
      true,
    );
  });
});
