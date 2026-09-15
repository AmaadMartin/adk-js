/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_rubric_based_evaluator.py`. Each `it()`
 * keeps the Python test name, so the two suites stay greppable against each
 * other.
 */

import {
  AutoRaterResponseParser,
  DefaultAutoRaterResponseParser,
  EvalMetric,
  EvalStatus,
  EvaluationResult,
  getAverageRubricScore,
  InputValidationError,
  Invocation,
  InvocationResultsSummarizer,
  LlmResponse,
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
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm} from './fake_judge_llm.js';
import {recordWarnings} from './recording_logger.js';

/** A concrete evaluator, so the abstract base can be exercised directly. */
class FakeRubricBasedEvaluator extends RubricBasedEvaluator {
  constructor(options: Omit<RubricBasedEvaluatorOptions, 'judgeModel'>) {
    super({...options, judgeModel: new FakeJudgeLlm([{silent: true}])});
  }

  override formatAutoRaterPrompt(): string {
    return 'fake prompt';
  }
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

const DEFAULT_RUBRICS: Rubric[] = [
  {rubricId: '1', rubricContent: {textProperty: 'Is the response good?'}},
  {rubricId: '2', rubricContent: {textProperty: 'Is the response bad?'}},
];

/** Returns a metric whose own threshold differs from its criterion's. */
function metricWithThresholds(
  metricThreshold: number | undefined,
  criterionThreshold: number,
  rubrics: Rubric[] = DEFAULT_RUBRICS,
): EvalMetric {
  return {
    metricName: PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
    threshold: metricThreshold,
    criterion: {
      threshold: criterionThreshold,
      rubrics,
      judgeModelOptions: {numSamples: 3},
    },
  };
}

function createEvaluator(
  options: Partial<Omit<RubricBasedEvaluatorOptions, 'judgeModel'>> = {},
): FakeRubricBasedEvaluator {
  return new FakeRubricBasedEvaluator({
    evalMetric: metricWithThresholds(0.5, 0.5),
    ...options,
  });
}

function createPerInvocationResult(
  rubricScores: RubricScore[],
): PerInvocationResult {
  const actualInvocation: Invocation = {
    userContent: {parts: [{text: 'part_1'}]},
  };
  const expectedInvocation: Invocation = {
    userContent: {parts: [{text: 'part_2'}]},
  };
  return {
    actualInvocation,
    expectedInvocation,
    score: getAverageRubricScore(rubricScores),
    rubricScores,
    evalStatus: EvalStatus.NOT_EVALUATED,
  };
}

function createLlmResponse(text?: string): LlmResponse {
  return text === undefined ? {} : {content: {parts: [{text}]}};
}

function rubricIds(rubricScores: RubricScore[] | undefined): string[] {
  return (rubricScores ?? []).map((rubricScore) => rubricScore.rubricId);
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

    expect(parsed).toEqual([
      {
        rubricId: undefined,
        propertyText: 'Is the response good?',
        rationale: 'It was good.',
        score: 1.0,
      },
    ]);
  });

  it('test_parse_auto_rater_response_with_single_no_verdict', () => {
    const response = `
      Property: Is the response bad?
      Rationale: It was bad.
      Verdict: no
      `;

    const parsed = new DefaultAutoRaterResponseParser().parse(response);

    expect(parsed).toEqual([
      {
        rubricId: undefined,
        propertyText: 'Is the response bad?',
        rationale: 'It was bad.',
        score: 0.0,
      },
    ]);
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
    // The second entry has no verdict.
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

  it('drops an id line that names no id', () => {
    const response = `
      ID:${' '}
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes
      `;

    const parsed = new DefaultAutoRaterResponseParser().parse(response);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].rubricId).toBeUndefined();
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
    expect(result.rubricScores).toEqual([{rubricId: '1', rationale: 'r1'}]);
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

  it('ignores a sample that assessed no rubric at all', () => {
    const scored = createPerInvocationResult([{rubricId: '1', score: 1.0}]);
    const unscored: PerInvocationResult = {
      actualInvocation: scored.actualInvocation,
      evalStatus: EvalStatus.NOT_EVALUATED,
    };

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      [unscored, scored],
      0.5,
    );

    expect(result.score).toBe(1.0);
    expect(result.rubricScores).toEqual([{rubricId: '1', score: 1.0}]);
    expect(
      new MeanInvocationResultsSummarizer().summarize([unscored], 0.5)
        .overallScore,
    ).toBeUndefined();
  });

  it('carries the invocations of the first sample', () => {
    const samples = [
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
      createPerInvocationResult([{rubricId: '1', score: 1.0}]),
    ];

    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.5,
    );

    expect(result.actualInvocation).toBe(samples[0].actualInvocation);
    expect(result.expectedInvocation).toBe(samples[0].expectedInvocation);
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
    expect(result.overallRubricScores).toHaveLength(2);
    expect(scoresById(result)).toEqual({'1': 1.0, '2': 0.0});
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
    expect(scoresById(result)).toEqual({'1': 0.5, '2': 0.5});
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
    expect(scoresById(result)).toEqual({'1': 0.5, '2': 1.0});
  });
});

function scoresById(
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
  it('test_convert_auto_rater_response_to_score_with_empty_response', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse(''),
    );

    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
  });

  it('test_convert_auto_rater_response_to_score_with_malformed_response', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse('This is not a valid format.'),
    );

    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
  });

  it('test_convert_auto_rater_response_to_score_with_none_content', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();

    const {result: autoRaterScore, warnings} = recordWarnings(() =>
      evaluator.convertAutoRaterResponseToScore(createLlmResponse()),
    );

    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warnings.join('\n')).toContain('empty response');
  });

  it('test_convert_auto_rater_response_to_score_warns_on_unparseable', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();

    const {result: autoRaterScore, warnings} = recordWarnings(() =>
      evaluator.convertAutoRaterResponseToScore(
        createLlmResponse('**Verdict**: Yes'),
      ),
    );

    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warnings.join('\n')).toContain('did not match the expected');
    expect(warnings.join('\n')).toContain('**Verdict**: Yes');
  });

  it('test_convert_auto_rater_response_to_score_with_mixed_verdicts', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();
    const responseText = `
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    Property: Is the response bad?
    Rationale: It was bad.
    Verdict: no
    `;

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse(responseText),
    );

    expect(autoRaterScore.score).toBe(0.5);
    expect(autoRaterScore.rubricScores).toHaveLength(2);
    expect(autoRaterScore.rubricScores?.[0].score).toBe(1.0);
    expect(autoRaterScore.rubricScores?.[1].score).toBe(0.0);
  });

  it('test_convert_auto_rater_response_to_score_with_invalid_verdict', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();
    const responseText = `
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    Property: Is the response bad?
    Rationale: I cannot tell.
    Verdict: invalid
    `;

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse(responseText),
    );

    expect(autoRaterScore.score).toBe(1.0);
    expect(autoRaterScore.rubricScores).toHaveLength(2);
    expect(autoRaterScore.rubricScores?.[0].score).toBe(1.0);
    expect(autoRaterScore.rubricScores?.[1].score).toBeUndefined();
  });

  it('test_convert_auto_rater_response_to_score_with_unknown_property', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();
    const responseText = `
    Property: Is the response amazing?
    Rationale: It was amazing.
    Verdict: yes
    `;

    const {result: autoRaterScore, warnings} = recordWarnings(() =>
      evaluator.convertAutoRaterResponseToScore(
        createLlmResponse(responseText),
      ),
    );

    expect(autoRaterScore.score).toBeUndefined();
    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warnings.join('\n')).toContain('not found in the rubrics');
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
    'test_convert_auto_rater_response_to_score_with_decorated_property [%s]',
    (propertyText) => {
      const evaluator = createEvaluator();
      evaluator.createEffectiveRubricsList();

      const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
        createLlmResponse(
          `Property: ${propertyText}\nRationale: It was good.\nVerdict: yes\n`,
        ),
      );

      expect(rubricIds(autoRaterScore.rubricScores)).toEqual(['1']);
      expect(autoRaterScore.score).toBe(1.0);
    },
  );

  it('test_convert_auto_rater_response_to_score_keeps_non_ascii_rubric', () => {
    const evaluator = createEvaluator({
      evalMetric: metricWithThresholds(0.5, 0.5, [
        {
          rubricId: '1',
          rubricContent: {textProperty: "La réponse utilise l'outil"},
        },
      ]),
    });
    evaluator.createEffectiveRubricsList();

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse(
        'Property: **La réponse utilise l\u2019outil**\n' +
          'Rationale: Oui.\n' +
          'Verdict: yes\n',
      ),
    );

    expect(rubricIds(autoRaterScore.rubricScores)).toEqual(['1']);
  });

  it('test_create_effective_rubrics_list_with_invocation_rubrics', () => {
    const evaluator = createEvaluator();

    evaluator.createEffectiveRubricsList([
      {rubricId: '3', rubricContent: {textProperty: 'Invocation rubric'}},
    ]);

    expect(
      evaluator.getEffectiveRubricsList().map((rubric) => rubric.rubricId),
    ).toEqual(['1', '2', '3']);
  });

  it('test_create_effective_rubrics_list_with_duplicate_invocation_rubric_id', () => {
    const evaluator = createEvaluator();

    expect(() =>
      evaluator.createEffectiveRubricsList([
        {rubricId: '1', rubricContent: {textProperty: 'Invocation rubric'}},
      ]),
    ).toThrow(
      new InputValidationError(
        "Rubric with rubric_id '1' already exists. Rubric defined in" +
          ' invocation conflicts with an existing rubric.',
      ),
    );
  });

  it('rejects a criterion that names the same rubric twice', () => {
    const duplicated: Rubric = {
      rubricId: '1',
      rubricContent: {textProperty: 'Is the response good?'},
    };
    const evaluator = createEvaluator({
      evalMetric: metricWithThresholds(0.5, 0.5, [duplicated, duplicated]),
    });

    expect(() => evaluator.createEffectiveRubricsList()).toThrow(
      new InputValidationError(
        "Rubric with rubric_id '1' already exists. Rubric defined in" +
          ' criterion conflicts with an existing rubric.',
      ),
    );
  });

  it('test_create_effective_rubrics_list_with_no_invocation_rubrics', () => {
    const evaluator = createEvaluator();

    evaluator.createEffectiveRubricsList();

    expect(
      evaluator.getEffectiveRubricsList().map((rubric) => rubric.rubricId),
    ).toEqual(['1', '2']);
  });

  it('test_create_effective_rubrics_list_with_no_rubrics_raises_error', () => {
    const evaluator = createEvaluator({
      evalMetric: metricWithThresholds(0.5, 0.5, []),
    });

    expect(() => evaluator.createEffectiveRubricsList()).toThrow(
      new InputValidationError('Rubrics are required.'),
    );
  });

  it('test_get_effective_rubrics_list_before_creation_raises_error', () => {
    const evaluator = createEvaluator();

    expect(() => evaluator.getEffectiveRubricsList()).toThrow(
      /Effective rubrics list not initialized\./,
    );
  });

  it('test_create_effective_rubrics_list_multiple_calls', () => {
    const evaluator = createEvaluator();

    evaluator.createEffectiveRubricsList([
      {rubricId: '3', rubricContent: {textProperty: 'Invocation rubric 1'}},
    ]);
    expect(
      evaluator.getEffectiveRubricsList().map((rubric) => rubric.rubricId),
    ).toEqual(['1', '2', '3']);

    evaluator.createEffectiveRubricsList([
      {rubricId: '4', rubricContent: {textProperty: 'Invocation rubric 2'}},
    ]);
    expect(
      evaluator.getEffectiveRubricsList().map((rubric) => rubric.rubricId),
    ).toEqual(['1', '2', '4']);
  });

  it('test_create_effective_rubrics_filters_by_rubric_type', () => {
    const evaluator = createEvaluator({rubricType: 'TEST_TYPE'});

    evaluator.createEffectiveRubricsList([
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

    expect(
      evaluator.getEffectiveRubricsList().map((rubric) => rubric.rubricId),
    ).toEqual(['1', '2', 'test_type_rubric']);
  });

  it('test_create_effective_rubrics_filters_to_empty_raises_error', () => {
    const evaluator = createEvaluator({
      evalMetric: metricWithThresholds(0.5, 0.5, []),
      rubricType: 'EXPECTED_TYPE',
    });

    expect(() =>
      evaluator.createEffectiveRubricsList([
        {
          rubricId: 'wrong_type_rubric',
          rubricContent: {textProperty: 'Invocation rubric'},
          type: 'WRONG_TYPE',
        },
      ]),
    ).toThrow(new InputValidationError('Rubrics are required.'));
  });

  it('test_convert_matches_by_id_when_text_paraphrased', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();
    const responseText = `
    ID: 1
    Property: Is the reply excellent?
    Rationale: It was good.
    Verdict: yes
    `;

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse(responseText),
    );

    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '1', rationale: 'It was good.', score: 1.0},
    ]);
  });

  it('test_convert_does_not_misattribute_when_first_id_omitted', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();
    const responseText = `
    Property: Is the reply excellent?
    Rationale: It was good.
    Verdict: yes

    ID: 2
    Property: Is the reply awful?
    Rationale: It was not bad.
    Verdict: no
    `;

    const {result: autoRaterScore} = recordWarnings(() =>
      evaluator.convertAutoRaterResponseToScore(
        createLlmResponse(responseText),
      ),
    );

    // The first property is paraphrased and carries no id, so it matches no
    // rubric. The second is matched by its id and keeps its own verdict.
    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '2', rationale: 'It was not bad.', score: 0.0},
    ]);
  });

  it('test_convert_falls_back_to_text_when_id_absent', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();
    const responseText = `
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    `;

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse(responseText),
    );

    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '1', rationale: 'It was good.', score: 1.0},
    ]);
  });

  it('falls back to the property text when the echoed id is unknown', () => {
    const evaluator = createEvaluator();
    evaluator.createEffectiveRubricsList();
    const responseText = `
    ID: 99
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    `;

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore(
      createLlmResponse(responseText),
    );

    expect(rubricIds(autoRaterScore.rubricScores)).toEqual(['1']);
  });

  it('drops a verdict that names neither an id nor a property', () => {
    const parser = new FixedResponseParser([
      {rationale: 'no property at all', score: 1.0},
    ]);
    const evaluator = createEvaluator({autoRaterResponseParser: parser});
    evaluator.createEffectiveRubricsList();

    const {result: autoRaterScore, warnings} = recordWarnings(() =>
      evaluator.convertAutoRaterResponseToScore(createLlmResponse('ignored')),
    );

    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warnings.join('\n')).toContain('not found in the rubrics');
  });
});

describe('TestMajorityVoteAggregatorEvalStatus', () => {
  /**
   * Returns samples where rubric "1" wins yes 2-1 and rubric "2" wins no 2-1,
   * so the aggregated score is mean(1.0, 0.0) == 0.5.
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
    expect(
      (result.rubricScores ?? []).map((rubricScore) => rubricScore.score),
    ).toEqual([0.0, 0.0]);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });

  it('test_unscored_rubrics_are_reported_as_not_evaluated', () => {
    const samples = [
      createPerInvocationResult([{rubricId: '1', rationale: 'r1'}]),
    ];

    // A threshold of 0.0 clears every real score, but nothing was scored
    // here, so the invocation must come back unevaluated rather than passed.
    const result = new MajorityVotePerInvocationResultsAggregator().aggregate(
      samples,
      0.0,
    );

    expect(result.score).toBeUndefined();
    expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });
});

describe('TestMeanSummarizerScoreAndStatus', () => {
  it('test_overall_score_weights_every_rubric_observation_equally', () => {
    // The first invocation scores rubric "1" 1.0 and rubric "2" 0.0; the
    // second only scores rubric "1" 1.0. The overall score is the mean over
    // all three observations (2/3), not of the two per-rubric means (0.5).
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
    expect(scoresById(result)).toEqual({'1': 1.0, '2': 0.0});
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
    expect(scoresById(result)).toEqual({'1': 0.0, '2': 0.0});
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('test_no_results_are_reported_as_not_evaluated', () => {
    const result = new MeanInvocationResultsSummarizer().summarize([], 0.0);

    // As above: an empty run must not be read as clearing a 0.0 threshold.
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('test_aggregated_rubric_score_does_not_reuse_a_sample_rationale', () => {
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
    const evaluator = createEvaluator({
      evalMetric: metricWithThresholds(0.9, 0.1),
      perInvocationResultsAggregator: aggregator,
    });
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
    const evaluator = createEvaluator({
      evalMetric: metricWithThresholds(0.9, 0.1),
      invocationResultsSummarizer: summarizer,
    });

    expect(evaluator.aggregateInvocationResults([])).toBe(sentinel);
    expect(summarizer.thresholds).toEqual([0.1]);
  });

  it('test_criterion_only_metric_still_grades', () => {
    const evaluator = createEvaluator({
      evalMetric: metricWithThresholds(undefined, 0.5),
    });

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
    const evaluator = createEvaluator({autoRaterResponseParser: parser});
    evaluator.createEffectiveRubricsList();

    const {result: autoRaterScore} = recordWarnings(() =>
      evaluator.convertAutoRaterResponseToScore(
        createLlmResponse('text the parser ignores'),
      ),
    );

    // Only the response naming a known rubric id survives; the unknown one is
    // dropped, so the mean is 1.0 rather than 0.5.
    expect(autoRaterScore.rubricScores).toEqual([
      {rubricId: '1', rationale: 'fine', score: 1.0},
    ]);
    expect(autoRaterScore.score).toBe(1.0);
  });
});
