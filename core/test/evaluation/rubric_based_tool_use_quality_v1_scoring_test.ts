/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The metric driven end to end against a scripted judge: the prompt reaches
 * the judge, the verdicts come back, and the scores fold up.
 */

import {
  EvalMetric,
  EvalStatus,
  IntermediateData,
  Invocation,
  PrebuiltMetrics,
  Rubric,
  RubricBasedToolUseV1Evaluator,
  RubricScore,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm, JudgeReply} from './fake_judge_llm.js';

const RUBRICS: Rubric[] = [
  {rubricId: '1', rubricContent: {textProperty: 'Was the geocoder called?'}},
  {
    rubricId: '2',
    rubricContent: {textProperty: 'Did the forecast follow the geocoder?'},
  },
];

function createEvaluator(
  options: {
    judge?: FakeJudgeLlm;
    numSamples?: number;
    parallelismLimit?: number;
  } = {},
): RubricBasedToolUseV1Evaluator {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_TOOL_USE_QUALITY_V1,
    criterion: {
      threshold: 0.5,
      rubrics: RUBRICS,
      judgeModelOptions: {
        numSamples: options.numSamples ?? 3,
        parallelismLimit: options.parallelismLimit,
      },
    },
  };
  return new RubricBasedToolUseV1Evaluator(
    evalMetric,
    options.judge ?? new FakeJudgeLlm([{silent: true}]),
  );
}

const INTERMEDIATE_DATA: IntermediateData = {
  toolUses: [
    {name: 'geocode', args: {place: 'Seattle'}, id: 'call1'},
    {name: 'get_weather', args: {lat: 47.6, lng: -122.3}, id: 'call2'},
  ],
  toolResponses: [
    {name: 'geocode', response: {lat: 47.6, lng: -122.3}, id: 'call1'},
    {name: 'get_weather', response: {celsius: 24}, id: 'call2'},
  ],
  intermediateResponses: [],
};

function createInvocation(userText = 'Is it warm in Seattle?'): Invocation {
  return {
    userContent: {parts: [{text: userText}]},
    finalResponse: {parts: [{text: 'It is 24C and sunny.'}]},
    intermediateData: INTERMEDIATE_DATA,
  };
}

/** A judge answer that scores rubric 1 and rubric 2 with the given verdicts. */
function critique(first: string, second: string): JudgeReply {
  return {
    critique:
      `ID: 1\nProperty: Was the geocoder called?\n` +
      `Rationale: Because.\nVerdict: ${first}\n\n` +
      `ID: 2\nProperty: Did the forecast follow the geocoder?\n` +
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

describe('evaluateInvocations against a scripted judge', () => {
  it('asks the judge about the tool calls it is grading', async () => {
    const judge = new FakeJudgeLlm([critique('yes', 'yes')]);

    await createEvaluator({judge, numSamples: 1}).evaluateInvocations([
      createInvocation(),
    ]);

    const prompt = judge.requests[0].contents?.[0]?.parts?.[0]?.text ?? '';
    expect(prompt).toContain('"name": "geocode"');
    expect(prompt).toContain('"name": "get_weather"');
    expect(prompt).toContain('*  [id: 1] Was the geocoder called?');
  });

  it('settles each rubric by majority vote across three samples', async () => {
    // Rubric 1 wins yes 2-1; rubric 2 wins no 2-1.
    const judge = new FakeJudgeLlm([
      critique('yes', 'yes'),
      critique('yes', 'no'),
      critique('no', 'no'),
    ]);

    const result = await createEvaluator({judge}).evaluateInvocations([
      createInvocation(),
    ]);

    expect(judge.requests).toHaveLength(3);
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(scoresById(result.overallRubricScores)).toEqual({
      '1': 1.0,
      '2': 0.0,
    });
    expect(result.perInvocationResults).toHaveLength(1);
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

    await createEvaluator({
      judge,
      numSamples: 3,
      parallelismLimit: 2,
    }).evaluateInvocations([
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

  it('stamps the default retry policy on the judge request', async () => {
    const judge = new FakeJudgeLlm([critique('yes', 'yes')]);

    await createEvaluator({judge, numSamples: 1}).evaluateInvocations([
      createInvocation(),
    ]);

    expect(judge.requests[0].config?.httpOptions?.retryOptions).toEqual({
      attempts: 7,
    });
  });
});
