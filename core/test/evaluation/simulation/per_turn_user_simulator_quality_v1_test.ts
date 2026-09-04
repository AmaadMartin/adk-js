/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from
 * `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_v1.py`
 * of `google/adk-python`, at commit 852b575e9d12. Each `it` keeps the name of
 * the reference test it came from.
 *
 * Where the reference calls a private method, this calls the module-level
 * function the port extracted. Where the reference replaces `_sample_llm` with
 * a stub, this injects a `FakeJudgeLlm`.
 */

import {
  aggregateConversationResults,
  aggregateSamples,
  convertLlmResponseToScore,
  EvalStatus,
  evaluateFirstTurn,
  formatConversationHistory,
  formatPerTurnUserSimulatorPrompt,
  InputValidationError,
  Label,
  parseIsValidLabel,
  PerTurnUserSimulatorQualityV1,
  type ConversationScenario,
  type Invocation,
  type LlmResponse,
  type PerInvocationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm} from '../fake_judge_llm.js';

const STOP_SIGNAL = 'test stop signal';

/**
 * A judge critique in the shape the reference uses. Only the `is_valid` line
 * varies between the reference cases; `passes` is not read by the parser.
 */
function critique(isValidLine: string): string {
  return [
    '```json',
    '  {',
    '    "criteria": [',
    '      {',
    '        "name": "TEST_NAME",',
    '        "reasoning": "test_resonining",',
    '        "passes": True',
    '      }',
    '    ],',
    `    ${isValidLine}`,
    '  }',
    '  ```',
  ].join('\n');
}

function llmResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

function createTestEvaluator(options: {
  threshold?: number;
  numSamples?: number;
  judgeModelConfig?: Record<string, never>;
  judgeModel: FakeJudgeLlm;
}): PerTurnUserSimulatorQualityV1 {
  const threshold = options.threshold ?? 1.0;
  return new PerTurnUserSimulatorQualityV1({
    evalMetric: {
      metricName: 'test_per_turn_user_simulator_quality_v1',
      threshold,
      criterion: {
        threshold,
        stopSignal: STOP_SIGNAL,
        judgeModelOptions: {
          judgeModel: 'gemini-2.5-flash',
          judgeModelConfig: options.judgeModelConfig,
          numSamples: options.numSamples ?? 3,
        },
      },
    },
    judgeModel: options.judgeModel,
  });
}

function createTestConversationScenario(
  startingPrompt = 'test starting prompt',
  conversationPlan = 'test conversation plan',
): ConversationScenario {
  return {startingPrompt, conversationPlan};
}

function createTestInvocation(
  invocationId: string,
  userContent = 'user content',
  modelContent = 'model content',
): Invocation {
  return {
    invocationId,
    userContent: {role: 'user', parts: [{text: userContent}]},
    finalResponse: {role: 'model', parts: [{text: modelContent}]},
  };
}

/** Builds one invocation per user/agent pair, in order. */
function createTestInvocations(conversationHistory: string[]): Invocation[] {
  expect(conversationHistory.length % 2).toBe(0);

  const invocations: Invocation[] = [];
  for (let turn = 0; turn < conversationHistory.length / 2; turn++) {
    invocations.push(
      createTestInvocation(
        `turn ${turn}`,
        conversationHistory[2 * turn],
        conversationHistory[2 * turn + 1],
      ),
    );
  }
  return invocations;
}

function sample(
  invocationId: string,
  score: number | undefined,
  evalStatus: EvalStatus,
): PerInvocationResult {
  return {
    actualInvocation: createTestInvocation(invocationId),
    score,
    evalStatus,
  };
}

describe('parseIsValidLabel', () => {
  it.each([
    ['"is_valid_undefined_key": True'],
    ['"is_valid": "undefined label",'],
  ])('test_parse_llm_response_label_not_found (%s)', (isValidLine) => {
    expect(parseIsValidLabel(critique(isValidLine))).toBe(Label.NOT_FOUND);
  });

  it.each([
    ['"is_valid": True'],
    ['"is_valid": "true"'],
    ['"is_valid": "valid"'],
  ])('test_parse_llm_response_label_valid (%s)', (isValidLine) => {
    expect(parseIsValidLabel(critique(isValidLine))).toBe(Label.VALID);
  });

  it.each([
    ['"is_valid": False'],
    ['"is_valid": "false",'],
    ['"is_valid": "invalid",'],
    ['"is_valid": "almost",'],
    ['"is_valid": "partially_valid",'],
    ['"is_valid": "partially valid",'],
    ['"is_valid": "partially",'],
  ])('test_parse_llm_response_label_invalid (%s)', (isValidLine) => {
    expect(parseIsValidLabel(critique(isValidLine))).toBe(Label.INVALID);
  });
});

