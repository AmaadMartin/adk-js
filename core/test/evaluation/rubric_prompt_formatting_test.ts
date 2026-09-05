/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests written for adk-js rather than ported from adk-python: the prompt
 * template filler, the rubric-text matching the filler feeds, and the metric
 * driven end to end against a scripted judge.
 */

import {
  EvalMetric,
  EvalStatus,
  formatPromptTemplate,
  InputValidationError,
  Invocation,
  parseRubricsBasedCriterion,
  PrebuiltMetrics,
  Rubric,
  RubricBasedFinalResponseQualityV1Evaluator,
  RubricScore,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm, JudgeReply} from './fake_judge_llm.js';
import {recordWarnings} from './recording_logger.js';

const RUBRICS: Rubric[] = [
  {rubricId: '1', rubricContent: {textProperty: 'Is the response good?'}},
  {rubricId: '2', rubricContent: {textProperty: 'Is the response bad?'}},
];

function createEvaluator(
  options: {
    judge?: FakeJudgeLlm;
    rubrics?: Rubric[];
    numSamples?: number;
    parallelismLimit?: number;
    includeIntermediateResponsesInFinal?: boolean;
  } = {},
): RubricBasedFinalResponseQualityV1Evaluator {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    criterion: {
      threshold: 0.5,
      rubrics: options.rubrics ?? RUBRICS,
      includeIntermediateResponsesInFinal:
        options.includeIntermediateResponsesInFinal,
      judgeModelOptions: {
        numSamples: options.numSamples ?? 3,
        parallelismLimit: options.parallelismLimit,
      },
    },
  };
  return new RubricBasedFinalResponseQualityV1Evaluator(
    evalMetric,
    options.judge ?? new FakeJudgeLlm([{silent: true}]),
  );
}

function createInvocation(userText = 'Is it warm in Seattle?'): Invocation {
  return {
    userContent: {parts: [{text: userText}]},
    finalResponse: {parts: [{text: 'It is 24C and sunny.'}]},
  };
}

/** A judge answer that scores rubric 1 and rubric 2 with the given verdicts. */
function critique(first: string, second: string): JudgeReply {
  return {
    critique:
      `ID: 1\nProperty: Is the response good?\n` +
      `Rationale: Because.\nVerdict: ${first}\n\n` +
      `ID: 2\nProperty: Is the response bad?\n` +
      `Rationale: Because.\nVerdict: ${second}\n`,
  };
}

function scoresById(
  rubricScores: RubricScore[] | undefined,
): Record<string, number | undefined> {
  return Object.fromEntries(
    (rubricScores ?? []).map((rubricScore) => [
      rubricScore.rubricId,
      rubricScore.score,
    ]),
  );
}

describe('formatPromptTemplate', () => {
  it('leaves a replacement pattern in the value alone', () => {
    const filled = formatPromptTemplate('<{rubrics}>', {
      rubrics: "costs $& and $1, not $'",
    });

    expect(filled).toBe("<costs $& and $1, not $'>");
  });

  it('collapses a doubled brace to a single one', () => {
    expect(formatPromptTemplate('{{"a": {value}}}', {value: '1'})).toBe(
      '{"a": 1}',
    );
  });

  it('leaves a placeholder the values do not name', () => {
    expect(formatPromptTemplate('{known} {unknown}', {known: 'yes'})).toBe(
      'yes {unknown}',
    );
  });

  it('substitutes every occurrence of the same placeholder', () => {
    expect(formatPromptTemplate('{a}-{a}', {a: 'x'})).toBe('x-x');
  });
});

describe('the rendered auto-rater prompt', () => {
  it('leaves no placeholder and no doubled brace behind', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt(createInvocation());

    expect(prompt).not.toMatch(/\{[a-z_]+\}/);
    expect(prompt).not.toContain('{{');
    expect(prompt).not.toContain('}}');
  });

  it('judges the final response alone by default', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt({
      ...createInvocation(),
      intermediateData: {
        invocationEvents: [
          {author: 'agent', content: {parts: [{text: 'Let me look it up.'}]}},
        ],
      },
    });

    expect(prompt).toContain('It is 24C and sunny.');
    expect(prompt).not.toContain('Let me look it up.');
  });

  it('judges the intermediate answers too when the criterion asks', () => {
    const prompt = createEvaluator({
      includeIntermediateResponsesInFinal: true,
    }).formatAutoRaterPrompt({
      ...createInvocation(),
      intermediateData: {
        invocationEvents: [
          {author: 'agent', content: {parts: [{text: 'Let me look it up.'}]}},
        ],
      },
    });

    expect(prompt).toContain(
      '<final_answer>\n  Let me look it up.\nIt is 24C and sunny.\n  </final_answer>',
    );
  });

  it('judges a recorded trajectory of intermediate answers', () => {
    const prompt = createEvaluator({
      includeIntermediateResponsesInFinal: true,
    }).formatAutoRaterPrompt({
      ...createInvocation(),
      intermediateData: {
        toolUses: [],
        toolResponses: [],
        intermediateResponses: [['agent', [{text: 'Checking the forecast.'}]]],
      },
    });

    expect(prompt).toContain(
      '<final_answer>\n  Checking the forecast.\nIt is 24C and sunny.\n  </final_answer>',
    );
  });

  it('judges the final response when the agent recorded no step', () => {
    const prompt = createEvaluator({
      includeIntermediateResponsesInFinal: true,
    }).formatAutoRaterPrompt(createInvocation());

    expect(prompt).toContain(
      '<final_answer>\n  It is 24C and sunny.\n  </final_answer>',
    );
  });

  it('keeps a rubric containing a replacement pattern intact', () => {
    const prompt = createEvaluator({
      rubrics: [
        {rubricId: '1', rubricContent: {textProperty: 'Costs $& not $1'}},
      ],
    }).formatAutoRaterPrompt(createInvocation());

    expect(prompt).toContain('*  [id: 1] Costs $& not $1');
  });
});

