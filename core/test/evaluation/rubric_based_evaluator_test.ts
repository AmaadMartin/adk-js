/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_rubric_based_evaluator.py` (`main`).
 */

import {
  AutoRaterResponseParser,
  CriterionParser,
  DefaultAutoRaterResponseParser,
  EvalMetric,
  EvalStatus,
  EvaluationResult,
  InputValidationError,
  Invocation,
  InvocationResultsSummarizer,
  LlmResponse,
  Logger,
  MajorityVotePerInvocationResultsAggregator,
  MeanInvocationResultsSummarizer,
  PerInvocationResult,
  PerInvocationResultsAggregator,
  PrebuiltMetrics,
  Rubric,
  RubricBasedEvaluator,
  RubricBasedEvaluatorOptions,
  RubricResponse,
  RubricScore,
  RubricsBasedCriterion,
  getAverageRubricScore,
  getTextFromContent,
  parseRubricsBasedCriterion,
} from '@google/adk';
import {
  MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {FakeJudgeLlm} from './fake_judge_llm.js';

/** Options every fake evaluator here shares, minus the metric under test. */
function evaluatorOptions(evalMetric: EvalMetric): RubricBasedEvaluatorOptions {
  return {
    evalMetric,
    parseCriterion: parseRubricsBasedCriterion,
    // Keeps the evaluator off `LLMRegistry`, so no test needs credentials.
    judgeModel: new FakeJudgeLlm([{critique: 'unused'}]),
  };
}

/** A concrete evaluator, standing in for a real rubric metric. */
class FakeRubricBasedEvaluator extends RubricBasedEvaluator {
  constructor(evalMetric: EvalMetric, rubricType?: string) {
    super({...evaluatorOptions(evalMetric), rubricType});
  }

  override formatAutoRaterPrompt(): string {
    return 'fake response';
  }
}

/** An evaluator that exposes `RubricBasedEvaluator`'s injectable pieces. */
class ConfigurableFakeRubricBasedEvaluator extends RubricBasedEvaluator {
  constructor(
    evalMetric: EvalMetric,
    collaborators: Partial<RubricBasedEvaluatorOptions> = {},
  ) {
    super({...evaluatorOptions(evalMetric), ...collaborators});
  }

  override formatAutoRaterPrompt(): string {
    return 'fake prompt';
  }
}

function createPerInvocationResult(
  rubricScores: RubricScore[],
): PerInvocationResult {
  return {
    actualInvocation: {userContent: {parts: [{text: 'part_1'}]}},
    expectedInvocation: {userContent: {parts: [{text: 'part_2'}]}},
    score: getAverageRubricScore(rubricScores),
    rubricScores,
    evalStatus: EvalStatus.NOT_EVALUATED,
  };
}

/** The two-rubric metric the reference fixture builds. */
function createEvaluatorMetric(): EvalMetric {
  return {
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    threshold: 0.5,
    criterion: {
      threshold: 0.5,
      rubrics: [
        {
          rubricId: '1',
          rubricContent: {textProperty: 'Is the response good?'},
        },
        {
          rubricId: '2',
          rubricContent: {textProperty: 'Is the response bad?'},
        },
      ],
      judgeModelOptions: {numSamples: 3},
    },
  };
}

/** A metric whose criterion carries no rubrics at all. */
function createRubriclessMetric(): EvalMetric {
  return {
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    threshold: 0.5,
    criterion: {threshold: 0.5, judgeModelOptions: {numSamples: 3}},
  };
}

/** A metric whose own threshold differs from its criterion's. */
function metricWithThresholds(
  metricThreshold: number | undefined,
  criterionThreshold: number,
): EvalMetric {
  return {
    ...createEvaluatorMetric(),
    threshold: metricThreshold,
    criterion: {
      ...createEvaluatorMetric().criterion,
      threshold: criterionThreshold,
    },
  };
}

function llmResponse(text: string): LlmResponse {
  return {content: {parts: [{text}]}};
}

/** Records the threshold it is handed and returns a fixed result. */
class RecordingAggregator implements PerInvocationResultsAggregator {
  readonly thresholds: number[] = [];
  readonly receivedSamples: PerInvocationResult[][] = [];

  constructor(private readonly result: PerInvocationResult) {}

  aggregate(
    perInvocationSamples: PerInvocationResult[],
    threshold: number,
  ): PerInvocationResult {
    this.thresholds.push(threshold);
    this.receivedSamples.push(perInvocationSamples);
    return this.result;
  }
}

/** Records the threshold it is handed and returns a fixed result. */
class RecordingSummarizer implements InvocationResultsSummarizer {
  readonly thresholds: number[] = [];

  constructor(private readonly result: EvaluationResult) {}

  summarize(
    perInvocationResults: PerInvocationResult[],
    threshold: number,
  ): EvaluationResult {
    this.thresholds.push(threshold);
    return this.result;
  }
}

/** Returns a fixed list of rubric responses, ignoring the raw text. */
class FixedResponseParser implements AutoRaterResponseParser {
  constructor(private readonly rubricResponses: RubricResponse[]) {}

  parse(): RubricResponse[] {
    return [...this.rubricResponses];
  }
}

/**
 * Captures the warnings the evaluator logs, and keeps the `@experimental`
 * notice the base class emits on first construction out of the test output.
 */
let warn: MockInstance<Logger['warn']>;

beforeEach(() => {
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The text of every warning recorded so far, joined for substring matching. */
function warningText(): string {
  return warn.mock.calls.map((call) => call.join(' ')).join('\n');
}

describe('TestDefaultAutoRaterResponseParser', () => {
  it('test_parse_auto_rater_response_with_empty_string', () => {
    expect(new DefaultAutoRaterResponseParser().parse('')).toEqual([]);
  });

  it('test_parse_auto_rater_response_with_malformed_string', () => {
    const response =
      'This is just some random text without the expected format.';
    expect(new DefaultAutoRaterResponseParser().parse(response)).toEqual([]);
  });

  it('test_parse_auto_rater_response_with_single_yes_verdict', () => {
    const response = `
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].propertyText).toBe('Is the response good?');
    expect(parsed[0].rationale).toBe('It was good.');
    expect(parsed[0].score).toBe(1.0);
  });

  it('test_parse_auto_rater_response_with_single_no_verdict', () => {
    const response = `
      Property: Is the response bad?
      Rationale: It was bad.
      Verdict: no
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].propertyText).toBe('Is the response bad?');
    expect(parsed[0].rationale).toBe('It was bad.');
    expect(parsed[0].score).toBe(0.0);
  });

  it('test_parse_auto_rater_response_with_invalid_verdict', () => {
    const response = `
      Property: Is it unclear?
      Rationale: I cannot tell.
      Verdict: maybe
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].propertyText).toBe('Is it unclear?');
    expect(parsed[0].rationale).toBe('I cannot tell.');
    expect(parsed[0].score).toBeUndefined();
  });

  it('test_parse_auto_rater_response_with_multiple_verdicts', () => {
    const response = `
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      Property: Is the response bad?
      Rationale: It was not bad.
      Verdict: no
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].propertyText).toBe('Is the response good?');
    expect(parsed[0].rationale).toBe('It was good.');
    expect(parsed[0].score).toBe(1.0);
    expect(parsed[1].propertyText).toBe('Is the response bad?');
    expect(parsed[1].rationale).toBe('It was not bad.');
    expect(parsed[1].score).toBe(0.0);
  });

  it('test_parse_auto_rater_response_with_incomplete_entry', () => {
    // The second block has no `Verdict` line.
    const response = `
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      Property: Is the response bad?
      Rationale: It was not bad.
      `;
    expect(new DefaultAutoRaterResponseParser().parse(response)).toEqual([]);
  });

  it('test_parse_auto_rater_response_with_case_insensitive_verdict', () => {
    const response = `
      Property: Is the response good?
      Rationale: It was good.
      Verdict: Yes
      Property: Is the response bad?
      Rationale: It was bad.
      Verdict: NO
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].score).toBe(1.0);
    expect(parsed[1].score).toBe(0.0);
  });

  it('test_parse_auto_rater_response_with_id', () => {
    const response = `
      ID: 1
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rubricId).toBe('1');
    expect(parsed[0].propertyText).toBe('Is the response good?');
    expect(parsed[0].score).toBe(1.0);
  });

  it('test_parse_auto_rater_response_without_id_leaves_id_none', () => {
    const response = `
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rubricId).toBeUndefined();
    expect(parsed[0].propertyText).toBe('Is the response good?');
  });

  it('test_parse_auto_rater_response_with_first_id_present_second_absent', () => {
    const response = `
      ID: 1
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      Property: Is the response bad?
      Rationale: It was not bad.
      Verdict: no
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].rubricId).toBe('1');
    expect(parsed[0].propertyText).toBe('Is the response good?');
    expect(parsed[1].rubricId).toBeUndefined();
    expect(parsed[1].propertyText).toBe('Is the response bad?');
  });

  it('test_parse_auto_rater_response_with_first_id_omitted_second_present', () => {
    const response = `
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      ID: 2
      Property: Is the response bad?
      Rationale: It was not bad.
      Verdict: no
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].rubricId).toBeUndefined();
    expect(parsed[0].propertyText).toBe('Is the response good?');
    expect(parsed[1].rubricId).toBe('2');
    expect(parsed[1].propertyText).toBe('Is the response bad?');
  });

  it('test_parse_auto_rater_response_ignores_mid_line_id_substring', () => {
    const response = `
      Property: Is the response good?
      Rationale: The session UUID: abc-123 was fine.
      Verdict: yes
      `;
    const parsed = new DefaultAutoRaterResponseParser().parse(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rubricId).toBeUndefined();
    expect(parsed[0].propertyText).toBe('Is the response good?');
  });
});

