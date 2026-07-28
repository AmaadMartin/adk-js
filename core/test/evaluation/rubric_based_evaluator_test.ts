/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  DefaultAutoRaterResponseParser,
  EvalMetric,
  EvalStatus,
  getAverageRubricScore,
  getLogger,
  InvocationSchema,
  LLMRegistry,
  LlmResponse,
  MajorityVotePerInvocationResultsAggregator,
  MeanInvocationResultsSummarizer,
  PerInvocationResult,
  PrebuiltMetrics,
  Rubric,
  RubricBasedEvaluator,
  RubricsBasedCriterionSchema,
  RubricScore,
  RubricScoreSchema,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

class MockJudge extends BaseLlm {
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    // Judge is never invoked in these tests (methods are called directly).
  }
  override connect(): Promise<never> {
    throw new Error('not implemented');
  }
}

/** A concrete RubricBasedEvaluator used to exercise the base behavior. */
class FakeRubricBasedEvaluator extends RubricBasedEvaluator {
  constructor(evalMetric: EvalMetric, rubricType?: string) {
    super(evalMetric, rubricType);
  }
  override formatAutoRaterPrompt(): string {
    return 'fake response';
  }
}

function rubricScore(
  rubricId: string,
  score?: number,
  rationale?: string,
): RubricScore {
  return RubricScoreSchema.parse({rubricId, score, rationale});
}

function perInvocationResult(rubricScores: RubricScore[]): PerInvocationResult {
  return {
    actualInvocation: InvocationSchema.parse({
      userContent: {parts: [{text: 'part_1'}]},
    }),
    expectedInvocation: InvocationSchema.parse({
      userContent: {parts: [{text: 'part_2'}]},
    }),
    score: getAverageRubricScore(rubricScores),
    rubricScores,
    evalStatus: EvalStatus.NOT_EVALUATED,
  };
}

function perInvocationResultNoScores(): PerInvocationResult {
  return {
    actualInvocation: InvocationSchema.parse({
      userContent: {parts: [{text: 'x'}]},
    }),
    score: undefined,
    evalStatus: EvalStatus.NOT_EVALUATED,
  };
}

function llmResponse(text: string | undefined): LlmResponse {
  return {content: text === undefined ? undefined : {parts: [{text}]}};
}

function warnLog(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => call.join(' ')).join('\n');
}

describe('DefaultAutoRaterResponseParser', () => {
  const parser = new DefaultAutoRaterResponseParser();

  it('returns [] for an empty string', () => {
    expect(parser.parse('')).toEqual([]);
  });

  it('returns [] for a malformed string', () => {
    expect(
      parser.parse(
        'This is just some random text without the expected format.',
      ),
    ).toEqual([]);
  });

  it('parses a single yes verdict', () => {
    const parsed = parser.parse(`
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes
      `);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].propertyText).toBe('Is the response good?');
    expect(parsed[0].rationale).toBe('It was good.');
    expect(parsed[0].score).toBe(1.0);
  });

  it('parses a single no verdict', () => {
    const parsed = parser.parse(`
      Property: Is the response bad?
      Rationale: It was bad.
      Verdict: no
      `);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].score).toBe(0.0);
  });

  it('maps an invalid verdict to undefined', () => {
    const parsed = parser.parse(`
      Property: Is it unclear?
      Rationale: I cannot tell.
      Verdict: maybe
      `);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].score).toBeUndefined();
  });

  it('parses multiple verdicts', () => {
    const parsed = parser.parse(`
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      Property: Is the response bad?
      Rationale: It was not bad.
      Verdict: no
      `);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].score).toBe(1.0);
    expect(parsed[1].score).toBe(0.0);
  });

  it('returns [] for an incomplete entry', () => {
    const parsed = parser.parse(`
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      Property: Is the response bad?
      Rationale: It was not bad.
      `);
    expect(parsed).toEqual([]);
  });

  it('is case-insensitive for verdicts', () => {
    const parsed = parser.parse(`
      Property: Is the response good?
      Rationale: It was good.
      Verdict: Yes
      Property: Is the response bad?
      Rationale: It was bad.
      Verdict: NO
      `);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].score).toBe(1.0);
    expect(parsed[1].score).toBe(0.0);
  });

  it('captures an echoed rubric id', () => {
    const parsed = parser.parse(`
      ID: 1
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes
      `);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rubricId).toBe('1');
  });

  it('leaves rubric id undefined without an ID line', () => {
    const parsed = parser.parse(`
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes
      `);
    expect(parsed[0].rubricId).toBeUndefined();
  });

  it('keeps an id with its own property when a later property omits its id', () => {
    const parsed = parser.parse(`
      ID: 1
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      Property: Is the response bad?
      Rationale: It was not bad.
      Verdict: no
      `);
    expect(parsed[0].rubricId).toBe('1');
    expect(parsed[1].rubricId).toBeUndefined();
  });

  it('does not shift a later id onto an earlier id-less property', () => {
    const parsed = parser.parse(`
      Property: Is the response good?
      Rationale: It was good.
      Verdict: yes

      ID: 2
      Property: Is the response bad?
      Rationale: It was not bad.
      Verdict: no
      `);
    expect(parsed[0].rubricId).toBeUndefined();
    expect(parsed[1].rubricId).toBe('2');
  });

  it('treats an empty ID line as no id', () => {
    // The "ID: " prefix is present but its value is blank.
    const parsed = parser.parse(
      'ID: \nProperty: Is the response good?\nRationale: r\nVerdict: yes\n',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rubricId).toBeUndefined();
  });

  it('ignores a mid-line ID substring', () => {
    const parsed = parser.parse(`
      Property: Is the response good?
      Rationale: The session UUID: abc-123 was fine.
      Verdict: yes
      `);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].rubricId).toBeUndefined();
  });
});

