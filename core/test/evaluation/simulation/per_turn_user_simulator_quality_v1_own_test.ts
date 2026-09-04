/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python reference tests do not cover: criterion validation, the
 * judge model the metric actually calls, the stop-signal turn, and the guards
 * around an empty conversation.
 */

import {
  aggregateConversationResults,
  aggregateSamples,
  BaseLlm,
  convertLlmResponseToScore,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  evaluateFirstTurn,
  formatConversationHistory,
  InputValidationError,
  Label,
  LLMRegistry,
  parseIsValidLabel,
  PerTurnUserSimulatorQualityV1,
  type BaseLlmConnection,
  type ConversationScenario,
  type EvalMetric,
  type Invocation,
  type LlmResponse,
  type PerInvocationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  FAKE_JUDGE_MODEL,
  FakeJudgeLlm,
  type JudgeReply,
} from '../fake_judge_llm.js';

const STARTING_PROMPT = 'first user prompt.';
const VALID_CRITIQUE = '{"is_valid": true}';
const INVALID_CRITIQUE = '{"is_valid": false}';

const SCENARIO: ConversationScenario = {
  startingPrompt: STARTING_PROMPT,
  conversationPlan: 'book a flight',
};

function turn(userText: string, modelText: string): Invocation {
  return {
    invocationId: userText,
    userContent: {role: 'user', parts: [{text: userText}]},
    finalResponse: {role: 'model', parts: [{text: modelText}]},
  };
}

const CONVERSATION = [
  turn(STARTING_PROMPT, 'model 1.'),
  turn('user 2.', 'model 2.'),
];

function metricWith(criterion: EvalMetric['criterion']): EvalMetric {
  return {metricName: 'per_turn_user_simulator_quality_v1', criterion};
}

const REGISTERED_JUDGE_MODEL = 'registry-resolved-test-judge';

/** A judge the metric can only reach by resolving it through `LLMRegistry`. */
class RegisteredJudgeLlm extends BaseLlm {
  static override readonly supportedModels = [REGISTERED_JUDGE_MODEL];