describe('TestMajorityVotePerInvocationResultsAggregator', () => {
  it('test_aggregate_per_invocation_samples_with_no_rubric_scores', () => {
    const samples = [
      createPerInvocationResult([]),
      createPerInvocationResult([]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    expect(result.score).toBeUndefined();
    expect(result.rubricScores).toEqual([]);
  });

  it('test_aggregate_per_invocation_samples_with_majority_positive', () => {
    const samples = [
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
      createPerInvocationResult([{rubricId: '1', score: 0.0}]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    expect(result.score).toBe(1.0);
    expect(result.rubricScores).toEqual([{rubricId: '1', score: 1.0}]);
  });

  it('test_aggregate_per_invocation_samples_with_majority_negative', () => {
    const samples = [
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
      createPerInvocationResult([{rubricId: '1', score: 0.0}]),
      createPerInvocationResult([{rubricId: '1', score: 0.0}]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    expect(result.score).toBe(0.0);
    expect(result.rubricScores).toEqual([{rubricId: '1', score: 0.0}]);
  });

  it('test_aggregate_per_invocation_samples_with_tie_verdicts', () => {
    const samples = [
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
      createPerInvocationResult([{rubricId: '1', score: 0.0}]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    // A tie loses.
    expect(result.score).toBe(0.0);
    expect(result.rubricScores).toEqual([{rubricId: '1', score: 0.0}]);
  });

  it('test_aggregate_per_invocation_samples_with_all_none_scores', () => {
    const samples = [
      createPerInvocationResult([{rubricId: '1', rationale: 'r1'}]),
      createPerInvocationResult([{rubricId: '1', rationale: 'r2'}]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    expect(result.score).toBeUndefined();
    expect(result.rubricScores).toHaveLength(1);
    expect(result.rubricScores?.[0].rubricId).toBe('1');
    expect(result.rubricScores?.[0].score).toBeUndefined();
    expect(result.rubricScores?.[0].rationale).toBe('r1');
  });

  it('test_aggregate_per_invocation_samples_with_multiple_rubrics', () => {
    const samples = [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
      createPerInvocationResult([
        {rubricId: '1', score: 0.0},
        {rubricId: '2', score: 1.0},
      ]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    expect(result.score).toBe(0.5);
    expect(result.rubricScores).toEqual([
      {rubricId: '1', score: 1.0},
      {rubricId: '2', score: 0.0},
    ]);
  });
});

describe('TestMeanInvocationResultsSummarizer', () => {
  it('test_summarize_with_empty_list', () => {
    const result = new MeanInvocationResultsSummarizer().summarize([], 0.5);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallRubricScores).toEqual([]);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('test_summarize_with_no_rubric_scores', () => {
    const invocations = [
      createPerInvocationResult([]),
      createPerInvocationResult([]),
    ];
    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );
    expect(result.overallScore).toBeUndefined();
    expect(result.overallRubricScores).toEqual([]);
    expect(result.perInvocationResults).toEqual(invocations);
  });

  it('test_summarize_with_single_invocation', () => {
    const invocations = [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
    ];
    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );
    expect(result.overallScore).toBe(0.5);
    expect(scoresByRubricId(result)).toEqual({'1': 1.0, '2': 0.0});
  });

  it('test_summarize_with_multiple_invocations_single_rubric', () => {
    const invocations = [
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
      createPerInvocationResult([{rubricId: '1', score: 0.0}]),
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
    ];
    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );
    expect(result.overallScore).toBeCloseTo(2 / 3);
    expect(result.overallRubricScores).toHaveLength(1);
    expect(result.overallRubricScores?.[0].rubricId).toBe('1');
    expect(result.overallRubricScores?.[0].score).toBeCloseTo(2 / 3);
  });

  it('test_summarize_with_multiple_invocations_and_rubrics', () => {
    const invocations = [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
      createPerInvocationResult([
        {rubricId: '1', score: 0.0},
        {rubricId: '2', score: 1.0},
      ]),
    ];
    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );
    expect(result.overallScore).toBe(0.5);
    expect(scoresByRubricId(result)).toEqual({'1': 0.5, '2': 0.5});
  });

  it('test_summarize_with_none_scores', () => {
    const invocations = [
      createPerInvocationResult([{rubricId: '1', score: 1.0}, {rubricId: '2'}]),
      createPerInvocationResult([
        {rubricId: '1', score: 0.0},
        {rubricId: '2', score: 1.0},
      ]),
    ];
    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );
    expect(result.overallScore).toBeCloseTo(2 / 3);
    expect(scoresByRubricId(result)).toEqual({'1': 0.5, '2': 1.0});
  });
});

/** The overall rubric scores of a summary, keyed by rubric id. */
function scoresByRubricId(
  result: EvaluationResult,
): Record<string, number | undefined> {
  return Object.fromEntries(
    (result.overallRubricScores ?? []).map((rubricScore) => [
      rubricScore.rubricId,
      rubricScore.score,
    ]),
  );
}

describe('TestRubricBasedEvaluator', () => {
  let evaluator: FakeRubricBasedEvaluator;

  beforeEach(() => {
    evaluator = new FakeRubricBasedEvaluator(createEvaluatorMetric());
  });

  it('test_convert_auto_rater_response_to_score_with_empty_response', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(''),
    );
    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
  });

  it('test_convert_auto_rater_response_to_score_with_malformed_response', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse('This is not a valid format.'),
    );
    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
  });

  it('test_convert_auto_rater_response_to_score_with_none_content', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore({});
    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warningText()).toContain('empty response');
  });

  it('test_convert_auto_rater_response_to_score_warns_on_unparseable', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse('**Verdict**: Yes'),
    );
    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warningText()).toContain('did not match the expected');
  });

  it('test_convert_auto_rater_response_to_score_with_mixed_verdicts', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    Property: Is the response bad?
    Rationale: It was bad.
    Verdict: no
    `),
    );
    expect(autoRaterScore.score).toBe(0.5);
    expect(autoRaterScore.rubricScores).toHaveLength(2);
    expect(autoRaterScore.rubricScores?.[0].score).toBe(1.0);
    expect(autoRaterScore.rubricScores?.[1].score).toBe(0.0);
  });

  it('test_convert_auto_rater_response_to_score_with_invalid_verdict', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    Property: Is the response bad?
    Rationale: I cannot tell.
    Verdict: invalid
    `),
    );
    expect(autoRaterScore.score).toBe(1.0);
    expect(autoRaterScore.rubricScores).toHaveLength(2);
    expect(autoRaterScore.rubricScores?.[0].score).toBe(1.0);
    expect(autoRaterScore.rubricScores?.[1].score).toBeUndefined();
  });

  it('test_convert_auto_rater_response_to_score_with_unknown_property', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response amazing?
    Rationale: It was amazing.
    Verdict: yes
    `),
    );
    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warningText()).toContain('not found in the rubrics');
  });

  it.each([
    '\u2022 Is the response good?',
    '- Is the response good?',
    '* **Is the response good?**',
    '**Is the response good?**',
    '### Is the response good?',
    '```Is the response good?```',
    '> Is the response good?',
    '\u201cIs the response good?\u201d',
    '\u2014 Is the response good?',
    'Is  the   response  good?',
  ])(
    'test_convert_auto_rater_response_to_score_with_decorated_property (%j)',
    (propertyText) => {
      evaluator.createEffectiveRubricsList();
      const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
        llmResponse(
          `Property: ${propertyText}\nRationale: It was good.\nVerdict: yes\n`,
        ),
      );
      expect(
        autoRaterScore.rubricScores?.map((score) => score.rubricId),
      ).toEqual(['1']);
      expect(autoRaterScore.score).toBe(1.0);
    },
  );

  it('test_convert_auto_rater_response_to_score_keeps_non_ascii_rubric', () => {
    const accentedEvaluator = new FakeRubricBasedEvaluator({
      metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      threshold: 0.5,
      criterion: {
        threshold: 0.5,
        rubrics: [
          {
            rubricId: '1',
            rubricContent: {textProperty: "La réponse utilise l'outil"},
          },
        ],
        judgeModelOptions: {numSamples: 1},
      },
    });
    accentedEvaluator.createEffectiveRubricsList();

    const autoRaterScore = accentedEvaluator.convertAutoRaterResponseToScore(
      llmResponse(
        'Property: **La réponse utilise l\u2019outil**\n' +
          'Rationale: Oui.\n' +
          'Verdict: yes\n',
      ),
    );

    expect(autoRaterScore.rubricScores?.map((score) => score.rubricId)).toEqual(
      ['1'],
    );
  });

  it('test_create_effective_rubrics_list_with_invocation_rubrics', () => {
    const invocationRubrics: Rubric[] = [
      {rubricId: '3', rubricContent: {textProperty: 'Invocation rubric'}},
    ];
    evaluator.createEffectiveRubricsList(invocationRubrics);
    expect(rubricIds(evaluator.getEffectiveRubricsList())).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('test_create_effective_rubrics_list_with_duplicate_invocation_rubric_id', () => {
    const invocationRubrics: Rubric[] = [
      {rubricId: '1', rubricContent: {textProperty: 'Invocation rubric'}},
    ];
    expect(() =>
      evaluator.createEffectiveRubricsList(invocationRubrics),
    ).toThrow(InputValidationError);
    expect(() =>
      evaluator.createEffectiveRubricsList(invocationRubrics),
    ).toThrow("Rubric with rubric_id '1' already exists.");
  });

  it('test_create_effective_rubrics_list_with_no_invocation_rubrics', () => {
    evaluator.createEffectiveRubricsList();
    expect(rubricIds(evaluator.getEffectiveRubricsList())).toEqual(['1', '2']);
  });

  it('test_create_effective_rubrics_list_with_no_rubrics_raises_error', () => {
    const rubriclessEvaluator = new FakeRubricBasedEvaluator(
      createRubriclessMetric(),
    );
    expect(() => rubriclessEvaluator.createEffectiveRubricsList()).toThrow(
      /Rubrics are required\./,
    );
  });

  it('test_get_effective_rubrics_list_before_creation_raises_error', () => {
    expect(() => evaluator.getEffectiveRubricsList()).toThrow(
      /Effective rubrics list not initialized\./,
    );
  });

  it('test_create_effective_rubrics_list_multiple_calls', () => {
    evaluator.createEffectiveRubricsList([
      {rubricId: '3', rubricContent: {textProperty: 'Invocation rubric 1'}},
    ]);
    expect(rubricIds(evaluator.getEffectiveRubricsList())).toEqual([
      '1',
      '2',
      '3',
    ]);

    evaluator.createEffectiveRubricsList([
      {rubricId: '4', rubricContent: {textProperty: 'Invocation rubric 2'}},
    ]);
    expect(rubricIds(evaluator.getEffectiveRubricsList())).toEqual([
      '1',
      '2',
      '4',
    ]);
  });

  it('test_create_effective_rubrics_filters_by_rubric_type', () => {
    const evaluatorWithType = new FakeRubricBasedEvaluator(
      createEvaluatorMetric(),
      'TEST_TYPE',
    );
    evaluatorWithType.createEffectiveRubricsList([
      {
        rubricId: 'test_type_rubric',
        rubricContent: {textProperty: 'Invocation rubric 1'},
        type: 'TEST_TYPE',
      },
      {
        rubricId: 'other_type_rubric',
        rubricContent: {textProperty: 'Invocation rubric 2'},
        type: 'OTHER_TYPE',
      },
    ]);

    expect(rubricIds(evaluatorWithType.getEffectiveRubricsList())).toEqual([
      '1',
      '2',
      'test_type_rubric',
    ]);
  });

  it('test_create_effective_rubrics_filters_to_empty_raises_error', () => {
    const typedEvaluator = new FakeRubricBasedEvaluator(
      createRubriclessMetric(),
      'EXPECTED_TYPE',
    );

    expect(() =>
      typedEvaluator.createEffectiveRubricsList([
        {
          rubricId: 'wrong_type_rubric',
          rubricContent: {textProperty: 'Invocation rubric'},
          type: 'WRONG_TYPE',
        },
      ]),
    ).toThrow(/Rubrics are required\./);
  });

  it('test_convert_matches_by_id_when_text_paraphrased', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    ID: 1
    Property: Is the reply excellent?
    Rationale: It was good.
    Verdict: yes
    `),
    );
    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '1', rationale: 'It was good.', score: 1.0},
    ]);
  });

  it('test_convert_does_not_misattribute_when_first_id_omitted', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the reply excellent?
    Rationale: It was good.
    Verdict: yes

    ID: 2
    Property: Is the reply awful?
    Rationale: It was not bad.
    Verdict: no
    `),
    );
    // The first (paraphrased, id-less) property matches no rubric; the second
    // is matched to rubric "2" by its id and keeps its own "no" verdict.
    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '2', rationale: 'It was not bad.', score: 0.0},
    ]);
  });

  it('test_convert_falls_back_to_text_when_id_absent', () => {
    evaluator.createEffectiveRubricsList();
    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    `),
    );
    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '1', rationale: 'It was good.', score: 1.0},
    ]);
  });
});

