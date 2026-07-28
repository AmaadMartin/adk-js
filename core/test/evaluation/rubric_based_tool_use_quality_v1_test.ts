/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppDetailsSchema,
  BaseLlm,
  InvocationSchema,
  LLMRegistry,
  LlmResponse,
  PrebuiltMetrics,
  Rubric,
  RubricBasedToolUseV1Evaluator,
  RubricsBasedCriterionSchema,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

class MockJudge extends BaseLlm {
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {}
  override connect(): Promise<never> {
    throw new Error('not implemented');
  }
}

const RUBRICS: Rubric[] = [
  {
    rubricId: '1',
    rubricContent: {textProperty: 'Did the agent use the correct tool?'},
  },
  {
    rubricId: '2',
    rubricContent: {textProperty: 'Were the tool parameters correct?'},
  },
];

function makeEvaluator(rubrics: Rubric[]): RubricBasedToolUseV1Evaluator {
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new MockJudge({model: 'm'}));
  return new RubricBasedToolUseV1Evaluator({
    metricName: PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
    threshold: 0.5,
    criterion: RubricsBasedCriterionSchema.parse({
      threshold: 0.5,
      rubrics,
      judgeModelOptions: {numSamples: 3},
    }),
  });
}

describe('RubricBasedToolUseV1Evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats a prompt for a basic invocation', () => {
    const evaluator = makeEvaluator(RUBRICS);
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
      }),
    );
    expect(prompt).toContain('User input here.');
    expect(prompt).toContain('Did the agent use the correct tool?');
    expect(prompt).toContain('Were the tool parameters correct?');
    expect(prompt).toContain(
      '<available_tools>\nAgent has no tools.\n</available_tools>',
    );
    expect(prompt).toContain(
      '<response>\nNo intermediate steps were taken.\n</response>',
    );
  });

  it('formats a prompt with invocation-level rubrics only', () => {
    const evaluator = makeEvaluator([]);
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        rubrics: [
          {
            rubricId: 'invocation-rubric',
            rubricContent: {textProperty: 'Did the agent use the lookup tool?'},
            type: RubricBasedToolUseV1Evaluator.RUBRIC_TYPE,
          },
        ],
      }),
    );
    expect(prompt).toContain('User input here.');
    expect(prompt).toContain('Did the agent use the lookup tool?');
  });

  it('throws when there are no effective rubrics', () => {
    const evaluator = makeEvaluator([]);
    expect(() =>
      evaluator.formatAutoRaterPrompt(
        InvocationSchema.parse({
          userContent: {parts: [{text: 'User input here.'}]},
        }),
      ),
    ).toThrow(/Rubrics are required/);
  });

  it('formats a prompt with app details', () => {
    const evaluator = makeEvaluator(RUBRICS);
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: {
          name: 'agent1',
          toolDeclarations: [
            {
              functionDeclarations: [
                {name: 'test_func', description: 'A test function.'},
              ],
            },
          ],
        },
      },
    });
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        appDetails,
      }),
    );
    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"description": "A test function."');
  });

  it('renders empty text for a missing user prompt', () => {
    const evaluator = makeEvaluator(RUBRICS);
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({userContent: {parts: []}}),
    );
    expect(prompt).toContain('<user_prompt>\n\n</user_prompt>');
  });

  it('formats a prompt with intermediate tool data', () => {
    const evaluator = makeEvaluator(RUBRICS);
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        intermediateData: {
          toolUses: [{name: 'test_func', args: {arg1: 'val1'}, id: 'call1'}],
          toolResponses: [
            {name: 'test_func', response: {result: 'ok'}, id: 'call1'},
          ],
        },
      }),
    );
    expect(prompt).toContain('"step": 0');
    expect(prompt).toContain('"toolCall":');
    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"toolResponse":');
    expect(prompt).toContain('"result": "ok"');
  });
});
