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
  SequentialAgent,
  State,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const USER_ID = 'test_user';
const AGENT_1_OUTPUT = 'result_from_agent_1';

class RecordingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly text: string) {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield {content: {role: 'model', parts: [{text: this.text}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('temp: state visibility within an invocation', () => {
  it('makes a temp: outputKey readable by a later sub-agent without persisting it', async () => {
    const secondModel = new RecordingLlm('rewritten');
    const agent = new SequentialAgent({
      name: 'seq',
      subAgents: [
        new LlmAgent({
          name: 'a1',
          model: new RecordingLlm(AGENT_1_OUTPUT),
          outputKey: `${State.TEMP_PREFIX}out`,
        }),
        new LlmAgent({
          name: 'a2',
          model: secondModel,
          instruction: `Rewrite: {${State.TEMP_PREFIX}out}`,
        }),
      ],
    });

    const runner = new InMemoryRunner({agent});
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: USER_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.author)).toContain('a2');
    expect(secondModel.requests).toHaveLength(1);
    expect(secondModel.requests[0].config?.systemInstruction).toContain(
      `Rewrite: ${AGENT_1_OUTPUT}`,
    );

    const storedSession = await runner.sessionService.getSession({
      appName: runner.appName,
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(
      Object.keys(storedSession?.state ?? {}).filter((key) =>
        key.startsWith(State.TEMP_PREFIX),
      ),
    ).toEqual([]);
  });
});
