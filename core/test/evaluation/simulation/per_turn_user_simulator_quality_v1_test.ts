/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_v1.py`
 * from google/adk-python at commit c9bacd40ee4f. Each `it` keeps the name of
 * the Python test it ports.
 *
 * The Python tests reach the evaluator's private members: they call
 * `_format_llm_prompt`, `_aggregate_samples` and friends on an instance, and
 * they monkeypatch `_sample_llm`. This port calls the module-level functions
 * those methods delegate to, and injects a {@link FakeJudgeLlm} through the
 * constructor.
 */

import {
  EvalStatus,
  Label,
  PerTurnUserSimulatorQualityV1,
  aggregateConversationResults,
  aggregateSamples,
  convertLlmResponseToScore,
  evaluateFirstTurn,
  formatConversationHistory,
  formatPerTurnUserSimulatorPrompt,
  parseIsValidLabel,
  type ConversationScenario,
  type EvalMetric,
  type Invocation,
  type PerInvocationResult,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {FakeJudgeLlm} from '../fake_judge_llm.js';

const VALID_CRITIQUE = '```json\n{\n  "is_valid": True,\n}\n```';

function criticism(isValid: string): string {
  return `\`\`\`json
  {
    "criteria": [
      {
        "name": "TEST_NAME",
        "reasoning": "test_resonining",
        "passes": True
      }
    ],
    ${isValid}
  }
  \`\`\``;
}

function createTestEvalMetric(
  threshold = 1.0,
  stopSignal = 'test stop signal',
  numSamples = 3,
): EvalMetric {
  return {
    metricName: 'test_per_turn_user_simulator_quality_v1',
    threshold,
    criterion: {
      threshold,
      stopSignal,
      judgeModelOptions: {
        judgeModel: 'gemini-2.5-flash',
        judgeModelConfig: {},
        numSamples,
      },
    },
  };
}

function createTestEvaluator(
  threshold = 1.0,
  stopSignal = 'test stop signal',
): PerTurnUserSimulatorQualityV1 {
  return new PerTurnUserSimulatorQualityV1({
    evalMetric: createTestEvalMetric(threshold, stopSignal),
    judgeModel: new FakeJudgeLlm([{critique: VALID_CRITIQUE}]),
  });
}

function createTestConversationScenario(
  conversationPlan = 'test conversation plan',
  startingPrompt = 'test starting prompt',
  userPersona?: UserPersona,
): ConversationScenario {
  return {startingPrompt, conversationPlan, userPersona};
}

function createTestInvocation(
  invocationId: string,
  userContent = 'user content',
  modelContent = 'model content',
): Invocation {
  return {
    invocationId,
    userContent: {parts: [{text: userContent}], role: 'user'},
    finalResponse: {parts: [{text: modelContent}], role: 'model'},
  };
}

/** Turns an alternating list of user and agent messages into turns. */
function createTestInvocations(conversationHistory: string[]): Invocation[] {
  expect(conversationHistory.length % 2).toBe(0);
  const invocations: Invocation[] = [];
  for (let i = 0; i < conversationHistory.length / 2; i++) {
    invocations.push(
      createTestInvocation(
        'turn {i}',
        conversationHistory[2 * i],
        conversationHistory[2 * i + 1],
      ),
    );
  }
  return invocations;
}

