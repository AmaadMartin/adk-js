/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Paths `rubric_based_evaluator_test.ts` does not reach, because the reference
 * suite in `google/adk-python` does not reach them either.
 */

import {
  AutoRaterResponseParser,
  CriterionParser,
  DefaultAutoRaterResponseParser,
  EvalMetric,
  EvalStatus,
  Invocation,
  LlmResponse,
  Logger,
  MajorityVotePerInvocationResultsAggregator,
  MeanInvocationResultsSummarizer,
  PerInvocationResult,
  PrebuiltMetrics,
  RubricBasedEvaluator,
  RubricBasedEvaluatorOptions,
  RubricResponse,
  RubricsBasedCriterion,
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

/** Returns a fixed list of rubric responses, ignoring the raw text. */
class FixedResponseParser implements AutoRaterResponseParser {
  constructor(private readonly rubricResponses: RubricResponse[]) {}

  parse(): RubricResponse[] {
    return [...this.rubricResponses];
  }
}

class FakeRubricBasedEvaluator extends RubricBasedEvaluator {
  constructor(options: Partial<RubricBasedEvaluatorOptions> = {}) {
    super({
      evalMetric: metricWithRubrics(),
      parseCriterion: parseRubricsBasedCriterion,
      judgeModel: new FakeJudgeLlm([{critique: 'unused'}]),
      ...options,
    });
  }

  override formatAutoRaterPrompt(): string {
    return 'fake prompt';
  }
}

/** A metric whose single rubric declares no text, only an id. */
function metricWithRubrics(): EvalMetric {
  return {
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    criterion: {
      threshold: 0.5,
      rubrics: [{rubricId: '1', rubricContent: {}}],
      judgeModelOptions: {numSamples: 1},
    },
  };
}

const invocation: Invocation = {userContent: {parts: [{text: 'hello'}]}};

function llmResponse(text: string): LlmResponse {
  return {content: {parts: [{text}]}};
}

let warn: MockInstance<Logger['warn']>;

beforeEach(() => {
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
    const evaluator = new FakeRubricBasedEvaluator();
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
    const evaluator = new FakeRubricBasedEvaluator({
      autoRaterResponseParser: new FixedResponseParser([
        {rationale: 'no idea what this graded', score: 1.0},
      ]),
      // The rubric declares text, so an absent property text matches nothing.
      evalMetric: {
        metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
        criterion: {
          threshold: 0.5,
          rubrics: [
            {rubricId: '1', rubricContent: {textProperty: 'Is it good?'}},
          ],
        },
      },
    });
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
    const evaluator = new FakeRubricBasedEvaluator({
      parseCriterion: parseCriterionWithoutRubrics,
    });
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
    actualInvocation: invocation,
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