describe('MajorityVotePerInvocationResultsAggregator', () => {
  const aggregator = new MajorityVotePerInvocationResultsAggregator();

  it('handles samples with no rubric scores', () => {
    const result = aggregator.aggregate(
      [perInvocationResult([]), perInvocationResult([])],
      0.5,
    );
    expect(result.score).toBeUndefined();
    expect(result.rubricScores).toEqual([]);
  });

  it('skips samples that have no rubricScores field', () => {
    const result = aggregator.aggregate([perInvocationResultNoScores()], 0.5);
    expect(result.score).toBeUndefined();
    expect(result.rubricScores).toEqual([]);
  });

  it('takes a majority-positive vote', () => {
    const result = aggregator.aggregate(
      [
        perInvocationResult([rubricScore('1', 1.0)]),
        perInvocationResult([rubricScore('1', 1.0)]),
        perInvocationResult([rubricScore('1', 0.0)]),
      ],
      0.5,
    );
    expect(result.score).toBe(1.0);
    expect(result.rubricScores?.[0].score).toBe(1.0);
  });

  it('takes a majority-negative vote', () => {
    const result = aggregator.aggregate(
      [
        perInvocationResult([rubricScore('1', 1.0)]),
        perInvocationResult([rubricScore('1', 0.0)]),
        perInvocationResult([rubricScore('1', 0.0)]),
      ],
      0.5,
    );
    expect(result.score).toBe(0.0);
    expect(result.rubricScores?.[0].score).toBe(0.0);
  });

  it('breaks ties in favor of negative', () => {
    const result = aggregator.aggregate(
      [
        perInvocationResult([rubricScore('1', 1.0)]),
        perInvocationResult([rubricScore('1', 0.0)]),
      ],
      0.5,
    );
    expect(result.score).toBe(0.0);
  });

  it('keeps the first no-score entry when all scores are undefined', () => {
    const result = aggregator.aggregate(
      [
        perInvocationResult([rubricScore('1', undefined, 'r1')]),
        perInvocationResult([rubricScore('1', undefined, 'r2')]),
      ],
      0.5,
    );
    expect(result.score).toBeUndefined();
    expect(result.rubricScores?.[0].rationale).toBe('r1');
  });

  it('aggregates multiple rubrics independently', () => {
    const result = aggregator.aggregate(
      [
        perInvocationResult([rubricScore('1', 1.0), rubricScore('2', 0.0)]),
        perInvocationResult([rubricScore('1', 1.0), rubricScore('2', 0.0)]),
        perInvocationResult([rubricScore('1', 0.0), rubricScore('2', 1.0)]),
      ],
      0.5,
    );
    expect(result.score).toBe(0.5);
    const byId = new Map(
      result.rubricScores?.map((s) => [s.rubricId, s.score]),
    );
    expect(byId.get('1')).toBe(1.0);
    expect(byId.get('2')).toBe(0.0);
  });
});

