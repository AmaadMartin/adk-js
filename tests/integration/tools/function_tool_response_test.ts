/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionTool,
  getFunctionResponses,
  LlmAgent,
  SingleAfterToolCallback,
  ToolExecuteFunction,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const TOOL_NAME = 'report_tool';

/** A function call for the tool, followed by the model's final answer. */
function modelResponses(): RawGenerateContentResponse[] {
  return [
    {
      candidates: [
        {
          content: {
            parts: [{functionCall: {name: TOOL_NAME, args: {}, id: 'call-1'}}],
            role: 'model',
          },
          finishReason: FinishReason.STOP,
        },
      ],
    },
    {
      candidates: [
        {
          content: {parts: [{text: 'done'}], role: 'model'},
          finishReason: FinishReason.STOP,
        },
      ],
    },
  ];
}

/**
 * Runs a real agent, tool and runner over a simulated model and returns both
 * the responses carried by the emitted function-response events and the
 * response each after-tool callback observed.
 */
async function runToolCall(execute: ToolExecuteFunction<undefined>): Promise<{
  eventResponses: Array<Record<string, unknown>>;
  callbackResponse?: Record<string, unknown>;
}> {
  let callbackResponse: Record<string, unknown> | undefined;
  const afterToolCallback: SingleAfterToolCallback = ({response}) => {
    callbackResponse = response;
    return undefined;
  };
  const agent = new LlmAgent({
    name: 'tool_response_agent',
    model: new GeminiWithMockResponses(modelResponses()),
    tools: [
      new FunctionTool({
        name: TOOL_NAME,
        description: 'Reports something.',
        parameters: z.object({}),
        execute,
      }),
    ],
    afterToolCallback,
  });

  const runner = await createRunner(agent);
  const eventResponses: Array<Record<string, unknown>> = [];
  for await (const event of runner.run('report please')) {
    for (const functionResponse of getFunctionResponses(event)) {
      if (functionResponse.response) {
        eventResponses.push(functionResponse.response);
      }
    }
  }

  return {eventResponses, callbackResponse};
}

describe('tool result normalization', () => {
  it('wraps a scalar tool result in a result field', async () => {
    const {eventResponses, callbackResponse} = await runToolCall(
      async () => 'sunny',
    );

    expect(eventResponses).toEqual([{result: 'sunny'}]);
    expect(callbackResponse).toEqual({result: 'sunny'});
  });

  it('wraps an array tool result in a results field', async () => {
    const {eventResponses, callbackResponse} = await runToolCall(async () => [
      'a',
      'b',
    ]);

    expect(eventResponses).toEqual([{results: ['a', 'b']}]);
    expect(callbackResponse).toEqual({results: ['a', 'b']});
  });

  it('passes a record tool result through unchanged', async () => {
    const {eventResponses, callbackResponse} = await runToolCall(async () => ({
      status: 'success',
    }));

    expect(eventResponses).toEqual([{status: 'success'}]);
    expect(callbackResponse).toEqual({status: 'success'});
  });
});