describe('rubric text matching', () => {
  it('resolves a rubric the judge wrapped in decoration', () => {
    const evaluator = createEvaluator({
      rubrics: [{rubricId: '1', rubricContent: {textProperty: 'Is a*b good?'}}],
    });
    evaluator.createEffectiveRubricsList();

    const autoRaterScore = evaluator.convertAutoRaterResponseToScore({
      content: {
        parts: [
          {
            text: 'Property: **Is a*b good?**\nRationale: Yes.\nVerdict: yes\n',
          },
        ],
      },
    });

    expect(scoresById(autoRaterScore.rubricScores)).toEqual({'1': 1.0});
  });

  it('does not resolve a rubric whose interior punctuation differs', () => {
    const evaluator = createEvaluator({
      rubrics: [{rubricId: '1', rubricContent: {textProperty: 'Is ab good?'}}],
    });
    evaluator.createEffectiveRubricsList();

    const {result: autoRaterScore, warnings} = recordWarnings(() =>
      evaluator.convertAutoRaterResponseToScore({
        content: {
          parts: [
            {text: 'Property: Is a*b good?\nRationale: Yes.\nVerdict: yes\n'},
          ],
        },
      }),
    );

    expect(autoRaterScore.rubricScores).toEqual([]);
    expect(warnings.join('\n')).toContain('not found in the rubrics');
  });
});

describe('evaluateInvocations against a scripted judge', () => {
  it('settles each rubric by majority vote across three samples', async () => {
    // Rubric 1 wins yes 2-1; rubric 2 wins no 2-1.
    const judge = new FakeJudgeLlm([
      critique('yes', 'yes'),
      critique('yes', 'no'),
      critique('no', 'no'),
    ]);
    const evaluator = createEvaluator({judge});

    const result = await evaluator.evaluateInvocations([createInvocation()]);

    expect(judge.requests).toHaveLength(3);
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(scoresById(result.overallRubricScores)).toEqual({
      '1': 1.0,
      '2': 0.0,
    });
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].score).toBe(0.5);
    expect(scoresById(result.perInvocationResults[0].rubricScores)).toEqual({
      '1': 1.0,
      '2': 0.0,
    });
  });

  it('fails an eval case whose rubrics the judge voted down', async () => {
    const judge = new FakeJudgeLlm([critique('no', 'no')]);

    const result = await createEvaluator({judge}).evaluateInvocations([
      createInvocation(),
    ]);

    expect(result.overallScore).toBe(0.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('runs no more judge calls at once than the parallelism limit', async () => {
    const judge = new FakeJudgeLlm([critique('yes', 'yes')]);
    const evaluator = createEvaluator({
      judge,
      numSamples: 3,
      parallelismLimit: 2,
    });

    await evaluator.evaluateInvocations([
      createInvocation('First turn.'),
      createInvocation('Second turn.'),
    ]);

    expect(judge.requests).toHaveLength(6);
    expect(judge.maxCallsInFlight).toBe(2);
  });

  it('reports an invocation whose judge call failed as not evaluated', async () => {
    const judge = new FakeJudgeLlm([{failure: 'judge is offline'}]);

    const result = await createEvaluator({judge}).evaluateInvocations([
      createInvocation(),
    ]);

    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.overallScore).toBeUndefined();
  });
});

describe('criterion validation', () => {
  it('names the offending property when a judge option has the wrong type', () => {
    expect(() =>
      parseRubricsBasedCriterion({
        threshold: 0.5,
        judge_model_options: {num_samples: 'three'},
      }),
    ).toThrow(
      new InputValidationError(
        'Invalid RubricsBasedCriterion: judgeModelOptions.numSamples:' +
          ' Invalid input: expected number, received string',
      ),
    );
  });

  it('applies the judge model defaults a criterion leaves out', () => {
    const criterion = parseRubricsBasedCriterion({threshold: 0.5});

    expect(criterion.judgeModelOptions.numSamples).toBe(5);
    expect(criterion.judgeModelOptions.parallelismLimit).toBe(1);
    expect(criterion.rubrics).toEqual([]);
  });
});