/** The ids of a rubrics list, in list order. */
function rubricIds(rubrics: Rubric[]): string[] {
  return rubrics.map((rubric) => rubric.rubricId);
}

describe('TestMajorityVoteAggregatorEvalStatus', () => {
  /**
   * Samples where rubric "1" wins yes 2-1 and rubric "2" wins no 2-1, so the
   * aggregated score is mean(1.0, 0.0) == 0.5.
   */
  function splitVerdictSamples(): PerInvocationResult[] {
    return [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
      createPerInvocationResult([
        {rubricId: '1', score: 0.0},
        {rubricId: '2', score: 1.0},
      ]),
    ];
  }

  it('test_aggregated_score_equal_to_threshold_passes', () => {
    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      splitVerdictSamples(),
      0.5,
    );

    expect(result.score).toBe(0.5);
    // The threshold is inclusive, so a score sitting exactly on it passes.
    expect(result.evalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_aggregated_score_just_short_of_threshold_fails', () => {
    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      splitVerdictSamples(),
      0.5000001,
    );

    expect(result.score).toBe(0.5);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });

  it('test_every_rubric_voted_down_scores_zero_and_fails', () => {
    const samples = [
      createPerInvocationResult([
        {rubricId: '1', score: 0.0},
        {rubricId: '2', score: 0.0},
      ]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    expect(result.score).toBe(0.0);
    expect(result.rubricScores?.map((score) => score.score)).toEqual([
      0.0, 0.0,
    ]);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });

  it('test_unscored_rubrics_are_reported_as_not_evaluated', () => {
    const samples = [
      createPerInvocationResult([{rubricId: '1', rationale: 'r1'}]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.0,
    );

    // A threshold of 0.0 clears every real score, but nothing was scored here,
    // so the invocation must come back unevaluated rather than passed.
    expect(result.score).toBeUndefined();
    expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });
});

describe('TestMeanSummarizerScoreAndStatus', () => {
  it('test_overall_score_weights_every_rubric_observation_equally', () => {
    // The first invocation scores rubric "1" 1.0 and rubric "2" 0.0; the
    // second only scores rubric "1" 1.0. The overall score is the mean over
    // all three observations (2/3), not the mean of the two per-rubric means
    // (0.5).
    const invocations = [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
    ];

    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );

    expect(result.overallScore).toBeCloseTo(2 / 3);
    expect(scoresByRubricId(result)).toEqual({'1': 1.0, '2': 0.0});
  });

  it('test_overall_score_equal_to_threshold_passes', () => {
    const invocations = [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
      ]),
    ];

    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('test_overall_score_below_threshold_fails', () => {
    // mean(1.0, 0.0, 0.0) is 1/3, which is under the 0.5 bar.
    const invocations = [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0},
        {rubricId: '2', score: 0.0},
        {rubricId: '3', score: 0.0},
      ]),
    ];

    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );

    expect(result.overallScore).toBeCloseTo(1 / 3);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('test_every_rubric_failing_in_every_invocation_scores_zero', () => {
    const invocations = [
      createPerInvocationResult([
        {rubricId: '1', score: 0.0},
        {rubricId: '2', score: 0.0},
      ]),
      createPerInvocationResult([
        {rubricId: '1', score: 0.0},
        {rubricId: '2', score: 0.0},
      ]),
    ];

    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );

    expect(result.overallScore).toBe(0.0);
    expect(scoresByRubricId(result)).toEqual({'1': 0.0, '2': 0.0});
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('test_no_results_are_reported_as_not_evaluated', () => {
    const result = new MeanInvocationResultsSummarizer().summarize([], 0.0);

    // As above: an empty run must not be read as clearing a 0.0 threshold.
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('test_aggregated_rubric_score_does_not_reuse_a_sample_rationale', () => {
    // A per-rubric mean has no model rationale behind it, so the summarizer
    // must say so rather than promote one sample's rationale to the whole set.
    const invocations = [
      createPerInvocationResult([
        {rubricId: '1', score: 1.0, rationale: 'looked great'},
      ]),
      createPerInvocationResult([
        {rubricId: '1', score: 0.0, rationale: 'looked awful'},
      ]),
    ];

    const result = new MeanInvocationResultsSummarizer().summarize(
      invocations,
      0.5,
    );

    const rationale = result.overallRubricScores?.[0].rationale ?? '';
    expect(rationale).not.toContain('looked great');
    expect(rationale).not.toContain('looked awful');
    expect(rationale).toContain('aggregated score');
  });
});

describe('TestRubricBasedEvaluatorCollaborators', () => {
  it('test_per_invocation_aggregation_uses_the_criterion_threshold', () => {
    const sentinel = createPerInvocationResult([{rubricId: '1', score: 1.0}]);
    const aggregator = new RecordingAggregator(sentinel);
    const evaluator = new ConfigurableFakeRubricBasedEvaluator(
      metricWithThresholds(0.9, 0.1),
      {perInvocationResultsAggregator: aggregator},
    );
    const samples = [createPerInvocationResult([])];

    expect(evaluator.aggregatePerInvocationSamples(samples)).toBe(sentinel);
    expect(aggregator.receivedSamples).toEqual([samples]);
    // The criterion's threshold reaches the aggregator, not the deprecated one.
    expect(aggregator.thresholds).toEqual([0.1]);
  });

  it('test_invocation_summarization_uses_the_criterion_threshold', () => {
    const sentinel: EvaluationResult = {
      overallScore: 0.25,
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    };
    const summarizer = new RecordingSummarizer(sentinel);
    const evaluator = new ConfigurableFakeRubricBasedEvaluator(
      metricWithThresholds(0.9, 0.1),
      {invocationResultsSummarizer: summarizer},
    );

    expect(evaluator.aggregateInvocationResults([])).toBe(sentinel);
    expect(summarizer.thresholds).toEqual([0.1]);
  });

  it('test_criterion_only_metric_still_grades', () => {
    // A metric configured with just a criterion carries no deprecated
    // threshold, and must still produce a real verdict.
    const evaluator = new FakeRubricBasedEvaluator(
      metricWithThresholds(undefined, 0.5),
    );

    const passing = evaluator.aggregatePerInvocationSamples([
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
    ]);
    expect(passing.evalStatus).toBe(EvalStatus.PASSED);
    expect(
      evaluator.aggregateInvocationResults([passing]).overallEvalStatus,
    ).toBe(EvalStatus.PASSED);

    const failing = evaluator.aggregatePerInvocationSamples([
      createPerInvocationResult([{rubricId: '1', score: 0.0}]),
    ]);
    expect(failing.evalStatus).toBe(EvalStatus.FAILED);
    expect(
      evaluator.aggregateInvocationResults([failing]).overallEvalStatus,
    ).toBe(EvalStatus.FAILED);
  });

  it('test_scoring_uses_the_injected_response_parser', () => {
    // The parser is the only thing that reads the auto-rater's raw text, so a
    // parser that ignores that text entirely still drives the scoring.
    const parser = new FixedResponseParser([
      {
        rubricId: '1',
        propertyText: 'a paraphrase no rubric contains',
        rationale: 'fine',
        score: 1.0,
      },
      {
        rubricId: 'not_a_rubric',
        propertyText: 'also unknown',
        rationale: 'fine',
        score: 0.0,
      },
    ]);
    const evaluator = new ConfigurableFakeRubricBasedEvaluator(
      metricWithThresholds(0.5, 0.5),
      {autoRaterResponseParser: parser},
    );
    evaluator.createEffectiveRubricsList();

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse('text the parser ignores'),
    );

    // Only the response naming a known rubric id survives; the unknown one is
    // dropped, so the mean is 1.0 rather than 0.5.
    expect(
      autoRaterScore.rubricScores?.map((score) => [
        score.rubricId,
        score.score,
      ]),
    ).toEqual([['1', 1.0]]);
    expect(autoRaterScore.score).toBe(1.0);
  });
});

/*
 * Paths the reference suite in `google/adk-python` does not reach, and so the
 * ported tests above do not either.
 */

/** A metric whose single rubric declares an id and no text. */
function createTextlessRubricMetric(): EvalMetric {
  return {
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    criterion: {
      threshold: 0.5,
      rubrics: [{rubricId: '1', rubricContent: {}}],
      judgeModelOptions: {numSamples: 1},
    },
  };
}

describe('DefaultAutoRaterResponseParser with a blank id', () => {
  it('reads an ID line that names nothing as no id at all', () => {
    const parsed = new DefaultAutoRaterResponseParser().parse(
      'ID:  \nProperty: Is the response good?\n' +
        'Rationale: It was good.\nVerdict: yes\n',
    );

    expect(parsed).toEqual([
      {
        rubricId: undefined,
        propertyText: 'Is the response good?',
        rationale: 'It was good.',
        score: 1.0,
      },
    ]);
  });
});

describe('RubricBasedEvaluator with rubrics that declare no text', () => {
  it('matches a rubric by its echoed id', () => {
    const evaluator = new ConfigurableFakeRubricBasedEvaluator(
      createTextlessRubricMetric(),
    );
    evaluator.createEffectiveRubricsList();

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse(
        'ID: 1\nProperty: Is the response good?\n' +
          'Rationale: It was good.\nVerdict: yes\n',
      ),
    );

    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '1', rationale: 'It was good.', score: 1.0},
    ]);
  });

  it('drops a verdict that names neither an id nor a property', () => {
    const evaluator = new ConfigurableFakeRubricBasedEvaluator(
      // The rubric declares text, so an absent property text matches nothing.
      {
        metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
        criterion: {
          threshold: 0.5,
          rubrics: [
            {rubricId: '1', rubricContent: {textProperty: 'Is it good?'}},
          ],
        },
      },
      {
        autoRaterResponseParser: new FixedResponseParser([
          {rationale: 'no idea what this graded', score: 1.0},
        ]),
      },
    );
    evaluator.createEffectiveRubricsList();

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      llmResponse('text the parser ignores'),
    );

    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(autoRaterScore.score).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('not found in the rubrics'),
    );
  });
});