describe('formatPerTurnUserSimulatorPrompt', () => {
  it('test_format_llm_prompt_raises_error_if_previous_invocations_is_none', () => {
    expect(() =>
      formatPerTurnUserSimulatorPrompt({
        invocation: createTestInvocation('1'),
        conversationScenario: createTestConversationScenario(),
        previousInvocations: undefined,
        stopSignal: STOP_SIGNAL,
      }),
    ).toThrow(/Previous invocations should have a set value/);
  });

  it('test_format_llm_prompt_raises_error_if_conversation_scenario_is_none', () => {
    expect(() =>
      formatPerTurnUserSimulatorPrompt({
        invocation: createTestInvocation('1'),
        conversationScenario: undefined,
        previousInvocations: [],
        stopSignal: STOP_SIGNAL,
      }),
    ).toThrow(/Conversation scenario should have a set value/);
  });
});

describe('convertLlmResponseToScore', () => {
  it('test_convert_llm_response_to_score_pass', () => {
    const response = ['```json', '{', '  "is_valid": True,', '}', '```'].join(
      '\n',
    );

    expect(convertLlmResponseToScore(llmResponse(response))).toEqual({
      score: 1.0,
    });
  });

  it('test_convert_llm_response_to_score_failure', () => {
    const response = ['```json', '{', '  "is_valid": False,', '}', '```'].join(
      '\n',
    );

    expect(convertLlmResponseToScore(llmResponse(response))).toEqual({
      score: 0.0,
    });
  });

  it('test_convert_llm_response_to_score_invalid_json', () => {
    expect(convertLlmResponseToScore(llmResponse('invalid json'))).toEqual({});
  });

  it('test_convert_llm_response_to_score_missing_key', () => {
    expect(convertLlmResponseToScore(llmResponse('{}'))).toEqual({});
  });
});

