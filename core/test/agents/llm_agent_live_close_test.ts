/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  LiveCloseCode,
  LiveConnectionClosedError,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

import {ScriptedLiveEntry, ScriptedLiveLlm} from './live_test_helpers.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session-id';

describe('LlmAgent live connection close', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  function runLive(llm: ScriptedLiveLlm): AsyncGenerator<Event, void, void> {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new LlmAgent({name: 'agent', model: llm}),
      sessionService,
      artifactService: new InMemoryArtifactService(),
    });
    const queue = new LiveRequestQueue();
    queue.send({content: {role: 'user', parts: [{text: 'hello'}]}});
    queue.close();

    return runner.runLive({
      userId: USER_ID,
      sessionId: SESSION_ID,
      liveRequestQueue: queue,
    });
  }

  async function drain(llm: ScriptedLiveLlm): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of runLive(llm)) {
      events.push(event);
    }
    return events;
  }

  it('ends the stream when the model closes the session normally', async () => {
    const llm = new ScriptedLiveLlm([
      [
        {content: {role: 'model', parts: [{text: 'bye'}]}},
        new LiveConnectionClosedError(LiveCloseCode.NORMAL, 'done'),
      ],
    ]);

    const events = await drain(llm);

    expect(llm.connections).toHaveLength(1);
    expect(
      events.some((event) => event.content?.parts?.[0]?.text === 'bye'),
    ).toBe(true);
  });

  it('reconnects on a normal close when a handle is available', async () => {
    const llm = new ScriptedLiveLlm([
      [
        {liveSessionResumptionUpdate: {newHandle: 'handle-1'}},
        new LiveConnectionClosedError(LiveCloseCode.NORMAL, 'done'),
      ],
      [{turnComplete: true}],
    ]);

    await drain(llm);

    expect(llm.connections).toHaveLength(2);
    expect(llm.requestsSeen[1].liveConnectConfig?.sessionResumption).toEqual({
      handle: 'handle-1',
    });
  });

  it('rejects on an abnormal close with no handle', async () => {
    const llm = new ScriptedLiveLlm([
      [new LiveConnectionClosedError(LiveCloseCode.INTERNAL, 'server fault')],
    ]);

    await expect(drain(llm)).rejects.toThrow(
      /live connection closed \(1011\): server fault/,
    );
    expect(llm.connections).toHaveLength(1);
  });

  it('rejects on a plain error that carries a normal close code', async () => {
    // A clean end is a LiveConnectionClosedError, not any error whose `code`
    // happens to read 1000.
    const impostor: ScriptedLiveEntry = Object.assign(
      new Error('unrelated failure'),
      {code: LiveCloseCode.NORMAL},
    );
    const llm = new ScriptedLiveLlm([[impostor]]);

    await expect(drain(llm)).rejects.toThrow('unrelated failure');
  });
});
