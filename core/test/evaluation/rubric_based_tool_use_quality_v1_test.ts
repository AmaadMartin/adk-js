/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_rubric_based_tool_use_quality_v1.py`.
 * Each `it()` keeps the Python test name, so the two suites stay greppable
 * against each other.
 */

import {
  AppDetails,
  EvalMetric,
  InputValidationError,
  IntermediateData,
  Invocation,
  PrebuiltMetrics,
  Rubric,
  RubricBasedToolUseV1Evaluator,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm} from './fake_judge_llm.js';

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

function createEvaluator(rubrics: Rubric[]): RubricBasedToolUseV1Evaluator {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
    threshold: 0.5,
    criterion: {
      threshold: 0.5,
      rubrics,
      judgeModelOptions: {numSamples: 3},
    },
  };
  return new RubricBasedToolUseV1Evaluator(
    evalMetric,
    new FakeJudgeLlm([{silent: true}]),
  );
}

function createInvocation(partial: Partial<Invocation> = {}): Invocation {
  return {userContent: {parts: [{text: 'User input here.'}]}, ...partial};
}

function createIntermediateData(
  partial: Partial<IntermediateData>,
): IntermediateData {
  return {
    toolUses: [],
    toolResponses: [],
    intermediateResponses: [],
    ...partial,
  };
}

describe('RubricBasedToolUseV1Evaluator', () => {
  it('test_format_auto_rater_prompt_with_basic_invocation', () => {
    const prompt =
      createEvaluator(RUBRICS).formatAutoRaterPrompt(createInvocation());

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

  it('test_format_auto_rater_prompt_with_invocation_rubrics_only', () => {
    const prompt = createEvaluator([]).formatAutoRaterPrompt(
      createInvocation({
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

  it('test_format_auto_rater_prompt_without_effective_rubrics_raises_error', () => {
    const evaluator = createEvaluator([]);

    expect(() => evaluator.formatAutoRaterPrompt(createInvocation())).toThrow(
      new InputValidationError('Rubrics are required.'),
    );
  });

  it('test_format_auto_rater_prompt_with_app_details', () => {
    const tool: Tool = {
      functionDeclarations: [
        {name: 'test_func', description: 'A test function.'},
      ],
    };
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1', toolDeclarations: [tool]}},
    };

    const prompt = createEvaluator(RUBRICS).formatAutoRaterPrompt(
      createInvocation({appDetails}),
    );

    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"description": "A test function."');
  });

  it('test_format_auto_rater_prompt_with_intermediate_data', () => {
    const intermediateData = createIntermediateData({
      toolUses: [{name: 'test_func', args: {arg1: 'val1'}, id: 'call1'}],
      toolResponses: [
        {name: 'test_func', response: {result: 'ok'}, id: 'call1'},
      ],
    });

    const prompt = createEvaluator(RUBRICS).formatAutoRaterPrompt(
      createInvocation({intermediateData}),
    );

    expect(prompt).toContain('"step": 0');
    expect(prompt).toContain('"tool_call":');
    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"tool_response":');
    expect(prompt).toContain('"result": "ok"');
  });
});
