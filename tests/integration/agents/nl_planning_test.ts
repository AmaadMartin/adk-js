/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a planner through the whole runner, so the wiring is exercised
 * rather than the processors on their own: the request processor must reach
 * the model's request, and the response processor must reach the events the
 * runner yields.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BuiltInPlanner,
  Event,
  FINAL_ANSWER_TAG,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PLANNING_TAG,
  PlanReActPlanner,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'nl_planning_integration';

/** A model that records the request it received and replays one reply. */
class RecordingLlm extends BaseLlm {
  request?: LlmRequest;

  constructor(private readonly reply: LlmResponse) {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.request = request;
    yield this.reply;
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

async function runTurn(agent: LlmAgent, message: string): Promise<Event[]> {
  const runner = new InMemoryRunner({agent, appName: APP_NAME});
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: createUserContent(message),
  })) {
    events.push(event);
  }
  return events;
}

describe('NL planning through the runner', () => {
  it('sends the planner preamble and splits the tagged reply', async () => {
    const model = new RecordingLlm({
      content: {
        role: 'model',
        parts: [
          {
            text:
              `${PLANNING_TAG}1. Look up the weather.\n` +
              `${FINAL_ANSWER_TAG}It is sunny.`,
          },
        ],
      },
    });
    const agent = new LlmAgent({
      name: 'researcher',
      model,
      planner: new PlanReActPlanner(),
    });

    const events = await runTurn(agent, 'What is the weather?');

    const systemInstruction = model.request?.config?.systemInstruction;
    expect(systemInstruction).toContain(PLANNING_TAG);
    expect(systemInstruction).toContain(FINAL_ANSWER_TAG);
    expect(events[0].content?.parts).toEqual([
      {text: '1. Look up the weather.\n', thought: true},
      {text: 'It is sunny.'},
    ]);
  });

  it('sends the thinking config and keeps the reply whole', async () => {
    const reply = {
      content: {
        role: 'model',
        parts: [{text: 'thinking...', thought: true}, {text: 'It is sunny.'}],
      },
    };
    const model = new RecordingLlm(reply);
    const agent = new LlmAgent({
      name: 'thinker',
      model,
      planner: new BuiltInPlanner({thinkingConfig: {includeThoughts: true}}),
    });

    const events = await runTurn(agent, 'What is the weather?');

    expect(model.request?.config?.thinkingConfig).toEqual({
      includeThoughts: true,
    });
    expect(events[0].content?.parts).toEqual(reply.content.parts);
  });

  it('leaves an agent with no planner untouched', async () => {
    const model = new RecordingLlm({
      content: {role: 'model', parts: [{text: `${PLANNING_TAG}untouched`}]},
    });
    const agent = new LlmAgent({name: 'plain', model});

    const events = await runTurn(agent, 'What is the weather?');

    expect(model.request?.config?.systemInstruction).not.toContain(
      FINAL_ANSWER_TAG,
    );
    expect(model.request?.config?.thinkingConfig).toBeUndefined();
    expect(events[0].content?.parts).toEqual([
      {text: `${PLANNING_TAG}untouched`},
    ]);
  });
});
