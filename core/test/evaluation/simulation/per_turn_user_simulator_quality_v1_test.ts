/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_v1.py`.
 * Each `it` name is the reference test name, so a reviewer can grep for it.
 */

import {
  EvalStatus,
  Label,
  PerTurnUserSimulatorQualityV1,
  type AutoRaterScore,
  type ConversationScenario,
  type EvalMetric,
  type Invocation,
  type PerInvocationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  aggregateConversationResults,
  aggregateSamples,
  convertLlmResponseToScore,
  evaluateFirstTurn,
  formatConversationHistory,
  formatJudgePrompt,
  parseIsValidLabel,
} from '../../../src/evaluation/simulation/per_turn_user_simulator_quality_v1.js';
import {FakeJudgeLlm} from '../fake_judge_llm.js';

/** A judge critique whose `is_valid` field holds `label`. */
function critique(label: string): string {
  return `\`\`\`json
  {
    "criteria": [
      {
        "name": "TEST_NAME",
        "reasoning": "test_resonining",
        "passes": True
      }
    ],
    "is_valid": ${label}
  }
  \`\`\``;
}

function createTestEvaluator(
  threshold = 1.0,
  stopSignal = 'test stop signal',
  judgeModel = new FakeJudgeLlm([{critique: critique('True')}]),
): PerTurnUserSimulatorQualityV1 {
  const evalMetric: EvalMetric = {
    metricName: 'test_per_turn_user_simulator_quality_v1',
    threshold,
    criterion: {
      threshold,
      stopSignal,
      judgeModelOptions: {
        judgeModel: 'gemini-2.5-flash',
        judgeModelConfig: {},
        numSamples: 3,
      },
    },
  };
  return new PerTurnUserSimulatorQualityV1(evalMetric, {judgeModel});
}

function createTestConversationScenario(
  conversationPlan = 'test conversation plan',
  startingPrompt = 'test starting prompt',
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
    userContent: {parts: [{text: userContent}], role: 'user'},
    finalResponse: {parts: [{text: modelContent}], role: 'model'},
  };
}

