/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmResponse,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

/** Always answers with a tool call, so the agent loop never ends on its own. */
class LoopingLlm extends BaseLlm {
  calls = 0;

  constructor() {
    super({model: 'looping-llm'});
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    this.calls += 1;
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {id: `c${this.calls}`, name: 'ping', args: {}}}],
      },
    };
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('This model does not support live connections.');
  }
}

describe('ADK_MAX_LLM_CALLS through the runner', () => {
  const originalEnvValue = process.env.ADK_MAX_LLM_CALLS;

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.ADK_MAX_LLM_CALLS;
    } else {
      process.env.ADK_MAX_LLM_CALLS = originalEnvValue;
    }
  });

  it.each([3, 5])('stops a looping run after %i calls', async (limit) => {
    process.env.ADK_MAX_LLM_CALLS = String(limit);
    const llm = new LoopingLlm();
    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'looper',
        model: llm,
        tools: [
          new FunctionTool({
            name: 'ping',
            description: 'Answers every call the same way.',
            execute: () => ({ok: true}),
          }),
        ],
      }),
    });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user',
    });

    for await (const _ of runner.runAsync({
      userId: 'user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      // drain
    }

    expect(llm.calls).toBe(limit);
  });
});
