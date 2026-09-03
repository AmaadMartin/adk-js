/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AutoRaterScore,
  BaseLlm,
  BaseLlmConnection,
  EvalStatus,
  EvaluationResult,
  InputValidationError,
  Invocation,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  LlmAsJudge,
  LlmAsJudgeOptions,
  LlmRequest,
  LlmResponse,
  Logger,
  PerInvocationResult,
  parseLlmAsAJudgeCriterion,
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

import {DEFAULT_RETRY_ATTEMPTS} from '../../src/evaluation/retry_options_utils.js';
import {logger} from '../../src/utils/logger.js';

const AUTO_RATER_RESPONSE: LlmResponse = {
  content: {role: 'model', parts: [{text: 'auto rater response'}]},
};

/** Returns the responses one judge call yields, or throws to fail the call. */
type JudgeResponder = (callIndex: number) => Promise<LlmResponse[]>;

const respondOnce: JudgeResponder = async () => [AUTO_RATER_RESPONSE];

class FakeJudgeModel extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private callIndex = 0;

  constructor(private readonly respond: JudgeResponder = respondOnce) {
    super({model: 'fake-judge-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield* await this.respond(this.callIndex++);
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The fake judge model has no live connection.');
  }
}

class MockLlmAsJudge extends LlmAsJudge<LlmAsAJudgeCriterion> {
  readonly formattedFor: Array<{actual: Invocation; expected?: Invocation}> =
    [];
  readonly scoredResponses: LlmResponse[] = [];
  readonly aggregatedSamples: PerInvocationResult[][] = [];
  aggregateInvocationResultsCalls = 0;
  autoRaterScore: AutoRaterScore = {score: 1.0};

  formatAutoRaterPrompt(actual: Invocation, expected?: Invocation): string {
    this.formattedFor.push({actual, expected});
    return 'formatted prompt';
  }

  convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): AutoRaterScore {
    this.scoredResponses.push(autoRaterResponse);
    return this.autoRaterScore;
  }

  aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult {
    this.aggregatedSamples.push(perInvocationSamples);
    return perInvocationSamples[0];
  }

  aggregateInvocationResults(
    _perInvocationResults: PerInvocationResult[],
  ): EvaluationResult {
    this.aggregateInvocationResultsCalls++;
    return {
      overallScore: 1.0,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    };
  }
}

/** Surfaces the per-invocation results the base class graded. */
class PerInvocationReportingLlmAsJudge extends MockLlmAsJudge {
  aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult {
    this.aggregateInvocationResultsCalls++;
    return {overallEvalStatus: EvalStatus.PASSED, perInvocationResults};
  }
}

function judgeCriterion(
  judgeModelOptions: Partial<JudgeModelOptions> = {},
  threshold = 0.5,
): LlmAsAJudgeCriterion {
  return {
    threshold,
    judgeModelOptions: {
      judgeModel: 'gemini-2.5-flash',
      numSamples: 3,
      parallelismLimit: 1,
      ...judgeModelOptions,
    },
  };
}

function judgeOptions(
  criterion: LlmAsAJudgeCriterion,
  judgeModel: BaseLlm,
): LlmAsJudgeOptions<LlmAsAJudgeCriterion> {
  return {
    evalMetric: {metricName: 'test_metric', threshold: 0.5, criterion},
    parseCriterion: parseLlmAsAJudgeCriterion,
    judgeModel,
  };
}

