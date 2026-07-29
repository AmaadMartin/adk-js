/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Example, ExampleTool, LlmAgent} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {createRunner, GeminiWithMockResponses} from '../test_case_utils.js';

const ARITHMETIC_EXAMPLE: Example = {
  input: {parts: [{text: 'What is 2+2?'}]},
  output: [{role: 'model', parts: [{text: '4'}]}],
};

const FUNCTION_CALL_EXAMPLE: Example = {
  input: {parts: [{text: 'Search for cats'}]},
  output: [
    {
      role: 'model',
      parts: [{functionCall: {name: 'search', args: {query: 'cats'}}}],
    },
    {role: 'model', parts: [{text: 'Found cats!'}]},
  ],
};

const MOCK_RESPONSE = {
  candidates: [{content: {role: 'model', parts: [{text: '4'}]}}],
};

const AGENT_INSTRUCTION = 'Answer the user question.';

/**
 * Runs an agent that has `examples` attached via {@link ExampleTool} and
 * returns the system instruction the model actually received.
 */
async function captureSystemInstruction(
  examples: Example[],
  model?: string,
): Promise<string> {
  let capturedInstruction = '';

  const agent = new LlmAgent({
    name: 'example_agent',
    instruction: AGENT_INSTRUCTION,
    tools: [new ExampleTool(examples)],
    beforeModelCallback: async ({request}) => {
      capturedInstruction +=
        request.config?.systemInstruction?.toString() ?? '';
      return undefined;
    },
  });
  agent.model = new GeminiWithMockResponses([MOCK_RESPONSE], model);

  const runner = await createRunner(agent);
  for await (const _event of runner.run('What is 2+2?')) {
    // Drain the stream so the invocation completes.
  }

  return capturedInstruction;
}

describe('ExampleTool Integration', () => {
  it('injects few-shot examples into the system instruction via the agent loop', async () => {
    const instruction = await captureSystemInstruction([ARITHMETIC_EXAMPLE]);

    expect(instruction).toContain('Begin few-shot');
    expect(instruction).toContain('End few-shot');
    expect(instruction).toContain('What is 2+2?');
    expect(instruction).toContain('4');
    // The block is appended, so the agent's own instruction must survive.
    expect(instruction).toContain(AGENT_INSTRUCTION);
  });

  it('renders examples with the fence style of the request model', async () => {
    // `tool_code` fences are only emitted for non-gemini-2 models, so this
    // fails if llmRequest.model is not populated before tools run.
    const instruction = await captureSystemInstruction(
      [FUNCTION_CALL_EXAMPLE],
      'gemini-1.5-pro',
    );

    expect(instruction).toContain('```tool_code');
  });
});