function createTestInvocations(conversationHistory: string[]): Invocation[] {
  expect(conversationHistory.length % 2).toBe(0);

  const invocations: Invocation[] = [];
  for (let turn = 0; turn < conversationHistory.length / 2; turn++) {
    invocations.push(
      createTestInvocation(
        'turn {i}',
        conversationHistory[2 * turn],
        conversationHistory[2 * turn + 1],
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

describe('parseIsValidLabel', () => {
  it.each([
    [
      'is_valid_undefined_key',
      `\`\`\`json
  {
    "is_valid_undefined_key": True
  }
  \`\`\``,
    ],
    ['undefined label', critique('"undefined label",')],
  ])('test_parse_llm_response_label_not_found (%s)', (_name, responseText) => {
    expect(parseIsValidLabel(responseText)).toBe(Label.NOT_FOUND);
  });

  it.each(['True', '"true"', '"valid"'])(
    'test_parse_llm_response_label_valid (%s)',
    (label) => {
      expect(parseIsValidLabel(critique(label))).toBe(Label.VALID);
    },
  );

  it.each([
    'False',
    '"false",',
    '"invalid",',
    '"almost",',
    '"partially_valid",',
    '"partially valid",',
    '"partially",',
  ])('test_parse_llm_response_label_invalid (%s)', (label) => {
    expect(parseIsValidLabel(critique(label))).toBe(Label.INVALID);
  });
});

describe('formatJudgePrompt', () => {
  it('test_format_llm_prompt_raises_error_if_previous_invocations_is_none', () => {
    expect(() =>
      formatJudgePrompt({
        invocation: createTestInvocation('1'),
        conversationScenario: createTestConversationScenario(),
        previousInvocations: undefined,
        stopSignal: 'test stop signal',
      }),
    ).toThrow(/Previous invocations should have a set value/);
  });

  it('test_format_llm_prompt_raises_error_if_conversation_scenario_is_none', () => {
    expect(() =>
      formatJudgePrompt({
        invocation: createTestInvocation('1'),
        conversationScenario: undefined,
        previousInvocations: [],
        stopSignal: 'test stop signal',
      }),
    ).toThrow(/Conversation scenario should have a set value/);
  });
});

describe('convertLlmResponseToScore', () => {
  it('test_convert_llm_response_to_score_pass', () => {
    const score = convertLlmResponseToScore({
      content: {
        parts: [{text: '```json\n{\n  "is_valid": True,\n}\n```'}],
        role: 'model',
      },
    });

    expect(score).toEqual({score: 1.0} satisfies AutoRaterScore);
  });

  it('test_convert_llm_response_to_score_failure', () => {
    const score = convertLlmResponseToScore({
      content: {
        parts: [{text: '```json\n{\n  "is_valid": False,\n}\n```'}],
        role: 'model',
      },
    });

    expect(score).toEqual({score: 0.0} satisfies AutoRaterScore);
  });

  it('test_convert_llm_response_to_score_invalid_json', () => {
    const score = convertLlmResponseToScore({
      content: {parts: [{text: 'invalid json'}], role: 'model'},
    });

    expect(score).toEqual({} satisfies AutoRaterScore);
  });

  it('test_convert_llm_response_to_score_missing_key', () => {
    const score = convertLlmResponseToScore({
      content: {parts: [{text: '{}'}], role: 'model'},
    });

    expect(score).toEqual({} satisfies AutoRaterScore);
  });
});

describe('aggregateSamples', () => {
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

    const result = aggregateSamples(samples);

    expect(result.score).toBe(1.0);
    expect(result.evalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_aggregate_samples_failure', () => {
    // The majority of results should be negative.
    const samples = [
      createSample('1', 1.0, EvalStatus.PASSED),
      createSample('2', 0.0, EvalStatus.FAILED),
      createSample('3', 0.0, EvalStatus.FAILED),
    ];

    const result = aggregateSamples(samples);

    expect(result.score).toBe(0.0);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });
});

describe('formatConversationHistory', () => {
  it('test_format_conversation_history_with_none_values', () => {
    const invocations: Invocation[] = [
      {invocationId: '1', userContent: {}, finalResponse: undefined},
    ];

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

  it.each([{role: 'user', parts: []}, {}])(
    'test_evaluate_first_turn_not_evaluated_when_user_content_has_no_text (%o)',
    (userContent) => {
      const result = evaluateFirstTurn(
        {invocationId: '1', userContent},
        createTestConversationScenario('plan', 'test starting prompt'),
        1.0,
      );

      expect(result.score).toBeUndefined();
      expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
    },
  );
});

describe('aggregateConversationResults', () => {
  it('test_aggregate_conversation_results_all_pass_produces_pass', () => {
    const results = [1, 2, 3, 4].map((turn) =>
      createSample(String(turn), 1.0, EvalStatus.PASSED),
    );

    const aggregation = aggregateConversationResults(results, 1.0);

    expect(aggregation.overallScore).toBe(1.0);
    expect(aggregation.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_aggregate_conversation_results_percentage_above_threshold_produces_pass', () => {
    // The third result passed with a score of 0, so the overall score sums the
    // scores rather than counting the results that passed.
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
    const results = [1, 2, 3, 4].map((turn) =>
      createSample(String(turn), 0.0, EvalStatus.FAILED),
    );

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
});

describe('PerTurnUserSimulatorQualityV1.evaluateInvocations', () => {
  // adk-python replaces the evaluator's private `_sample_llm`. The guidelines
  // forbid reaching a private member, so the judge model is injected instead.
  it('test_evaluate_invocations_all_pass', async () => {
    const evaluator = createTestEvaluator();
    const startingPrompt = 'first user prompt.';

    const result = await evaluator.evaluateInvocations(
      createTestInvocations([
        startingPrompt,
        'model 1.',
        'user 2.',
        'model 2.',
      ]),
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
    const evalMetric: EvalMetric = {
      metricName: 'test_per_turn_user_simulator_quality_v1',
      threshold: 1.0,
      criterion: {
        threshold: 1.0,
        stopSignal: 'test stop signal',
        judgeModelOptions: {
          judgeModel: 'gemini-2.5-flash',
          judgeModelConfig: undefined,
          numSamples: 1,
        },
      },
    };
    const evaluator = new PerTurnUserSimulatorQualityV1(evalMetric, {
      judgeModel: new FakeJudgeLlm([{critique: critique('True')}]),
    });
    const startingPrompt = 'first user prompt.';

    const result = await evaluator.evaluateInvocations(
      createTestInvocations([
        startingPrompt,
        'model 1.',
        'user 2.',
        'model 2.',
      ]),
      undefined,
      createTestConversationScenario('test conversation plan', startingPrompt),
    );

    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });
});
