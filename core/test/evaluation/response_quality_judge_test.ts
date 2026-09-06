/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exercises the `ResponseQualityJudge` that
 * `docs/guides/evaluation/llm_as_judge/index.md` presents, so the guide's
 * example stays a working one. The judge model is injected here, because the
 * guide's own snippet resolves a real Gemini model that needs credentials.
 */

import {
  AutoRaterScore,
  BaseLlm,
  BaseLlmConnection,
  EvalStatus,
  EvaluationResult,
  Invocation,
  LlmAsAJudgeCriterion,
  LlmAsJudge,
  LlmRequest,
  LlmResponse,
  PerInvocationResult,
  getEvalStatus,
  getTextFromContent,
  parseLlmAsAJudgeCriterion,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

/** Scores how well the agent's answer matches the golden one. */
class ResponseQualityJudge extends LlmAsJudge<LlmAsAJudgeCriterion> {
  formatAutoRaterPrompt(actual: Invocation, expected?: Invocation): string {
    return [
      'Rate the answer between 0 and 1. Reply with the number only.',
      `Question: ${getTextFromContent(actual.userContent)}`,
      `Answer: ${getTextFromContent(actual.finalResponse)}`,
      `Reference: ${getTextFromContent(expected?.finalResponse)}`,
    ].join('\n');
  }

  convertAutoRaterResponseToScore(response: LlmResponse): AutoRaterScore {
    const score = Number.parseFloat(getTextFromContent(response.content));
    return {score: Number.isNaN(score) ? undefined : score};
  }

  aggregatePerInvocationSamples(
    samples: PerInvocationResult[],
  ): PerInvocationResult {
    const scores = samples.flatMap((sample) =>
      sample.score === undefined ? [] : [sample.score],
    );
    const score =
      scores.length === 0
        ? undefined
        : scores.reduce((total, value) => total + value, 0) / scores.length;
    return {
      ...samples[0],
      score,
      evalStatus: getEvalStatus(score, this.threshold),
    };
  }

  aggregateInvocationResults(results: PerInvocationResult[]): EvaluationResult {
    const passed = results.filter(
      (result) => result.evalStatus === EvalStatus.PASSED,
    ).length;
    const overallScore = passed / results.length;
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults: results,
    };
  }
}

/** Replies with the texts it was given, one per judge call, in order. */
class ScriptedJudgeModel extends BaseLlm {
  readonly prompts: string[] = [];
  private callIndex = 0;

  constructor(private readonly replies: string[]) {
    super({model: 'scripted-judge-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.prompts.push(llmRequest.contents[0].parts?.[0].text ?? '');
    yield {
      content: {
        role: 'model',
        parts: [{text: this.replies[this.callIndex++]}],
      },
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The scripted judge model has no live connection.');
  }
}

function createInvocation(question: string, answer: string): Invocation {
  return {
    userContent: {role: 'user', parts: [{text: question}]},
    finalResponse: {role: 'model', parts: [{text: answer}]},
  };
}

function createJudge(replies: string[]): {
  judge: ResponseQualityJudge;
  judgeModel: ScriptedJudgeModel;
} {
  const judgeModel = new ScriptedJudgeModel(replies);
  const judge = new ResponseQualityJudge({
    evalMetric: {
      metricName: 'response_quality_v1',
      criterion: {
        threshold: 0.6,
        judgeModelOptions: {
          judgeModel: 'gemini-2.5-flash',
          numSamples: 3,
          parallelismLimit: 2,
        },
      },
    },
    parseCriterion: parseLlmAsAJudgeCriterion,
    judgeModel,
  });
  return {judge, judgeModel};
}

describe('ResponseQualityJudge', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('averages the samples of one invocation and grades the average', async () => {
    const {judge} = createJudge(['0.5', '0.8', '0.8']);
    const actual = [createInvocation('capital of France?', 'Paris')];
    const expected = [createInvocation('capital of France?', 'Paris.')];

    const result = await judge.evaluateInvocations(actual, expected);

    expect(result.perInvocationResults[0].score).toBeCloseTo(0.7);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallScore).toBe(1);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails an invocation whose average falls under the threshold', async () => {
    const {judge} = createJudge(['0.1', '0.2', '0.3']);
    const actual = [createInvocation('capital of France?', 'Berlin')];

    const result = await judge.evaluateInvocations(actual);

    expect(result.perInvocationResults[0].score).toBeCloseTo(0.2);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('scores nothing when the judge replies with no number', async () => {
    const {judge} = createJudge(['unsure', 'unsure', 'unsure']);
    const actual = [createInvocation('capital of France?', 'Paris')];

    const result = await judge.evaluateInvocations(actual);

    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });

  it('sends the question, the answer and the reference in the prompt', async () => {
    const {judge, judgeModel} = createJudge(['0.9', '0.9', '0.9']);
    const actual = [createInvocation('capital of France?', 'Paris')];
    const expected = [createInvocation('capital of France?', 'Paris.')];

    await judge.evaluateInvocations(actual, expected);

    expect(judgeModel.prompts[0]).toBe(
      'Rate the answer between 0 and 1. Reply with the number only.\n' +
        'Question: capital of France?\n' +
        'Answer: Paris\n' +
        'Reference: Paris.',
    );
  });
});