describe('RubricBasedEvaluator with a criterion that omits rubrics', () => {
  /** A parser that leaves `rubrics` off the criterion it returns. */
  const parseCriterionWithoutRubrics: CriterionParser<RubricsBasedCriterion> =
    Object.assign((): RubricsBasedCriterion => ({threshold: 0.5}), {
      criterionName: 'RubricsBasedCriterion',
    });

  it('grades against the invocation rubrics alone', () => {
    const evaluator = new ConfigurableFakeRubricBasedEvaluator(
      createTextlessRubricMetric(),
      {parseCriterion: parseCriterionWithoutRubrics},
    );
    evaluator.createEffectiveRubricsList([
      {rubricId: 'inv-1', rubricContent: {textProperty: 'Is it good?'}},
    ]);

    expect(evaluator.getEffectiveRubricsList()).toEqual([
      {rubricId: 'inv-1', rubricContent: {textProperty: 'Is it good?'}},
    ]);
  });
});

describe('aggregating an invocation that was never scored', () => {
  /** The shape `LlmAsJudge` emits for a sample whose judge call failed. */
  const unscored: PerInvocationResult = {
    actualInvocation: {userContent: {parts: [{text: 'hello'}]}},
    evalStatus: EvalStatus.NOT_EVALUATED,
  };

  it('majority vote reports no rubric scores', () => {
    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      [unscored],
      0.5,
    );

    expect(result.score).toBeUndefined();
    expect(result.rubricScores).toEqual([]);
    expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('the mean summarizer reports no overall rubric scores', () => {
    const result = new MeanInvocationResultsSummarizer().summarize(
      [unscored],
      0.5,
    );

    expect(result.overallScore).toBeUndefined();
    expect(result.overallRubricScores).toEqual([]);
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });
});

/** The metric shape the developer guide's "Get started" section builds. */
class FinalAnswerRubricMetric extends RubricBasedEvaluator {
  constructor(evalMetric: EvalMetric, judgeModel: FakeJudgeLlm) {
    super({evalMetric, parseCriterion: parseRubricsBasedCriterion, judgeModel});
  }

  override formatAutoRaterPrompt(actual: Invocation): string {
    const rubrics = this.getEffectiveRubricsList()
      .map(
        (rubric) =>
          `ID: ${rubric.rubricId}\n` +
          `Property: ${rubric.rubricContent.textProperty}`,
      )
      .join('\n\n');

    return [
      'Answer each property below with a Rationale and a Verdict.',
      `Answer: ${getTextFromContent(actual.finalResponse)}`,
      rubrics,
    ].join('\n\n');
  }
}

/** One judge reply, verdict per rubric in rubric order. */
function critique(...verdicts: string[]): {critique: string} {
  return {
    critique: verdicts
      .map(
        (verdict, index) =>
          `ID: ${index + 1}\nProperty: rubric ${index + 1}\n` +
          `Rationale: because.\nVerdict: ${verdict}`,
      )
      .join('\n\n'),
  };
}

describe('grading a whole eval case through LlmAsJudge', () => {
  const graded: Invocation = {
    userContent: {parts: [{text: 'What is the capital of France?'}]},
    finalResponse: {parts: [{text: 'Paris, per the atlas.'}]},
  };

  const metric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    criterion: {
      threshold: 0.5,
      rubrics: [
        {rubricId: '1', rubricContent: {textProperty: 'It cites a source.'}},
        {rubricId: '2', rubricContent: {textProperty: 'It is concise.'}},
      ],
      judgeModelOptions: {numSamples: 3},
    },
  };

  it('settles each rubric by majority vote over the three samples', async () => {
    // Rubric "1" wins yes 2-1; rubric "2" ties 1-1-1 on yes/no/unreadable, so
    // its single "no" outvotes its single "yes" and it fails.
    const judgeModel = new FakeJudgeLlm([
      critique('yes', 'yes'),
      critique('yes', 'no'),
      critique('no', 'maybe'),
    ]);
    const evaluator = new FinalAnswerRubricMetric(metric, judgeModel);
    evaluator.createEffectiveRubricsList();

    const result = await evaluator.evaluateInvocations([graded]);

    expect(judgeModel.requests).toHaveLength(3);
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(
      result.overallRubricScores?.map((score) => [score.rubricId, score.score]),
    ).toEqual([
      ['1', 1.0],
      ['2', 0.0],
    ]);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('reports the invocation as unevaluated when every judge call fails', async () => {
    const evaluator = new FinalAnswerRubricMetric(
      metric,
      new FakeJudgeLlm([{failure: 'judge unavailable'}]),
    );
    evaluator.createEffectiveRubricsList();

    const result = await evaluator.evaluateInvocations([graded]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });
});