  /** How many times the metric asked this judge, across all instances. */
  static calls = 0;

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    RegisteredJudgeLlm.calls++;
    yield {content: {role: 'model', parts: [{text: VALID_CRITIQUE}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredJudgeLlm does not support live connections.');
  }
}

function evaluatorWith(
  replies: JudgeReply[],
  criterion: EvalMetric['criterion'],
): {evaluator: PerTurnUserSimulatorQualityV1; judge: FakeJudgeLlm} {
  const judge = new FakeJudgeLlm(replies);
  return {
    evaluator: new PerTurnUserSimulatorQualityV1({
      evalMetric: metricWith(criterion),
      judgeModel: judge,
    }),
    judge,
  };
}

function promptOf(judge: FakeJudgeLlm, requestIndex: number): string {
  const text = judge.requests[requestIndex].contents[0].parts?.[0].text;
  if (text === undefined) {
    return expect.fail('The judge was sent a request with no prompt text.');
  }
  return text;
}

describe('PerTurnUserSimulatorQualityV1 construction', () => {
  it('rejects a metric that carries no criterion', () => {
    expect(
      () =>
        new PerTurnUserSimulatorQualityV1({evalMetric: metricWith(undefined)}),
    ).toThrow(
      '`per_turn_user_simulator_quality_v1` metric expects a criterion of ' +
        'type `LlmBackedUserSimulatorCriterion`.',
    );
  });

  it('reports the criterion the parser rejected as the cause', () => {
    // A judge cannot sample a model one and a half times.
    const construct = () =>
      new PerTurnUserSimulatorQualityV1({
        evalMetric: metricWith({
          threshold: 0.8,
          judgeModelOptions: {numSamples: 1.5},
        }),
      });

    expect(construct).toThrow(
      '`per_turn_user_simulator_quality_v1` metric expects a criterion of ' +
        'type `LlmBackedUserSimulatorCriterion`.',
    );

    let caught: Error | undefined;
    try {
      construct();
    } catch (error) {
      if (!(error instanceof Error)) {
        expect.fail(`The constructor threw a non-error: ${String(error)}`);
      }
      caught = error;
    }
    expect(caught?.cause).toBeInstanceOf(Error);
  });

  it('resolves the judge model from the registry when none is given', async () => {
    LLMRegistry.register(RegisteredJudgeLlm);
    RegisteredJudgeLlm.calls = 0;

    const evaluator = new PerTurnUserSimulatorQualityV1({
      evalMetric: metricWith({
        threshold: 0.8,
        judgeModelOptions: {
          judgeModel: REGISTERED_JUDGE_MODEL,
          numSamples: 1,
        },
      }),
    });
    await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

    expect(RegisteredJudgeLlm.calls).toBe(2);
  });
});

describe('PerTurnUserSimulatorQualityV1 judge calls', () => {
  it('sends the prompt to the injected judge, not to the criterion model', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 1},
    });

    await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

    expect(judge.requests.every((r) => r.model === FAKE_JUDGE_MODEL)).toBe(
      true,
    );
  });

  it('stamps the default retry policy onto every judge request', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      judgeModelOptions: {numSamples: 1},
    });

    await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

    expect(judge.requests[0].config?.httpOptions?.retryOptions).toBeDefined();
  });

  it('issues one judge call per sample, and none for the first turn', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      judgeModelOptions: {numSamples: 3},
    });

    await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

    // Three samples for the second turn, three for the stop-signal turn.
    expect(judge.requests).toHaveLength(6);
  });

  it('puts the default stop signal in the prompt when the criterion omits it', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      judgeModelOptions: {numSamples: 1},
    });

    await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

    expect(promptOf(judge, 0)).toContain(
      `\`${DEFAULT_USER_SIMULATOR_STOP_SIGNAL}\``,
    );
  });

  it('grades a later turn against the turns before it', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      judgeModelOptions: {numSamples: 1},
    });

    await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

    const secondTurnPrompt = promptOf(judge, 0);
    expect(secondTurnPrompt).toContain(`user: ${STARTING_PROMPT}`);
    expect(secondTurnPrompt).not.toContain('user: user 2.');
    expect(secondTurnPrompt).toContain('# Generated User Response\nuser 2.');
  });

  it('does not evaluate a turn when the judge answers nothing', async () => {
    const {evaluator} = evaluatorWith([{silent: true}], {
      threshold: 0.8,
      judgeModelOptions: {numSamples: 1},
    });

    const result = await evaluator.evaluateInvocations(
      CONVERSATION,
      undefined,
      SCENARIO,
    );

    expect(result.perInvocationResults[1].score).toBeUndefined();
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });

  it('does not evaluate a turn when the criterion asks for no samples', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      judgeModelOptions: {numSamples: 0},
    });

    const result = await evaluator.evaluateInvocations(
      CONVERSATION,
      undefined,
      SCENARIO,
    );

    expect(judge.requests).toHaveLength(0);
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });
});

describe('PerTurnUserSimulatorQualityV1 stop-signal turn', () => {
  it('replaces the last turn when the conversation should have ended', async () => {
    const {evaluator} = evaluatorWith(
      // The second turn passes; the stop-signal call that follows it fails.
      [{critique: VALID_CRITIQUE}, {critique: INVALID_CRITIQUE}],
      {threshold: 0.8, judgeModelOptions: {numSamples: 1}},
    );

    const result = await evaluator.evaluateInvocations(
      CONVERSATION,
      undefined,
      SCENARIO,
    );

    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[1].actualInvocation.invocationId).toBe(
      'stop_signal_proxy_invocation',
    );
    expect(result.perInvocationResults[1].score).toBe(0.0);
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('keeps every turn when the conversation ended correctly', async () => {
    const {evaluator} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      judgeModelOptions: {numSamples: 1},
    });

    const result = await evaluator.evaluateInvocations(
      CONVERSATION,
      undefined,
      SCENARIO,
    );

    expect(result.perInvocationResults).toHaveLength(2);
    expect(
      result.perInvocationResults.map((r) => r.actualInvocation.invocationId),
    ).toEqual([STARTING_PROMPT, 'user 2.']);
  });

  it('sends the stop signal as the turn the last judge call grades', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
      stopSignal: '<<done>>',
      judgeModelOptions: {numSamples: 1},
    });

    await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

    expect(promptOf(judge, judge.requests.length - 1)).toContain(
      '# Generated User Response\n<<done>>',
    );
  });
});

