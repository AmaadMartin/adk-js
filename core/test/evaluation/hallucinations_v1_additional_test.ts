/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The paths `google/adk-python`'s
 * `tests/unittests/evaluation/test_hallucinations_v1.py` does not reach:
 * criterion validation, the judge failure modes, the retry policy, and the
 * report the validator produces.
 */

import {
  AppDetails,
  BaseLlm,
  BaseLlmConnection,
  EvalMetric,
  EvalStatus,
  HallucinationsV1Evaluator,
  InputValidationError,
  Invocation,
  LLMRegistry,
  LlmResponse,
  PrebuiltMetrics,
  createContextForStep,
  evaluateNlResponse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm, JudgeReply} from './fake_judge_llm.js';

/** The attempt count `addDefaultRetryOptionsIfNotPresent` stamps. */
const DEFAULT_RETRY_ATTEMPTS = 7;

const NON_ERROR_FAILURE = 'the judge rejected with a plain string';

const USER_CONTENT = {parts: [{text: 'User query.'}]};

/** A judge that rejects with a value that is not an `Error`. */
class NonErrorJudgeLlm extends BaseLlm {
  constructor() {
    super({model: 'non-error-judge'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield await Promise.reject(NON_ERROR_FAILURE);
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('NonErrorJudgeLlm does not support live connections.');
  }
}

const REGISTERED_JUDGE_MODEL = 'hallucinations-registry-judge';

let registeredJudgeCalls = 0;

/** A judge the metric can only reach through {@link LLMRegistry}. */
class RegisteredJudgeLlm extends BaseLlm {
  static readonly supportedModels = [REGISTERED_JUDGE_MODEL];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    registeredJudgeCalls++;
    yield {content: {role: 'model', parts: [{text: 'no sentence tags'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredJudgeLlm does not support live connections.');
  }
}

LLMRegistry.register(RegisteredJudgeLlm);

function createEvalMetric(
  criterion?: EvalMetric['criterion'],
  metricName: string = PrebuiltMetrics.HALLUCINATIONS_V1,
): EvalMetric {
  return {metricName, threshold: 0.5, criterion};
}

function createEvaluator(replies: JudgeReply[]): {
  judge: FakeJudgeLlm;
  metric: HallucinationsV1Evaluator;
} {
  const judge = new FakeJudgeLlm(replies);
  return {
    judge,
    metric: new HallucinationsV1Evaluator(
      createEvalMetric({threshold: 0.5, evaluateIntermediateNlResponses: true}),
      judge,
    ),
  };
}

function createInvocation(finalResponse = 'Final response.'): Invocation {
  return {
    userContent: USER_CONTENT,
    finalResponse: {parts: [{text: finalResponse}]},
  };
}

describe('criterion validation', () => {
  it('rejects a metric that carries no criterion', () => {
    expect(() => new HallucinationsV1Evaluator(createEvalMetric())).toThrow(
      InputValidationError,
    );
  });

  it('names the metric and the criterion type it expects', () => {
    let thrown: unknown;
    try {
      new HallucinationsV1Evaluator(createEvalMetric(undefined, 'my_metric'));
    } catch (error: unknown) {
      thrown = error;
    }

    if (!(thrown instanceof InputValidationError)) {
      expect.fail('expected an InputValidationError');
    }
    expect(thrown.message).toContain(
      '`my_metric` metric expects a criterion of type' +
        ' `HallucinationsCriterion`.',
    );
    expect(thrown.cause).toBeInstanceOf(Error);
  });

  it('rejects a criterion whose threshold is not a number', () => {
    expect(
      () =>
        new HallucinationsV1Evaluator(
          createEvalMetric({threshold: Number.NaN}),
        ),
    ).toThrow(InputValidationError);
  });

  it('resolves the judge from the registry when none is supplied', async () => {
    const metric = new HallucinationsV1Evaluator(
      createEvalMetric({
        threshold: 0.5,
        judgeModelOptions: {judgeModel: REGISTERED_JUDGE_MODEL},
      }),
    );

    const result = await metric.evaluateInvocations([createInvocation()]);

    expect(registeredJudgeCalls).toBeGreaterThan(0);
    expect(result.perInvocationResults[0].score).toBeUndefined();
  });
});

describe('evaluateInvocations', () => {
  it('returns an empty result for an empty invocation list', async () => {
    const {metric} = createEvaluator([{silent: true}]);

    const result = await metric.evaluateInvocations([]);

    expect(result.perInvocationResults).toEqual([]);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('rejects invocation lists of different lengths', async () => {
    const {metric} = createEvaluator([{silent: true}]);

    await expect(
      metric.evaluateInvocations([createInvocation()], []),
    ).rejects.toThrow(InputValidationError);
  });

  it('stamps the default retry policy on both judge requests', async () => {
    const {judge, metric} = createEvaluator([
      {critique: '<sentence>Final response.</sentence>'},
      {
        critique: [
          'sentence: Final response.',
          'label: supported',
          'rationale: The context says so.',
          'supporting_excerpt: The context says so.',
          'contradicting_excerpt: null',
        ].join('\n'),
      },
    ]);

    const result = await metric.evaluateInvocations([createInvocation()]);

    expect(judge.requests).toHaveLength(2);
    for (const request of judge.requests) {
      expect(request.config?.httpOptions?.retryOptions?.attempts).toBe(
        DEFAULT_RETRY_ATTEMPTS,
      );
    }
    expect(result.perInvocationResults[0].score).toBe(1);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[0].rubricScores).toEqual([]);
  });

  it('ignores a recorded tool trajectory, which carries no events', async () => {
    const {judge, metric} = createEvaluator([
      {critique: '<sentence>Final response.</sentence>'},
      {critique: 'unparseable'},
    ]);

    await metric.evaluateInvocations([
      {
        ...createInvocation(),
        intermediateData: {
          toolUses: [{name: 'tool1', args: {}}],
          toolResponses: [],
          intermediateResponses: [],
        },
      },
    ]);

    const validatorPrompt = judge.requests[1].contents[0].parts?.[0].text ?? '';
    expect(validatorPrompt).not.toContain('tool_calls:');
  });

  it('grades no intermediate step for an event that carries no content', async () => {
    const {judge, metric} = createEvaluator([
      {critique: '<sentence>Final response.</sentence>'},
      {critique: 'unparseable'},
    ]);

    await metric.evaluateInvocations([
      {
        ...createInvocation(),
        intermediateData: {invocationEvents: [{author: 'root'}]},
      },
    ]);

    expect(judge.requests).toHaveLength(2);
  });
});

describe('createContextForStep', () => {
  it('reports that the agent has no tools when the app is unknown', () => {
    const context = createContextForStep(
      undefined,
      {userContent: USER_CONTENT},
      [],
    );

    expect(context.trim()).toBe(
      [
        'Developer instructions:',
        '',
        '',
        'User prompt:',
        'User query.',
        '',
        'Tool definitions:',
        'Agent has no tools.',
      ].join('\n'),
    );
  });

  it('names no agent when the app declares none', () => {
    const context = createContextForStep({}, {userContent: USER_CONTENT}, []);

    expect(context).toContain('Developer instructions:\n\n');
    expect(context).toContain('{\n  "tool_declarations": {}\n}');
  });

  it('skips an agent that carries no instructions', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        root: {name: 'root', instructions: 'Root agent instructions.'},
        silent: {name: 'silent'},
      },
    };

    const context = createContextForStep(
      appDetails,
      {userContent: USER_CONTENT},
      [{author: 'root'}],
    );

    expect(context).toContain('Developer instructions:\nroot:\nRoot agent');
    expect(context).not.toContain('silent:\n');
    expect(context).toContain('"silent": []');
  });
});

describe('evaluateNlResponse', () => {
  it('reports a segmenter that answered nothing', async () => {
    const judge = new FakeJudgeLlm([{silent: true}]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({details: 'Segmenter returned no text.'});
  });

  it('reports a segmenter that produced no sentences', async () => {
    const judge = new FakeJudgeLlm([{critique: 'no tags here'}]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({details: 'No sentences produced by segmenter.'});
  });

  it('reports a segmenter call that failed', async () => {
    const judge = new FakeJudgeLlm([{failure: 'segmenter is down'}]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({
      details: 'Error during sentence segmentation: segmenter is down',
    });
  });

  it('reports a validator that answered nothing', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>One.</sentence>'},
      {silent: true},
    ]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({details: 'Sentence validator returned no text.'});
  });

  it('reports a validator call that failed', async () => {
    const judge = new FakeJudgeLlm([
      {critique: '<sentence>One.</sentence>'},
      {failure: 'validator is down'},
    ]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result).toEqual({
      details: 'Error during sentence validation: validator is down',
    });
  });

  it('reports a judge that rejected with something other than an Error', async () => {
    const result = await evaluateNlResponse(
      new NonErrorJudgeLlm(),
      {},
      'nl',
      'ctx',
    );

    expect(result).toEqual({
      details: `Error during sentence segmentation: ${NON_ERROR_FAILURE}`,
    });
  });

  it('serializes the validator report the way adk-python does', async () => {
    const judge = new FakeJudgeLlm([
      {
        critique:
          '<sentence>Apples are red.</sentence>' +
          '<sentence>Enjoy your fruit!</sentence>',
      },
      {
        critique: [
          'sentence: Apples are red.',
          'label: supported',
          'rationale: The context says apples are red.',
          'supporting_excerpt: Apples are red fruits.',
          'contradicting_excerpt: null',
          '',
          'sentence: Enjoy your fruit!',
          'label: not_applicable',
          'rationale: A greeting needs no attribution.',
          'supporting_excerpt: null',
          'contradicting_excerpt: null',
        ].join('\n'),
      },
    ]);

    const result = await evaluateNlResponse(judge, {}, 'nl', 'ctx');

    expect(result.score).toBe(1);
    expect(JSON.parse(result.details)).toEqual([
      {
        sentence: 'Apples are red.',
        label: 'supported',
        rationale: 'The context says apples are red.',
        supporting_excerpt: 'Apples are red fruits.',
        contradicting_excerpt: null,
      },
      {
        sentence: 'Enjoy your fruit!',
        label: 'not_applicable',
        rationale: 'A greeting needs no attribution.',
        supporting_excerpt: null,
        contradicting_excerpt: null,
      },
    ]);
  });

  it('sends the judge the model it was built with', async () => {
    const judge = new FakeJudgeLlm([{silent: true}]);

    await evaluateNlResponse(judge, {temperature: 0}, 'nl', 'ctx');

    expect(judge.requests[0].model).toBe(judge.model);
    expect(judge.requests[0].config?.temperature).toBe(0);
  });
});
