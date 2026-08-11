/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  BaseLlm,
  BaseLlmConnection,
  BuiltInCodeExecutor,
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

/** The stop the run reaches once the gate accepts the model. */
const DOWNSTREAM_STOP_MESSAGE = 'CFC is not yet supported in callLlmAsync';

function gateMessage(model: string): string {
  return `CFC is not supported for model: ${model} in agent: ${AGENT_NAME}`;
}

/**
 * A model that only carries an id.
 *
 * The gate reads `canonicalModel.model`. A `string` model would go through
 * `LlmRegistry`, which does not resolve a non-Gemini id, so every case passes
 * an instance instead.
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
 * Runs a fresh agent on `model` and reports what the gate did.
 *
 * A fresh agent per call is required: the gate installs a code executor on the
 * agent when it accepts the model.
 */
async function runAgent(options: {
  model: string;
  supportCfc?: boolean;
  codeExecutor?: BaseCodeExecutor;
}): Promise<GateResult> {
  const agent = new LlmAgent({
    name: AGENT_NAME,
    model: new IdOnlyLlm({model: options.model}),
    codeExecutor: options.codeExecutor,
  });
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
      runConfig: {supportCfc: options.supportCfc ?? true},
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
  it.each(['gemini-flash-early-exp', 'gemini-flash-early-exp3'])(
    'rejects the unversioned Early Access id %s',
    async (model) => {
      const {thrownMessage, agent} = await runAgent({model});

      expect(thrownMessage).toBe(gateMessage(model));
      expect(agent.codeExecutor).toBeUndefined();
    },
  );

  it('rejects a non-Gemini model', async () => {
    const {thrownMessage, agent} = await runAgent({model: 'claude-3-5-sonnet'});

    expect(thrownMessage).toBe(gateMessage('claude-3-5-sonnet'));
    expect(agent.codeExecutor).toBeUndefined();
  });

  it('accepts a versioned Gemini 2 model and installs a built-in executor', async () => {
    const {thrownMessage, eventErrorMessages, agent} = await runAgent({
      model: 'gemini-2.5-flash',
    });

    expect(thrownMessage).toBeUndefined();
    expect(eventErrorMessages).toEqual([DOWNSTREAM_STOP_MESSAGE]);
    expect(agent.codeExecutor).toBeInstanceOf(BuiltInCodeExecutor);
  });

  it('keeps an already-installed built-in executor', async () => {
    const codeExecutor = new BuiltInCodeExecutor();

    const {agent} = await runAgent({model: 'gemini-2.5-flash', codeExecutor});

    expect(agent.codeExecutor).toBe(codeExecutor);
  });

  it('does not touch the agent when supportCfc is off', async () => {
    const {thrownMessage, eventErrorMessages, agent} = await runAgent({
      model: 'gemini-flash-early-exp',
      supportCfc: false,
    });

    expect(thrownMessage).toBeUndefined();
    expect(eventErrorMessages).toEqual([]);
    expect(agent.codeExecutor).toBeUndefined();
  });
});
