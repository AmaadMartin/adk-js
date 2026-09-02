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
  LlmResponse,
  RunConfig,
  Runner,
} from '@google/adk';
import {Content} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

import {ScriptedLiveLlm} from './live_test_helpers.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session-id';

const BLOCKED_RESPONSE: LlmResponse = {
  content: {role: 'model', parts: [{text: 'blocked by policy'}]},
};

const TRANSFER_CALL: Content = {
  role: 'model',
  parts: [
    {functionCall: {name: 'transfer_to_agent', args: {agentName: 'child'}}},
  ],
};

describe('LlmAgent live run config resumption handle', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  async function runLive(
    agent: LlmAgent,
    runConfig?: RunConfig,
  ): Promise<Event[]> {
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
      runConfig,
    })) {
      events.push(event);
    }
    return events;
  }

  it('retries with the run config handle when the first connection drops', async () => {
    const llm = new ScriptedLiveLlm([
      [new LiveConnectionClosedError(LiveCloseCode.ABNORMAL, 'dropped')],
      [{turnComplete: true}],
    ]);

    await runLive(new LlmAgent({name: 'agent', model: llm}), {
      sessionResumption: {handle: 'stored'},
    });

    expect(llm.connections).toHaveLength(2);
    expect(
      llm.requestsSeen[0].liveConnectConfig?.sessionResumption?.handle,
    ).toBe('stored');
    expect(
      llm.requestsSeen[1].liveConnectConfig?.sessionResumption?.handle,
    ).toBe('stored');
  });

  it('keeps a transparent flag the caller set on the run config', async () => {
    const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);

    await runLive(new LlmAgent({name: 'agent', model: llm}), {
      sessionResumption: {handle: 'stored', transparent: false},
    });

    expect(llm.requestsSeen[0].liveConnectConfig?.sessionResumption).toEqual({
      handle: 'stored',
      transparent: false,
    });
  });

  it('opens the sub-agent session without the parent run config handle', async () => {
    const childLlm = new ScriptedLiveLlm([[{turnComplete: true}]], 'child-llm');
    const child = new LlmAgent({name: 'child', model: childLlm});
    const parentLlm = new ScriptedLiveLlm([
      [{content: TRANSFER_CALL}, {turnComplete: true}],
    ]);
    const parent = new LlmAgent({
      name: 'parent',
      model: parentLlm,
      subAgents: [child],
    });

    await runLive(parent, {sessionResumption: {handle: 'stored'}});

    expect(childLlm.connections).toHaveLength(1);
    expect(
      childLlm.requestsSeen[0].liveConnectConfig?.sessionResumption?.handle,
    ).toBeUndefined();
  });

  it('drops the run config handle when a blocked turn restarts the session', async () => {
    const llm = new ScriptedLiveLlm([
      [
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

    await runLive(agent, {sessionResumption: {handle: 'stored'}});

    expect(llm.connections).toHaveLength(2);
    expect(
      llm.requestsSeen[1].liveConnectConfig?.sessionResumption?.handle,
    ).toBeUndefined();
  });
});