function createSample(
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

describe('test_parse_llm_response_label_not_found', () => {
  it.each([
    ['"is_valid_undefined_key": True'],
    ['"is_valid": "undefined label",'],
  ])('%s', (isValid) => {
    expect(parseIsValidLabel(criticism(isValid))).toBe(Label.NOT_FOUND);
  });
});

describe('test_parse_llm_response_label_valid', () => {
  it.each([
    ['"is_valid": True'],
    ['"is_valid": "true"'],
    ['"is_valid": "valid"'],
  ])('%s', (isValid) => {
    expect(parseIsValidLabel(criticism(isValid))).toBe(Label.VALID);
  });
});

describe('test_parse_llm_response_label_invalid', () => {
  it.each([
    ['"is_valid": False'],
    ['"is_valid": "false",'],
    ['"is_valid": "invalid",'],
    ['"is_valid": "almost",'],
    ['"is_valid": "partially_valid",'],
    ['"is_valid": "partially valid",'],
    ['"is_valid": "partially",'],
  ])('%s', (isValid) => {
    expect(parseIsValidLabel(criticism(isValid))).toBe(Label.INVALID);
  });
});

it('test_format_llm_prompt_raises_error_if_previous_invocations_is_none', () => {
  expect(() =>
    formatPerTurnUserSimulatorPrompt({
      invocation: createTestInvocation('1'),
      conversationScenario: createTestConversationScenario(),
      previousInvocations: undefined,
      stopSignal: 'test stop signal',
    }),
  ).toThrow(/^Previous invocations should have a set value/);
});

it('test_format_llm_prompt_raises_error_if_conversation_scenario_is_none', () => {
  expect(() =>
    formatPerTurnUserSimulatorPrompt({
      invocation: createTestInvocation('1'),
      conversationScenario: undefined,
      previousInvocations: [],
      stopSignal: 'test stop signal',
    }),
  ).toThrow(/^Conversation scenario should have a set value/);
});

it('test_convert_llm_response_to_score_pass', () => {
  const autoRaterScore = convertLlmResponseToScore({
    content: {parts: [{text: VALID_CRITIQUE}], role: 'model'},
  });

  expect(autoRaterScore).toEqual({score: 1.0});
});

it('test_convert_llm_response_to_score_failure', () => {
  const autoRaterScore = convertLlmResponseToScore({
    content: {
      parts: [{text: '```json\n{\n  "is_valid": False,\n}\n```'}],
      role: 'model',
    },
  });

  expect(autoRaterScore).toEqual({score: 0.0});
});

it('test_convert_llm_response_to_score_invalid_json', () => {
  const autoRaterScore = convertLlmResponseToScore({
    content: {parts: [{text: 'invalid json'}], role: 'model'},
  });

  expect(autoRaterScore).toEqual({});
});

it('test_convert_llm_response_to_score_missing_key', () => {
  const autoRaterScore = convertLlmResponseToScore({
    content: {parts: [{text: '{}'}], role: 'model'},
  });

  expect(autoRaterScore).toEqual({});
});

it('test_aggregate_samples_not_evaluated', () => {
  const samples = [
    createSample('1', undefined, EvalStatus.NOT_EVALUATED),
    createSample('2', undefined, EvalStatus.NOT_EVALUATED),
  ];

  expect(aggregateSamples(samples)).toBe(samples[0]);
});

it('test_aggregate_samples_pass', () => {
  // The majority of results should be positive.
  const samples = [
    createSample('1', 1.0, EvalStatus.PASSED),
    createSample('2', 1.0, EvalStatus.PASSED),
    createSample('3', 0.0, EvalStatus.FAILED),
  ];

  const aggregationResult = aggregateSamples(samples);

  expect(aggregationResult.score).toBe(1.0);
  expect(aggregationResult.evalStatus).toBe(EvalStatus.PASSED);
});

it('test_aggregate_samples_failure', () => {
  // The majority of results should be negative.
  const samples = [
    createSample('1', 1.0, EvalStatus.PASSED),
    createSample('2', 0.0, EvalStatus.FAILED),
    createSample('3', 0.0, EvalStatus.FAILED),
  ];

  const aggregationResult = aggregateSamples(samples);

  expect(aggregationResult.score).toBe(0.0);
  expect(aggregationResult.evalStatus).toBe(EvalStatus.FAILED);
});

it('test_format_conversation_history_with_none_values', () => {
  const invocations: Invocation[] = [
    {invocationId: '1', userContent: {}, finalResponse: undefined},
  ];

  expect(formatConversationHistory(invocations)).toBe('');
});

it('test_format_conversation_history', () => {
  const invocationHistory = createTestInvocations([
    'first user prompt.',
    'first agent response.',
    'second user prompt.',
    'second agent response.',
  ]);

  expect(formatConversationHistory(invocationHistory)).toBe(
    'user: first user prompt.\n' +
      '\n' +
      'model: first agent response.\n' +
      '\n' +
      'user: second user prompt.\n' +
      '\n' +
      'model: second agent response.',
  );
});

it('test_evaluate_first_turn_pass', () => {
  const result = evaluateFirstTurn(
    createTestInvocation('1', 'test starting prompt'),
    createTestConversationScenario('plan', 'test starting prompt'),
    0.8,
  );

  expect(result.score).toBe(1.0);
  expect(result.evalStatus).toBe(EvalStatus.PASSED);
});

it('test_evaluate_first_turn_failure', () => {
  const result = evaluateFirstTurn(
    createTestInvocation('1', 'wrong starting prompt'),
    createTestConversationScenario('plan', 'test starting prompt'),
    1.0,
  );

  expect(result.score).toBe(0.0);
  expect(result.evalStatus).toBe(EvalStatus.FAILED);
});

describe('test_evaluate_first_turn_not_evaluated_when_user_content_has_no_text', () => {
  // A first turn with empty or absent parts is not evaluated, rather than
  // crashing.
  it.each([[{role: 'user', parts: []}], [{}]])('%o', (userContent) => {
    const result = evaluateFirstTurn(
      {invocationId: '1', userContent},
      createTestConversationScenario('plan', 'test starting prompt'),
      1.0,
    );

    expect(result.score).toBeUndefined();
    expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });
});

it('test_aggregate_conversation_results_all_pass_produces_pass', () => {
  const results = [
    createSample('1', 1.0, EvalStatus.PASSED),
    createSample('2', 1.0, EvalStatus.PASSED),
    createSample('3', 1.0, EvalStatus.PASSED),
    createSample('4', 1.0, EvalStatus.PASSED),
  ];

  const aggregation = aggregateConversationResults(results, 1.0);

  expect(aggregation.overallScore).toBe(1.0);
  expect(aggregation.overallEvalStatus).toBe(EvalStatus.PASSED);
});

it('test_aggregate_conversation_results_percentage_above_threshold_produces_pass', () => {
  const results = [
    createSample('1', 1.0, EvalStatus.PASSED),
    createSample('2', 1.0, EvalStatus.PASSED),
    createSample('3', 0.0, EvalStatus.PASSED),
    createSample('4', 1.0, EvalStatus.PASSED),
  ];

  const aggregation = aggregateConversationResults(results, 0.7);

  expect(aggregation.overallScore).toBe(0.75);
  expect(aggregation.overallEvalStatus).toBe(EvalStatus.PASSED);
});

it('test_aggregate_conversation_results_all_failures_produces_failure', () => {
  const results = [
    createSample('1', 0.0, EvalStatus.FAILED),
    createSample('2', 0.0, EvalStatus.FAILED),
    createSample('3', 0.0, EvalStatus.FAILED),
    createSample('4', 0.0, EvalStatus.FAILED),
  ];

  const aggregation = aggregateConversationResults(results, 1.0);

  expect(aggregation.overallScore).toBe(0.0);
  expect(aggregation.overallEvalStatus).toBe(EvalStatus.FAILED);
});

it('test_aggregate_conversation_percentage_below_threshold_produces_failure', () => {
  const results = [
    createSample('1', 0.0, EvalStatus.FAILED),
    createSample('2', 1.0, EvalStatus.PASSED),
    createSample('3', 1.0, EvalStatus.PASSED),
    createSample('4', 1.0, EvalStatus.PASSED),
  ];

  const aggregation = aggregateConversationResults(results, 1.0);

  expect(aggregation.overallScore).toBe(0.75);
  expect(aggregation.overallEvalStatus).toBe(EvalStatus.FAILED);
});

it('test_evaluate_invocations_all_pass', async () => {
  const evaluator = createTestEvaluator();
  const startingPrompt = 'first user prompt.';
  const invocations = createTestInvocations([
    startingPrompt,
    'model 1.',
    'user 2.',
    'model 2.',
  ]);

  const result = await evaluator.evaluateInvocations(
    invocations,
    undefined,
    createTestConversationScenario('test conversation plan', startingPrompt),
  );

  expect(result.overallScore).toBe(1.0);
  expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  expect(result.perInvocationResults).toHaveLength(2);
  expect(result.perInvocationResults[0].score).toBe(1.0);
  expect(result.perInvocationResults[1].score).toBe(1.0);
});

it('test_evaluate_invocations_none_judge_model_config', async () => {
  const evaluator = new PerTurnUserSimulatorQualityV1({
    evalMetric: {
      metricName: 'test_per_turn_user_simulator_quality_v1',
      threshold: 1.0,
      criterion: {
        threshold: 1.0,
        stopSignal: 'test stop signal',
        judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 1},
      },
    },
    judgeModel: new FakeJudgeLlm([{critique: VALID_CRITIQUE}]),
  });
  const startingPrompt = 'first user prompt.';
  const invocations = createTestInvocations([
    startingPrompt,
    'model 1.',
    'user 2.',
    'model 2.',
  ]);

  const result = await evaluator.evaluateInvocations(
    invocations,
    undefined,
    createTestConversationScenario('test conversation plan', startingPrompt),
  );

  expect(result.overallScore).toBe(1.0);
  expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
});