describe('PerTurnUserSimulatorQualityV1 input guards', () => {
  it('rejects a call that supplies no conversation scenario', async () => {
    const {evaluator} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
    });

    await expect(evaluator.evaluateInvocations(CONVERSATION)).rejects.toThrow(
      new InputValidationError(
        'conversationScenario is needed by this metric.',
      ),
    );
  });

  it('evaluates nothing for an empty conversation', async () => {
    const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
      threshold: 0.8,
    });

    const result = await evaluator.evaluateInvocations([], undefined, SCENARIO);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(judge.requests).toHaveLength(0);
  });
});

describe('aggregateSamples tie-breaking', () => {
  function scored(score: number | undefined): PerInvocationResult {
    return {
      actualInvocation: CONVERSATION[0],
      score,
      evalStatus:
        score === 1.0
          ? EvalStatus.PASSED
          : score === 0.0
            ? EvalStatus.FAILED
            : EvalStatus.NOT_EVALUATED,
    };
  }

  it('gives a tie to the samples that rejected the turn', () => {
    const aggregated = aggregateSamples([
      scored(1.0),
      scored(1.0),
      scored(0.0),
      scored(0.0),
    ]);

    expect(aggregated.score).toBe(0.0);
    expect(aggregated.evalStatus).toBe(EvalStatus.FAILED);
  });

  it('ignores an unscored sample when other samples voted', () => {
    const aggregated = aggregateSamples([
      scored(undefined),
      scored(1.0),
      scored(0.0),
      scored(1.0),
    ]);

    expect(aggregated.score).toBe(1.0);
  });

  it('rejects an empty sample list', () => {
    expect(() => aggregateSamples([])).toThrow(
      new InputValidationError('No samples to aggregate into a result.'),
    );
  });
});

describe('aggregateConversationResults edge cases', () => {
  it('evaluates nothing for an empty result list', () => {
    expect(aggregateConversationResults([], 0.8)).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
  });

  it('counts a passed turn that carries no score as zero', () => {
    const aggregated = aggregateConversationResults(
      [
        {actualInvocation: CONVERSATION[0], evalStatus: EvalStatus.PASSED},
        {
          actualInvocation: CONVERSATION[1],
          score: 1.0,
          evalStatus: EvalStatus.PASSED,
        },
      ],
      0.4,
    );

    expect(aggregated.overallScore).toBe(0.5);
    expect(aggregated.overallEvalStatus).toBe(EvalStatus.PASSED);
  });
});

describe('parseIsValidLabel edge cases', () => {
  it('strips the braces a critique leaves around the verdict', () => {
    expect(parseIsValidLabel('"is_valid": }valid}\n')).toBe(Label.VALID);
  });

  it('reports a critique with no verdict field at all', () => {
    expect(parseIsValidLabel('the judge said nothing useful')).toBe(
      Label.NOT_FOUND,
    );
  });
});

describe('convertLlmResponseToScore edge cases', () => {
  it('reads no score out of a response with no content', () => {
    expect(convertLlmResponseToScore({})).toEqual({});
  });
});

describe('evaluateFirstTurn whitespace handling', () => {
  it('accepts a starting prompt that differs only in surrounding whitespace', () => {
    const result = evaluateFirstTurn(
      {
        invocationId: '1',
        userContent: {role: 'user', parts: [{text: `  ${STARTING_PROMPT}\n`}]},
      },
      {startingPrompt: `\n${STARTING_PROMPT}  `, conversationPlan: 'plan'},
      1.0,
    );

    expect(result.score).toBe(1);
    expect(result.evalStatus).toBe(EvalStatus.PASSED);
  });

  it('rejects a starting prompt that differs inside the text', () => {
    const result = evaluateFirstTurn(
      {
        invocationId: '1',
        userContent: {role: 'user', parts: [{text: 'first  user prompt.'}]},
      },
      SCENARIO,
      1.0,
    );

    expect(result.score).toBe(0);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });
});

describe('formatConversationHistory edge cases', () => {
  it('names the agent role when the reply carries none', () => {
    const history = formatConversationHistory([
      {
        invocationId: '1',
        userContent: {role: 'user', parts: [{text: 'hello'}]},
        finalResponse: {parts: [{text: 'hi'}]},
      },
    ]);

    expect(history).toBe('user: hello\n\nmodel: hi');
  });
});
