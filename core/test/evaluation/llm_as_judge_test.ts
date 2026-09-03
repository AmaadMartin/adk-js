/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  EvalStatus,
  FinalResponseMatchV2Evaluator,
  InputValidationError,
  Invocation,
  JudgeModelOptions,
  LlmAsAJudgeMetric,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';
// The eval system keeps its retry policy internal, so this constant has no
// public export to import it from.
import {DEFAULT_RETRY_ATTEMPTS} from '../../src/evaluation/retry_options_utils.js';
import {FAKE_JUDGE_MODEL, FakeJudgeLlm, JudgeReply} from './fake_judge_llm.js';

const VALID_CRITIQUE = '{"is_the_agent_response_valid": "valid"}';
const INVALID_CRITIQUE = '{"is_the_agent_response_valid": "invalid"}';

/** The model name only this test's registered judge answers to. */
const REGISTERED_JUDGE_MODEL = 'test-only-registered-judge';

/** A judge the registry resolves, for a criterion that names a model. */
class RegisteredJudgeLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    REGISTERED_JUDGE_MODEL,
  ];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: VALID_CRITIQUE}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredJudgeLlm does not support live connections.');
  }
}

function createEvaluator(
  judgeModelOptions: JudgeModelOptions,
  judgeModel?: BaseLlm,
): FinalResponseMatchV2Evaluator {
  const evalMetric: LlmAsAJudgeMetric = {
    metricName: 'final_response_match_v2',
    criterion: {threshold: 0.5, judgeModelOptions},
  };
  return new FinalResponseMatchV2Evaluator(evalMetric, judgeModel);
}

function createInvocation(finalResponse: string): Invocation {
  return {
    userContent: {role: 'user', parts: [{text: 'This is a test query.'}]},
    finalResponse: {role: 'model', parts: [{text: finalResponse}]},
  };
}

function createInvocations(count: number): Invocation[] {
  return Array.from({length: count}, (_, index) =>
    createInvocation(`response ${index}`),
  );
}

function evaluate(
  judgeModelOptions: JudgeModelOptions,
  replies: JudgeReply[],
  invocationCount = 1,
): Promise<[FakeJudgeLlm, Awaited<ReturnType<typeof runEvaluation>>]> {
  const judgeModel = new FakeJudgeLlm(replies);
  const evaluator = createEvaluator(judgeModelOptions, judgeModel);
  return runEvaluation(evaluator, invocationCount).then((result) => [
    judgeModel,
    result,
  ]);
}

function runEvaluation(
  evaluator: FinalResponseMatchV2Evaluator,
  invocationCount: number,
) {
  return evaluator.evaluateInvocations(
    createInvocations(invocationCount),
    createInvocations(invocationCount),
  );
}

describe('LlmAsJudge', () => {
  // Registered once: the registry has no way to drop a class, so a repeated
  // registration would only log that it replaced itself.
  beforeAll(() => {
    LLMRegistry.register(RegisteredJudgeLlm);
  });

  it('rejects an eval case with no reference invocations', async () => {
    const evaluator = createEvaluator({}, new FakeJudgeLlm([{silent: true}]));

    await expect(
      evaluator.evaluateInvocations(createInvocations(1)),
    ).rejects.toThrow(InputValidationError);
  });

  it('rejects invocation lists of different lengths', async () => {
    const evaluator = createEvaluator({}, new FakeJudgeLlm([{silent: true}]));

    await expect(
      evaluator.evaluateInvocations(createInvocations(2), createInvocations(1)),
    ).rejects.toThrow(InputValidationError);
  });

  it('evaluates nothing when there are no invocations', async () => {
    const [judgeModel, result] = await evaluate(
      {},
      [{critique: VALID_CRITIQUE}],
      0,
    );

    expect(judgeModel.requests).toHaveLength(0);
    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
  });

  it('samples the judge and takes the majority verdict', async () => {
    const [judgeModel, result] = await evaluate({numSamples: 3}, [
      {critique: VALID_CRITIQUE},
      {critique: INVALID_CRITIQUE},
      {critique: VALID_CRITIQUE},
    ]);

    expect(judgeModel.requests).toHaveLength(3);
    expect(result.overallScore).toBe(1);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('reports the invocation as not evaluated when a sample fails', async () => {
    const [, result] = await evaluate(
      {numSamples: 2},
      [
        {critique: VALID_CRITIQUE},
        {failure: 'judge is down'},
        {critique: VALID_CRITIQUE},
        {critique: VALID_CRITIQUE},
      ],
      2,
    );

    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[1]).toMatchObject({
      score: 1,
      evalStatus: EvalStatus.PASSED,
    });
    expect(result.overallScore).toBe(1);
  });

  it('reports the invocation as not evaluated when the judge says nothing', async () => {
    const [, result] = await evaluate({numSamples: 1}, [{silent: true}]);

    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('reports the invocation as not evaluated when the judge gives no verdict', async () => {
    const [, result] = await evaluate({numSamples: 1}, [
      {critique: 'I would rather not say.'},
    ]);

    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('runs at most as many judge calls at once as the criterion allows', async () => {
    const [judgeModel] = await evaluate(
      {numSamples: 3, parallelismLimit: 2},
      [{critique: VALID_CRITIQUE}],
      2,
    );

    expect(judgeModel.requests).toHaveLength(6);
    expect(judgeModel.maxCallsInFlight).toBe(2);
  });

  it('runs one judge call at a time by default', async () => {
    const [judgeModel] = await evaluate({numSamples: 3}, [
      {critique: VALID_CRITIQUE},
    ]);

    expect(judgeModel.maxCallsInFlight).toBe(1);
  });

  it.each([{parallelismLimit: 0}, {numSamples: 0}])(
    'rejects the judge options %j',
    (judgeModelOptions) => {
      expect(() =>
        createEvaluator(judgeModelOptions, new FakeJudgeLlm([{silent: true}])),
      ).toThrow(InputValidationError);
    },
  );

  it('sends the judge model name, its config and a retry policy', async () => {
    const judgeModelConfig = {temperature: 0.25};
    const [judgeModel] = await evaluate({numSamples: 1, judgeModelConfig}, [
      {critique: VALID_CRITIQUE},
    ]);

    const request: LlmRequest = judgeModel.requests[0];
    expect(request.model).toBe(FAKE_JUDGE_MODEL);
    expect(request.config?.temperature).toBe(0.25);
    expect(request.config?.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_RETRY_ATTEMPTS,
    });
    expect(request.contents[0].parts?.[0].text).toContain(
      '"Agent response": response 0,',
    );
  });

  it('names the judge it calls, not the one the criterion names', async () => {
    const [judgeModel] = await evaluate(
      {judgeModel: 'a-model-that-is-not-called', numSamples: 1},
      [{critique: VALID_CRITIQUE}],
    );

    // The caller injected this judge, so the request must route to it rather
    // than to the model the criterion names.
    expect(judgeModel.requests[0].model).toBe(FAKE_JUDGE_MODEL);
  });

  it('resolves the judge model the criterion names through the registry', async () => {
    const evaluator = createEvaluator({
      judgeModel: REGISTERED_JUDGE_MODEL,
      numSamples: 1,
    });

    const result = await runEvaluation(evaluator, 1);

    expect(result.overallScore).toBe(1);
  });
});
