/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  LlmResponse,
  Runner,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

import {ScriptedLiveLlm} from './live_test_helpers.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session-id';

/** The restart budget the flow enforces, plus the attempt that exceeds it. */
const MAX_LIVE_RESTARTS = 5;

const BLOCKED_RESPONSE: LlmResponse = {
  content: {role: 'model', parts: [{text: 'blocked by policy'}]},
};

describe('LlmAgent live reconnect', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  async function runLive(agent: LlmAgent): Promise<Event[]> {
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      artifactService: new InMemoryArtifactService(),
    });
    const queue = new LiveRequestQueue();
    queue.send({content: {role: 'user', parts: [{text: 'hello'}]}});
    queue.close();

    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: USER_ID,
      sessionId: SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }
    return events;
  }

  it('opens a new session with rebuilt history when a turn is blocked', async () => {
    const llm = new ScriptedLiveLlm([
      [
        {liveSessionResumptionUpdate: {newHandle: 'handle-1'}},
        {outputTranscription: {text: 'forbidden', finished: false}},
        {turnComplete: true},
      ],
      [{turnComplete: true}],
    ]);
    let blocks = 0;
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      afterModelCallback: () => (blocks++ === 0 ? BLOCKED_RESPONSE : undefined),
    });

    await runLive(agent);

    expect(llm.connections).toHaveLength(2);
    // The restarted session holds none of the old one's state.
    expect(
      llm.requestsSeen[1].liveConnectConfig.sessionResumption,
    ).toBeUndefined();
    // Its history is rebuilt from the session instead.
    expect(llm.connections[1].historyCalls).toHaveLength(1);
    const replayed = llm.connections[1].historyCalls[0];
    expect(
      replayed.some((content) =>
        content.parts?.some((part) => part.text === 'hello'),
      ),
    ).toBe(true);
  });

  it('keeps the handle and skips history when the server asks to reconnect', async () => {
    const llm = new ScriptedLiveLlm([
      [{liveSessionResumptionUpdate: {newHandle: 'handle-1'}}, {goAway: {}}],
      [{turnComplete: true}],
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});

    await runLive(agent);

    expect(llm.connections).toHaveLength(2);
    expect(llm.requestsSeen[1].liveConnectConfig.sessionResumption).toEqual({
      handle: 'handle-1',
    });
    expect(llm.connections[1].historyCalls).toEqual([]);
  });

  it('refuses to restart past the budget', async () => {
    const blockingTurn: LlmResponse[] = [
      {outputTranscription: {text: 'forbidden', finished: false}},
      {turnComplete: true},
    ];
    const llm = new ScriptedLiveLlm(
      Array.from({length: MAX_LIVE_RESTARTS + 2}, () => blockingTurn),
    );
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      afterModelCallback: () => BLOCKED_RESPONSE,
    });

    await expect(runLive(agent)).rejects.toThrow(
      `Max live session restarts reached (${MAX_LIVE_RESTARTS}).`,
    );
    expect(llm.connections).toHaveLength(MAX_LIVE_RESTARTS + 1);
  });
});
