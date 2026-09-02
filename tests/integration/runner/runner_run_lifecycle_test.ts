/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  SessionNotFoundError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const USER_ID = 'integration_user';
const SESSION_ID = 'integration_session';
const MESSAGE = {role: 'user', parts: [{text: 'count for me'}]};

/** Streams one partial response per scripted chunk, then a final one. */
class ScriptedLlm extends BaseLlm {
  constructor(private readonly chunks: string[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    for (const chunk of this.chunks) {
      yield {content: {role: 'model', parts: [{text: chunk}]}};
    }
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

function newRunner(
  chunks: string[],
  autoCreateSession = false,
): InMemoryRunner {
  return new InMemoryRunner({
    appName: 'integration_app',
    agent: new LlmAgent({
      name: 'scripted_agent',
      model: new ScriptedLlm(chunks),
    }),
    autoCreateSession,
  });
}

function textOf(events: Event[]): string[] {
  return events.map((e) => e.content?.parts?.[0]?.text ?? '');
}

describe('Runner.run end to end', () => {
  it('delivers every event in order', async () => {
    const chunks = ['one', 'two', 'three', 'four', 'five'];
    const runner = newRunner(chunks);
    await runner.sessionService.createSession({
      appName: 'integration_app',
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const received: Event[] = [];
    for await (const event of runner.run({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: MESSAGE,
    })) {
      received.push(event);
    }

    expect(textOf(received)).toEqual(chunks);
  });

  it('raises SessionNotFoundError for an unknown session id', async () => {
    const runner = newRunner(['one']);

    await expect(
      (async () => {
        for await (const _ of runner.run({
          userId: USER_ID,
          sessionId: 'unknown',
          newMessage: MESSAGE,
        })) {
          // Drain until the failure surfaces.
        }
      })(),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('creates the unknown session when autoCreateSession is set', async () => {
    const runner = newRunner(['one'], true);

    const received: Event[] = [];
    for await (const event of runner.run({
      userId: USER_ID,
      sessionId: 'unknown',
      newMessage: MESSAGE,
    })) {
      received.push(event);
    }

    expect(textOf(received)).toEqual(['one']);
    const session = await runner.sessionService.getSession({
      appName: 'integration_app',
      userId: USER_ID,
      sessionId: 'unknown',
    });
    expect(session?.id).toBe('unknown');
  });
});
