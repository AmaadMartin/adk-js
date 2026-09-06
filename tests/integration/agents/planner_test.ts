/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end wiring tests for the NL planning processors.
 *
 * They drive a real `InMemoryRunner` over a scripted model, so the default
 * processor lists, the planner dispatch and the event stream all take part.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BuiltInPlanner,
  Event,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PlanReActPlanner,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'planner_integration';

/** A model that replays a fixed script and records the requests it receives. */
class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    yield this.script[this.index++] ?? {
      content: {role: 'model', parts: [{text: 'ok'}]},
    };
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

async function runTurn(agent: LlmAgent, prompt: string): Promise<Event[]> {
  const runner = new InMemoryRunner({agent, appName: APP_NAME});
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: createUserContent(prompt),
  })) {
    events.push(event);
  }
  return events;
}

const TAGGED_RESPONSE: LlmResponse = {
  content: {
    role: 'model',
    parts: [
      {
        text:
          '/*PLANNING*/1. Recall the number.\n' +
          '/*REASONING*/It is well known.\n' +
          '/*FINAL_ANSWER*/The answer is 42.',
      },
    ],
  },
};

describe('LlmAgent with a PlanReActPlanner', () => {
  it('sends the planning instruction and cleans the tagged reply', async () => {
    const model = new ScriptedLlm([TAGGED_RESPONSE]);
    const agent = new LlmAgent({
      name: 'planning_agent',
      model,
      planner: new PlanReActPlanner(),
    });

    const events = await runTurn(agent, 'What is the answer?');

    expect(model.requests[0].config?.systemInstruction).toContain(
      '/*FINAL_ANSWER*/',
    );
    const parts = events.flatMap((event) => event.content?.parts ?? []);
    expect(parts).toEqual([
      {text: '1. Recall the number.\nIt is well known.\n', thought: true},
      {text: 'The answer is 42.'},
    ]);
  });

  it('leaves the tagged reply alone when the agent has no planner', async () => {
    const model = new ScriptedLlm([TAGGED_RESPONSE]);
    const agent = new LlmAgent({name: 'plain_agent', model});

    const events = await runTurn(agent, 'What is the answer?');

    expect(model.requests[0].config?.systemInstruction ?? '').not.toContain(
      '/*FINAL_ANSWER*/',
    );
    const parts = events.flatMap((event) => event.content?.parts ?? []);
    expect(parts).toEqual(TAGGED_RESPONSE.content?.parts);
  });
});

describe('LlmAgent with a BuiltInPlanner', () => {
  it('sends the thinking config and no planning instruction', async () => {
    const model = new ScriptedLlm([
      {content: {role: 'model', parts: [{text: 'Done.'}]}},
    ]);
    const agent = new LlmAgent({
      name: 'thinking_agent',
      model,
      planner: new BuiltInPlanner({
        thinkingConfig: {includeThoughts: true, thinkingBudget: 1024},
      }),
    });

    const events = await runTurn(agent, 'What is the answer?');

    expect(model.requests[0].config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    });
    expect(model.requests[0].config?.systemInstruction ?? '').not.toContain(
      '/*PLANNING*/',
    );
    const parts = events.flatMap((event) => event.content?.parts ?? []);
    expect(parts).toEqual([{text: 'Done.'}]);
  });
});
