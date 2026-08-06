/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TEST_APP_ID = 'cfc_test_app';
const TEST_USER_ID = 'cfc_test_user';
const AGENT_NAME = 'cfc_agent';
const VERTEX_PATH_MODEL =
  'projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-flash';

/**
 * The stop the run reaches once the gate accepts the model.
 *
 * `LlmAgent.callLlmAsync` does not implement the CFC call path yet, so it
 * raises this and the agent reports it as an error event.
 */
const DOWNSTREAM_STOP_MESSAGE = 'CFC is not yet supported in callLlmAsync';

function gateMessage(model: string): string {
  return `CFC is not supported for model: ${model} in agent: ${AGENT_NAME}`;
}

/**
 * A model that only carries an id.
 *
 * The gate reads `canonicalModel.model`. A `string` model would go through
 * `LlmRegistry`, which resolves neither a non-Gemini id nor a Vertex publisher
 * path, so every case passes an instance instead.
 */
class IdOnlyLlm extends BaseLlm {
  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {};
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('connect is not used by the CFC gate'));
  }
}

interface GateResult {
  /** Message of the error thrown out of `runAsync`, if the gate rejected. */
  thrownMessage: string | undefined;
  /** Error message of every event the run emitted. */
  eventErrorMessages: string[];
  agent: LlmAgent;
}

/**
 * Runs an agent on `model` with `supportCfc` on and reports what the gate did.
 *
 * A fresh agent per call is required: the gate installs a code executor on the
 * agent when it accepts the model.
 */
async function runWithCfc(model: string): Promise<GateResult> {
  const agent = new LlmAgent({name: AGENT_NAME, model: new IdOnlyLlm({model})});
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: TEST_APP_ID,
    userId: TEST_USER_ID,
  });
  const runner = new Runner({appName: TEST_APP_ID, agent, sessionService});

  const events: Event[] = [];
  let thrownMessage: string | undefined;
  try {
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'hi'}]},
      runConfig: {supportCfc: true},
    })) {
      events.push(event);
    }
  } catch (e: unknown) {
    thrownMessage = e instanceof Error ? e.message : String(e);
  }

  return {
    thrownMessage,
    eventErrorMessages: events.flatMap((event) =>
      event.errorMessage ? [event.errorMessage] : [],
    ),
    agent,
  };
}

describe('Runner CFC model gate', () => {
  it.each([
    ['the current default', 'gemini-2.5-flash'],
    ['the next major', 'gemini-3.0-pro'],
    ['the Vertex publisher path form', VERTEX_PATH_MODEL],
  ])('accepts %s and installs a code executor', async (_label, model) => {
    const {thrownMessage, eventErrorMessages, agent} = await runWithCfc(model);

    expect(thrownMessage).toBeUndefined();
    expect(eventErrorMessages).toEqual([DOWNSTREAM_STOP_MESSAGE]);
    expect(agent.codeExecutor).toBeDefined();
  });

  it('rejects a non-Gemini model and installs no code executor', async () => {
    const {thrownMessage, eventErrorMessages, agent} =
      await runWithCfc('claude-3-5-sonnet');

    expect(thrownMessage).toBe(gateMessage('claude-3-5-sonnet'));
    expect(eventErrorMessages).toEqual([]);
    expect(agent.codeExecutor).toBeUndefined();
  });
});