function createInvocation(invocationId: string): Invocation {
  return {
    invocationId,
    userContent: {
      role: 'user',
      parts: [{text: `user content ${invocationId}`}],
    },
    finalResponse: {
      role: 'model',
      parts: [{text: `final response ${invocationId}`}],
    },
  };
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

describe('LlmAsJudge construction', () => {
  it('rejects a metric that carries no criterion', () => {
    const construct = () =>
      new MockLlmAsJudge({
        evalMetric: {metricName: 'test_metric', threshold: 0.8},
        parseCriterion: parseLlmAsAJudgeCriterion,
        judgeModel: new FakeJudgeModel(),
      });

    expect(construct).toThrow(InputValidationError);
    expect(construct).toThrow(
      '`test_metric` metric expects a criterion of type `LlmAsAJudgeCriterion`.',
    );
  });

  it('rejects a criterion the parser refuses, keeping its report as the cause', () => {
    try {
      new MockLlmAsJudge(
        judgeOptions(
          judgeCriterion({parallelismLimit: 0}),
          new FakeJudgeModel(),
        ),
      );
      expect.fail('the constructor should have rejected the criterion');
    } catch (error) {
      expect(error).toBeInstanceOf(InputValidationError);
      expect(error).toHaveProperty(
        'message',
        '`test_metric` metric expects a criterion of type `LlmAsAJudgeCriterion`.',
      );
      expect(error).toHaveProperty(
        'cause.message',
        expect.stringContaining('Invalid LlmAsAJudgeCriterion'),
      );
    }
  });

  it('rejects a judge model the registry does not know', () => {
    expect(
      () =>
        new MockLlmAsJudge({
          evalMetric: {
            metricName: 'test_metric',
            threshold: 0.8,
            criterion: judgeCriterion({judgeModel: 'unregistered_model'}),
          },
          parseCriterion: parseLlmAsAJudgeCriterion,
        }),
    ).toThrow('Model unregistered_model not found.');
  });
});

describe('LlmAsJudge.evaluateInvocations', () => {
  it('samples each invocation and aggregates once', async () => {
    const judge = new MockLlmAsJudge(
      judgeOptions(judgeCriterion({numSamples: 3}), new FakeJudgeModel()),
    );
    const actualInvocations = [
      createInvocation('id1'),
      createInvocation('id2'),
    ];

    const result = await judge.evaluateInvocations(
      actualInvocations,
      actualInvocations,
    );

    expect(result.overallScore).toBe(1.0);
    expect(judge.formattedFor).toHaveLength(2);
    expect(judge.scoredResponses).toHaveLength(6);
    expect(judge.aggregateInvocationResultsCalls).toBe(1);
  });

  it('grades a criterion-only metric against the criterion threshold', async () => {
    const judge = new PerInvocationReportingLlmAsJudge({
      evalMetric: {
        metricName: 'test_metric',
        criterion: judgeCriterion({numSamples: 1}),
      },
      parseCriterion: parseLlmAsAJudgeCriterion,
      judgeModel: new FakeJudgeModel(),
    });

    const result = await judge.evaluateInvocations([createInvocation('id1')]);

    expect(
      result.perInvocationResults.map((entry) => entry.evalStatus),
    ).toEqual([EvalStatus.PASSED]);
  });

  it('prefers the criterion threshold over the metric threshold', async () => {
    const judge = new PerInvocationReportingLlmAsJudge({
      evalMetric: {
        metricName: 'test_metric',
        threshold: 0.9,
        criterion: judgeCriterion({numSamples: 1}, 0.5),
      },
      parseCriterion: parseLlmAsAJudgeCriterion,
      judgeModel: new FakeJudgeModel(),
    });
    judge.autoRaterScore = {score: 0.8};

    const result = await judge.evaluateInvocations([createInvocation('id1')]);

    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('never runs more judge calls at once than the parallelism limit', async () => {
    let active = 0;
    let maxActive = 0;
    const judgeModel = new FakeJudgeModel(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return [AUTO_RATER_RESPONSE];
    });
    const judge = new MockLlmAsJudge(
      judgeOptions(
        judgeCriterion({numSamples: 3, parallelismLimit: 2}),
        judgeModel,
      ),
    );
    const actualInvocations = [
      createInvocation('id1'),
      createInvocation('id2'),
    ];

    await judge.evaluateInvocations(actualInvocations, actualInvocations);

    expect(judgeModel.requests).toHaveLength(6);
    expect(maxActive).toBe(2);
  });

  it('marks only the invocation whose sample failed as not evaluated', async () => {
    const judgeModel = new FakeJudgeModel(async (callIndex) => {
      if (callIndex === 0) {
        throw new Error('Simulated LLM failure');
      }
      return [AUTO_RATER_RESPONSE];
    });
    const judge = new PerInvocationReportingLlmAsJudge(
      judgeOptions(judgeCriterion({numSamples: 2}), judgeModel),
    );
    const actualInvocations = [
      createInvocation('id1'),
      createInvocation('id2'),
    ];

    const result = await judge.evaluateInvocations(
      actualInvocations,
      actualInvocations,
    );

    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0]).toEqual({
      actualInvocation: actualInvocations[0],
      expectedInvocation: actualInvocations[0],
      evalStatus: EvalStatus.NOT_EVALUATED,
    });
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[1].score).toBe(1.0);
    expect(judge.aggregatedSamples).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Evaluation sample failed for invocation 0'),
    );
  });

  it('marks an invocation not evaluated when the judge yields nothing', async () => {
    const judge = new PerInvocationReportingLlmAsJudge(
      judgeOptions(
        judgeCriterion({numSamples: 1}),
        new FakeJudgeModel(async () => []),
      ),
    );

    const result = await judge.evaluateInvocations([createInvocation('id1')]);

    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'LLM evaluation failed: no response received from judge model',
      ),
    );
  });

  it('rejects a call with no expected invocations when the metric needs them', async () => {
    const judge = new MockLlmAsJudge({
      ...judgeOptions(judgeCriterion(), new FakeJudgeModel()),
      expectedInvocationsRequired: true,
    });

    await expect(
      judge.evaluateInvocations([createInvocation('id1')]),
    ).rejects.toThrow('expectedInvocations is needed by this metric.');
  });

  it('accepts expected invocations when the metric needs them', async () => {
    const judge = new PerInvocationReportingLlmAsJudge({
      ...judgeOptions(judgeCriterion({numSamples: 1}), new FakeJudgeModel()),
      expectedInvocationsRequired: true,
    });
    const actualInvocations = [createInvocation('id1')];

    const result = await judge.evaluateInvocations(
      actualInvocations,
      actualInvocations,
    );

    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('rejects lists of different lengths', async () => {
    const judge = new MockLlmAsJudge(
      judgeOptions(judgeCriterion(), new FakeJudgeModel()),
    );

    await expect(
      judge.evaluateInvocations(
        [createInvocation('id1'), createInvocation('id2')],
        [createInvocation('id1')],
      ),
    ).rejects.toThrow(InputValidationError);
  });

  it('pairs each invocation with no expected one when none are supplied', async () => {
    const judge = new PerInvocationReportingLlmAsJudge(
      judgeOptions(judgeCriterion({numSamples: 1}), new FakeJudgeModel()),
    );

    const result = await judge.evaluateInvocations([createInvocation('id1')]);

    expect(judge.formattedFor[0].expected).toBeUndefined();
    expect(result.perInvocationResults[0].expectedInvocation).toBeUndefined();
  });

  it('reports nothing evaluated for an empty list of invocations', async () => {
    const judge = new MockLlmAsJudge(
      judgeOptions(judgeCriterion(), new FakeJudgeModel()),
    );

    const result = await judge.evaluateInvocations([]);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(judge.aggregateInvocationResultsCalls).toBe(0);
  });

  it('omits an invocation that is never sampled', async () => {
    const judgeModel = new FakeJudgeModel();
    const judge = new MockLlmAsJudge(
      judgeOptions(judgeCriterion({numSamples: 0}), judgeModel),
    );

    const result = await judge.evaluateInvocations([createInvocation('id1')]);

    expect(result.perInvocationResults).toEqual([]);
    expect(judgeModel.requests).toEqual([]);
    expect(judge.aggregateInvocationResultsCalls).toBe(0);
  });

  it('sends one prompt per invocation, shared by that invocation samples', async () => {
    const judgeModel = new FakeJudgeModel();
    const judge = new MockLlmAsJudge(
      judgeOptions(judgeCriterion({numSamples: 3}), judgeModel),
    );

    await judge.evaluateInvocations([createInvocation('id1')]);

    expect(judge.formattedFor).toHaveLength(1);
    expect(judgeModel.requests).toHaveLength(3);
    expect(judgeModel.requests[1]).toBe(judgeModel.requests[0]);
    expect(judgeModel.requests[0].model).toBe('gemini-2.5-flash');
    expect(judgeModel.requests[0].contents).toEqual([
      {role: 'user', parts: [{text: 'formatted prompt'}]},
    ]);
    expect(judgeModel.requests[0].config?.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_RETRY_ATTEMPTS,
    });
  });

  it('sends the judge model config the criterion carries', async () => {
    const judgeModel = new FakeJudgeModel();
    const judge = new MockLlmAsJudge(
      judgeOptions(
        judgeCriterion({
          numSamples: 1,
          judgeModelConfig: {temperature: 0.2},
        }),
        judgeModel,
      ),
    );

    await judge.evaluateInvocations([createInvocation('id1')]);

    expect(judgeModel.requests[0].config?.temperature).toBe(0.2);
  });

  it('keeps a retry policy the judge model config already carries', async () => {
    const judgeModel = new FakeJudgeModel();
    const judge = new MockLlmAsJudge(
      judgeOptions(
        judgeCriterion({
          numSamples: 1,
          judgeModelConfig: {httpOptions: {retryOptions: {attempts: 2}}},
        }),
        judgeModel,
      ),
    );

    await judge.evaluateInvocations([createInvocation('id1')]);

    expect(judgeModel.requests[0].config?.httpOptions?.retryOptions).toEqual({
      attempts: 2,
    });
  });

  it('carries the rubric scores the auto-rater produced', async () => {
    const judge = new PerInvocationReportingLlmAsJudge(
      judgeOptions(judgeCriterion({numSamples: 1}), new FakeJudgeModel()),
    );
    judge.autoRaterScore = {
      score: 0.9,
      rubricScores: [{rubricId: 'r1', score: 1}],
    };

    const result = await judge.evaluateInvocations([createInvocation('id1')]);

    expect(result.perInvocationResults[0].rubricScores).toEqual([
      {rubricId: 'r1', score: 1},
    ]);
  });
});