describe('MeanInvocationResultsSummarizer', () => {
  const summarizer = new MeanInvocationResultsSummarizer();

  it('handles an empty list', () => {
    const result = summarizer.summarize([], 0.5);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallRubricScores).toEqual([]);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('handles results with no rubric scores', () => {
    const invocations = [perInvocationResult([]), perInvocationResult([])];
    const result = summarizer.summarize(invocations, 0.5);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallRubricScores).toEqual([]);
  });

  it('skips samples that have no rubricScores field', () => {
    const result = summarizer.summarize([perInvocationResultNoScores()], 0.5);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallRubricScores).toEqual([]);
  });

  it('summarizes a single invocation', () => {
    const result = summarizer.summarize(
      [perInvocationResult([rubricScore('1', 1.0), rubricScore('2', 0.0)])],
      0.5,
    );
    expect(result.overallScore).toBe(0.5);
    const byId = new Map(
      result.overallRubricScores?.map((s) => [s.rubricId, s.score]),
    );
    expect(byId.get('1')).toBe(1.0);
    expect(byId.get('2')).toBe(0.0);
  });

  it('averages a single rubric across invocations', () => {
    const result = summarizer.summarize(
      [
        perInvocationResult([rubricScore('1', 1.0)]),
        perInvocationResult([rubricScore('1', 0.0)]),
        perInvocationResult([rubricScore('1', 1.0)]),
      ],
      0.5,
    );
    expect(result.overallScore).toBeCloseTo(2 / 3);
    expect(result.overallRubricScores?.[0].score).toBeCloseTo(2 / 3);
  });

  it('averages multiple invocations and rubrics', () => {
    const result = summarizer.summarize(
      [
        perInvocationResult([rubricScore('1', 1.0), rubricScore('2', 0.0)]),
        perInvocationResult([rubricScore('1', 0.0), rubricScore('2', 1.0)]),
      ],
      0.5,
    );
    expect(result.overallScore).toBe(0.5);
    const byId = new Map(
      result.overallRubricScores?.map((s) => [s.rubricId, s.score]),
    );
    expect(byId.get('1')).toBe(0.5);
    expect(byId.get('2')).toBe(0.5);
  });

  it('ignores undefined scores when averaging', () => {
    const result = summarizer.summarize(
      [
        perInvocationResult([
          rubricScore('1', 1.0),
          rubricScore('2', undefined),
        ]),
        perInvocationResult([rubricScore('1', 0.0), rubricScore('2', 1.0)]),
      ],
      0.5,
    );
    expect(result.overallScore).toBeCloseTo(2 / 3);
    const byId = new Map(
      result.overallRubricScores?.map((s) => [s.rubricId, s.score]),
    );
    expect(byId.get('1')).toBe(0.5);
    expect(byId.get('2')).toBe(1.0);
  });
});