describe('aggregateSamples', () => {
  it('test_aggregate_samples_not_evaluated', () => {
    const samples = [
      sample('1', undefined, EvalStatus.NOT_EVALUATED),
      sample('2', undefined, EvalStatus.NOT_EVALUATED),
    ];

    expect(aggregateSamples(samples)).toBe(samples[0]);
  });

  it('test_aggregate_samples_pass', () => {
    const aggregated = aggregateSamples([
      sample('1', 1.0, EvalStatus.PASSED),
      sample('2', 1.0, EvalStatus.PASSED),
      sample('3', 0.0, EvalStatus.FAILED),
    ]);

    expect(aggregated.score).toBe(1.0);
    expect(aggregated.evalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_aggregate_samples_failure', () => {
    const aggregated = aggregateSamples([
      sample('1', 1.0, EvalStatus.PASSED),
      sample('2', 0.0, EvalStatus.FAILED),
      sample('3', 0.0, EvalStatus.FAILED),
    ]);

    expect(aggregated.score).toBe(0.0);
    expect(aggregated.evalStatus).toBe(EvalStatus.FAILED);
  });
});

describe('formatConversationHistory', () => {
  it('test_format_conversation_history_with_none_values', () => {
    const invocations: Invocation[] = [{invocationId: '1', userContent: {}}];

    expect(formatConversationHistory(invocations)).toBe('');
  });

  it('test_format_conversation_history', () => {
    const invocations = createTestInvocations([
      'first user prompt.',
      'first agent response.',
      'second user prompt.',
      'second agent response.',
    ]);

    expect(formatConversationHistory(invocations)).toBe(
      [
        'user: first user prompt.',
        '',
        'model: first agent response.',
        '',
        'user: second user prompt.',
        '',
        'model: second agent response.',
      ].join('\n'),
    );
  });
});

describe('evaluateFirstTurn', () => {
  it('test_evaluate_first_turn_pass', () => {
    const result = evaluateFirstTurn(
      createTestInvocation('1', 'test starting prompt'),
      createTestConversationScenario('test starting prompt', 'plan'),
      0.8,
    );

    expect(result.score).toBe(1.0);
    expect(result.evalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_evaluate_first_turn_failure', () => {
    const result = evaluateFirstTurn(
      createTestInvocation('1', 'wrong starting prompt'),
      createTestConversationScenario('test starting prompt', 'plan'),
      1.0,
    );

    expect(result.score).toBe(0.0);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });

  // adk-python's `Invocation.user_content` is optional and the reference
  // guards on it being absent. adk-js requires it, so the two reference cases
  // both land on the no-text guard.
  it.each([{role: 'user', parts: []}, {}])(
    'test_evaluate_first_turn_not_evaluated_when_user_content_has_no_text (%o)',
    (userContent) => {
      const result = evaluateFirstTurn(
        {invocationId: '1', userContent},
        createTestConversationScenario('test starting prompt', 'plan'),
        1.0,
      );

      expect(result.score).toBeUndefined();
      expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
    },
  );
});

describe('aggregateConversationResults', () => {
  it('test_aggregate_conversation_results_all_pass_produces_pass', () => {
    const aggregated = aggregateConversationResults(
      [
        sample('1', 1.0, EvalStatus.PASSED),
        sample('2', 1.0, EvalStatus.PASSED),
        sample('3', 1.0, EvalStatus.PASSED),
        sample('4', 1.0, EvalStatus.PASSED),
      ],
      1.0,
    );

    expect(aggregated.overallScore).toBe(1.0);
    expect(aggregated.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_aggregate_conversation_results_percentage_above_threshold_produces_pass', () => {
    const aggregated = aggregateConversationResults(
      [
        sample('1', 1.0, EvalStatus.PASSED),
        sample('2', 1.0, EvalStatus.PASSED),
        sample('3', 0.0, EvalStatus.PASSED),
        sample('4', 1.0, EvalStatus.PASSED),
      ],
      0.7,
    );

    expect(aggregated.overallScore).toBe(0.75);
    expect(aggregated.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_aggregate_conversation_results_all_failures_produces_failure', () => {
    const aggregated = aggregateConversationResults(
      [
        sample('1', 0.0, EvalStatus.FAILED),
        sample('2', 0.0, EvalStatus.FAILED),
        sample('3', 0.0, EvalStatus.FAILED),
        sample('4', 0.0, EvalStatus.FAILED),
      ],
      1.0,
    );

    expect(aggregated.overallScore).toBe(0.0);
    expect(aggregated.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('test_aggregate_conversation_percentage_below_threshold_produces_failure', () => {
    const aggregated = aggregateConversationResults(
      [
        sample('1', 0.0, EvalStatus.FAILED),
        sample('2', 1.0, EvalStatus.PASSED),
        sample('3', 1.0, EvalStatus.PASSED),
        sample('4', 1.0, EvalStatus.PASSED),
      ],
      1.0,
    );

    expect(aggregated.overallScore).toBe(0.75);
    expect(aggregated.overallEvalStatus).toBe(EvalStatus.FAILED);
  });
});

describe('PerTurnUserSimulatorQualityV1.evaluateInvocations', () => {
  it('test_evaluate_invocations_all_pass', async () => {
    const startingPrompt = 'first user prompt.';
    const evaluator = createTestEvaluator({
      judgeModel: new FakeJudgeLlm([{critique: critique('"is_valid": True')}]),
    });

    const result = await evaluator.evaluateInvocations(
      createTestInvocations([
        startingPrompt,
        'model 1.',
        'user 2.',
        'model 2.',
      ]),
      undefined,
      createTestConversationScenario(startingPrompt),
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0].score).toBe(1.0);
    expect(result.perInvocationResults[1].score).toBe(1.0);
  });

  it('test_evaluate_invocations_none_judge_model_config', async () => {
    const startingPrompt = 'first user prompt.';
    const evaluator = createTestEvaluator({
      numSamples: 1,
      judgeModelConfig: undefined,
      judgeModel: new FakeJudgeLlm([{critique: critique('"is_valid": True')}]),
    });

    const result = await evaluator.evaluateInvocations(
      createTestInvocations([
        startingPrompt,
        'model 1.',
        'user 2.',
        'model 2.',
      ]),
      undefined,
      createTestConversationScenario(startingPrompt),
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });
});

describe('InputValidationError from the ported error paths', () => {
  it('reports an absent previous invocation list as invalid input', () => {
    expect(() =>
      formatPerTurnUserSimulatorPrompt({
        invocation: createTestInvocation('1'),
        conversationScenario: createTestConversationScenario(),
        stopSignal: STOP_SIGNAL,
      }),
    ).toThrow(InputValidationError);
  });
});
