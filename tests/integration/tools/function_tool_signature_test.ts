/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context, Event, LlmRequest, LlmResponse} from '@google/adk';
import {
  BasePlugin,
  FunctionTool,
  LlmAgent,
  runWithSyncCallableRunner,
} from '@google/adk';
import {FinishReason, FunctionDeclaration, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

/** Records the tool declarations the flow sends to the model. */
class DeclarationRecorder extends BasePlugin {
  readonly declarations: FunctionDeclaration[][] = [];

  constructor() {
    super('declaration-recorder');
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.declarations.push(
      params.llmRequest.config?.tools?.flatMap(
        (tool) =>
          ('functionDeclarations' in tool && tool.functionDeclarations) || [],
      ) ?? [],
    );
    return undefined;
  }
}

function callThenAnswer(
  toolName: string,
  args: Record<string, unknown>,
  answer: string,
): RawGenerateContentResponse[] {
  return [
    {
      candidates: [
        {
          content: {
            parts: [
              {functionCall: {name: toolName, args, id: 'adk-mock-call-1'}},
            ],
            role: 'model',
          },
          finishReason: FinishReason.STOP,
        },
      ],
    },
    {
      candidates: [
        {
          content: {parts: [{text: answer}], role: 'model'},
          finishReason: FinishReason.STOP,
        },
      ],
    },
  ];
}

async function drain(
  events: AsyncGenerator<Event, void, undefined>,
): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('FunctionTool signature parity through a full agent turn', () => {
  it('advertises a schema-less tool and calls it', async () => {
    const forecast = new FunctionTool({
      name: 'forecast',
      description: 'Looks up a forecast.',
      execute: ({city, days = 3}) => `${city} for ${days} days`,
    });
    const recorder = new DeclarationRecorder();
    const agent = new LlmAgent({
      name: 'weather_agent',
      model: new GeminiWithMockResponses(
        callThenAnswer('forecast', {city: 'Paris'}, 'Here is the forecast.'),
      ),
      instruction: 'Answer weather questions.',
      tools: [forecast],
    });

    const runner = await createRunner(agent, [recorder]);
    const events = await drain(runner.run('Forecast for Paris?'));

    expect(recorder.declarations[0]).toEqual([
      {
        name: 'forecast',
        description: 'Looks up a forecast.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            city: {type: Type.TYPE_UNSPECIFIED},
            days: {type: Type.TYPE_UNSPECIFIED},
          },
          required: ['city'],
        },
      },
    ]);

    const response = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse !== undefined);
    expect(response?.functionResponse?.response).toEqual({
      result: 'Paris for 3 days',
    });
  });

  it('runs a sync tool body through a bound runner', async () => {
    const offloaded: string[] = [];
    const syncTool = new FunctionTool({
      name: 'lookup',
      description: 'Blocks while it looks something up.',
      execute: ({city}) => `found ${city}`,
    });
    const agent = new LlmAgent({
      name: 'lookup_agent',
      model: new GeminiWithMockResponses(
        callThenAnswer('lookup', {city: 'Paris'}, 'Found it.'),
      ),
      instruction: 'Look things up.',
      tools: [syncTool],
    });

    const runner = await createRunner(agent);
    const events = await runWithSyncCallableRunner(
      async (call) => {
        offloaded.push('lookup');
        await new Promise((resolve) => setImmediate(resolve));
        return call();
      },
      () => drain(runner.run('Look up Paris.')),
    );

    expect(offloaded).toEqual(['lookup']);
    const response = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse !== undefined);
    expect(response?.functionResponse?.response).toEqual({
      result: 'found Paris',
    });
  });

  it('leaves an async tool body on the caller loop', async () => {
    const offloaded: string[] = [];
    const asyncTool = new FunctionTool({
      name: 'lookup',
      description: 'Looks something up asynchronously.',
      execute: async ({city}) => `found ${city}`,
    });
    const agent = new LlmAgent({
      name: 'lookup_agent',
      model: new GeminiWithMockResponses(
        callThenAnswer('lookup', {city: 'Paris'}, 'Found it.'),
      ),
      instruction: 'Look things up.',
      tools: [asyncTool],
    });

    const runner = await createRunner(agent);
    const events = await runWithSyncCallableRunner(
      async (call) => {
        offloaded.push('lookup');
        return call();
      },
      () => drain(runner.run('Look up Paris.')),
    );

    expect(offloaded).toEqual([]);
    const response = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse !== undefined);
    expect(response?.functionResponse?.response).toEqual({
      result: 'found Paris',
    });
  });
});