describe('RubricBasedEvaluator', () => {
  function makeEvaluator(
    rubrics: Rubric[] | undefined,
    rubricType?: string,
  ): FakeRubricBasedEvaluator {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new MockJudge({model: 'm'}),
    );
    return new FakeRubricBasedEvaluator(
      {
        metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
        threshold: 0.5,
        criterion: RubricsBasedCriterionSchema.parse({
          threshold: 0.5,
          rubrics: rubrics ?? [],
          judgeModelOptions: {numSamples: 3},
        }),
      },
      rubricType,
    );
  }

  const defaultRubrics: Rubric[] = [
    {rubricId: '1', rubricContent: {textProperty: 'Is the response good?'}},
    {rubricId: '2', rubricContent: {textProperty: 'Is the response bad?'}},
  ];

  let evaluator: FakeRubricBasedEvaluator;

  beforeEach(() => {
    evaluator = makeEvaluator(defaultRubrics);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scores an empty response as empty and warns', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(llmResponse(''));
    expect(score.score).toBeUndefined();
    expect(score.rubricScores).toEqual([]);
    expect(warnLog(warnSpy)).toContain('empty response');
  });

  it('warns when the response cannot be parsed', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
      llmResponse('This is not a valid format.'),
    );
    expect(score.rubricScores).toEqual([]);
    expect(warnLog(warnSpy)).toContain('did not match the expected');
  });

  it('handles a response with no content', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
      llmResponse(undefined),
    );
    expect(score.score).toBeUndefined();
    expect(score.rubricScores).toEqual([]);
    expect(warnLog(warnSpy)).toContain('empty response');
  });

  it('scores mixed verdicts', () => {
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    Property: Is the response bad?
    Rationale: It was bad.
    Verdict: no
    `),
    );
    expect(score.score).toBe(0.5);
    expect(score.rubricScores).toHaveLength(2);
    expect(score.rubricScores?.[0].score).toBe(1.0);
    expect(score.rubricScores?.[1].score).toBe(0.0);
  });

  it('scores an invalid verdict as undefined', () => {
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    Property: Is the response bad?
    Rationale: I cannot tell.
    Verdict: invalid
    `),
    );
    expect(score.score).toBe(1.0);
    expect(score.rubricScores?.[0].score).toBe(1.0);
    expect(score.rubricScores?.[1].score).toBeUndefined();
  });

  it('drops an unknown property', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response amazing?
    Rationale: It was amazing.
    Verdict: yes
    `),
    );
    expect(score.score).toBeUndefined();
    expect(score.rubricScores).toEqual([]);
    expect(warnLog(warnSpy)).toContain('not found in the rubrics');
  });

  it('merges invocation rubrics into the effective list', () => {
    evaluator.createEffectiveRubricsList([
      {rubricId: '3', rubricContent: {textProperty: 'Invocation rubric'}},
    ]);
    expect(
      new Set(evaluator.getEffectiveRubricsList().map((r) => r.rubricId)),
    ).toEqual(new Set(['1', '2', '3']));
  });

  it('throws on a duplicate invocation rubric id', () => {
    expect(() =>
      evaluator.createEffectiveRubricsList([
        {rubricId: '1', rubricContent: {textProperty: 'Invocation rubric'}},
      ]),
    ).toThrow(/Rubric with rubric_id '1' already exists/);
  });

  it('uses only criterion rubrics when no invocation rubrics are given', () => {
    evaluator.createEffectiveRubricsList(undefined);
    expect(evaluator.getEffectiveRubricsList()).toHaveLength(2);
  });

  it('throws when no rubrics are provided', () => {
    const empty = makeEvaluator([]);
    expect(() => empty.createEffectiveRubricsList(undefined)).toThrow(
      /Rubrics are required/,
    );
  });

  it('throws when the effective list is read before creation', () => {
    expect(() => evaluator.getEffectiveRubricsList()).toThrow(
      /Effective rubrics list not initialized/,
    );
  });

  it('recomputes the effective list on repeated calls', () => {
    evaluator.createEffectiveRubricsList([
      {rubricId: '3', rubricContent: {textProperty: 'Invocation rubric 1'}},
    ]);
    expect(
      new Set(evaluator.getEffectiveRubricsList().map((r) => r.rubricId)),
    ).toEqual(new Set(['1', '2', '3']));
    evaluator.createEffectiveRubricsList([
      {rubricId: '4', rubricContent: {textProperty: 'Invocation rubric 2'}},
    ]);
    expect(
      new Set(evaluator.getEffectiveRubricsList().map((r) => r.rubricId)),
    ).toEqual(new Set(['1', '2', '4']));
  });

  it('filters invocation rubrics by type', () => {
    const typed = makeEvaluator(defaultRubrics, 'TEST_TYPE');
    typed.createEffectiveRubricsList([
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
      new Set(typed.getEffectiveRubricsList().map((r) => r.rubricId)),
    ).toEqual(new Set(['1', '2', 'test_type_rubric']));
  });

  it('throws when type filtering removes every rubric', () => {
    const typed = makeEvaluator([], 'EXPECTED_TYPE');
    expect(() =>
      typed.createEffectiveRubricsList([
        {
          rubricId: 'wrong_type_rubric',
          rubricContent: {textProperty: 'Invocation rubric'},
          type: 'WRONG_TYPE',
        },
      ]),
    ).toThrow(/Rubrics are required/);
  });

  it('matches a rubric by echoed id even when the text is paraphrased', () => {
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    ID: 1
    Property: Is the reply excellent?
    Rationale: It was good.
    Verdict: yes
    `),
    );
    expect(score.rubricScores).toHaveLength(1);
    expect(score.rubricScores?.[0].rubricId).toBe('1');
    expect(score.rubricScores?.[0].score).toBe(1.0);
  });

  it('does not misattribute when the first id is omitted', () => {
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
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
    expect(score.rubricScores).toHaveLength(1);
    expect(score.rubricScores?.[0].rubricId).toBe('2');
    expect(score.rubricScores?.[0].score).toBe(0.0);
  });

  it('defaults judge model options when the criterion omits them', () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new MockJudge({model: 'm'}),
    );
    const evaluatorWithDefaults = new FakeRubricBasedEvaluator({
      metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      threshold: 0.5,
      criterion: RubricsBasedCriterionSchema.parse({
        threshold: 0.5,
        rubrics: defaultRubrics,
      }),
    });
    expect(evaluatorWithDefaults).toBeInstanceOf(RubricBasedEvaluator);
  });

  it('handles effective rubrics without property text', () => {
    const noTextEvaluator = makeEvaluator([
      {rubricId: 'notext', rubricContent: {}},
    ]);
    noTextEvaluator.createEffectiveRubricsList(undefined);
    const score = noTextEvaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    ID: notext
    Property: whatever
    Rationale: r
    Verdict: yes
    `),
    );
    expect(score.rubricScores).toHaveLength(1);
    expect(score.rubricScores?.[0].rubricId).toBe('notext');
  });

  it('falls back to normalized property text when the id is absent', () => {
    evaluator.createEffectiveRubricsList(undefined);
    const score = evaluator.convertAutoRaterResponseToScore(
      llmResponse(`
    Property: Is the response good?
    Rationale: It was good.
    Verdict: yes
    `),
    );
    expect(score.rubricScores).toHaveLength(1);
    expect(score.rubricScores?.[0].rubricId).toBe('1');
    expect(score.rubricScores?.[0].score).toBe(1.0);
  });
});
