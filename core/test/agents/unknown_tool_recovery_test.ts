/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  Event,
  FunctionTool,
  getFunctionCalls,
  getFunctionResponses,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

/** Replays a fixed script of model responses, one per turn. */
class ScriptedLlm extends BaseLlm {
  callCount = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.script[this.callCount];
    this.callCount++;
    if (response) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/** Answers a failed tool call with guidance the model can act on. */
class ReflectionPlugin extends BasePlugin {
  override async onToolErrorCallback({
    tool,
  }: Parameters<BasePlugin['onToolErrorCallback']>[0]): Promise<
    Record<string, unknown>
  > {
    return {
      errorType: 'ValueError',
      retryCount: 1,
      reflectionGuidance: `There is no tool named "${tool.name}". Call "increase".`,
    };
  }
}

const increase = new FunctionTool({
  name: 'increase',
  description: 'increases a number by one',
  parameters: z.object({value: z.number()}),
  execute: async ({value}: {value: number}) => ({value: value + 1}),
});

function modelResponse(
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {
    content: {role: 'model', parts: [{functionCall: {id: name, name, args}}]},
  };
}

async function runTurn(runner: Runner, sessionId: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user_1',
    sessionId,
    newMessage: {parts: [{text: 'increase 1'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('recovery from a hallucinated tool name', () => {
  it('lets a plugin answer the call so the model retries the real tool', async () => {
    const model = new ScriptedLlm([
      modelResponse('increase_by_one', {value: 1}),
      modelResponse('increase', {value: 1}),
    ]);
    const agent = new LlmAgent({name: 'counter', model, tools: [increase]});
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user_1',
    });
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
      plugins: [new ReflectionPlugin('reflection')],
    });

    const events = await runTurn(runner, session.id);

    expect(events.flatMap(getFunctionCalls).map((call) => call.name)).toEqual([
      'increase_by_one',
      'increase',
    ]);
    expect(events.flatMap(getFunctionResponses)).toEqual([
      expect.objectContaining({
        name: 'increase_by_one',
        response: {
          errorType: 'ValueError',
          retryCount: 1,
          reflectionGuidance:
            'There is no tool named "increase_by_one". Call "increase".',
        },
      }),
      expect.objectContaining({name: 'increase', response: {value: 2}}),
    ]);
    expect(events.some((event) => event.errorMessage)).toBe(false);
  });

  it('ends the run in an error when no plugin answers the call', async () => {
    const model = new ScriptedLlm([
      modelResponse('increase_by_one', {value: 1}),
    ]);
    const agent = new LlmAgent({name: 'counter', model, tools: [increase]});
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user_1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    const events = await runTurn(runner, session.id);

    expect(events.flatMap(getFunctionResponses)).toEqual([]);
    expect(events.at(-1)?.errorMessage).toBe(
      'Function increase_by_one is not found in the toolsDict.',
    );
  });
});
